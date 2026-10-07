// Edge agents: coding agents that live entirely on Cloudflare.
//
// Each edge agent is a Durable Object. It flies exactly like an external agent — take_off, clearance,
// contrail, landing — but its workspace is an in-memory git checkout of its Artifacts fork, its tests
// run in Dynamic Workers, and its reasoning runs on Workers AI. The loop advances one model turn per
// alarm, so an agent can fly for as long as it needs without holding a request open.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { verifyTree } from "../runway/verify";
import type { TakeOffResult } from "../tower/tower";
import { errorMessage, sha256 } from "../util";
import { Workspace } from "./workspace";

export const DEFAULT_EDGE_MODEL = "@cf/zai-org/glm-5.3-flash";
const MAX_TURNS_PER_FLIGHT = 40;
/** Scripted steps are cheap, but a landing turned away every time must not loop forever. */
const MAX_SCRIPTED_STEPS = 200;
/** Errors in a row (say, the project was deleted) after which an agent stops trying. */
const MAX_ERRORS = 30;
const MAX_TOOL_OUTPUT = 16_000;

interface Config {
	slug: string;
	agentId: string;
	callsign: string;
	model: string;
	maxFlights: number;
	/** "llm": reasons with Workers AI. "scripted": applies the machine-readable script in the intent (load tests). */
	mode?: "llm" | "scripted";
}

/** Machine-readable intent payload for scripted agents: a line `script: {...}` in the intent body. */
interface Script {
	op: "increment" | "append";
	path: string;
	symbol: string;
	code?: string;
}

function parseScript(body: string): Script | null {
	const m = body.match(/^script:\s*(\{.*\})\s*$/m);
	if (!m) return null;
	try {
		return JSON.parse(m[1]) as Script;
	} catch {
		return null;
	}
}

type Phase = "boarding" | "flying" | "done" | "stopped";

interface ChatMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: string;
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
	tool_call_id?: string;
}

interface State {
	phase: Phase;
	flights: number;
	turn: number;
	script?: Script | null;
	step?: "claim" | "apply" | "land";
	flight: { code: string; intent: string; cloneUrl: string; upstreamUrl: string } | null;
	messages: ChatMessage[];
	lastError: string | null;
	errors?: number;
	tokens: number;
}

const fn = (name: string, description: string, properties: Record<string, unknown> = {}, required: string[] = []) => ({
	type: "function" as const,
	function: { name, description, parameters: { type: "object", properties, required } },
});
const s = (description: string) => ({ type: "string", description });

const TOOLS = [
	fn("list_files", "List the files in your workspace with their line counts."),
	fn("read_file", "Read a file from your workspace.", { path: s("Repository-relative path.") }, ["path"]),
	fn("write_file", "Create or overwrite a file in your workspace with the full new content.", { path: s("Path."), content: s("Complete file content.") }, ["path", "content"]),
	fn(
		"edit_file",
		"Replace one exact occurrence of old_text with new_text in a file. old_text must match exactly once.",
		{ path: s("Path."), old_text: s("Exact text to replace."), new_text: s("Replacement text.") },
		["path", "old_text", "new_text"],
	),
	fn("run_tests", "Run the test suite (test/*.test.js) against your workspace in an isolated Worker."),
	fn(
		"request_clearance",
		"Claim the functions/methods you will change or add BEFORE editing them, as 'path#symbol'. New functions/tests are claimed by their new name. Do not claim whole files.",
		{ targets: { type: "array", items: { type: "string" } }, reason: s("What you will do.") },
		["targets"],
	),
	fn("log", "Record your plan (kind 'plan') or a decision (kind 'decision') in your contrail.", { kind: { type: "string", enum: ["plan", "decision", "note"] }, text: s("Text.") }, ["kind", "text"]),
	fn("why", "Ask why code on trunk looks the way it does: the intents and decisions behind a symbol.", { path: s("File path."), symbol: s("Function/class/method.") }, ["path"]),
	fn("radar", "See other flights, what they hold, and recent landings."),
	fn("radio", "Message another flight or agent.", { to: s("Flight code or callsign."), text: s("Message.") }, ["to", "text"]),
	fn("sync_with_trunk", "Merge the latest trunk into your workspace (after a conflict or turbulence). Conflicting files get conflict markers you must resolve."),
	fn("land", "Commit and push your work, then ask the Tower to land it on trunk. Returns landed, or the conflict/test details to fix.", { summary: s("1-3 sentences: what and why.") }, ["summary"]),
];

function systemPrompt(callsign: string) {
	return `You are ${callsign}, an autonomous coding agent running on Cloudflare's edge. Many agents change this codebase at the same time; the Contrail tower coordinates you. You have a private workspace (a fork of trunk) and these tools.

For the intent you are given:
1. list_files / read_file to understand the code and its tests. Write tests in the style of the existing test files; run_tests runs the project's own suite.
2. request_clearance for every existing function/method you will change and every new function/test you will add (path#name). If a target is HOLDING (another flight owns it), don't edit it yet: work on other parts, radio them, or call request_clearance again later. Landing a change to code another flight holds is turned away.
3. Before you change an existing function, call why on it: earlier intents and decisions tell you what must keep working. Then log your plan (2-3 sentences).
4. Make the change with edit_file (preferred) or write_file. Add tests at the end of the relevant test file.
5. run_tests until green.
6. land with a short summary. On conflict or failing tests: sync_with_trunk, resolve, run_tests, land again.
Keep changes minimal and focused. Never stop before you have landed. Reply with tool calls only.`;
}

export class EdgeAgent extends DurableObject<Env> {
	private ws: Workspace | null = null;

	private async config(): Promise<Config> {
		const c = await this.ctx.storage.get<Config>("config");
		if (!c) throw new Error("edge agent not configured");
		return c;
	}

	private async state(): Promise<State> {
		return (await this.ctx.storage.get<State>("state")) ?? { phase: "boarding", flights: 0, turn: 0, flight: null, messages: [], lastError: null, tokens: 0 };
	}

	private async save(state: State) {
		await this.ctx.storage.put("state", state);
	}

	private tower(slug: string) {
		return this.env.TOWER.get(this.env.TOWER.idFromName(slug));
	}

	async start(config: Config) {
		await this.ctx.storage.put("config", config);
		await this.save({ phase: "boarding", flights: 0, turn: 0, flight: null, messages: [], lastError: null, tokens: 0 });
		await this.ctx.storage.setAlarm(Date.now() + 100);
	}

	async stop() {
		const state = await this.state();
		state.phase = "stopped";
		await this.save(state);
		await this.ctx.storage.deleteAlarm();
		const c = await this.ctx.storage.get<Config>("config");
		if (c && state.flight) await this.tower(c.slug).abort(c.agentId, undefined, "edge agent stopped").catch(() => {});
	}

	async status() {
		const [config, state] = await Promise.all([this.ctx.storage.get<Config>("config"), this.state()]);
		return { config, phase: state.phase, flights: state.flights, turn: state.turn, flight: state.flight?.code ?? null, lastError: state.lastError, tokens: state.tokens };
	}

	async alarm() {
		const config = await this.config();
		const state = await this.state();
		if (state.phase === "done" || state.phase === "stopped") return;
		let delay = 50;
		try {
			if (state.phase === "boarding") delay = await this.board(config, state);
			else if (config.mode === "scripted") delay = await this.flyScript(config, state);
			else delay = await this.fly(config, state);
			state.lastError = null;
			state.errors = 0;
		} catch (err) {
			state.lastError = errorMessage(err);
			state.errors = (state.errors ?? 0) + 1;
			if (state.errors >= MAX_ERRORS) state.phase = "done";
			delay = 5000;
		}
		// stop() may have run while this turn waited on the model or the tower: the stop wins, and a
		// flight this turn took off on goes back to the tower.
		if ((await this.state()).phase === "stopped") {
			if (state.flight) await this.tower(config.slug).abort(config.agentId, undefined, "edge agent stopped").catch(() => {});
			return;
		}
		await this.save(state);
		const phase = state.phase as Phase; // board()/fly() may have moved it
		if (phase !== "done" && phase !== "stopped") await this.ctx.storage.setAlarm(Date.now() + delay);
	}

	private async board(config: Config, state: State): Promise<number> {
		if (state.flights >= config.maxFlights) {
			state.phase = "done";
			return 0;
		}
		const res = await this.tower(config.slug)
			.takeOff(config.agentId, {})
			.catch(async (err) => {
				// The tower still has a flight for us that this agent lost track of: give its intent back and start over.
				if (!/already flying/.test(errorMessage(err))) throw err;
				await this.tower(config.slug).abort(config.agentId, undefined, "edge agent lost track of this flight");
				return null;
			});
		if (!res) return 1000;
		if ("idle" in res) {
			if (/lined up/.test(res.message)) return 2500 + Math.floor(Math.random() * 2500);
			if (/blocked/.test(res.message)) return 15_000;
			state.phase = "done";
			return 0;
		}
		const t = res as TakeOffResult;
		// Counted before the workspace opens: a fork that fails to open still used up a flight.
		state.flights++;
		try {
			this.ws = await Workspace.open(t.workspace.cloneUrl, t.upstream.cloneUrl, {
				name: config.callsign,
				email: `${config.callsign.toLowerCase()}@agents.contrail.dev`,
			});
		} catch (err) {
			// Don't leave the flight in the air without an agent: give the intent back, then retry.
			await this.tower(config.slug).abort(config.agentId, undefined, `workspace did not open: ${errorMessage(err)}`).catch(() => {});
			throw err;
		}
		const files = await this.ws.listFiles();
		state.flight = { code: t.flight.code, intent: `INT-${t.intent.seq} ${t.intent.title}`, cloneUrl: t.workspace.cloneUrl, upstreamUrl: t.upstream.cloneUrl };
		state.turn = 0;
		state.phase = "flying";
		if (config.mode === "scripted") {
			state.script = parseScript(t.intent.body);
			state.step = "claim";
			state.messages = [];
			if (!state.script) {
				await this.tower(config.slug).abort(config.agentId, undefined, "intent has no script for a scripted agent");
				this.ws = null;
				state.flight = null;
				state.phase = "boarding";
			}
			return 50;
		}
		const previous = (t as TakeOffResult & { previousAttempts?: unknown }).previousAttempts;
		state.messages = [
			{ role: "system", content: systemPrompt(config.callsign) },
			{
				role: "user",
				content: [
					`Flight ${t.flight.code} — your intent is INT-${t.intent.seq}: ${t.intent.title}`,
					t.intent.body,
					previous ? `Earlier attempts at this intent (their contrail):\n${JSON.stringify(previous, null, 1).slice(0, 3000)}` : "",
					`Workspace files:\n${files.map((f) => `${f.path} (${f.lines} lines)`).join("\n")}`,
				]
					.filter(Boolean)
					.join("\n\n"),
			},
		];
		return 50;
	}

	private async workspace(state: State, config: Config): Promise<Workspace> {
		if (this.ws) return this.ws;
		// The isolate was evicted mid-flight: re-open the workspace from what was last pushed.
		this.ws = await Workspace.open(state.flight!.cloneUrl, state.flight!.upstreamUrl, {
			name: config.callsign,
			email: `${config.callsign.toLowerCase()}@agents.contrail.dev`,
		});
		state.messages.push({ role: "user", content: "Note: your workspace was reloaded from your last push; uncommitted edits were lost. Re-check files before continuing." });
		return this.ws;
	}

	private async fly(config: Config, state: State): Promise<number> {
		if (state.turn >= MAX_TURNS_PER_FLIGHT) {
			await this.giveUp(config, `turn budget of ${MAX_TURNS_PER_FLIGHT} exhausted`);
			this.ws = null;
			state.flight = null;
			state.phase = "boarding";
			return 1000;
		}
		state.turn++;
		const ws = await this.workspace(state, config);
		const out = (await this.env.AI.run(config.model as any, {
			messages: compact(state.messages),
			tools: TOOLS,
			max_completion_tokens: 4096,
			temperature: 0.2,
		} as any)) as any;
		const choice = out?.choices?.[0];
		const msg = choice?.message ?? { content: out?.response ?? "", tool_calls: out?.tool_calls };
		state.tokens += out?.usage?.total_tokens ?? 0;
		const calls = (msg.tool_calls ?? []).map((c: any, i: number) => ({
			id: c.id ?? `call_${state.turn}_${i}`,
			type: "function" as const,
			function: { name: c.function?.name ?? c.name, arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.arguments ?? c.function?.arguments ?? {}) },
		}));
		state.messages.push({ role: "assistant", content: msg.content ?? "", ...(calls.length ? { tool_calls: calls } : {}) });
		if (calls.length === 0) {
			state.messages.push({ role: "user", content: "You have not landed yet. Continue with tool calls: make the change, run_tests, then land." });
			return 50;
		}
		for (const call of calls) {
			let args: any = {};
			try {
				args = JSON.parse(call.function.arguments || "{}");
			} catch {
				// leave empty; the tool reports what is missing
			}
			let result: string;
			try {
				result = await this.runTool(config, state, ws, call.function.name, args);
			} catch (err) {
				result = `Error: ${errorMessage(err)}`;
			}
			state.messages.push({ role: "tool", tool_call_id: call.id, content: result.slice(0, MAX_TOOL_OUTPUT) });
			if (state.phase === "boarding") break; // landed: the flight is over
		}
		return 50;
	}

	/** One step of a scripted (LLM-free) flight: claim → apply on fresh trunk → land. */
	private async flyScript(config: Config, state: State): Promise<number> {
		const tower = this.tower(config.slug);
		const script = state.script!;
		const target = `${script.path}#${script.symbol}`;
		if (state.turn >= MAX_SCRIPTED_STEPS) {
			await this.giveUp(config, `${MAX_SCRIPTED_STEPS} scripted steps without landing`);
			this.ws = null;
			state.flight = null;
			state.phase = "boarding";
			return 1000;
		}
		state.turn++;
		if (state.step === "claim") {
			const r = await tower.requestClearance(config.agentId, { targets: [target], reason: `${script.op} ${script.symbol}` });
			if (r.holding.length) return 1500 + Math.floor(Math.random() * 1500); // circle until cleared
			if (state.turn === 1) await tower.log(config.agentId, { kind: "plan", text: `Scripted ${script.op} of ${target} on the latest trunk.` });
			state.step = "apply";
			return 20;
		}
		const ws = await this.workspace(state, config);
		if (state.step === "apply") {
			// Apply the script to trunk's copy of the file, not the workspace's: after a landing that was
			// turned away, the workspace still holds the earlier attempt, and applying on top of it would
			// count an increment twice.
			await ws.sync();
			const src = await ws.readTrunk(script.path).catch(() => "");
			let next = src;
			if (script.op === "increment") {
				const re = new RegExp(`(export function ${script.symbol}\\(\\) \\{\\n  return )(\\d+)(;)`);
				if (!re.test(src)) throw new Error(`${target} not found`);
				next = src.replace(re, (_m, a, n, b) => `${a}${Number(n) + 1}${b}`);
			} else {
				next = `${src.trimEnd()}\n\n${(script.code ?? `export function ${script.symbol}() {\n  return true;\n}`).trim()}\n`;
			}
			await ws.write(script.path, next);
			await ws.commitAndPush(`${script.op} ${script.symbol}`);
			state.step = "land";
			return 20;
		}
		const r = await tower.requestLanding(config.agentId, { summary: `${script.op === "increment" ? "Incremented" : "Added"} ${target}.` });
		if (r.landing.status === "landed") {
			this.ws = null;
			state.flight = null;
			state.phase = "boarding";
			return 50;
		}
		if (r.landing.status === "conflict" || r.landing.status === "failed") {
			// Start over from fresh trunk: re-open the workspace and re-apply.
			this.ws = null;
			state.step = "apply";
			return 500;
		}
		return 2000; // still on approach
	}

	/** Aborts the current flight. One the tower has already ended (an operator, a stop) needs nothing more. */
	private async giveUp(config: Config, reason: string) {
		await this.tower(config.slug)
			.abort(config.agentId, undefined, reason)
			.catch((err) => {
				if (!/no active flight/.test(errorMessage(err))) throw err;
			});
	}

	private async runTool(config: Config, state: State, ws: Workspace, name: string, args: any): Promise<string> {
		const tower = this.tower(config.slug);
		const radio = (r: { radio?: { text: string }[] }) => (r.radio?.length ? `\n\nRADIO:\n${r.radio.map((m) => `- ${m.text}`).join("\n")}` : "");
		switch (name) {
			case "list_files":
				return (await ws.listFiles()).map((f) => `${f.path} (${f.lines} lines)`).join("\n");
			case "read_file":
				return await ws.read(String(args.path));
			case "write_file":
				await ws.write(String(args.path), String(args.content ?? ""));
				return `Wrote ${args.path}.`;
			case "edit_file":
				await ws.edit(String(args.path), String(args.old_text ?? ""), String(args.new_text ?? ""));
				return `Edited ${args.path}.`;
			case "run_tests": {
				const files = await ws.snapshot();
				const id = await sha256([...files.entries()].map(([p, c]) => `${p}\0${c}`).join("\0"));
				const report = await verifyTree(this.env.LOADER, `edge-${id}`, files);
				const fails = report.results.filter((r) => !r.ok).map((r) => `FAIL ${r.file} › ${r.name}: ${r.error}`);
				return `${report.passed} passed, ${report.failed} failed${report.error ? `\nLoad error: ${report.error}` : ""}${fails.length ? `\n${fails.join("\n")}` : ""}`;
			}
			case "request_clearance": {
				const r = await tower.requestClearance(config.agentId, { targets: args.targets ?? [], reason: args.reason });
				return `Granted: ${r.granted.join(", ") || "none"}${r.holding.length ? `\nHOLDING (do not edit): ${r.holding.map((h) => `${h.target} held by ${h.heldBy.callsign} ${h.heldBy.flight} (${h.heldBy.intent})`).join("; ")}` : ""}${radio(r)}`;
			}
			case "log": {
				const r = await tower.log(config.agentId, { kind: args.kind ?? "note", text: String(args.text ?? "") });
				return `Logged.${radio(r)}`;
			}
			case "why":
				return JSON.stringify(await tower.why({ path: String(args.path ?? ""), symbol: args.symbol }, config.agentId), null, 1);
			case "radar":
				return JSON.stringify(await tower.radar(config.agentId), null, 1);
			case "radio": {
				const r = await tower.radio(config.agentId, { to: String(args.to ?? ""), text: String(args.text ?? "") });
				return `Delivered to ${r.delivered.join(", ") || "nobody"}.${radio(r)}`;
			}
			case "sync_with_trunk": {
				const r = await ws.sync();
				if (r.conflicts.length) return `Merged trunk. CONFLICTS in ${r.conflicts.join(", ")}: resolve the <<<<<<< / >>>>>>> markers (keep both intents working), run_tests, then land.`;
				return `Merged trunk cleanly${r.fastForward ? " (fast-forward)" : ""}. Changed: ${r.changed.join(", ") || "nothing"}. Run tests, then land.`;
			}
			case "land": {
				const markers = await ws.hasConflictMarkers();
				if (markers.length) return `Not landed: unresolved conflict markers in ${markers.join(", ")}.`;
				await ws.commitAndPush(`${state.flight?.intent ?? "work"}\n\n${String(args.summary ?? "")}`);
				const r = await tower.requestLanding(config.agentId, { summary: String(args.summary ?? "") });
				const l = r.landing;
				if (l.status === "landed") {
					this.ws = null;
					state.flight = null;
					state.phase = "boarding";
					return `Landed as ${l.trunkAfter?.slice(0, 8)}.`;
				}
				if (l.status === "conflict") {
					const detail = l.conflicts
						.map((c) => `${c.path}: ${c.hunks.map((h) => `${h.symbols.join(",")} (trunk changed by ${c.causedBy.map((b) => `${b.callsign} for ${b.intent}`).join(", ") || "another flight"})`).join("; ")}`)
						.join("\n");
					return `CONFLICT — not landed.\n${detail}\nCall sync_with_trunk, resolve, run_tests, then land again.${radio(r)}`;
				}
				if (l.status === "failed") {
					const fails = l.tests?.results.filter((x) => !x.ok).map((x) => `${x.file} › ${x.name}: ${x.error}`) ?? [];
					return `NOT LANDED: ${l.error}\n${fails.join("\n")}\nCall sync_with_trunk (trunk may have moved), fix, run_tests, land again.${radio(r)}`;
				}
				if (l.status === "review") return `Awaiting human review (policy covers ${l.review?.required.join(", ")}). Call land again later to check.${radio(r)}`;
				if (l.status === "rejected") return `Reviewer requested changes: ${l.review?.comment ?? ""}. Fix it, run_tests, land again.${radio(r)}`;
				return `Still on approach (${l.status}). Call land again shortly.${radio(r)}`;
			}
			default:
				return `Unknown tool ${name}.`;
		}
	}
}

/** Keeps the conversation small: old tool outputs are elided once they have been acted on. */
function compact(messages: ChatMessage[]): ChatMessage[] {
	const keepFrom = Math.max(0, messages.length - 16);
	return messages.map((m, i) => (m.role === "tool" && i < keepFrom && m.content.length > 400 ? { ...m, content: `${m.content.slice(0, 300)}\n…[elided]` } : m));
}
