// Tower: the coordination brain of one project.
//
// One Tower Durable Object per project owns everything that is not file contents: agents, intents,
// flights, clearances (who may touch which functions), the landing queue, the contrail (why code
// changed) and the radar event stream that the UI and agents watch. File contents live in Artifacts:
// one trunk repo per project and one workspace fork per flight. The Runway DO is the only writer of
// trunk.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import type { BatchResult, LandingJob, LandingOutcome } from "../runway/runway";
import { CONFIG_FILE } from "../runway/verify";
import type {
	Agent,
	AgentKind,
	Clearance,
	ConflictReport,
	ContrailEntry,
	ContrailKind,
	FileChange,
	Flight,
	FlightStatus,
	Intent,
	Landing,
	ProjectInfo,
	RadarEvent,
	RadarSnapshot,
	TrunkFile,
	TrunkState,
} from "../shared/types";
import { callsignFor, colorFor, errorMessage, json, now, randomId, randomToken, repoSafe, sha256, sleep } from "../util";
import { PROTOCOL, workspaceInstructions } from "./briefing";
import { findCollisions, normalizeTarget, parseTarget, targetsOverlap } from "./clearance";
import { SCHEMA } from "./schema";

type Row = Record<string, SqlStorageValue>;

const CLEARANCE_TTL_MS = 45 * 60_000;
const WORKSPACE_TOKEN_TTL_S = 6 * 3600;
const TRAIN_SIZE = 12;
const LANDING_WAIT_MS = 50_000;
const MAX_EVENTS = 1000;
const ACTIVE: FlightStatus[] = ["taxiing", "airborne", "holding", "approach", "diverted"];

export interface ProjectSource {
	kind: "files" | "github";
	files?: Record<string, string>;
	url?: string;
	branch?: string;
}

export interface Workspace {
	repo: string;
	remote: string;
	cloneUrl: string;
	expiresAt: string;
}

export interface TakeOffResult {
	flight: Flight;
	intent: Intent;
	/** Contrail of earlier flights on this intent that did not land: context handed to the next agent. */
	previousAttempts?: { flight: string; agent: string; status: string; contrail: { kind: string; text: string }[] }[];
	workspace: Workspace;
	upstream: Workspace;
	setup: string;
	briefing: string;
	radio: RadioMessage[];
}

export interface RadioMessage {
	kind: string;
	text: string;
	at: number;
}

export interface HoldInfo {
	target: string;
	heldBy: { flight: string; callsign: string; intent: string; plan: string | null; reason: string | null; since: number };
}

export interface ClearanceResult {
	granted: string[];
	holding: HoldInfo[];
	radio: RadioMessage[];
}

export interface LandingView {
	landing: Landing;
	position?: number;
	radio: RadioMessage[];
	next: string;
}

export class Tower extends DurableObject<Env> {
	private sql: SqlStorage;
	private waiters = new Map<string, ((l: Landing) => void)[]>();
	private processing = false;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		ctx.blockConcurrencyWhile(async () => {
			this.migrate();
			// A restart (deploy, eviction) can interrupt a train: put its landings back in the queue.
			const stale = this.sql.exec("UPDATE landings SET status = 'queued' WHERE status IN ('merging', 'verifying') RETURNING id").toArray();
			if (stale.length) await ctx.storage.setAlarm(Date.now() + 500);
		});
	}

	private migrate() {
		for (const stmt of SCHEMA) {
			try {
				this.sql.exec(stmt);
			} catch (err) {
				// ALTER TABLE … ADD COLUMN is not idempotent in SQLite; an existing column is fine.
				if (!/duplicate column/i.test(errorMessage(err))) throw err;
			}
		}
	}

	// ───────────────────────── helpers ─────────────────────────

	private rows<T = Row>(query: string, ...args: SqlStorageValue[]): T[] {
		return this.sql.exec(query, ...args).toArray() as T[];
	}

	private row<T = Row>(query: string, ...args: SqlStorageValue[]): T | null {
		return (this.rows<T>(query, ...args)[0] as T) ?? null;
	}

	private meta<T>(k: string, fallback: T): T {
		const r = this.row<{ v: string }>("SELECT v FROM meta WHERE k = ?", k);
		return r ? json<T>(r.v, fallback) : fallback;
	}

	private setMeta(k: string, v: unknown) {
		this.sql.exec("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, JSON.stringify(v));
	}

	private bump(stat: string, by = 1) {
		const stats = this.meta<Record<string, number>>("stats", {});
		stats[stat] = (stats[stat] ?? 0) + by;
		this.setMeta("stats", stats);
		this.patch("stats", stats);
	}

	private project(): ProjectInfo {
		const p = this.meta<ProjectInfo | null>("project", null);
		if (!p) throw new Error("project is not set up");
		return p;
	}

	private runway() {
		return this.env.RUNWAY.get(this.env.RUNWAY.idFromName(this.project().slug));
	}

	private toAgent(r: Row): Agent {
		return {
			id: r.id as string,
			callsign: r.callsign as string,
			kind: r.kind as AgentKind,
			model: (r.model as string) ?? null,
			color: r.color as string,
			joinedAt: r.joined_at as number,
			lastSeenAt: r.last_seen_at as number,
		};
	}

	private toIntent(r: Row): Intent {
		return {
			id: r.id as string,
			seq: r.seq as number,
			title: r.title as string,
			body: r.body as string,
			priority: r.priority as number,
			status: r.status as Intent["status"],
			labels: json(r.labels as string, []),
			createdBy: r.created_by as string,
			createdAt: r.created_at as number,
			flightId: (r.flight_id as string) ?? null,
			landedCommit: (r.landed_commit as string) ?? null,
			dependsOn: json(r.depends_on as string, []),
		};
	}

	private toFlight(r: Row): Flight {
		return {
			id: r.id as string,
			code: r.code as string,
			agentId: r.agent_id as string,
			intentId: r.intent_id as string,
			status: r.status as FlightStatus,
			repo: r.repo as string,
			baseCommit: r.base_commit as string,
			plan: (r.plan as string) ?? null,
			createdAt: r.created_at as number,
			updatedAt: r.updated_at as number,
			landedAt: (r.landed_at as number) ?? null,
			attempts: r.attempts as number,
			touched: json(r.touched as string, []),
		};
	}

	private toClearance(r: Row): Clearance {
		return {
			id: r.id as string,
			flightId: r.flight_id as string,
			target: r.target as string,
			status: r.status as Clearance["status"],
			reason: (r.reason as string) ?? null,
			createdAt: r.created_at as number,
			expiresAt: r.expires_at as number,
		};
	}

	private toLanding(r: Row): Landing {
		return {
			id: r.id as string,
			seq: r.seq as number,
			flightId: r.flight_id as string,
			status: r.status as Landing["status"],
			summary: r.summary as string,
			forkHead: (r.fork_head as string) ?? null,
			trunkBefore: (r.trunk_before as string) ?? null,
			trunkAfter: (r.trunk_after as string) ?? null,
			changes: json(r.changes as string, []),
			conflicts: json(r.conflicts as string, []),
			tests: json(r.tests as string, null),
			error: (r.error as string) ?? null,
			unioned: r.unioned as number,
			review: json(r.review as string, null),
			createdAt: r.created_at as number,
			finishedAt: (r.finished_at as number) ?? null,
		};
	}

	private agentById(id: string): Agent {
		const r = this.row("SELECT * FROM agents WHERE id = ?", id);
		if (!r) throw new Error(`unknown agent ${id}`);
		return this.toAgent(r);
	}

	private flightById(id: string): Flight {
		const r = this.row("SELECT * FROM flights WHERE id = ?", id);
		if (!r) throw new Error(`unknown flight ${id}`);
		return this.toFlight(r);
	}

	private intentById(id: string): Intent {
		const r = this.row("SELECT * FROM intents WHERE id = ?", id);
		if (!r) throw new Error(`unknown intent ${id}`);
		return this.toIntent(r);
	}

	/** Resolves a flight reference (id or code) owned by `agentId`; defaults to the agent's active flight. */
	private ownFlight(agentId: string, ref?: string | null): Flight {
		const r = ref
			? this.row("SELECT * FROM flights WHERE (id = ? OR code = ?) AND agent_id = ?", ref, ref.toUpperCase(), agentId)
			: this.row(`SELECT * FROM flights WHERE agent_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY created_at DESC LIMIT 1`, agentId, ...ACTIVE);
		if (!r) throw new Error(ref ? `flight ${ref} is not yours or does not exist` : "you have no active flight — call take_off first");
		return this.toFlight(r);
	}

	private setFlightStatus(flightId: string, status: FlightStatus) {
		this.sql.exec("UPDATE flights SET status = ?, updated_at = ? WHERE id = ?", status, now(), flightId);
	}

	private touchAgent(agentId: string) {
		this.sql.exec("UPDATE agents SET last_seen_at = ? WHERE id = ?", now(), agentId);
	}

	private emit(type: string, text: string, extra: { flightId?: string; agentId?: string; data?: Record<string, unknown> } = {}) {
		const at = now();
		const res = this.sql.exec(
			"INSERT INTO events (at, type, flight_id, agent_id, text, data) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
			at,
			type,
			extra.flightId ?? null,
			extra.agentId ?? null,
			text,
			extra.data ? JSON.stringify(extra.data) : null,
		);
		const seq = (res.one() as { seq: number }).seq;
		if (seq % 100 === 0) this.sql.exec("DELETE FROM events WHERE seq <= ?", seq - MAX_EVENTS);
		const event: RadarEvent = { seq, at, type, text, flightId: extra.flightId, agentId: extra.agentId, data: extra.data };
		this.broadcast({ kind: "event", event });
	}

	private broadcast(message: unknown) {
		const payload = JSON.stringify(message);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(payload);
			} catch {
				// Socket is closing; hibernation API cleans it up.
			}
		}
	}

	/** Broadcasts the changed rows so the Radar can patch its state without refetching. */
	private patch(kind: string, value: unknown) {
		this.broadcast({ kind: "patch", entity: kind, value });
	}

	private addContrail(flightId: string, agentId: string | null, kind: ContrailKind, text: string, refs: string[] = []): ContrailEntry {
		const at = now();
		const res = this.sql.exec(
			"INSERT INTO contrail (flight_id, agent_id, kind, text, refs, at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id",
			flightId,
			agentId,
			kind,
			text,
			JSON.stringify(refs),
			at,
		);
		const entry: ContrailEntry = { id: (res.one() as { id: number }).id, flightId, agentId, kind, text, refs, at };
		this.patch("contrail", entry);
		return entry;
	}

	private sendRadio(flightId: string, kind: string, text: string) {
		this.sql.exec("INSERT INTO inbox (flight_id, kind, text, at) VALUES (?, ?, ?, ?)", flightId, kind, text, now());
	}

	/** Undelivered radio messages for a flight; marks them delivered. */
	private drainRadio(flightId: string | null): RadioMessage[] {
		if (!flightId) return [];
		const rows = this.rows<{ id: number; kind: string; text: string; at: number }>(
			"SELECT id, kind, text, at FROM inbox WHERE flight_id = ? AND delivered = 0 ORDER BY id",
			flightId,
		);
		if (rows.length) this.sql.exec("UPDATE inbox SET delivered = 1 WHERE flight_id = ? AND delivered = 0", flightId);
		return rows.map((r) => ({ kind: r.kind, text: r.text, at: r.at }));
	}

	private workspaceUrl(remote: string, token: string): string {
		const secret = token.split("?expires=")[0];
		return `https://x:${secret}@${remote.replace(/^https:\/\//, "")}`;
	}

	private async mintWorkspace(repoName: string, scope: "read" | "write"): Promise<Workspace> {
		const repo = await this.env.ARTIFACTS.get(repoName);
		try {
			const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, WORKSPACE_TOKEN_TTL_S)]);
			return { repo: repoName, remote: info.remote, cloneUrl: this.workspaceUrl(info.remote, token.plaintext), expiresAt: token.expiresAt };
		} finally {
			repo[Symbol.dispose]?.();
		}
	}

	// ───────────────────────── project setup ─────────────────────────

	async setup(input: { slug: string; name: string; description: string; public: boolean; playground?: boolean; source: ProjectSource }): Promise<ProjectInfo> {
		const existing = this.meta<ProjectInfo | null>("project", null);
		if (existing && this.meta<boolean>("ready", false)) return existing;
		const trunkRepo = repoSafe(`${input.slug}--trunk`);
		const info: ProjectInfo = existing ?? {
			slug: input.slug,
			name: input.name,
			description: input.description,
			trunkRepo,
			createdAt: now(),
			public: input.public,
			playground: input.playground ?? false,
		};
		this.setMeta("project", info);
		const A = this.env.ARTIFACTS;
		// Idempotent: a setup interrupted half-way (deploy, eviction) can simply be called again.
		const exists = await A.get(trunkRepo)
			.then((r) => (r[Symbol.dispose]?.(), true))
			.catch(() => false);
		if (input.source.kind === "github") {
			if (!exists) await A.import({ source: { url: input.source.url!, branch: input.source.branch }, target: { name: trunkRepo, opts: { description: `${input.name} trunk` } } });
			for (let i = 0; i < 120; i++) {
				try {
					const r = await A.get(trunkRepo);
					r[Symbol.dispose]?.();
					break;
				} catch (err) {
					if ((err as { code?: string }).code !== "IMPORT_IN_PROGRESS") throw err;
					await sleep(500);
				}
			}
		} else {
			if (!exists) await A.create(trunkRepo, { setDefaultBranch: "main", description: `${input.name} trunk` });
			const log = await A.get(trunkRepo).then(async (r) => {
				try {
					return await r.log({ ref: "main", limit: 1 });
				} finally {
					r[Symbol.dispose]?.();
				}
			});
			if (log.length === 0) await this.runway().seedTrunk(trunkRepo, input.source.files ?? { "README.md": `# ${input.name}\n` }, `Create ${input.name}`);
		}
		if (!existing) this.bump("repos");
		this.emit("project.created", `Trunk repo ${trunkRepo} is ready`, { data: { trunkRepo } });
		await this.refreshTrunk();
		await this.readTestCommand();
		this.setMeta("ready", true);
		return info;
	}

	async info(): Promise<ProjectInfo | null> {
		return this.meta<ProjectInfo | null>("project", null);
	}

	/** The project's own way to run its tests (contrail.json), told to agents when they take off. */
	private async readTestCommand() {
		const repo = await this.env.ARTIFACTS.get(this.project().trunkRepo);
		try {
			const blob = await repo.readFile({ ref: "main", path: CONFIG_FILE });
			const command = blob ? (JSON.parse(await new Response(blob).text()) as { tests?: { command?: unknown } }).tests?.command : null;
			this.setMeta("testCommand", typeof command === "string" ? command : null);
		} catch {
			this.setMeta("testCommand", null);
		} finally {
			repo[Symbol.dispose]?.();
		}
	}

	private async refreshTrunk(): Promise<TrunkState> {
		const { head, files } = await this.runway().trunkFiles(this.project().trunkRepo);
		const state: TrunkState = { head, files, landedCount: this.meta<Record<string, number>>("stats", {}).landings ?? 0 };
		this.setMeta("trunk", state);
		this.patch("trunk", state);
		return state;
	}

	// ───────────────────────── agents ─────────────────────────

	async join(input: { callsign?: string; kind?: AgentKind; model?: string }): Promise<{ agent: Agent; key: string }> {
		const n = (this.row<{ n: number }>("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM agents")?.n ?? 1) as number;
		if (n > 2000) throw new Error("this airspace is full (2000 agents)");
		const kind: AgentKind = input.kind ?? "other";
		let callsign = (input.callsign ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20) || callsignFor(kind, n);
		if (this.row("SELECT id FROM agents WHERE callsign = ?", callsign)) callsign = `${callsign}-${n}`;
		const key = randomToken("ct");
		const agent: Agent = { id: randomId(), callsign, kind, model: input.model?.slice(0, 60) ?? null, color: colorFor(n - 1), joinedAt: now(), lastSeenAt: now() };
		this.sql.exec(
			"INSERT INTO agents (id, n, callsign, kind, model, color, key_hash, joined_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			agent.id,
			n,
			agent.callsign,
			agent.kind,
			agent.model,
			agent.color,
			await sha256(key),
			agent.joinedAt,
			agent.lastSeenAt,
		);
		this.patch("agent", agent);
		this.emit("agent.joined", `${agent.callsign} joined${agent.model ? ` (${agent.model})` : ""}`, { agentId: agent.id });
		return { agent, key };
	}

	async authenticate(key: string): Promise<Agent | null> {
		const r = this.row("SELECT * FROM agents WHERE key_hash = ?", await sha256(key));
		return r ? this.toAgent(r) : null;
	}

	// ───────────────────────── intents ─────────────────────────

	async addIntents(list: { title: string; body?: string; priority?: number; labels?: string[]; dependsOn?: number[] }[], createdBy: string): Promise<Intent[]> {
		const created: Intent[] = [];
		for (const item of list) {
			const seq = (this.row<{ s: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM intents")?.s ?? 1) as number;
			const deps = (item.dependsOn ?? [])
				.map((s) => this.row<{ id: string }>("SELECT id FROM intents WHERE seq = ?", s)?.id)
				.filter((x): x is string => !!x);
			const intent: Intent = {
				id: randomId(),
				seq,
				title: item.title.slice(0, 200),
				body: (item.body ?? "").slice(0, 8000),
				priority: item.priority ?? 0,
				status: "open",
				labels: item.labels ?? [],
				createdBy,
				createdAt: now(),
				flightId: null,
				landedCommit: null,
				dependsOn: deps,
			};
			this.sql.exec(
				"INSERT INTO intents (id, seq, title, body, priority, status, labels, created_by, created_at, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				intent.id,
				intent.seq,
				intent.title,
				intent.body,
				intent.priority,
				intent.status,
				JSON.stringify(intent.labels),
				createdBy,
				intent.createdAt,
				JSON.stringify(deps),
			);
			created.push(intent);
			this.patch("intent", intent);
			this.emit("intent.created", `INT-${intent.seq} ${intent.title}`, { data: { intentId: intent.id } });
		}
		return created;
	}

	/** Agents can file follow-up work for other agents. */
	async fileIntent(agentId: string, input: { title: string; body?: string; priority?: number }): Promise<Intent> {
		const agent = this.agentById(agentId);
		const recent = this.row<{ c: number }>("SELECT COUNT(*) AS c FROM intents WHERE created_by != 'operator' AND created_at > ?", now() - 3600_000)?.c ?? 0;
		if (recent >= 30) throw new Error("agents have filed 30 intents in the last hour; ask the operator to file more");
		const [intent] = await this.addIntents([input], agent.callsign);
		return intent;
	}

	private nextIntent(intentRef?: string | number | null): Intent | null {
		if (intentRef !== undefined && intentRef !== null && intentRef !== "") {
			const ref = String(intentRef).replace(/^INT-/i, "");
			const r = /^\d+$/.test(ref) ? this.row("SELECT * FROM intents WHERE seq = ?", Number(ref)) : this.row("SELECT * FROM intents WHERE id = ?", ref);
			if (!r) throw new Error(`no intent ${intentRef}`);
			const intent = this.toIntent(r);
			if (intent.status !== "open") throw new Error(`INT-${intent.seq} is ${intent.status}`);
			return intent;
		}
		for (const r of this.rows("SELECT * FROM intents WHERE status = 'open' ORDER BY priority DESC, seq ASC")) {
			const intent = this.toIntent(r);
			const blocked = intent.dependsOn.some((id) => this.row<{ status: string }>("SELECT status FROM intents WHERE id = ?", id)?.status !== "landed");
			if (!blocked) return intent;
		}
		return null;
	}

	// ───────────────────────── flights ─────────────────────────

	async takeOff(agentId: string, opts: { intent?: string | number | null } = {}): Promise<TakeOffResult | { idle: true; message: string; radio: RadioMessage[] }> {
		const agent = this.agentById(agentId);
		this.touchAgent(agentId);
		const active = this.row(`SELECT * FROM flights WHERE agent_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`, agentId, ...ACTIVE);
		if (active) {
			const f = this.toFlight(active);
			throw new Error(`you are already flying ${f.code} (${f.status}); land it or call abort before taking off again`);
		}
		const intent = this.nextIntent(opts.intent);
		if (!intent) {
			const waiting = this.row<{ c: number }>("SELECT COUNT(*) AS c FROM intents WHERE status = 'open'")?.c ?? 0;
			return {
				idle: true,
				message: waiting ? `${waiting} open intent(s) are blocked by dependencies that have not landed yet. Try again shortly.` : "No open intents. Nothing to do — you may stop.",
				radio: [],
			};
		}

		const project = this.project();
		const seq = (this.row<{ s: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM flights")?.s ?? 1) as number;
		const code = `FL-${String(seq).padStart(3, "0")}`;
		const flightId = randomId();
		const repo = repoSafe(`${project.slug}--${code.toLowerCase()}-${randomId(4)}`);
		const trunk = this.meta<TrunkState>("trunk", { head: null, files: [], landedCount: 0 });
		const t = now();
		this.sql.exec(
			"INSERT INTO flights (id, seq, code, agent_id, intent_id, status, repo, base_commit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'taxiing', ?, ?, ?, ?)",
			flightId,
			seq,
			code,
			agentId,
			intent.id,
			repo,
			trunk.head ?? "",
			t,
			t,
		);
		this.sql.exec("UPDATE intents SET status = 'assigned', flight_id = ? WHERE id = ?", flightId, intent.id);
		this.patch("flight", this.flightById(flightId));
		this.patch("intent", this.intentById(intent.id));
		this.emit("flight.taxiing", `${agent.callsign} taxiing as ${code} for INT-${intent.seq}`, { flightId, agentId });

		try {
			// Artifacts runs one fork of a repo at a time; under a take-off burst, wait for our turn.
			for (let attempt = 0; ; attempt++) {
				const trunkRepo = await this.env.ARTIFACTS.get(project.trunkRepo);
				try {
					await trunkRepo.fork(repo, { defaultBranchOnly: true, description: `${code} · ${agent.callsign} · INT-${intent.seq} ${intent.title}`.slice(0, 200) });
					break;
				} catch (err) {
					const code = (err as { code?: string }).code ?? "";
					const transient = code === "FORK_IN_PROGRESS" || code === "INTERNAL_ERROR" || code === "UPSTREAM_UNAVAILABLE" || /internal error/i.test(errorMessage(err));
					if (!transient || attempt >= 40) throw err;
					await sleep(300 + Math.random() * 700 + attempt * 100);
				} finally {
					trunkRepo[Symbol.dispose]?.();
				}
			}
			let workspace: Workspace | null = null;
			for (let i = 0; i < 60 && !workspace; i++) {
				try {
					workspace = await this.mintWorkspace(repo, "write");
				} catch (err) {
					const code = (err as { code?: string }).code;
					if (code !== "FORK_IN_PROGRESS" && code !== "CREATE_IN_PROGRESS" && code !== "NOT_FOUND" && code !== "INTERNAL_ERROR") throw err;
					await sleep(250);
				}
			}
			if (!workspace) throw new Error("workspace fork did not become ready");
			const upstream = await this.mintWorkspace(project.trunkRepo, "read");
			this.bump("repos");
			this.setFlightStatus(flightId, "airborne");
			this.addContrail(flightId, agentId, "intent", `INT-${intent.seq} ${intent.title}${intent.body ? `\n\n${intent.body}` : ""}`);
			const flight = this.flightById(flightId);
			this.patch("flight", flight);
			this.emit("flight.airborne", `${code} airborne — workspace ${repo} forked from trunk`, { flightId, agentId, data: { repo } });
			const dir = code.toLowerCase();
			const previousAttempts = this.rows("SELECT * FROM flights WHERE intent_id = ? AND id != ? AND status = 'aborted' ORDER BY seq", intent.id, flightId)
				.map((r) => this.toFlight(r))
				.map((f) => ({
					flight: f.code,
					agent: this.agentById(f.agentId).callsign,
					status: f.status,
					contrail: this.rows<{ kind: string; text: string }>(
						"SELECT kind, text FROM contrail WHERE flight_id = ? AND kind IN ('plan', 'decision', 'handoff', 'conflict', 'test', 'note') ORDER BY id",
						f.id,
					),
				}))
				.filter((a) => a.contrail.length > 0);
			if (previousAttempts.length) {
				this.addContrail(flightId, null, "handoff", `Inherited the contrail of ${previousAttempts.map((a) => `${a.flight} (${a.agent})`).join(", ")}`);
				this.emit("contrail.handoff", `${code} inherits context from ${previousAttempts.map((a) => a.flight).join(", ")}`, { flightId, agentId });
			}
			return {
				flight,
				intent: this.intentById(intent.id),
				...(previousAttempts.length ? { previousAttempts } : {}),
				workspace,
				upstream,
				setup: workspaceInstructions({ cloneUrl: workspace.cloneUrl, upstreamUrl: upstream.cloneUrl, dir, flightCode: code, callsign: agent.callsign, testCommand: this.meta<string | null>("testCommand", null) ?? undefined }),
				briefing: PROTOCOL,
				radio: this.drainRadio(flightId),
			};
		} catch (err) {
			this.setFlightStatus(flightId, "aborted");
			this.sql.exec("UPDATE intents SET status = 'open', flight_id = NULL WHERE id = ?", intent.id);
			this.patch("flight", this.flightById(flightId));
			this.patch("intent", this.intentById(intent.id));
			this.addContrail(flightId, agentId, "note", `Aborted on the ground: ${errorMessage(err)}`);
			this.emit("flight.aborted", `${code} aborted on the ground: ${errorMessage(err)}`, { flightId, agentId });
			throw err;
		}
	}

	async refreshWorkspace(agentId: string, flightRef?: string): Promise<{ workspace: Workspace; upstream: Workspace }> {
		const flight = this.ownFlight(agentId, flightRef);
		return { workspace: await this.mintWorkspace(flight.repo, "write"), upstream: await this.mintWorkspace(this.project().trunkRepo, "read") };
	}

	async abort(agentId: string, flightRef?: string, reason?: string): Promise<{ ok: true; radio: RadioMessage[] }> {
		const flight = this.ownFlight(agentId, flightRef);
		this.setFlightStatus(flight.id, "aborted");
		this.sql.exec("UPDATE intents SET status = 'open', flight_id = NULL WHERE id = ? AND status = 'assigned'", flight.intentId);
		this.releaseAll(flight.id);
		if (reason) this.addContrail(flight.id, agentId, "note", `Aborted: ${reason}`);
		this.patch("flight", this.flightById(flight.id));
		this.patch("intent", this.intentById(flight.intentId));
		this.emit("flight.aborted", `${flight.code} aborted${reason ? `: ${reason}` : ""}`, { flightId: flight.id, agentId });
		return { ok: true, radio: this.drainRadio(flight.id) };
	}

	// ───────────────────────── clearances ─────────────────────────

	private activeClearances(): Clearance[] {
		return this.rows("SELECT * FROM clearances WHERE expires_at > ? ORDER BY created_at", now()).map((r) => this.toClearance(r));
	}

	async requestClearance(agentId: string, input: { targets: string[]; reason?: string; flight?: string }): Promise<ClearanceResult> {
		const flight = this.ownFlight(agentId, input.flight);
		const agent = this.agentById(agentId);
		this.touchAgent(agentId);
		const targets = [...new Set(input.targets.map((t) => this.resolveTarget(normalizeTarget(t))).filter((t) => t.length > 0))].slice(0, 50);
		if (targets.length === 0) throw new Error("name at least one target, e.g. src/cart.js#applyDiscount");
		const all = this.activeClearances();
		const mine = all.filter((c) => c.flightId === flight.id);
		const granted = all.filter((c) => c.status === "granted");
		const result: ClearanceResult = { granted: [], holding: [], radio: [] };
		const expires = now() + CLEARANCE_TTL_MS;
		// Re-requests (renewals, agents polling while they hold) stay silent: only changes are reported.
		const newlyGranted: string[] = [];
		const newHolds: HoldInfo[] = [];

		for (const target of targets) {
			const already = mine.find((c) => c.target === target);
			if (already?.status === "granted") {
				this.sql.exec("UPDATE clearances SET expires_at = ? WHERE id = ?", expires, already.id);
				result.granted.push(target);
				continue;
			}
			const collisions = findCollisions([target], granted.map((c) => ({ target: c.target, flightId: c.flightId })), flight.id);
			if (collisions.length === 0) {
				if (already) this.sql.exec("UPDATE clearances SET status = 'granted', expires_at = ? WHERE id = ?", expires, already.id);
				else
					this.sql.exec(
						"INSERT INTO clearances (id, flight_id, target, status, reason, created_at, expires_at) VALUES (?, ?, ?, 'granted', ?, ?, ?)",
						randomId(),
						flight.id,
						target,
						input.reason ?? null,
						now(),
						expires,
					);
				result.granted.push(target);
				newlyGranted.push(target);
				continue;
			}
			const holder = this.flightById(collisions[0].with.flightId);
			const holderAgent = this.agentById(holder.agentId);
			const holderIntent = this.intentById(holder.intentId);
			const heldClearance = granted.find((c) => c.flightId === holder.id && c.target === collisions[0].with.target);
			if (!already) {
				this.bump("conflictsPrevented");
				this.sql.exec(
					"INSERT INTO clearances (id, flight_id, target, status, reason, created_at, expires_at) VALUES (?, ?, ?, 'holding', ?, ?, ?)",
					randomId(),
					flight.id,
					target,
					input.reason ?? null,
					now(),
					expires,
				);
			}
			const hold: HoldInfo = {
				target,
				heldBy: {
					flight: holder.code,
					callsign: holderAgent.callsign,
					intent: `INT-${holderIntent.seq} ${holderIntent.title}`,
					plan: holder.plan,
					reason: heldClearance?.reason ?? null,
					since: heldClearance?.createdAt ?? holder.createdAt,
				},
			};
			result.holding.push(hold);
			if (!already) {
				newHolds.push(hold);
				this.sendRadio(
					holder.id,
					"traffic",
					`${agent.callsign} (${flight.code}) is holding for ${target}, which you hold. Land or release it when you are done with it.`,
				);
			}
		}

		if (newlyGranted.length) {
			this.addContrail(flight.id, agentId, "clearance", `Cleared: ${newlyGranted.join(", ")}${input.reason ? ` — ${input.reason}` : ""}`, newlyGranted);
			this.emit("clearance.granted", `${flight.code} cleared for ${newlyGranted.join(", ")}`, { flightId: flight.id, agentId, data: { targets: newlyGranted } });
		}
		if (result.holding.length) {
			this.setFlightStatus(flight.id, "holding");
		}
		if (newHolds.length) {
			this.addContrail(
				flight.id,
				agentId,
				"clearance",
				`Holding for ${newHolds.map((h) => `${h.target} (held by ${h.heldBy.callsign} ${h.heldBy.flight})`).join(", ")}`,
				newHolds.map((h) => h.target),
			);
			this.emit("clearance.holding", `${flight.code} holding — ${newHolds.map((h) => `${h.target} held by ${h.heldBy.flight}`).join(", ")}`, {
				flightId: flight.id,
				agentId,
				data: { holding: newHolds },
			});
		} else if (!result.holding.length && flight.status === "holding" && !this.row("SELECT id FROM clearances WHERE flight_id = ? AND status = 'holding'", flight.id)) {
			this.setFlightStatus(flight.id, "airborne");
		}
		const after = this.flightById(flight.id);
		if (newlyGranted.length || newHolds.length) this.patch("clearances", this.activeClearances());
		if (after.status !== flight.status) this.patch("flight", after);
		result.radio = this.drainRadio(flight.id);
		return result;
	}

	/** Maps a bare method name to its qualified symbol when unambiguous: "src/cart.js#add" → "src/cart.js#Cart.add". */
	private resolveTarget(target: string): string {
		const t = parseTarget(target);
		if (!t.symbol || t.isDir) return target;
		const file = this.meta<TrunkState>("trunk", { head: null, files: [], landedCount: 0 }).files.find((f) => f.path === t.path);
		if (!file || file.symbols.some((s) => s.name === t.symbol)) return target;
		const matches = file.symbols.filter((s) => s.name.endsWith(`.${t.symbol}`));
		return matches.length === 1 ? `${t.path}#${matches[0].name}` : target;
	}

	async releaseClearance(agentId: string, input: { targets?: string[]; flight?: string }): Promise<{ released: string[]; radio: RadioMessage[] }> {
		const flight = this.ownFlight(agentId, input.flight);
		const targets = input.targets?.map(normalizeTarget);
		const mine = this.rows<{ id: string; target: string }>("SELECT id, target FROM clearances WHERE flight_id = ?", flight.id);
		const released = mine.filter((c) => !targets || targets.includes(c.target));
		for (const c of released) this.sql.exec("DELETE FROM clearances WHERE id = ?", c.id);
		if (released.length) {
			this.emit("clearance.released", `${flight.code} released ${released.map((c) => c.target).join(", ")}`, { flightId: flight.id, agentId });
			this.promoteHolds();
		}
		this.patch("clearances", this.activeClearances());
		return { released: released.map((c) => c.target), radio: this.drainRadio(flight.id) };
	}

	private releaseAll(flightId: string) {
		const had = this.row("SELECT id FROM clearances WHERE flight_id = ?", flightId);
		this.sql.exec("DELETE FROM clearances WHERE flight_id = ?", flightId);
		if (had) this.promoteHolds();
		this.patch("clearances", this.activeClearances());
	}

	/** Grants queued clearances whose blockers are gone, oldest request first. */
	private promoteHolds() {
		const all = this.activeClearances();
		const granted = all.filter((c) => c.status === "granted");
		for (const hold of all.filter((c) => c.status === "holding")) {
			const blocked = granted.some((g) => g.flightId !== hold.flightId && targetsOverlap(g.target, hold.target));
			if (blocked) continue;
			this.sql.exec("UPDATE clearances SET status = 'granted', expires_at = ? WHERE id = ?", now() + CLEARANCE_TTL_MS, hold.id);
			granted.push({ ...hold, status: "granted" });
			const flight = this.flightById(hold.flightId);
			this.sendRadio(hold.flightId, "clearance", `Cleared for ${hold.target}. Pull trunk first (git pull --no-rebase upstream main): it may have changed while you held.`);
			this.addContrail(hold.flightId, null, "clearance", `Cleared after holding: ${hold.target}`, [hold.target]);
			this.emit("clearance.granted", `${flight.code} cleared for ${hold.target} after holding`, { flightId: hold.flightId, data: { targets: [hold.target] } });
			if (flight.status === "holding" && !this.row("SELECT id FROM clearances WHERE flight_id = ? AND status = 'holding'", flight.id)) {
				this.setFlightStatus(flight.id, "airborne");
				this.patch("flight", this.flightById(flight.id));
			}
		}
	}

	// ───────────────────────── contrail & radio ─────────────────────────

	async log(agentId: string, input: { kind: ContrailKind; text: string; refs?: string[]; flight?: string }): Promise<{ entry: ContrailEntry; radio: RadioMessage[] }> {
		const flight = this.ownFlight(agentId, input.flight);
		this.touchAgent(agentId);
		const kind: ContrailKind = ["plan", "decision", "note", "handoff", "test"].includes(input.kind) ? input.kind : "note";
		const text = input.text.slice(0, 4000);
		const entry = this.addContrail(flight.id, agentId, kind, text, (input.refs ?? []).map(normalizeTarget).slice(0, 20));
		if (kind === "plan") {
			this.sql.exec("UPDATE flights SET plan = ?, updated_at = ? WHERE id = ?", text, now(), flight.id);
			this.patch("flight", this.flightById(flight.id));
		}
		this.emit(`contrail.${kind}`, `${flight.code} ${kind}: ${text.split("\n")[0].slice(0, 140)}`, { flightId: flight.id, agentId });
		return { entry, radio: this.drainRadio(flight.id) };
	}

	async radio(agentId: string, input: { to: string; text: string; flight?: string }): Promise<{ delivered: string[]; radio: RadioMessage[] }> {
		const flight = this.ownFlight(agentId, input.flight);
		const agent = this.agentById(agentId);
		const to = input.to.trim().toUpperCase();
		const recipients = this.rows(
			`SELECT f.* FROM flights f JOIN agents a ON a.id = f.agent_id WHERE f.status IN (${ACTIVE.map(() => "?").join(",")}) AND f.id != ? AND (? = 'ALL' OR f.code = ? OR a.callsign = ?)`,
			...ACTIVE,
			flight.id,
			to,
			to,
			to,
		).map((r) => this.toFlight(r));
		const text = input.text.slice(0, 2000);
		for (const r of recipients) {
			this.sendRadio(r.id, "radio", `${agent.callsign} (${flight.code}): ${text}`);
			this.addContrail(r.id, agentId, "radio", `From ${agent.callsign} (${flight.code}): ${text}`);
		}
		this.addContrail(flight.id, agentId, "radio", `To ${to}: ${text}`);
		this.emit("radio", `${flight.code} → ${to}: ${text.slice(0, 140)}`, { flightId: flight.id, agentId });
		return { delivered: recipients.map((r) => r.code), radio: this.drainRadio(flight.id) };
	}

	// ───────────────────────── landing ─────────────────────────

	async requestLanding(agentId: string, input: { summary: string; flight?: string; wait?: boolean }): Promise<LandingView> {
		let flight: Flight;
		try {
			flight = this.ownFlight(agentId, input.flight);
		} catch (err) {
			// Idempotent retries: an agent that lost the response of a successful landing gets it again.
			const last = this.row("SELECT * FROM flights WHERE agent_id = ? AND status = 'landed' AND landed_at > ? ORDER BY landed_at DESC LIMIT 1", agentId, now() - 10 * 60_000);
			const landing = last ? this.row("SELECT * FROM landings WHERE flight_id = ? AND status = 'landed' ORDER BY seq DESC LIMIT 1", last.id as string) : null;
			if (!landing) throw err;
			const l = this.toLanding(landing);
			return { landing: l, radio: this.drainRadio(last!.id as string), next: this.nextStep(l) };
		}
		const agent = this.agentById(agentId);
		this.touchAgent(agentId);
		const pending = this.row("SELECT * FROM landings WHERE flight_id = ? AND status IN ('queued', 'merging', 'verifying', 'review')", flight.id);
		let landing: Landing;
		if (pending) {
			landing = this.toLanding(pending);
		} else {
			const seq = (this.row<{ s: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS s FROM landings")?.s ?? 1) as number;
			landing = {
				id: randomId(),
				seq,
				flightId: flight.id,
				status: "queued",
				summary: input.summary.slice(0, 4000),
				forkHead: null,
				trunkBefore: null,
				trunkAfter: null,
				changes: [],
				conflicts: [],
				tests: null,
				error: null,
				unioned: 0,
				review: null,
				createdAt: now(),
				finishedAt: null,
			};
			this.sql.exec(
				"INSERT INTO landings (id, seq, flight_id, status, summary, created_at) VALUES (?, ?, ?, 'queued', ?, ?)",
				landing.id,
				seq,
				flight.id,
				landing.summary,
				landing.createdAt,
			);
			this.sql.exec("UPDATE flights SET attempts = attempts + 1 WHERE id = ?", flight.id);
			this.setFlightStatus(flight.id, "approach");
			this.patch("landing", landing);
			this.patch("flight", this.flightById(flight.id));
			this.emit("landing.queued", `${flight.code} (${agent.callsign}) on final approach: ${landing.summary.split("\n")[0].slice(0, 120)}`, {
				flightId: flight.id,
				agentId,
				data: { landingId: landing.id },
			});
		}

		const done = new Promise<Landing>((resolve) => {
			const list = this.waiters.get(landing.id) ?? [];
			list.push(resolve);
			this.waiters.set(landing.id, list);
		});
		this.ctx.waitUntil(this.processQueue());
		const finished = input.wait === false ? null : await Promise.race([done, sleep(LANDING_WAIT_MS).then(() => null)]);
		const current = finished ?? this.toLanding(this.row("SELECT * FROM landings WHERE id = ?", landing.id)!);
		const position = this.row<{ c: number }>("SELECT COUNT(*) AS c FROM landings WHERE status = 'queued' AND seq < ?", current.seq)?.c ?? 0;
		return { landing: current, position, radio: this.drainRadio(flight.id), next: this.nextStep(current) };
	}

	async landingStatus(agentId: string, input: { flight?: string }): Promise<LandingView> {
		let flight: Flight;
		try {
			flight = this.ownFlight(agentId, input.flight);
		} catch (err) {
			// The flight may have landed (e.g. after a review approval): report on the latest one.
			const last = this.row("SELECT * FROM flights WHERE agent_id = ? ORDER BY seq DESC LIMIT 1", agentId);
			if (!last) throw err;
			flight = this.toFlight(last);
		}
		const r = this.row("SELECT * FROM landings WHERE flight_id = ? ORDER BY seq DESC LIMIT 1", flight.id);
		if (!r) throw new Error("no landing requested yet");
		const landing = this.toLanding(r);
		return { landing, radio: this.drainRadio(flight.id), next: this.nextStep(landing) };
	}

	private nextStep(l: Landing): string {
		switch (l.status) {
			case "landed":
				return `Landed on trunk as ${l.trunkAfter?.slice(0, 8)}. Your flight is complete — call take_off for the next intent.`;
			case "review":
				return `Merged and green, but it touches ${l.review?.required.join(", ")}, which policy reserves for a human. Hold position: you will get a radio message with the decision (or call landing_status).`;
			case "rejected":
				return `A reviewer requested changes${l.review?.comment ? `: ${l.review.comment}` : ""}. Fix it, push, and request_landing again.`;
			case "conflict":
				return "Conflict with trunk. Run `git pull --no-rebase upstream main`, resolve the conflicting hunks (the report shows who changed them and why), commit, push to origin, then request_landing again.";
			case "failed":
				return l.tests && l.tests.failed > 0
					? "Tests failed on the merged tree. Pull upstream, reproduce, fix, push, then request_landing again."
					: `Landing failed: ${l.error}. Fix it, push, and request_landing again.`;
			default:
				return "Still on approach. Call landing_status in a little while.";
		}
	}

	/** Drains the landing queue in trains. Exactly one train is on the runway at a time. */
	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			for (;;) {
				const queued = this.rows("SELECT * FROM landings WHERE status = 'queued' ORDER BY seq LIMIT ?", TRAIN_SIZE).map((r) => this.toLanding(r));
				if (queued.length === 0) return;
				const project = this.project();
				const jobs: LandingJob[] = [];
				for (const l of queued) {
					const flight = this.flightById(l.flightId);
					const agent = this.agentById(flight.agentId);
					const intent = this.intentById(flight.intentId);
					const contrail = this.rows<{ kind: string; text: string }>(
						"SELECT kind, text FROM contrail WHERE flight_id = ? AND kind IN ('plan', 'decision', 'handoff') ORDER BY id",
						flight.id,
					);
					jobs.push({
						landingId: l.id,
						flightId: flight.id,
						repo: flight.repo,
						review: this.meta<{ review?: string[] }>("policy", {}).review ?? [],
						approved: l.review?.decision === "approved",
						author: { name: agent.callsign, email: `${agent.callsign.toLowerCase()}@agents.contrail.dev` },
						message: [
							`${intent.title} (INT-${intent.seq})`,
							"",
							l.summary,
							"",
							`Contrail-Flight: ${flight.code}`,
							`Contrail-Landing: ${l.id}`,
							`Contrail-Intent: INT-${intent.seq}`,
							`Contrail-Agent: ${agent.callsign}${agent.model ? ` (${agent.model})` : ""}`,
						].join("\n"),
						note: {
							flight: flight.code,
							agent: agent.callsign,
							model: agent.model,
							intent: { seq: intent.seq, title: intent.title, body: intent.body },
							summary: l.summary,
							plan: flight.plan,
							decisions: contrail.filter((c) => c.kind !== "plan").map((c) => c.text),
						},
					});
					this.sql.exec("UPDATE landings SET status = 'merging' WHERE id = ?", l.id);
					this.patch("landing", { ...l, status: "merging" });
				}
				this.emit("runway.train", `Runway: train of ${jobs.length} landing${jobs.length > 1 ? "s" : ""} — ${queued.map((l) => this.flightById(l.flightId).code).join(", ")}`, {
					data: { landings: queued.map((l) => l.id) },
				});

				let result: BatchResult;
				try {
					result = await this.runway().land(project.trunkRepo, jobs);
				} catch (err) {
					for (const l of queued) this.finishLanding(l, { status: "failed", error: `runway error: ${errorMessage(err)}` });
					continue;
				}
				for (const outcome of result.outcomes) {
					const l = queued.find((q) => q.id === outcome.landingId)!;
					this.applyOutcome(l, outcome);
				}
				if (result.outcomes.some((o) => o.status === "landed" && o.changes.some((c) => c.path === CONFIG_FILE))) await this.readTestCommand();
				if (result.trunk) {
					const stats = this.meta<Record<string, number>>("stats", {});
					const state: TrunkState = { head: result.head, files: result.trunk, landedCount: stats.landings ?? 0 };
					this.setMeta("trunk", state);
					this.patch("trunk", state);
				}
			}
		} finally {
			this.processing = false;
		}
	}

	private finishLanding(l: Landing, patch: Partial<Landing>) {
		const landing: Landing = { ...l, ...patch, finishedAt: now() };
		this.sql.exec(
			"UPDATE landings SET status = ?, fork_head = ?, trunk_before = ?, trunk_after = ?, changes = ?, conflicts = ?, tests = ?, error = ?, unioned = ?, review = ?, finished_at = ? WHERE id = ?",
			landing.status,
			landing.forkHead,
			landing.trunkBefore,
			landing.trunkAfter,
			JSON.stringify(landing.changes),
			JSON.stringify(landing.conflicts),
			landing.tests ? JSON.stringify(landing.tests) : null,
			landing.error,
			landing.unioned,
			landing.review ? JSON.stringify(landing.review) : null,
			landing.finishedAt,
			landing.id,
		);
		this.patch("landing", landing);
		for (const resolve of this.waiters.get(landing.id) ?? []) resolve(landing);
		this.waiters.delete(landing.id);
		return landing;
	}

	private applyOutcome(l: Landing, o: LandingOutcome) {
		const flight = this.flightById(l.flightId);
		const agent = this.agentById(flight.agentId);
		const intent = this.intentById(flight.intentId);
		const touched = o.changes.map((c) => c.path);
		this.sql.exec("UPDATE flights SET touched = ? WHERE id = ?", JSON.stringify(touched), flight.id);

		if (o.status === "landed") {
			const landing = this.finishLanding(l, {
				status: "landed",
				forkHead: o.forkHead,
				trunkBefore: o.trunkBefore,
				trunkAfter: o.trunkAfter,
				changes: o.changes,
				tests: o.tests,
				unioned: o.unioned,
			});
			const t = now();
			this.sql.exec("UPDATE flights SET status = 'landed', landed_at = ?, updated_at = ? WHERE id = ?", t, t, flight.id);
			this.sql.exec("UPDATE intents SET status = 'landed', landed_commit = ? WHERE id = ?", o.trunkAfter, intent.id);
			for (const change of o.changes) {
				for (const symbol of change.symbols.length ? change.symbols : ["(top)"]) {
					this.sql.exec(
						"INSERT INTO symbol_history (target, path, landing_id, flight_id, commit_hash, at) VALUES (?, ?, ?, ?, ?, ?)",
						`${change.path}#${symbol}`,
						change.path,
						l.id,
						flight.id,
						o.trunkAfter,
						t,
					);
				}
			}
			this.bump("landings");
			if (o.unioned) this.bump("unioned", o.unioned);
			if (flight.attempts > 1) this.bump("conflictsResolved");
			this.addContrail(
				flight.id,
				null,
				"landing",
				`Landed ${o.trunkAfter?.slice(0, 8)} — ${o.changes.length} file(s), +${o.changes.reduce((s, c) => s + c.additions, 0)}/−${o.changes.reduce((s, c) => s + c.deletions, 0)}${o.tests ? `, ${o.tests.passed} tests green${o.tests.train ? ` (train of ${o.tests.train})` : ""}` : ""}`,
				o.changes.flatMap((c) => c.symbols.map((s) => `${c.path}#${s}`)),
			);
			this.releaseAll(flight.id);
			this.patch("flight", this.flightById(flight.id));
			this.patch("intent", this.intentById(intent.id));
			this.emit(
				"landing.landed",
				`${flight.code} landed INT-${intent.seq} "${intent.title}" as ${o.trunkAfter?.slice(0, 8)}${o.unioned ? ` (auto-merged ${o.unioned} parallel insert${o.unioned > 1 ? "s" : ""})` : ""}`,
				{ flightId: flight.id, agentId: agent.id, data: { landingId: landing.id, commit: o.trunkAfter, changes: o.changes, ms: o.ms } },
			);
			this.notifyTurbulence(flight, agent.callsign, intent, o.changes);
			return;
		}

		if (o.status === "review") {
			const review = { required: o.reviewRequired ?? [], decision: null, reviewer: null, comment: null, at: null };
			this.finishLanding(l, { status: "review", forkHead: o.forkHead, trunkBefore: o.trunkBefore, changes: o.changes, tests: o.tests, unioned: o.unioned, review });
			this.addContrail(flight.id, null, "note", `Green and ready, but policy requires a human review for ${review.required.join(", ")}. Waiting on the tower.`);
			this.sendRadio(flight.id, "review", `Your landing passed merge and tests but touches ${review.required.join(", ")}, which needs a human review. Hold position; you will be told the decision.`);
			this.emit("landing.review", `${flight.code} needs a human review: touches ${review.required.join(", ")}`, { flightId: flight.id, agentId: agent.id, data: { landingId: l.id } });
			this.bump("reviews");
			return;
		}

		if (o.status === "conflict") {
			const conflicts = o.conflicts.map((c) => ({ ...c, causedBy: this.causedBy(flight, c) }));
			this.finishLanding(l, { status: "conflict", forkHead: o.forkHead, trunkBefore: o.trunkBefore, changes: o.changes, conflicts, unioned: o.unioned });
			this.setFlightStatus(flight.id, "diverted");
			const where = conflicts.map((c) => `${c.path}${c.hunks.length ? `#${[...new Set(c.hunks.flatMap((h) => h.symbols))].join(",")}` : ""}`).join("; ");
			const who = [...new Set(conflicts.flatMap((c) => c.causedBy.map((b) => `${b.callsign} (${b.code}: ${b.intent})`)))].join(", ");
			this.addContrail(flight.id, null, "conflict", `Conflict on ${where}${who ? ` with changes landed by ${who}` : ""}`, conflicts.map((c) => c.path));
			this.patch("flight", this.flightById(flight.id));
			this.emit("landing.conflict", `${flight.code} diverted: conflict on ${where}${who ? ` (vs ${who})` : ""}`, {
				flightId: flight.id,
				agentId: agent.id,
				data: { landingId: l.id, conflicts },
			});
			return;
		}

		this.finishLanding(l, { status: "failed", forkHead: o.forkHead, trunkBefore: o.trunkBefore, changes: o.changes, tests: o.tests, error: o.error, unioned: o.unioned });
		this.setFlightStatus(flight.id, "diverted");
		const failing = o.tests?.results.filter((r) => !r.ok).map((r) => `${r.file} › ${r.name}`) ?? [];
		this.addContrail(flight.id, null, "test", `Landing rejected: ${o.error}${failing.length ? `\n${failing.join("\n")}` : ""}`);
		this.patch("flight", this.flightById(flight.id));
		this.emit("landing.failed", `${flight.code} diverted: ${o.error}`, { flightId: flight.id, agentId: agent.id, data: { landingId: l.id, tests: o.tests } });
	}

	/** Which landed flights changed the lines this flight now conflicts with. */
	private causedBy(flight: Flight, c: ConflictReport): ConflictReport["causedBy"] {
		const symbols = [...new Set(c.hunks.flatMap((h) => h.symbols))];
		const rows = this.rows<{ flight_id: string; commit_hash: string; target: string }>(
			"SELECT DISTINCT flight_id, commit_hash, target FROM symbol_history WHERE path = ? AND at >= ? AND flight_id != ? ORDER BY at DESC",
			c.path,
			flight.createdAt,
			flight.id,
		).filter((r) => symbols.length === 0 || symbols.some((s) => r.target === `${c.path}#${s}`));
		const seen = new Set<string>();
		const out: ConflictReport["causedBy"] = [];
		for (const r of rows) {
			if (seen.has(r.flight_id)) continue;
			seen.add(r.flight_id);
			const f = this.flightById(r.flight_id);
			const a = this.agentById(f.agentId);
			const i = this.intentById(f.intentId);
			out.push({ flightId: f.id, code: f.code, callsign: a.callsign, intent: `INT-${i.seq} ${i.title}`, commit: r.commit_hash });
		}
		return out;
	}

	/** Tells in-flight agents when trunk changed code they hold or have touched. */
	private notifyTurbulence(landed: Flight, callsign: string, intent: Intent, changes: FileChange[]) {
		const changedTargets = changes.flatMap((c) => (c.symbols.length ? c.symbols.map((s) => `${c.path}#${s}`) : [c.path]));
		const changedPaths = new Set(changes.map((c) => c.path));
		const active = this.rows(`SELECT * FROM flights WHERE status IN (${ACTIVE.map(() => "?").join(",")}) AND id != ?`, ...ACTIVE, landed.id).map((r) =>
			this.toFlight(r),
		);
		for (const f of active) {
			const held = this.rows<{ target: string }>("SELECT target FROM clearances WHERE flight_id = ?", f.id).map((r) => r.target);
			const hits = changedTargets.filter((t) => held.some((h) => targetsOverlap(h, t)));
			// Symbol-level overlap always matters; a shared file only matters to a flight that already
			// failed to land (it must rebase anyway). Parallel appends to one file are not turbulence.
			const fileHits = f.status === "diverted" ? f.touched.filter((p) => changedPaths.has(p)) : [];
			if (hits.length === 0 && fileHits.length === 0) continue;
			const what = hits.length ? hits.join(", ") : fileHits.join(", ");
			this.sendRadio(
				f.id,
				"turbulence",
				`Trunk moved under you: ${callsign} (${landed.code}) landed INT-${intent.seq} "${intent.title}" touching ${what}. Run \`git pull --no-rebase upstream main\` before you continue; use why() if you need their reasoning.`,
			);
			this.emit("turbulence", `${f.code} alerted: ${landed.code} changed ${what}`, { flightId: f.id, data: { by: landed.id } });
		}
	}

	// ───────────────────────── awareness ─────────────────────────

	/** What an agent needs to see the airspace around it. */
	async radar(agentId: string | null): Promise<Record<string, unknown>> {
		if (agentId) this.touchAgent(agentId);
		const own = agentId ? this.row(`SELECT * FROM flights WHERE agent_id = ? AND status IN (${ACTIVE.map(() => "?").join(",")})`, agentId, ...ACTIVE) : null;
		const flights = this.rows(`SELECT * FROM flights WHERE status IN (${ACTIVE.map(() => "?").join(",")}) ORDER BY seq`, ...ACTIVE).map((r) => this.toFlight(r));
		const clearances = this.activeClearances();
		const trunk = this.meta<TrunkState>("trunk", { head: null, files: [], landedCount: 0 });
		return {
			trunk: { head: trunk.head, files: trunk.files.length },
			you: own ? this.toFlight(own).code : null,
			traffic: flights.map((f) => {
				const a = this.agentById(f.agentId);
				const i = this.intentById(f.intentId);
				return {
					flight: f.code,
					callsign: a.callsign,
					status: f.status,
					intent: `INT-${i.seq} ${i.title}`,
					plan: f.plan?.slice(0, 300) ?? null,
					cleared: clearances.filter((c) => c.flightId === f.id && c.status === "granted").map((c) => c.target),
					holdingFor: clearances.filter((c) => c.flightId === f.id && c.status === "holding").map((c) => c.target),
				};
			}),
			recentLandings: this.rows("SELECT * FROM landings WHERE status = 'landed' ORDER BY seq DESC LIMIT 8").map((r) => {
				const l = this.toLanding(r);
				const f = this.flightById(l.flightId);
				const i = this.intentById(f.intentId);
				return { flight: f.code, intent: `INT-${i.seq} ${i.title}`, commit: l.trunkAfter?.slice(0, 8), changed: l.changes.map((c) => `${c.path}${c.symbols.length ? `#${c.symbols.join(",")}` : ""}`) };
			}),
			openIntents: this.rows("SELECT * FROM intents WHERE status = 'open' ORDER BY priority DESC, seq").map((r) => {
				const i = this.toIntent(r);
				return `INT-${i.seq} ${i.title}`;
			}),
			radio: this.drainRadio(own ? (own.id as string) : null),
		};
	}

	/** The story behind a line or symbol of trunk: which intents changed it, by whom, and why. */
	async why(input: { path: string; line?: number; symbol?: string }): Promise<Record<string, unknown>> {
		const path = normalizeTarget(input.path).split("#")[0];
		const trunk = this.meta<TrunkState>("trunk", { head: null, files: [], landedCount: 0 });
		const file = trunk.files.find((f) => f.path === path);
		let symbol = input.symbol ?? (input.path.includes("#") ? input.path.split("#")[1] : null);
		if (!symbol && input.line && file) {
			const hit = file.symbols.filter((s) => input.line! >= s.start && input.line! <= s.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
			symbol = hit?.name ?? "(top)";
		}
		const rows = this.rows<{ landing_id: string; flight_id: string; target: string; commit_hash: string; at: number }>(
			"SELECT DISTINCT landing_id, flight_id, target, commit_hash, at FROM symbol_history WHERE path = ? ORDER BY at DESC",
			path,
		).filter((r) => !symbol || r.target === `${path}#${symbol}` || r.target.startsWith(`${path}#${symbol}.`) || `${path}#${symbol}`.startsWith(`${r.target}.`));
		const seen = new Set<string>();
		const history = [];
		for (const r of rows) {
			if (seen.has(r.landing_id)) continue;
			seen.add(r.landing_id);
			const f = this.flightById(r.flight_id);
			const a = this.agentById(f.agentId);
			const i = this.intentById(f.intentId);
			const l = this.toLanding(this.row("SELECT * FROM landings WHERE id = ?", r.landing_id)!);
			const notes = this.rows<{ kind: string; text: string }>(
				"SELECT kind, text FROM contrail WHERE flight_id = ? AND kind IN ('plan', 'decision', 'handoff') ORDER BY id",
				f.id,
			);
			history.push({
				commit: r.commit_hash.slice(0, 8),
				when: new Date(r.at).toISOString(),
				flight: f.code,
				agent: a.callsign,
				model: a.model,
				intent: `INT-${i.seq} ${i.title}`,
				intentBody: i.body.slice(0, 600),
				summary: l.summary,
				plan: notes.filter((n) => n.kind === "plan").map((n) => n.text).pop() ?? null,
				decisions: notes.filter((n) => n.kind !== "plan").map((n) => n.text),
			});
			if (history.length >= 6) break;
		}
		return {
			target: symbol ? `${path}#${symbol}` : path,
			history,
			note: history.length ? undefined : "No landed flight has touched this yet — it predates Contrail or was part of the initial import.",
		};
	}

	async flightDetail(ref: string): Promise<Record<string, unknown>> {
		const r = this.row("SELECT * FROM flights WHERE id = ? OR code = ?", ref, ref.toUpperCase());
		if (!r) throw new Error(`no flight ${ref}`);
		const flight = this.toFlight(r);
		return {
			flight,
			agent: this.agentById(flight.agentId),
			intent: this.intentById(flight.intentId),
			clearances: this.rows("SELECT * FROM clearances WHERE flight_id = ?", flight.id).map((c) => this.toClearance(c)),
			contrail: this.rows("SELECT * FROM contrail WHERE flight_id = ? ORDER BY id", flight.id).map((c) => ({
				id: c.id,
				flightId: c.flight_id,
				agentId: c.agent_id,
				kind: c.kind,
				text: c.text,
				refs: json(c.refs as string, []),
				at: c.at,
			})),
			landings: this.rows("SELECT * FROM landings WHERE flight_id = ? ORDER BY seq", flight.id).map((l) => this.toLanding(l)),
		};
	}

	async snapshot(): Promise<RadarSnapshot> {
		const project = this.project();
		const stats = this.meta<Record<string, number>>("stats", {});
		return {
			project,
			agents: this.rows("SELECT * FROM agents ORDER BY n").map((r) => this.toAgent(r)),
			intents: this.rows("SELECT * FROM intents ORDER BY seq").map((r) => this.toIntent(r)),
			flights: this.rows("SELECT * FROM flights ORDER BY seq").map((r) => this.toFlight(r)),
			clearances: this.activeClearances(),
			landings: this.rows("SELECT * FROM landings ORDER BY seq DESC LIMIT 200").map((r) => this.toLanding(r)),
			trunk: this.meta<TrunkState>("trunk", { head: null, files: [], landedCount: 0 }),
			events: this.rows("SELECT * FROM events ORDER BY seq DESC LIMIT 200")
				.map((r) => ({
					seq: r.seq as number,
					at: r.at as number,
					type: r.type as string,
					flightId: (r.flight_id as string) ?? undefined,
					agentId: (r.agent_id as string) ?? undefined,
					text: r.text as string,
					data: json(r.data as string, undefined),
				}))
				.reverse(),
			stats: {
				repos: stats.repos ?? 0,
				landings: stats.landings ?? 0,
				conflictsPrevented: stats.conflictsPrevented ?? 0,
				conflictsResolved: stats.conflictsResolved ?? 0,
				unioned: stats.unioned ?? 0,
			},
		};
	}

	async eventLog(input: { type?: string; limit?: number }): Promise<RadarEvent[]> {
		const limit = Math.min(1000, input.limit ?? 200);
		const rows = input.type
			? this.rows("SELECT * FROM events WHERE type = ? ORDER BY seq DESC LIMIT ?", input.type, limit)
			: this.rows("SELECT * FROM events ORDER BY seq DESC LIMIT ?", limit);
		return rows.map((r) => ({
			seq: r.seq as number,
			at: r.at as number,
			type: r.type as string,
			flightId: (r.flight_id as string) ?? undefined,
			agentId: (r.agent_id as string) ?? undefined,
			text: r.text as string,
			data: json(r.data as string, undefined),
		}));
	}

	async contrailFor(flightId: string): Promise<ContrailEntry[]> {
		return this.rows("SELECT * FROM contrail WHERE flight_id = ? ORDER BY id", flightId).map((c) => ({
			id: c.id as number,
			flightId: c.flight_id as string,
			agentId: (c.agent_id as string) ?? null,
			kind: c.kind as ContrailKind,
			text: c.text as string,
			refs: json(c.refs as string, []),
			at: c.at as number,
		}));
	}

	async trunkFiles(): Promise<TrunkFile[]> {
		return this.meta<TrunkState>("trunk", { head: null, files: [], landedCount: 0 }).files;
	}

	async resync(): Promise<TrunkState> {
		return this.refreshTrunk();
	}

	// ───────────────────────── review by exception ─────────────────────────

	async setPolicy(policy: { review?: string[] }): Promise<{ review: string[] }> {
		const review = (policy.review ?? []).map(normalizeTarget).filter(Boolean).slice(0, 100);
		this.setMeta("policy", { review });
		this.emit("policy.updated", review.length ? `Human review required for: ${review.join(", ")}` : "No human review required: every green landing lands");
		return { review };
	}

	async policy(): Promise<{ review: string[] }> {
		return { review: this.meta<{ review?: string[] }>("policy", {}).review ?? [] };
	}

	async reviewLanding(input: { landingId: string; decision: "approve" | "reject"; comment?: string; reviewer?: string }): Promise<Landing> {
		const r = this.row("SELECT * FROM landings WHERE id = ?", input.landingId);
		if (!r) throw new Error("no such landing");
		const l = this.toLanding(r);
		if (l.status !== "review") throw new Error(`landing is ${l.status}, not awaiting review`);
		const flight = this.flightById(l.flightId);
		const reviewer = (input.reviewer ?? "operator").slice(0, 40);
		const comment = input.comment?.slice(0, 2000) ?? null;
		if (input.decision === "approve") {
			const review = { ...(l.review ?? { required: [] }), decision: "approved" as const, reviewer, comment, at: now() };
			this.sql.exec("UPDATE landings SET status = 'queued', review = ? WHERE id = ?", JSON.stringify(review), l.id);
			this.patch("landing", { ...l, status: "queued", review });
			this.addContrail(flight.id, null, "decision", `Approved by ${reviewer}${comment ? `: ${comment}` : ""}`);
			this.emit("review.approved", `${reviewer} approved ${flight.code}${comment ? ` — ${comment}` : ""}`, { flightId: flight.id });
			this.ctx.waitUntil(this.processQueue());
			return { ...l, status: "queued", review };
		}
		const review = { ...(l.review ?? { required: [] }), decision: "rejected" as const, reviewer, comment, at: now() };
		const landing = this.finishLanding(l, { status: "rejected", review });
		this.setFlightStatus(flight.id, "diverted");
		this.patch("flight", this.flightById(flight.id));
		this.sendRadio(flight.id, "review", `${reviewer} requested changes: ${comment ?? "(no comment)"}. Fix, push, and request_landing again.`);
		this.addContrail(flight.id, null, "decision", `Changes requested by ${reviewer}: ${comment ?? ""}`);
		this.emit("review.rejected", `${reviewer} sent ${flight.code} back${comment ? ` — ${comment}` : ""}`, { flightId: flight.id });
		return landing;
	}

	// ───────────────────────── edge agents ─────────────────────────

	async launchEdge(input: { count: number; model?: string; maxFlights?: number; limit?: number; mode?: "llm" | "scripted" }): Promise<{ launched: Agent[] }> {
		const fleet = this.meta<string[]>("edgeFleet", []);
		const statuses = await Promise.all(fleet.map((id) => this.edgeStub(id).status().catch(() => null)));
		const flying = statuses.filter((s) => s && s.phase !== "done" && s.phase !== "stopped").length;
		const room = Math.max(0, (input.limit ?? 50) - flying);
		const count = Math.min(Math.max(1, input.count), room);
		const launched: Agent[] = [];
		for (let i = 0; i < count; i++) {
			const scripted = input.mode === "scripted";
			const model = input.model ?? "@cf/zai-org/glm-5.3-flash";
			const { agent } = await this.join({ kind: "edge", model: scripted ? "scripted" : model.replace(/^@cf\//, "") });
			await this.edgeStub(agent.id).start({
				slug: this.project().slug,
				agentId: agent.id,
				callsign: agent.callsign,
				model,
				maxFlights: input.maxFlights ?? 6,
				mode: scripted ? "scripted" : "llm",
			});
			fleet.push(agent.id);
			launched.push(agent);
		}
		this.setMeta("edgeFleet", fleet);
		if (launched.length)
			this.emit(
				"edge.launched",
				input.mode === "scripted"
					? `Launched ${launched.length} scripted load-test agents (Durable Objects, no LLM)`
					: `Launched ${launched.length} edge agent${launched.length > 1 ? "s" : ""} on Workers AI: ${launched.map((a) => a.callsign).join(", ")}`,
			);
		return { launched };
	}

	/** Playground rules for launches by anonymous visitors: a few LLM agents at a time, rate limited. */
	async launchEdgePublic(input: { count: number }): Promise<{ launched: Agent[] } | { error: string }> {
		const project = this.project();
		if (!project.playground) return { error: "launching agents here needs the admin key" };
		const last = this.meta<number>("lastPublicLaunch", 0);
		if (now() - last < 90_000) return { error: `the tower is busy: try again in ${Math.ceil((90_000 - (now() - last)) / 1000)}s` };
		if (!this.row("SELECT id FROM intents WHERE status = 'open' LIMIT 1")) return { error: "no open intents left in this airspace" };
		this.setMeta("lastPublicLaunch", now());
		return this.launchEdge({ count: Math.min(4, Math.max(1, input.count)), maxFlights: 3, limit: 6 });
	}

	/** Deletes the project: stops its agents and removes its trunk and every workspace repo from Artifacts. */
	async destroy(): Promise<{ repos: number }> {
		const project = this.meta<ProjectInfo | null>("project", null);
		await this.stopEdge().catch(() => {});
		let repos = 0;
		if (project) {
			const names = [project.trunkRepo, ...this.rows<{ repo: string }>("SELECT repo FROM flights").map((r) => r.repo)];
			for (let i = 0; i < names.length; i += 10) {
				const batch = await Promise.all(names.slice(i, i + 10).map((name) => this.env.ARTIFACTS.delete(name).catch(() => false)));
				repos += batch.filter(Boolean).length;
			}
		}
		for (const ws of this.ctx.getWebSockets()) ws.close(1001, "project deleted");
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		// This instance may live on: a project created again under the same slug starts from empty tables.
		this.migrate();
		return { repos };
	}

	async stopEdge(): Promise<{ stopped: number }> {
		const fleet = this.meta<string[]>("edgeFleet", []);
		await Promise.all(fleet.map((id) => this.edgeStub(id).stop().catch(() => {})));
		this.emit("edge.stopped", `Stopped ${fleet.length} edge agent(s)`);
		return { stopped: fleet.length };
	}

	async edgeStatus() {
		const fleet = this.meta<string[]>("edgeFleet", []);
		return Promise.all(fleet.map(async (id) => ({ agentId: id, ...(await this.edgeStub(id).status().catch((e) => ({ error: errorMessage(e) }))) })));
	}

	private edgeStub(agentId: string) {
		return this.env.EDGE.get(this.env.EDGE.idFromName(`${this.project().slug}:${agentId}`));
	}

	// ───────────────────────── live connections ─────────────────────────

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		pair[1].send(JSON.stringify({ kind: "snapshot", snapshot: await this.snapshot() }));
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (message === "ping") ws.send("pong");
	}

	async webSocketClose(ws: WebSocket, code: number) {
		try {
			ws.close(code, "bye");
		} catch {
			// already closed
		}
	}

	// ───────────────────────── maintenance ─────────────────────────

	async alarm() {
		this.sql.exec("DELETE FROM clearances WHERE expires_at <= ?", now());
		this.promoteHolds();
		this.patch("clearances", this.activeClearances());
		await this.ctx.storage.setAlarm(now() + 60_000);
		if (this.row("SELECT id FROM landings WHERE status = 'queued' LIMIT 1")) await this.processQueue();
	}

	async ensureAlarm() {
		if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(now() + 60_000);
	}
}
