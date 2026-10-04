// The agent-facing operations. The same table drives the MCP server and the REST API, so an agent
// gets identical behaviour whether it speaks MCP (Claude Code, Codex, Cursor…) or plain HTTP.
import type { Tower } from "./tower/tower";

type TowerStub = DurableObjectStub<Tower>;

export interface ToolDef {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	run: (tower: TowerStub, agentId: string, args: Record<string, any>) => Promise<unknown>;
	/** One-line human summary placed before the JSON payload. */
	summarize?: (result: any) => string;
}

const str = (description: string) => ({ type: "string", description });

export const TOOLS: ToolDef[] = [
	{
		name: "take_off",
		description:
			"Start your next flight: the Tower assigns you an open intent (task) and creates your own workspace repo — an Artifacts fork of trunk — plus a read-only upstream remote. Returns clone commands. Optionally pass an intent number to pick a specific one.",
		inputSchema: { type: "object", properties: { intent: str("Optional intent number like 'INT-4' or '4'.") } },
		run: (t, a, args) => t.takeOff(a, { intent: args.intent ?? null }),
		summarize: (r) =>
			r.idle
				? `Nothing assigned: ${r.message}`
				: `✈ ${r.flight.code} airborne for INT-${r.intent.seq} "${r.intent.title}". Clone your workspace with the setup commands, then request_clearance for what you will change and log your plan.`,
	},
	{
		name: "request_clearance",
		description:
			"Before editing, claim the code you will change. Targets are 'path#symbol' (a function, class or Class.method) or a whole 'path' or directory 'dir/'. Granted targets are yours; targets another flight holds put you in a holding pattern for them and tell you who holds them and why. Call again whenever your plan grows.",
		inputSchema: {
			type: "object",
			properties: {
				targets: { type: "array", items: { type: "string" }, description: "e.g. ['src/cart.js#applyDiscount', 'src/money.js']" },
				reason: str("What you are going to do to them."),
			},
			required: ["targets"],
		},
		run: (t, a, args) => t.requestClearance(a, { targets: args.targets ?? [], reason: args.reason }),
		summarize: (r) =>
			r.holding.length
				? `Cleared: ${r.granted.join(", ") || "nothing"}. HOLDING for ${r.holding.map((h: any) => `${h.target} (held by ${h.heldBy.callsign} ${h.heldBy.flight}: ${h.heldBy.intent})`).join("; ")}. Work on something else, radio them, or wait for a clearance message.`
				: `Cleared for ${r.granted.join(", ")}.`,
	},
	{
		name: "release_clearance",
		description: "Give back clearances you no longer need (all of them if no targets are given) so waiting flights can proceed.",
		inputSchema: { type: "object", properties: { targets: { type: "array", items: { type: "string" } } } },
		run: (t, a, args) => t.releaseClearance(a, { targets: args.targets }),
		summarize: (r) => `Released ${r.released.join(", ") || "nothing"}.`,
	},
	{
		name: "log",
		description:
			"Write to your flight's contrail — the permanent record of why the code changed. Log your plan once you have one (kind 'plan'), and each non-obvious choice (kind 'decision'). Use 'handoff' for notes the next agent needs. These are attached to your landed commit as a git note.",
		inputSchema: {
			type: "object",
			properties: {
				kind: { type: "string", enum: ["plan", "decision", "note", "handoff"] },
				text: str("Plain language, specific."),
				refs: { type: "array", items: { type: "string" }, description: "Optional code targets this is about." },
			},
			required: ["kind", "text"],
		},
		run: (t, a, args) => t.log(a, { kind: args.kind, text: String(args.text ?? ""), refs: args.refs }),
		summarize: () => "Logged to your contrail.",
	},
	{
		name: "radio",
		description: "Send a message to another flight (by flight code like 'FL-003' or callsign like 'CLAUDE-2'), or 'all'. Use it to coordinate when you are holding for something they hold.",
		inputSchema: { type: "object", properties: { to: str("Flight code, callsign, or 'all'."), text: str("Message.") }, required: ["to", "text"] },
		run: (t, a, args) => t.radio(a, { to: String(args.to ?? ""), text: String(args.text ?? "") }),
		summarize: (r) => (r.delivered.length ? `Delivered to ${r.delivered.join(", ")}.` : "No active flight matched; message logged."),
	},
	{
		name: "request_landing",
		description:
			"After committing and pushing to your workspace (git push origin HEAD:main), ask the Tower to land your work on trunk. It merges onto the current trunk, runs the test suite in an isolated Worker, and lands it as one attributed commit. Waits for the result. On conflict or failing tests you get the exact details: pull upstream, fix, push, and call again.",
		inputSchema: { type: "object", properties: { summary: str("What changed and why, 1-5 sentences. Becomes the commit body.") }, required: ["summary"] },
		run: (t, a, args) => t.requestLanding(a, { summary: String(args.summary ?? "") }),
		summarize: (r) => {
			const l = r.landing;
			if (l.status === "landed") return `🛬 Landed as ${l.trunkAfter?.slice(0, 8)}${l.tests ? ` — ${l.tests.passed} tests green` : ""}. ${r.next}`;
			if (l.status === "conflict") return `⚠ Conflict — not landed. ${r.next}`;
			if (l.status === "failed") return `✖ Not landed: ${l.error}. ${r.next}`;
			return `On approach (queue position ${r.position}). ${r.next}`;
		},
	},
	{
		name: "landing_status",
		description: "Check the result of your latest landing request.",
		inputSchema: { type: "object", properties: {} },
		run: (t, a) => t.landingStatus(a, {}),
		summarize: (r) => `${r.landing.status}. ${r.next}`,
	},
	{
		name: "radar",
		description: "See the airspace: every active flight, what it is cleared for or holding for, recent landings, open intents, and your radio messages.",
		inputSchema: { type: "object", properties: {} },
		run: (t, a) => t.radar(a),
		summarize: (r) => `${r.traffic.length} active flight(s), ${r.openIntents.length} open intent(s).`,
	},
	{
		name: "why",
		description:
			"Ask why code on trunk is the way it is. Give a path and a line or symbol; get the intents, agents, plans and decisions that shaped it. Use it before changing code you did not write.",
		inputSchema: {
			type: "object",
			properties: { path: str("File path, or 'path#symbol'."), line: { type: "number" }, symbol: str("Function/class/method name.") },
			required: ["path"],
		},
		run: (t, _a, args) => t.why({ path: String(args.path ?? ""), line: args.line, symbol: args.symbol }),
		summarize: (r) => (r.history.length ? `${r.target}: ${r.history.length} landed change(s) on record.` : `${r.target}: no recorded history.`),
	},
	{
		name: "file_intent",
		description: "File a new intent (task) for another agent — e.g. a follow-up you discovered but that is outside your own intent.",
		inputSchema: { type: "object", properties: { title: str("Imperative title."), body: str("Details and acceptance criteria."), priority: { type: "number" } }, required: ["title"] },
		run: (t, a, args) => t.fileIntent(a, { title: String(args.title ?? ""), body: args.body, priority: args.priority }),
		summarize: (r) => `Filed INT-${r.seq} "${r.title}".`,
	},
	{
		name: "abort",
		description: "Abandon your current flight. Its intent goes back to the queue and its clearances are released.",
		inputSchema: { type: "object", properties: { reason: str("Why.") } },
		run: (t, a, args) => t.abort(a, undefined, args.reason),
		summarize: () => "Flight aborted; intent returned to the queue.",
	},
	{
		name: "refresh_workspace",
		description: "Get fresh clone URLs (tokens) for your workspace and upstream if git reports authentication errors.",
		inputSchema: { type: "object", properties: {} },
		run: (t, a) => t.refreshWorkspace(a),
		summarize: () => "Fresh workspace credentials issued. Update your remotes with `git remote set-url`.",
	},
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
