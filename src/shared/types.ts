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
	/** Compact diff for reviewers (truncated). */
	hunks?: { start: number; removed: string[]; added: string[] }[];
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
	createdAt: number;
	finishedAt: number | null;
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
	stats: { repos: number; landings: number; conflictsPrevented: number; conflictsResolved: number; unioned: number };
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
