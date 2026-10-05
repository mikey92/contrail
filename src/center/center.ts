// Center: one per sectored monorepo (a single Durable Object per center slug).
//
// A big codebase can be split into sectors, each a full airspace (Tower, Runway and its own trunk repo
// in Artifacts) that owns one directory prefix. Sectors land independently and in parallel. The Center
// keeps the monorepo's own trunk: whenever sectors move, it fetches their latest trunks and commits one
// composed tree. Prefixes are disjoint, so composing never conflicts and never needs tests of its own.
//
// The Center also flies crossings: changes that span several sectors. A crossing works in a fork of the
// monorepo trunk and flies one leg in each sector it touches, a flight there with clearances and a
// contrail. Its landing is a two-phase commit: each sector's runway merges and tests its part and holds
// it; only when every sector is ready do all parts land, and the monorepo trunk gets one commit.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import {
	cloneMain,
	commit,
	commitTreeOid,
	fetchFork,
	fetchMain,
	fetchUnrelated,
	listTree,
	mergeBase,
	newRepo,
	type Repo,
	pushMain,
	pushTo,
	seed,
	setMain,
	writeFlatTree,
} from "../runway/gitops";
import type { AgentKind, CenterAgent, CenterInfo, CenterIntent, CenterSnapshot, ContrailKind, Crossing, CrossingLeg, CrossingStatus, Landing, SectorInfo } from "../shared/types";
import { conventionalTestCommand, CROSSING_PROTOCOL, workspaceInstructions } from "../tower/briefing";
import { normalizeTarget } from "../tower/clearance";
import type { HoldInfo, RadioMessage, Workspace } from "../tower/tower";
import { callsignFor, cloneUrl, errorMessage, now, randomId, randomToken, repoSafe, sha256, sleep } from "../util";
import { checkPrefixes, composeTree, ownerOf, type PathChange, sectorChanges } from "./compose";
import { sectorPart } from "./crossing";

/** How long the Center waits after a sector moves, so a burst of landings becomes one composition. */
const COALESCE_MS = 1000;
const MAX_REPO_BYTES = 64 * 1024 * 1024;
const TOKEN_SECONDS = 600;
const AUTHOR = { name: "Contrail Center", email: "center@contrail.dev" };
/** How long a sector's runway holds a crossing's part, merged and green, for the crossing's other sectors. */
const HOLD_MS = 60_000;
/** How long the Center waits for a sector to prepare its part before the crossing is given up. */
const PREPARE_MS = 90_000;
const WORKSPACE_TOKEN_TTL_S = 6 * 3600;
/** A crossing's workspace fork is kept this long after it lands or aborts, for inspection. */
const FORK_RETENTION_MS = 60 * 60_000;
const ACTIVE: CrossingStatus[] = ["airborne", "approach", "diverted"];

/** An agent of this Center, with the agent it flies its legs as in each sector. */
interface AgentRecord extends CenterAgent {
	legs: Record<string, string>;
	/** Its latest crossing. */
	crossing: string | null;
}

/** What a crossing's change does to one sector. */
interface Part {
	sector: SectorInfo;
	changes: PathChange[];
	/** The sector-history commit pushed to the leg's workspace; null when the sector already has the change. */
	commit: string | null;
}

const pad = (n: number) => String(n).padStart(6, "0");
const AGENT = (id: string) => `agent:${id}`;
const KEY = (hash: string) => `key:${hash}`;
const INTENT = (seq: number) => `intent:${pad(seq)}`;
const CROSSING = (seq: number) => `crossing:${pad(seq)}`;

const publicAgent = ({ legs: _legs, crossing: _crossing, ...agent }: AgentRecord): CenterAgent => agent;
const agentEmail = (callsign: string) => `${callsign.toLowerCase()}@agents.contrail.dev`;
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
	Promise.race([p, sleep(ms).then((): never => { throw new Error(`${what} did not answer within ${ms / 1000} s`); })]);

function legLanding(l: Landing): NonNullable<CrossingLeg["landing"]> {
	return { status: l.status, commit: l.trunkAfter, error: l.error, tests: l.tests && { passed: l.tests.passed, failed: l.tests.failed }, conflicts: l.conflicts, changes: l.changes.length };
}

/** Why a sector turned its part away, in a few words. */
function turnedAway(l: Landing): string {
	if (l.status === "conflict") return `conflict on ${l.conflicts.map((c) => c.path).join(", ")}`;
	const failing = l.tests?.results.filter((r) => !r.ok).slice(0, 3).map((r) => `${r.file} › ${r.name}`) ?? [];
	if (l.tests && l.tests.failed > 0) return `${l.tests.failed} test(s) failed${failing.length ? ` (${failing.join("; ")})` : ""}`;
	return l.error ?? l.status;
}

function composeMessage(moved: { name: string; head: string }[]): string {
	return [`Compose ${moved.map((m) => m.name).join(", ")}`, "", ...moved.map((m) => `Contrail-Sector: ${m.name} ${m.head.slice(0, 12)}`)].join("\n");
}

export class Center extends DurableObject<Env> {
	private repo: Repo | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private landingQueue: Promise<unknown> = Promise.resolve();
	private crossingQueues = new Map<string, Promise<unknown>>();
	/** Remote URLs and tokens per repo and scope, reused for most of each token's life. */
	private access = new Map<string, { remote: string; token: string; until: number }>();
	/** Sectors a crossing is landing in: their compositions wait for the crossing's own commit. */
	private holding = new Set<string>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			// A restart interrupted a crossing's landing. Its sectors let their held parts go on their own.
			const code = await ctx.storage.get<string>("landing");
			if (!code) return;
			await ctx.storage.delete("landing");
			const cx = await this.crossingByCode(code);
			if (cx?.landing?.status === "landing") {
				cx.landing = { ...cx.landing, status: "failed", finishedAt: now(), error: "interrupted by a restart: request_landing again" };
				cx.status = "diverted";
				await this.saveCrossing(cx);
			}
			await this.scheduleAlarm();
		});
	}

	/** Serializes all git work on the in-memory clone. */
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	/** One crossing lands at a time: two crossings each holding a runway the other one needs would wait on each other. */
	private oneLanding<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.landingQueue.then(fn, fn);
		this.landingQueue = run.catch(() => {});
		return run;
	}

	/** A crossing's own calls run one at a time (its legs are opened once). */
	private serial<T>(code: string, fn: () => Promise<T>): Promise<T> {
		const run = (this.crossingQueues.get(code) ?? Promise.resolve()).then(fn, fn);
		const tail = run.catch(() => {});
		this.crossingQueues.set(code, tail);
		tail.then(() => this.crossingQueues.get(code) === tail && this.crossingQueues.delete(code));
		return run;
	}

	private async info(): Promise<CenterInfo> {
		const info = await this.ctx.storage.get<CenterInfo>("center");
		if (!info) throw new Error("center is not set up");
		return info;
	}

	private tower(slug: string) {
		return this.env.TOWER.get(this.env.TOWER.idFromName(slug));
	}

	/** Creates the monorepo trunk from the full file set; the sectors were created from their slices of it. */
	async setup(input: { slug: string; name: string; description: string; public: boolean; sectors: SectorInfo[]; files: Record<string, string> }): Promise<CenterInfo> {
		const existing = await this.ctx.storage.get<CenterInfo>("center");
		if (existing) return existing;
		const problem = checkPrefixes(input.sectors.map((s) => s.prefix));
		if (problem) throw new Error(problem);
		const trunkRepo = repoSafe(`${input.slug}--monorepo`);
		const A = this.env.ARTIFACTS;
		const exists = await A.get(trunkRepo)
			.then((r) => (r[Symbol.dispose]?.(), true))
			.catch(() => false);
		if (!exists) await A.create(trunkRepo, { setDefaultBranch: "main", description: `${input.name} monorepo (composed from ${input.sectors.length} sectors)` });
		const repo = await A.get(trunkRepo);
		try {
			const log = await repo.log({ ref: "main", limit: 1 });
			if (log.length === 0) {
				const [info, t] = await Promise.all([repo.info(), repo.createToken("write", 600)]);
				await seed(info.remote, t.plaintext, input.files, `Create ${input.name}`, AUTHOR);
			}
		} finally {
			repo[Symbol.dispose]?.();
		}
		const info: CenterInfo = { slug: input.slug, name: input.name, description: input.description, trunkRepo, sectors: input.sectors, createdAt: Date.now(), public: input.public };
		await this.ctx.storage.put("center", info);
		return info;
	}

	/** A sector's trunk moved. Compositions are coalesced: a burst of landings becomes one commit. */
	async sectorMoved(slug: string): Promise<void> {
		const dirty = new Set((await this.ctx.storage.get<string[]>("dirty")) ?? []);
		dirty.add(slug);
		await this.ctx.storage.put("dirty", [...dirty]);
		await this.scheduleAlarm();
	}

	/** The alarm composes sectors that moved and retires old crossing workspaces, whichever is due first. */
	private async scheduleAlarm() {
		const dirty = ((await this.ctx.storage.get<string[]>("dirty")) ?? []).filter((slug) => !this.holding.has(slug));
		const retiring = (await this.ctx.storage.get<{ due: number }[]>("retiring")) ?? [];
		const next = Math.min(dirty.length ? Date.now() + COALESCE_MS : Infinity, ...retiring.map((r) => r.due));
		if (next === Infinity) return;
		const current = await this.ctx.storage.getAlarm();
		if (!current || current > next) await this.ctx.storage.setAlarm(next);
	}

	async alarm() {
		// A center that was deleted (or never set up) has nothing to compose.
		if (!(await this.ctx.storage.get<CenterInfo>("center"))) {
			await this.ctx.storage.deleteAll();
			return;
		}
		try {
			await this.compose();
		} catch (err) {
			await this.ctx.storage.put("lastError", errorMessage(err));
			await this.ctx.storage.setAlarm(Date.now() + 5000);
			return;
		}
		await this.retireForks();
		// Sectors that moved while we were composing get the next commit.
		await this.scheduleAlarm();
	}

	/** Brings the monorepo trunk up to date with every sector that moved. */
	async compose(): Promise<string | null> {
		return this.exclusive(async () => {
			const info = await this.info();
			const all = (await this.ctx.storage.get<string[]>("dirty")) ?? [];
			// Sectors a crossing is landing in wait: the crossing composes them in a commit of its own.
			const dirty = all.filter((slug) => !this.holding.has(slug));
			if (!dirty.length) return null;
			await this.ctx.storage.put("dirty", all.filter((slug) => this.holding.has(slug)));
			const heads = (await this.ctx.storage.get<Record<string, string>>("heads")) ?? {};
			try {
				const { head, token } = await this.sync(info.trunkRepo);
				const r = this.repo!;
				const due = info.sectors.filter((s) => dirty.includes(s.slug));
				const sectorHeads = await this.fetchSectors(due);
				const moved: { name: string; prefix: string; head: string }[] = [];
				for (const [i, sector] of due.entries()) {
					if (heads[sector.slug] === sectorHeads[i]) continue;
					moved.push({ name: sector.name, prefix: sector.prefix, head: sectorHeads[i] });
				}
				if (!moved.length) return head;
				const composed = await this.composeAt(head, moved, composeMessage(moved), AUTHOR);
				if (composed === head) return head;
				await this.publish(composed, token);
				for (const m of moved) heads[info.sectors.find((s) => s.prefix === m.prefix)!.slug] = m.head;
				await this.ctx.storage.put({ heads, head: composed, composedAt: Date.now(), compositions: ((await this.ctx.storage.get<number>("compositions")) ?? 0) + 1, lastError: null });
				return composed;
			} catch (err) {
				this.access.clear(); // a token may have been revoked
				// Put the sectors back so the next attempt picks them up.
				const now = new Set([...((await this.ctx.storage.get<string[]>("dirty")) ?? []), ...dirty]);
				await this.ctx.storage.put("dirty", [...now]);
				throw err;
			}
		});
	}

	/** A commit on `head` with each moved sector's subtree replaced by its tree at `m.head` (or `head` if nothing changes). */
	private async composeAt(head: string, moved: { prefix: string; head: string }[], message: string, author: { name: string; email: string }): Promise<string> {
		const r = this.repo!;
		const trees = await Promise.all(moved.map(async (m) => ({ prefix: m.prefix, tree: await listTree(r, m.head) })));
		const tree = await writeFlatTree(r, composeTree(await listTree(r, head), trees));
		if (tree === (await commitTreeOid(r, head))) return head;
		return commit(r, { tree, parents: [head], message, author, committer: AUTHOR });
	}

	/** Pushes the clone's new main to the monorepo trunk. */
	private async publish(head: string, token: string) {
		const r = this.repo!;
		await setMain(r, head);
		try {
			await pushMain(r, token);
		} catch (err) {
			this.repo = null; // someone else moved the monorepo trunk: start from a fresh clone next time
			throw err;
		}
	}

	/** Fetches sector trunks into the clone; returns their heads. */
	private async fetchSectors(sectors: SectorInfo[]): Promise<string[]> {
		const sources = await Promise.all(sectors.map(async (s) => ({ name: `sector-${s.slug}`, ...(await this.repoAccess(s.trunkRepo, "read")) })));
		return fetchUnrelated(this.repo!, sources.map((s) => ({ name: s.name, url: s.remote, token: s.token })));
	}

	private async repoAccess(name: string, scope: "read" | "write"): Promise<{ remote: string; token: string }> {
		const key = `${scope} ${name}`;
		const known = this.access.get(key);
		if (known && known.until > Date.now()) return known;
		const repo = await this.env.ARTIFACTS.get(name);
		try {
			const [info, t] = await Promise.all([repo.info(), repo.createToken(scope, TOKEN_SECONDS)]);
			const access = { remote: info.remote, token: t.plaintext, until: Date.now() + (TOKEN_SECONDS - 60) * 1000 };
			this.access.set(key, access);
			return access;
		} finally {
			repo[Symbol.dispose]?.();
		}
	}

	/** A warm clone of the monorepo trunk and a write token for it. */
	private async sync(trunkRepo: string): Promise<{ head: string; token: string }> {
		const { remote, token } = await this.repoAccess(trunkRepo, "write");
		if (this.repo && this.repo.fs.byteSize < MAX_REPO_BYTES) {
			const head = await fetchMain(this.repo, token);
			await setMain(this.repo, head);
			return { head, token };
		}
		this.repo = newRepo();
		return { head: await cloneMain(this.repo, remote, token), token };
	}

	// ───────────────────────── crossings: agents and intents ─────────────────────────

	async join(input: { callsign?: string; kind?: AgentKind; model?: string }): Promise<{ agent: CenterAgent; key: string }> {
		await this.info();
		const n = await this.next("seq:agent");
		const kind: AgentKind = input.kind ?? "other";
		const callsign = (input.callsign ?? "").trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 20) || callsignFor(kind, n);
		const key = randomToken("ct");
		const agent: AgentRecord = { id: randomId(), callsign, kind, model: input.model?.slice(0, 60) ?? null, joinedAt: now(), lastSeenAt: now(), legs: {}, crossing: null };
		await this.ctx.storage.put<unknown>({ [AGENT(agent.id)]: agent, [KEY(await sha256(key))]: agent.id });
		return { agent: publicAgent(agent), key };
	}

	async authenticate(key: string): Promise<CenterAgent | null> {
		const id = await this.ctx.storage.get<string>(KEY(await sha256(key)));
		const agent = id ? await this.ctx.storage.get<AgentRecord>(AGENT(id)) : undefined;
		return agent ? publicAgent(agent) : null;
	}

	async addIntents(list: { title: string; body?: string }[], createdBy = "operator"): Promise<CenterIntent[]> {
		await this.info();
		const created: CenterIntent[] = [];
		for (const item of list.slice(0, 100)) {
			const title = String(item.title ?? "").trim().slice(0, 200);
			if (!title) throw new Error("an intent needs a title");
			const intent: CenterIntent = { seq: await this.next("seq:intent"), title, body: String(item.body ?? "").slice(0, 8000), status: "open", crossing: null, createdBy, createdAt: now(), landedCommit: null };
			await this.ctx.storage.put(INTENT(intent.seq), intent);
			created.push(intent);
		}
		return created;
	}

	private async next(counter: string): Promise<number> {
		const n = ((await this.ctx.storage.get<number>(counter)) ?? 0) + 1;
		await this.ctx.storage.put(counter, n);
		return n;
	}

	private async agentRecord(id: string): Promise<AgentRecord> {
		const agent = await this.ctx.storage.get<AgentRecord>(AGENT(id));
		if (!agent) throw new Error(`unknown agent ${id}`);
		return agent;
	}

	private async crossingByCode(code: string): Promise<Crossing | null> {
		const m = /^CX-(\d+)$/i.exec(code.trim());
		return m ? ((await this.ctx.storage.get<Crossing>(CROSSING(Number(m[1])))) ?? null) : null;
	}

	private async saveCrossing(cx: Crossing) {
		cx.updatedAt = now();
		await this.ctx.storage.put(CROSSING(cx.seq), cx);
	}

	/** The agent and the crossing it is flying. */
	private async ownCrossing(agentId: string): Promise<{ agent: AgentRecord; cx: Crossing }> {
		const agent = await this.agentRecord(agentId);
		const cx = agent.crossing ? await this.crossingByCode(agent.crossing) : null;
		if (!cx || !ACTIVE.includes(cx.status)) throw new Error("you have no crossing in the air — call take_off first");
		agent.lastSeenAt = now();
		await this.ctx.storage.put(AGENT(agent.id), agent);
		return { agent, cx };
	}

	/** Runs `fn` on the agent's crossing with its latest state, one call of that crossing at a time. */
	private async withCrossing<T>(agentId: string, fn: (agent: AgentRecord, cx: Crossing) => Promise<T>): Promise<T> {
		const { cx } = await this.ownCrossing(agentId);
		return this.serial(cx.code, async () => {
			const current = await this.ownCrossing(agentId);
			return fn(current.agent, current.cx);
		});
	}

	private async openIntents(): Promise<CenterIntent[]> {
		return [...(await this.ctx.storage.list<CenterIntent>({ prefix: "intent:" })).values()].filter((i) => i.status === "open");
	}

	// ───────────────────────── crossings: flying ─────────────────────────

	async takeOff(agentId: string, opts: { intent?: string | number | null } = {}) {
		const info = await this.info();
		const agent = await this.agentRecord(agentId);
		const flying = agent.crossing ? await this.crossingByCode(agent.crossing) : null;
		if (flying && ACTIVE.includes(flying.status)) throw new Error(`you are already flying ${flying.code} (${flying.status}); land it or call abort before taking off again`);
		let intent: CenterIntent | undefined;
		if (opts.intent !== undefined && opts.intent !== null && opts.intent !== "") {
			const seq = Number(String(opts.intent).replace(/^INT-/i, ""));
			intent = Number.isInteger(seq) ? await this.ctx.storage.get<CenterIntent>(INTENT(seq)) : undefined;
			if (!intent) throw new Error(`no intent ${opts.intent}`);
			if (intent.status !== "open") throw new Error(`INT-${intent.seq} is ${intent.status}`);
		} else intent = (await this.openIntents())[0];
		if (!intent) return { idle: true as const, message: "No open crossings. Nothing to do — you may stop.", radio: [] as RadioMessage[] };

		const seq = await this.next("seq:crossing");
		const code = `CX-${String(seq).padStart(3, "0")}`;
		const t = now();
		const cx: Crossing = {
			code,
			seq,
			agentId,
			callsign: agent.callsign,
			model: agent.model,
			intent: { seq: intent.seq, title: intent.title, body: intent.body },
			status: "airborne",
			repo: "",
			base: "",
			plan: null,
			contrail: [],
			legs: [],
			attempts: 0,
			landing: null,
			createdAt: t,
			updatedAt: t,
			landedAt: null,
			retiredAt: null,
		};
		// Recorded before the first await on the network, so a second take-off sees this one.
		intent.status = "assigned";
		intent.crossing = code;
		agent.crossing = code;
		agent.lastSeenAt = t;
		await this.ctx.storage.put<unknown>({ [INTENT(intent.seq)]: intent, [AGENT(agent.id)]: agent, [CROSSING(seq)]: cx });
		try {
			cx.repo = await this.forkTrunk(info, code, `${code} · ${agent.callsign} · ${intent.title}`);
			const [workspace, upstream, testCommand] = await Promise.all([this.mintWorkspace(cx.repo, "write"), this.mintWorkspace(info.trunkRepo, "read"), this.testCommand(info.trunkRepo)]);
			const fork = await this.env.ARTIFACTS.get(cx.repo);
			cx.base = (await fork.log({ ref: "main", limit: 1 }).finally(() => fork[Symbol.dispose]?.()))[0]?.hash ?? "";
			await this.saveCrossing(cx);
			return {
				crossing: cx,
				intent,
				sectors: info.sectors.map((s) => ({ name: s.name, prefix: s.prefix })),
				workspace,
				upstream,
				setup: workspaceInstructions({ cloneUrl: workspace.cloneUrl, upstreamUrl: upstream.cloneUrl, dir: code.toLowerCase(), flightCode: code, callsign: agent.callsign, testCommand: testCommand ?? undefined }),
				briefing: CROSSING_PROTOCOL,
				radio: [] as RadioMessage[],
			};
		} catch (err) {
			cx.status = "aborted";
			if (cx.repo) await this.retireLater(cx);
			await this.saveCrossing(cx);
			intent.status = "open";
			intent.crossing = null;
			await this.ctx.storage.put(INTENT(intent.seq), intent);
			throw err;
		}
	}

	/** How the monorepo runs its tests (`npm test`, a test/run.mjs runner), told to crossing agents at take-off. */
	private async testCommand(trunkRepo: string): Promise<string | null> {
		const repo = await this.env.ARTIFACTS.get(trunkRepo);
		try {
			return await conventionalTestCommand(async (path) => {
				const blob = await repo.readFile({ ref: "main", path }).catch(() => null);
				return blob ? new Response(blob).text() : null;
			});
		} catch {
			return null;
		} finally {
			repo[Symbol.dispose]?.();
		}
	}

	/** Forks the monorepo trunk as a crossing's workspace. Artifacts runs one fork of a repo at a time: wait for our turn. */
	private async forkTrunk(info: CenterInfo, code: string, description: string): Promise<string> {
		const name = () => repoSafe(`${info.slug}--${code.toLowerCase()}-${randomId(4)}`);
		let repo = name();
		for (let attempt = 0; ; attempt++) {
			const trunk = await this.env.ARTIFACTS.get(info.trunkRepo);
			try {
				await trunk.fork(repo, { defaultBranchOnly: true, description: description.slice(0, 200) });
				return repo;
			} catch (err) {
				const code = (err as { code?: string }).code ?? "";
				// A fork that failed with a transient error can leave its repo behind: start over under a fresh name.
				if (attempt > 0 && /already exists/i.test(errorMessage(err))) {
					const stale = repo;
					repo = name();
					this.ctx.waitUntil(this.env.ARTIFACTS.delete(stale).catch(() => false));
					continue;
				}
				const transient = code === "FORK_IN_PROGRESS" || code === "INTERNAL_ERROR" || code === "UPSTREAM_UNAVAILABLE" || /internal error/i.test(errorMessage(err));
				if (!transient || attempt >= 40) throw err;
				await sleep(300 + Math.random() * 700 + attempt * 100);
			} finally {
				trunk[Symbol.dispose]?.();
			}
		}
	}

	private async mintWorkspace(repoName: string, scope: "read" | "write"): Promise<Workspace> {
		for (let i = 0; ; i++) {
			try {
				const repo = await this.env.ARTIFACTS.get(repoName);
				try {
					const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, WORKSPACE_TOKEN_TTL_S)]);
					return { repo: repoName, remote: info.remote, cloneUrl: cloneUrl(info.remote, token.plaintext), expiresAt: token.expiresAt };
				} finally {
					repo[Symbol.dispose]?.();
				}
			} catch (err) {
				const code = (err as { code?: string }).code;
				// A fresh fork takes a moment to become ready.
				if (i >= 60 || (code !== "FORK_IN_PROGRESS" && code !== "CREATE_IN_PROGRESS" && code !== "NOT_FOUND" && code !== "INTERNAL_ERROR")) throw err;
				await sleep(250);
			}
		}
	}

	/** The crossing's leg in `sector`: a flight there under the crossing's agent, opened the first time it is needed. */
	private async leg(info: CenterInfo, agent: AgentRecord, cx: Crossing, sector: SectorInfo): Promise<CrossingLeg> {
		const open = cx.legs.find((l) => l.sector === sector.slug);
		if (open) return open;
		const tower = this.tower(sector.slug);
		const { agentId, flight } = await tower.openLeg({
			crossing: cx.code,
			agentId: agent.legs[sector.slug] ?? null,
			callsign: agent.callsign,
			kind: agent.kind,
			model: agent.model,
			title: cx.intent.title,
			body: `Part of crossing ${cx.code} in ${info.name}: one change that lands in every sector it touches at once, or in none.${cx.intent.body ? `\n\n${cx.intent.body}` : ""}`,
		});
		const leg: CrossingLeg = { sector: sector.slug, name: sector.name, prefix: sector.prefix, agentId, flightId: flight.id, flight: flight.code, repo: flight.repo, landing: null };
		cx.legs.push(leg);
		const order = (l: CrossingLeg) => info.sectors.findIndex((s) => s.slug === l.sector);
		cx.legs.sort((a, b) => order(a) - order(b));
		agent.legs[sector.slug] = agentId;
		await this.ctx.storage.put(AGENT(agent.id), agent);
		await this.saveCrossing(cx);
		// The sector's contrail gets the crossing's plan and decisions so far.
		for (const e of cx.contrail) await tower.log(agentId, { kind: e.kind, text: e.text }).catch(() => null);
		return leg;
	}

	/** Groups monorepo targets by the sector that owns them. */
	private bySector(info: CenterInfo, targets: string[]): Map<SectorInfo, string[]> {
		const groups = new Map<SectorInfo, string[]>();
		const outside: string[] = [];
		for (const raw of targets.slice(0, 50)) {
			const target = normalizeTarget(String(raw));
			if (!target) continue;
			const sector = ownerOf(target.split("#")[0], info.sectors);
			if (!sector) outside.push(target);
			else groups.set(sector, [...(groups.get(sector) ?? []), target]);
		}
		if (outside.length)
			throw new Error(`${outside.join(", ")} ${outside.length > 1 ? "are" : "is"} outside every sector. Name code inside a sector: ${info.sectors.map((s) => s.prefix).join(", ")}`);
		if (!groups.size) throw new Error(`name at least one target, e.g. ${info.sectors[0]?.prefix ?? ""}src/index.js#main`);
		return groups;
	}

	private tag(leg: { name: string }, radio: RadioMessage[]): RadioMessage[] {
		return radio.map((m) => ({ ...m, text: `[${leg.name}] ${m.text}` }));
	}

	/** Radio that the crossing's legs got since its agent last heard, tagged with their sector. */
	private async relay(cx: Crossing, skip: string[] = []): Promise<RadioMessage[]> {
		const legs = cx.legs.filter((l) => !skip.includes(l.sector));
		const lists = await Promise.all(legs.map((l) => this.tower(l.sector).radioFor(l.agentId).catch(() => [] as RadioMessage[])));
		return lists.flatMap((list, i) => this.tag(legs[i], list));
	}

	async requestClearance(agentId: string, input: { targets: string[]; reason?: string }) {
		const info = await this.info();
		return this.withCrossing(agentId, async (agent, cx) => {
			const groups = [...this.bySector(info, input.targets ?? [])];
			const results = await Promise.all(
				groups.map(async ([sector, targets]) => {
					const leg = await this.leg(info, agent, cx, sector);
					return { leg, res: await this.tower(sector.slug).requestClearance(leg.agentId, { targets, reason: input.reason }) };
				}),
			);
			return {
				granted: results.flatMap((r) => r.res.granted),
				holding: results.flatMap((r) => r.res.holding.map((h): HoldInfo & { sector: string } => ({ ...h, sector: r.leg.name }))),
				radio: [...results.flatMap((r) => this.tag(r.leg, r.res.radio)), ...(await this.relay(cx, results.map((r) => r.leg.sector)))],
			};
		});
	}

	async releaseClearance(agentId: string, input: { targets?: string[] }) {
		const info = await this.info();
		return this.withCrossing(agentId, async (_agent, cx) => {
			const asked = input.targets?.length ? [...this.bySector(info, input.targets)] : null;
			const calls = asked
				? asked.flatMap(([sector, targets]) => cx.legs.filter((l) => l.sector === sector.slug).map((leg) => ({ leg, targets })))
				: cx.legs.map((leg) => ({ leg, targets: undefined }));
			// A leg that has landed already (the crossing's other sectors have not) holds nothing.
			const results = await Promise.all(
				calls.map(async ({ leg, targets }) => ({ leg, res: await this.tower(leg.sector).releaseClearance(leg.agentId, { targets }).catch(() => ({ released: [] as string[], radio: [] as RadioMessage[] })) })),
			);
			return { released: results.flatMap((r) => r.res.released), radio: results.flatMap((r) => this.tag(r.leg, r.res.radio)) };
		});
	}

	async log(agentId: string, input: { kind: ContrailKind; text: string; refs?: string[] }) {
		return this.withCrossing(agentId, async (_agent, cx) => {
			const kind: ContrailKind = ["plan", "decision", "note", "handoff", "test"].includes(input.kind) ? input.kind : "note";
			const text = String(input.text ?? "").slice(0, 4000);
			cx.contrail = [...cx.contrail, { kind, text, at: now() }].slice(-50);
			if (kind === "plan") cx.plan = text;
			await this.saveCrossing(cx);
			// Each sector keeps it: it is the context of the crossing's landing there.
			const results = await Promise.all(
				cx.legs.map(async (leg) => ({
					leg,
					res: await this.tower(leg.sector)
						.log(leg.agentId, { kind, text, refs: (input.refs ?? []).filter((r) => String(r).startsWith(leg.prefix)) })
						.catch(() => null),
				})),
			);
			return { logged: { kind, text }, sectors: cx.legs.map((l) => l.name), radio: results.flatMap((r) => (r.res ? this.tag(r.leg, r.res.radio) : [])) };
		});
	}

	/** Why code is the way it is: the sector that owns the path answers. */
	async why(input: { path: string; line?: number; symbol?: string }, agentId?: string) {
		const info = await this.info();
		const path = normalizeTarget(String(input.path ?? "")).split("#")[0];
		const sector = ownerOf(path, info.sectors);
		if (!sector) return { target: path, history: [], note: `No sector owns ${path}: it belongs to the monorepo itself, outside every sector.` };
		let legAgent: string | undefined;
		if (agentId) {
			const agent = await this.ctx.storage.get<AgentRecord>(AGENT(agentId));
			const cx = agent?.crossing ? await this.crossingByCode(agent.crossing) : null;
			legAgent = cx?.legs.find((l) => l.sector === sector.slug)?.agentId ?? agent?.legs[sector.slug];
		}
		// The Tower's answer is plain JSON (its RPC type is not spelled out).
		const answer = (await (this.tower(sector.slug).why(input, legAgent) as Promise<unknown>)) as Record<string, unknown>;
		return { sector: sector.name, ...answer };
	}

	async radar(agentId: string) {
		const info = await this.info();
		const agent = await this.agentRecord(agentId);
		const cx = agent.crossing ? await this.crossingByCode(agent.crossing) : null;
		const active = cx && ACTIVE.includes(cx.status) ? cx : null;
		const sectors = await Promise.all(
			info.sectors.map(async (s) => {
				const leg = active?.legs.find((l) => l.sector === s.slug);
				const r = (await (this.tower(s.slug).radar(leg?.agentId ?? null) as Promise<unknown>).catch(() => null)) as { traffic?: unknown[]; radio?: RadioMessage[] } | null;
				return { sector: s.name, prefix: s.prefix, you: leg?.flight ?? null, traffic: (r?.traffic ?? []).slice(0, 30), radio: r?.radio ?? [] };
			}),
		);
		return {
			you: active ? { crossing: active.code, status: active.status, intent: `INT-${active.intent.seq} ${active.intent.title}`, legs: active.legs.map((l) => ({ sector: l.name, flight: l.flight })) } : null,
			sectors: sectors.map(({ radio: _radio, ...s }) => s),
			openIntents: (await this.openIntents()).map((i) => `INT-${i.seq} ${i.title}`),
			radio: sectors.flatMap((s) => this.tag({ name: s.sector }, s.radio)),
		};
	}

	async refreshWorkspace(agentId: string): Promise<{ workspace: Workspace; upstream: Workspace }> {
		const info = await this.info();
		const { cx } = await this.ownCrossing(agentId);
		return { workspace: await this.mintWorkspace(cx.repo, "write"), upstream: await this.mintWorkspace(info.trunkRepo, "read") };
	}

	async abort(agentId: string, reason?: string) {
		return this.withCrossing(agentId, async (_agent, cx) => {
			const why = `crossing ${cx.code} aborted${reason ? `: ${reason}` : ""}`;
			await Promise.all(cx.legs.map((l) => this.tower(l.sector).closeLeg(l.agentId, why).catch(() => {})));
			cx.status = "aborted";
			if (reason) cx.contrail = [...cx.contrail, { kind: "note" as ContrailKind, text: `Aborted: ${reason}`, at: now() }].slice(-50);
			await this.saveCrossing(cx);
			const intent = await this.ctx.storage.get<CenterIntent>(INTENT(cx.intent.seq));
			if (intent?.status === "assigned") await this.ctx.storage.put(INTENT(intent.seq), { ...intent, status: "open", crossing: null });
			await this.retireLater(cx);
			return { ok: true as const, radio: [] as RadioMessage[] };
		});
	}

	async landingStatus(agentId: string) {
		const agent = await this.agentRecord(agentId);
		const cx = agent.crossing ? await this.crossingByCode(agent.crossing) : null;
		if (!cx) throw new Error("no crossing yet — call take_off first");
		return { crossing: cx, next: this.nextStep(cx), radio: ACTIVE.includes(cx.status) ? await this.relay(cx) : [] };
	}

	/**
	 * Lands the crossing in every sector it touches, or in none. Its change is split by sector, each part
	 * as one commit on that sector's own history; every sector's runway merges and tests its part and holds
	 * it; then all parts land and the monorepo gets one commit, or every part is let go.
	 */
	async requestLanding(agentId: string, input: { summary: string }) {
		const info = await this.info();
		return this.withCrossing(agentId, (agent, cx) =>
			this.oneLanding(async () => {
				const summary = String(input.summary ?? "").slice(0, 4000);
				cx.status = "approach";
				cx.attempts++;
				cx.landing = { status: "landing", summary, at: now(), finishedAt: null, commit: null, error: null };
				for (const leg of cx.legs) leg.landing = null;
				await this.saveCrossing(cx);
				await this.ctx.storage.put("landing", cx.code);
				try {
					await this.land(info, agent, cx, summary);
				} catch (err) {
					await this.finish(cx, { landed: false, error: errorMessage(err) });
				} finally {
					await this.ctx.storage.delete("landing");
				}
				return { crossing: cx, next: this.nextStep(cx), radio: await this.relay(cx) };
			}),
		);
	}

	private async land(info: CenterInfo, agent: AgentRecord, cx: Crossing, summary: string) {
		// What the change touches (the clone is the composer's too, so this waits for a composition in progress).
		const touched = await this.exclusive(() => this.touched(info, cx));
		await Promise.all(touched.sectors.map((s) => this.leg(info, agent, cx, s)));
		let parts: Part[] = [];
		try {
			parts = await this.exclusive(() => this.split(info, cx, touched, summary));
			const legs = parts.filter((p) => p.commit).map((p) => cx.legs.find((l) => l.sector === p.sector.slug)!);

			// Phase one: every sector merges, checks and tests its part, then holds it.
			const prepared = await Promise.all(
				legs.map((leg) =>
					withTimeout(this.tower(leg.sector).prepareLeg(leg.agentId, { crossing: cx.code, summary, holdMs: HOLD_MS }), PREPARE_MS, leg.name).catch((err) => ({
						ready: false,
						landing: null,
						error: errorMessage(err),
					})),
				),
			);
			prepared.forEach((p, i) => (legs[i].landing = p.landing ? legLanding(p.landing) : { status: "failed", commit: null, error: "error" in p ? p.error : null, tests: null, conflicts: [], changes: 0 }));
			if (!prepared.every((p) => p.ready)) {
				const reasons = prepared.flatMap((p, i) => (p.ready ? [] : [`${legs[i].name}: ${p.landing ? turnedAway(p.landing) : "error" in p ? p.error : "not ready"}`]));
				const held = legs.filter((_, i) => prepared[i].ready).map((l) => l.name);
				await Promise.all(legs.map((leg) => this.tower(leg.sector).abortLeg(leg.agentId, `held back: crossing ${cx.code} did not land in ${reasons.map((r) => r.split(":")[0]).join(", ")}`).catch(() => null)));
				for (const leg of legs) if (leg.landing?.status === "verifying" || leg.landing?.status === "merging") leg.landing = { ...leg.landing, status: "failed", error: "held back" };
				await this.finish(cx, { landed: false, error: `Not landed anywhere. ${reasons.join("; ")}.${held.length ? ` ${held.join(" and ")} ${held.length > 1 ? "were" : "was"} ready and held back.` : ""}` });
				return;
			}

			// Phase two: every sector is ready, so every part lands. From here on the crossing only moves forward.
			const landed = await Promise.all(legs.map((leg) => this.tower(leg.sector).commitLeg(leg.agentId).catch((err) => errorMessage(err))));
			landed.forEach((l, i) => (legs[i].landing = typeof l === "string" ? { status: "failed", commit: null, error: l, tests: null, conflicts: [], changes: 0 } : legLanding(l)));
			// Its other legs close: sectors where it asked for clearance but changed nothing, or whose part had landed before.
			const others = cx.legs.filter((l) => !legs.includes(l));
			await Promise.all(others.map((l) => this.tower(l.sector).closeLeg(l.agentId, `crossing ${cx.code} landed without a change here`).catch(() => {})));
			const down = landed.flatMap((l, i) => (typeof l !== "string" && l.status === "landed" && l.trunkAfter && l.trunkBefore ? [{ leg: legs[i], before: l.trunkBefore, after: l.trunkAfter }] : []));
			const commit = down.length ? await this.exclusive(() => this.composeCrossing(info, cx, down, summary)) : ((await this.ctx.storage.get<string>("head")) ?? null);
			const missed = legs.filter((l) => l.landing?.status !== "landed");
			if (missed.length)
				await this.finish(cx, {
					landed: false,
					commit,
					error: `Landed in ${down.map((d) => d.leg.name).join(", ") || "no sector"} but not in ${missed.map((l) => `${l.name} (${l.landing?.error ?? l.landing?.status})`).join(", ")}. Request landing again to land the rest.`,
				});
			else await this.finish(cx, { landed: true, commit });
		} finally {
			for (const p of parts) this.holding.delete(p.sector.slug);
			await this.scheduleAlarm();
		}
	}

	/** The crossing's workspace head, the monorepo commit it builds on, and its change by sector. */
	private async touched(info: CenterInfo, cx: Crossing) {
		const { head } = await this.sync(info.trunkRepo);
		const r = this.repo!;
		const fork = await this.repoAccess(cx.repo, "read");
		const forkHead = await fetchFork(r, "crossing", fork.remote, fork.token);
		const base = await mergeBase(r, forkHead, head);
		if (!base) throw new Error("your workspace shares no history with the monorepo trunk");
		if (base === forkHead) throw new Error("nothing to land: your workspace has no commits beyond the monorepo trunk. Commit, then git push origin HEAD:main");
		const { bySector, outside } = sectorChanges(await listTree(r, base), await listTree(r, forkHead), info.sectors);
		if (outside.length)
			throw new Error(
				`a crossing changes code inside sectors only, and ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ` and ${outside.length - 5} more` : ""} ${outside.length > 1 ? "are" : "is"} outside every sector (${info.sectors.map((s) => s.prefix).join(", ")})`,
			);
		if (!bySector.size) throw new Error("nothing to land: your workspace makes no changes");
		return { forkHead, base, bySector, sectors: info.sectors.filter((s) => bySector.has(s.slug)) };
	}

	/**
	 * Splits the change by sector. Each sector's part becomes one commit on that sector's own history, on the
	 * commit the monorepo had composed where the workspace branched off, and goes to the leg's workspace.
	 */
	private async split(info: CenterInfo, cx: Crossing, t: Awaited<ReturnType<Center["touched"]>>, summary: string): Promise<Part[]> {
		await this.sync(info.trunkRepo);
		const r = this.repo!;
		const fork = await this.repoAccess(cx.repo, "read");
		if ((await fetchFork(r, "crossing", fork.remote, fork.token)) !== t.forkHead) throw new Error("your workspace moved while it was landing: request landing again");
		const heads = await this.fetchSectors(t.sectors);
		const parts: Part[] = [];
		for (const [i, sector] of t.sectors.entries()) {
			const changes = t.bySector.get(sector.slug)!;
			try {
				const oid = await sectorPart(r, {
					base: t.base,
					sectorHead: heads[i],
					prefix: sector.prefix,
					changes,
					message: `${cx.intent.title}\n\n${summary}\n\nContrail-Crossing: ${cx.code}`,
					author: { name: cx.callsign, email: agentEmail(cx.callsign) },
					committer: AUTHOR,
				});
				parts.push({ sector, changes, commit: oid });
			} catch (err) {
				throw new Error(`${sector.name}: ${errorMessage(err)}. git pull --no-rebase upstream main, push, and request landing again`);
			}
		}
		await Promise.all(
			parts
				.filter((p) => p.commit)
				.map(async (p) => {
					const leg = cx.legs.find((l) => l.sector === p.sector.slug)!;
					const access = await this.repoAccess(leg.repo, "write");
					await pushTo(r, access.remote, access.token, p.commit!);
				}),
		);
		// Until the crossing's own commit, compositions leave these sectors alone.
		for (const p of parts) this.holding.add(p.sector.slug);
		return parts;
	}

	/**
	 * The monorepo's commit for a landed crossing: its sectors composed at exactly the commits the crossing
	 * landed as. Sector landings that came before it and were not composed yet get a commit of their own first.
	 */
	private async composeCrossing(info: CenterInfo, cx: Crossing, down: { leg: CrossingLeg; before: string; after: string }[], summary: string): Promise<string> {
		const synced = await this.sync(info.trunkRepo);
		let head = synced.head;
		await this.fetchSectors(down.map((d) => info.sectors.find((s) => s.slug === d.leg.sector)!));
		const heads = (await this.ctx.storage.get<Record<string, string>>("heads")) ?? {};
		const behind = down.filter((d) => heads[d.leg.sector] !== d.before).map((d) => ({ name: d.leg.name, prefix: d.leg.prefix, head: d.before }));
		const start = head;
		if (behind.length) head = await this.composeAt(head, behind, composeMessage(behind), AUTHOR);
		const caughtUp = head;
		const message = [
			`Land ${cx.code} ${cx.intent.title} across ${down.map((d) => d.leg.name).join(", ")}`,
			"",
			summary.replace(/^Contrail-[\w-]+:.*$/gim, "").trim(),
			"",
			`Contrail-Crossing: ${cx.code}`,
			`Contrail-Agent: ${cx.callsign}${cx.model ? ` (${cx.model})` : ""}`,
			...down.map((d) => `Contrail-Sector: ${d.leg.name} ${d.after.slice(0, 12)}`),
		].join("\n");
		head = await this.composeAt(head, down.map((d) => ({ prefix: d.leg.prefix, head: d.after })), message, { name: cx.callsign, email: agentEmail(cx.callsign) });
		for (const d of down) heads[d.leg.sector] = d.after;
		if (head === start) {
			await this.ctx.storage.put("heads", heads);
			return head;
		}
		await this.publish(head, synced.token);
		await this.ctx.storage.put({ heads, head, composedAt: Date.now(), compositions: ((await this.ctx.storage.get<number>("compositions")) ?? 0) + (caughtUp === start ? 1 : 2) - (head === caughtUp ? 1 : 0), lastError: null });
		return head;
	}

	private async finish(cx: Crossing, outcome: { landed: boolean; commit?: string | null; error?: string | null }) {
		const t = now();
		cx.landing = { ...(cx.landing ?? { summary: "", at: t }), status: outcome.landed ? "landed" : "failed", finishedAt: t, commit: outcome.commit ?? null, error: outcome.error ?? null };
		cx.status = outcome.landed ? "landed" : "diverted";
		if (outcome.landed) {
			cx.landedAt = t;
			const intent = await this.ctx.storage.get<CenterIntent>(INTENT(cx.intent.seq));
			if (intent) await this.ctx.storage.put(INTENT(intent.seq), { ...intent, status: "landed", landedCommit: outcome.commit ?? null });
			await this.retireLater(cx);
		}
		await this.saveCrossing(cx);
	}

	private nextStep(cx: Crossing): string {
		const l = cx.landing;
		if (cx.status === "aborted") return "Aborted. Call take_off for the next crossing.";
		if (!l) return "Not landing yet: commit, git push origin HEAD:main, then request_landing.";
		if (l.status === "landing") return "Landing: each sector is merging and testing its part. Call landing_status in a little while.";
		if (l.status === "landed") {
			const names = cx.legs.filter((x) => x.landing?.status === "landed").map((x) => x.name);
			const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "its sectors");
			return `Landed in ${list} at once${l.commit ? `; the monorepo trunk has it as ${l.commit.slice(0, 8)}` : ""}. Your crossing is complete — call take_off for the next one.`;
		}
		if (cx.legs.some((x) => x.landing?.status === "conflict"))
			return `${l.error} Pull the monorepo trunk (git pull --no-rebase upstream main), resolve the conflicting hunks, commit, push and request_landing again.`;
		if (/airspace violation/.test(l.error ?? "")) return `${l.error} Call request_clearance for that code: you hold until it is free and the radio tells you when. Then pull upstream main, push and request_landing again.`;
		return `${l.error} Pull upstream main, fix it, push and request_landing again.`;
	}

	// ───────────────────────── crossings: workspaces ─────────────────────────

	private async retireLater(cx: Crossing) {
		const retiring = (await this.ctx.storage.get<{ repo: string; seq: number; due: number }[]>("retiring")) ?? [];
		if (!retiring.some((r) => r.repo === cx.repo)) retiring.push({ repo: cx.repo, seq: cx.seq, due: now() + FORK_RETENTION_MS });
		await this.ctx.storage.put("retiring", retiring);
		await this.scheduleAlarm();
	}

	/** Deletes the workspace forks of crossings that ended over an hour ago, a few at a time. */
	private async retireForks() {
		const retiring = (await this.ctx.storage.get<{ repo: string; seq: number; due: number }[]>("retiring")) ?? [];
		const due = retiring.filter((r) => r.due <= now()).slice(0, 20);
		if (!due.length) return;
		// delete() is false when the repo is already gone, which counts as retired too; a throw is retried next time.
		const gone = new Set((await Promise.all(due.map((r) => this.env.ARTIFACTS.delete(r.repo).then(() => r.repo, () => null)))).filter((x): x is string => x !== null));
		for (const r of due) {
			if (!gone.has(r.repo)) continue;
			const cx = await this.ctx.storage.get<Crossing>(CROSSING(r.seq));
			if (cx) await this.ctx.storage.put(CROSSING(r.seq), { ...cx, retiredAt: now() });
		}
		await this.ctx.storage.put("retiring", retiring.filter((r) => !gone.has(r.repo)));
	}

	/** Crossing workspace forks that still exist (for the orphan sweep). */
	async liveForks(): Promise<string[]> {
		return [...(await this.ctx.storage.list<Crossing>({ prefix: "crossing:" })).values()].filter((cx) => !cx.retiredAt).map((cx) => cx.repo);
	}

	async crossing(code: string): Promise<Crossing | null> {
		return this.crossingByCode(code);
	}

	/** The Center page: the composed trunk, every sector's live counts and the latest crossings. */
	async snapshot(): Promise<CenterSnapshot> {
		const info = await this.info();
		const [head, composedAt, compositions, dirty, crossings, open] = await Promise.all([
			this.ctx.storage.get<string>("head"),
			this.ctx.storage.get<number>("composedAt"),
			this.ctx.storage.get<number>("compositions"),
			this.ctx.storage.get<string[]>("dirty"),
			this.ctx.storage.list<Crossing>({ prefix: "crossing:", reverse: true, limit: 20 }),
			this.openIntents(),
		]);
		const sectors = await Promise.all(
			info.sectors.map(async (s) => ({ ...s, summary: await this.env.TOWER.get(this.env.TOWER.idFromName(s.slug)).summary().catch(() => null) })),
		);
		return {
			center: info,
			head: head ?? null,
			composedAt: composedAt ?? null,
			behind: (dirty ?? []).length,
			compositions: compositions ?? 0,
			sectors,
			crossings: [...crossings.values()],
			openIntents: open.length,
		};
	}

	/** Deletes the monorepo trunk and crossing workspaces (the sectors are projects of their own and are deleted separately). */
	async destroy(): Promise<{ deleted: string | null }> {
		const info = await this.ctx.storage.get<CenterInfo>("center");
		const forks = await this.liveForks();
		if (info) await this.env.ARTIFACTS.delete(info.trunkRepo).catch(() => false);
		await Promise.all(forks.map((name) => this.env.ARTIFACTS.delete(name).catch(() => false)));
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.repo = null;
		this.access.clear();
		this.holding.clear();
		return { deleted: info?.trunkRepo ?? null };
	}
}
