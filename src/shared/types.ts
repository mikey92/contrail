// Types shared by the Worker, the Durable Objects, the MCP server and the Radar UI.

export type AgentKind = "claude-code" | "codex" | "edge" | "human" | "other";

export interface Agent {
	id: string;
	callsign: string;
	kind: AgentKind;
	model: string | null;
	color: string;
	joinedAt: number;
	lastSeenAt: number;
}

export type IntentStatus = "open" | "assigned" | "landed" | "cancelled";

export interface Intent {
	id: string;
	/** Human-friendly number, e.g. 12 for "INT-12". */
	seq: number;
	title: string;
	body: string;
	priority: number;
	status: IntentStatus;
	labels: string[];
	createdBy: string;
	createdAt: number;
	flightId: string | null;
	landedCommit: string | null;
	/** Intents that must land before this one can be taken. */
	dependsOn: string[];
}

/**
 * taxiing   workspace (an Artifacts fork of trunk) is being prepared
 * airborne  the agent is working
 * holding   waiting for a clearance another flight holds
 * approach  landing requested, queued or in progress on the runway
 * diverted  last landing attempt failed (conflict or tests); the agent must fix and retry
 * landed    work is on trunk
 * aborted   abandoned
 */
export type FlightStatus = "taxiing" | "airborne" | "holding" | "approach" | "diverted" | "landed" | "aborted";

export interface Flight {
	id: string;
	/** Short display code, e.g. "CL7-0412". */
	code: string;
	agentId: string;
	intentId: string;
	status: FlightStatus;
	/** Artifacts repo name of the flight's workspace fork. */
	repo: string;
	baseCommit: string;
	plan: string | null;
	createdAt: number;
	updatedAt: number;
	landedAt: number | null;
	attempts: number;
	/** Files the flight has touched so far (from its last landing attempt). */
	touched: string[];
	/** When its workspace fork was deleted, an hour after the flight ended; null while it exists. */
	retiredAt: number | null;
}

export type ClearanceStatus = "granted" | "holding";

export interface Clearance {
	id: string;
	flightId: string;
	target: string;
	status: ClearanceStatus;
	reason: string | null;
	createdAt: number;
	expiresAt: number;
}

/** review: green, but touches code the project's policy reserves for a human decision. */
export type LandingStatus = "queued" | "merging" | "verifying" | "review" | "landed" | "conflict" | "failed" | "rejected";

export interface ReviewState {
	/** Protected targets (from the project policy) this landing touches. */
	required: string[];
	decision: "approved" | "rejected" | null;
	reviewer: string | null;
	comment: string | null;
	at: number | null;
}

/** An AI reviewer's verdict on a landing's change. "skipped": it gave none, and the tests alone decided. */
export interface AiReview {
	/** The Workers AI model that reviewed it, from another family than the agent's. */
	model: string;
	verdict: "approve" | "flag" | "skipped";
	reason: string;
	concerns: string[];
	ms: number;
}

export interface ConflictReport {
	path: string;
	kind: "content" | "modify/delete" | "binary";
	hunks: {
		baseStart: number;
		baseLines: string[];
		ours: string[];
		theirs: string[];
		symbols: string[];
	}[];
	/** Flights whose landings changed these lines on trunk since this flight's base. */
	causedBy: { flightId: string; code: string; callsign: string; intent: string; commit: string }[];
}

export interface TestResult {
	file: string;
	name: string;
	ok: boolean;
	ms?: number;
	error?: string;
	skipped?: boolean;
}

export interface TestReport {
	passed: number;
	failed: number;
	skipped?: number;
	/** Every result for small suites; only the failures (up to 50) for big ones. */
	results: TestResult[];
	/** Load-time failure (syntax error, missing import) for the whole suite. */
	error?: string;
	ms: number;
	/** Number of landings verified together in this run (a train), when more than one. */
	train?: number;
}

export interface FileChange {
	path: string;
	status: "added" | "modified" | "deleted";
	symbols: string[];
	additions: number;
	deletions: number;
	/**
	 * Compact diff for reviewers (truncated: `cut` marks a hunk cut short). The AI reviewer's copy also has each
	 * hunk's symbols and the unchanged lines around it.
	 */
	hunks?: { start: number; removed: string[]; added: string[]; cut?: boolean; symbols?: string[]; before?: string[]; after?: string[] }[];
	/** Not text (or not readable as text), so its lines can't be shown. */
	binary?: boolean;
	/** A changed file mode, "100644 → 100755"; a symlink's is 120000. */
	mode?: string;
}

export interface Landing {
	id: string;
	seq: number;
	flightId: string;
	status: LandingStatus;
	summary: string;
	forkHead: string | null;
	trunkBefore: string | null;
	trunkAfter: string | null;
	changes: FileChange[];
	conflicts: ConflictReport[];
	tests: TestReport | null;
	error: string | null;
	unioned: number;
	review: ReviewState | null;
	/** The AI reviewer's verdict, when the project's policy asks for one. A flag sends the landing to a person. */
	aiReview?: AiReview | null;
	createdAt: number;
	finishedAt: number | null;
	/** The crossing (e.g. "CX-003") this landing is one sector's part of: it lands with the others or not at all. */
	crossing?: string | null;
}

export type ContrailKind = "intent" | "plan" | "decision" | "note" | "radio" | "clearance" | "landing" | "conflict" | "test" | "handoff";

export interface ContrailEntry {
	id: number;
	flightId: string;
	agentId: string | null;
	kind: ContrailKind;
	text: string;
	refs: string[];
	at: number;
}

export interface TrunkFile {
	path: string;
	lines: number;
	symbols: { name: string; kind: string; start: number; end: number }[];
}

export interface TrunkState {
	head: string | null;
	files: TrunkFile[];
	landedCount: number;
}

export interface ProjectInfo {
	slug: string;
	name: string;
	description: string;
	trunkRepo: string;
	createdAt: number;
	public: boolean;
	/** Anyone may launch a few edge agents and join with the published join code. */
	playground?: boolean;
	/** A sector of a bigger codebase: the Center it belongs to, and the directory prefix it owns. */
	center?: string;
	prefix?: string;
}

/** One sector as the Center sees it: an airspace that owns a directory of the monorepo. */
export interface SectorInfo {
	slug: string;
	name: string;
	prefix: string;
	trunkRepo: string;
}

/** A monorepo split into sectors. The Center composes the sector trunks into one trunk. */
export interface CenterInfo {
	slug: string;
	name: string;
	description: string;
	trunkRepo: string;
	sectors: SectorInfo[];
	createdAt: number;
	public: boolean;
}

/** What a sector's Tower reports to the Center page. */
export interface SectorSummary {
	inAir: number;
	holding: number;
	landed: number;
	intents: number;
	landings: number;
	conflictsPrevented: number;
	agents: number;
	head: string | null;
	firstTakeOff: number | null;
	lastLanding: number | null;
}

export interface CenterSnapshot {
	center: CenterInfo;
	/** The composed monorepo trunk and when it last caught up with the sectors. */
	head: string | null;
	composedAt: number | null;
	/** Sector heads that landed but are not composed yet. */
	behind: number;
	compositions: number;
	sectors: (SectorInfo & { summary: SectorSummary | null })[];
	/** The latest crossings, newest first; how many crossings landed in all; how many crossing intents wait for an agent. */
	crossings: Crossing[];
	landedCrossings: number;
	openIntents: number;
}

/** An agent that flies crossings. In each sector, its legs fly under a callsign of their own there. */
export interface CenterAgent {
	id: string;
	callsign: string;
	kind: AgentKind;
	model: string | null;
	joinedAt: number;
	lastSeenAt: number;
}

/** Work for a crossing: a change across sectors. */
export interface CenterIntent {
	seq: number;
	title: string;
	body: string;
	status: "open" | "assigned" | "landed";
	crossing: string | null;
	createdBy: string;
	createdAt: number;
	landedCommit: string | null;
}

/** One sector's part of a crossing: a flight in that sector, whose landing lands with the others or not at all. */
export interface CrossingLeg {
	sector: string;
	name: string;
	prefix: string;
	agentId: string;
	flightId: string;
	flight: string;
	repo: string;
	/** Its flight is over: its part landed, or the crossing landed without a change in this sector. */
	closed?: boolean;
	/** Its part of the latest landing attempt. */
	landing: {
		status: LandingStatus;
		commit: string | null;
		error: string | null;
		tests: { passed: number; failed: number } | null;
		conflicts: ConflictReport[];
		changes: number;
	} | null;
}

export type CrossingStatus = "airborne" | "approach" | "landed" | "diverted" | "aborted";

/** One change to a sectored monorepo that spans several sectors and lands in all of them at once, or in none. */
export interface Crossing {
	code: string;
	seq: number;
	agentId: string;
	callsign: string;
	model: string | null;
	intent: { seq: number; title: string; body: string };
	status: CrossingStatus;
	/** Its workspace: a fork of the monorepo trunk. */
	repo: string;
	base: string;
	plan: string | null;
	/** Its plan, decisions and notes; every leg's contrail gets them too. */
	contrail: { kind: ContrailKind; text: string; at: number }[];
	legs: CrossingLeg[];
	attempts: number;
	/** The latest landing attempt: `commit` is the monorepo commit it became. */
	landing: { status: "landing" | "landed" | "failed"; summary: string; at: number; finishedAt: number | null; commit: string | null; error: string | null } | null;
	createdAt: number;
	updatedAt: number;
	landedAt: number | null;
	retiredAt: number | null;
	/** It landed over more than one attempt (a sector's runway restarted between the two phases), so not at once. */
	inParts?: boolean;
	/** Sectors where an earlier attempt landed its part, whose legs were opened again since. */
	landedBefore?: string[];
}

/** Everything the Radar UI needs to render a project. */
export interface RadarSnapshot {
	project: ProjectInfo;
	agents: Agent[];
	intents: Intent[];
	flights: Flight[];
	clearances: Clearance[];
	landings: Landing[];
	trunk: TrunkState;
	events: RadarEvent[];
	/** planned: take-offs routed around an intent whose code was already in the air. holdMs: time flights spent holding. */
	stats: { repos: number; landings: number; conflictsPrevented: number; conflictsResolved: number; unioned: number; planned: number; holdMs: number };
}

export interface RadarEvent {
	seq: number;
	at: number;
	type: string;
	flightId?: string;
	agentId?: string;
	text: string;
	data?: Record<string, unknown>;
}
