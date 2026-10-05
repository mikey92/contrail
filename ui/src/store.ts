import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import type { Agent, Clearance, ContrailEntry, Flight, Intent, Landing, RadarEvent, RadarSnapshot, TrunkState } from "../../src/shared/types";

export type Stats = RadarSnapshot["stats"];

export interface Flash {
	id: number;
	targets: string[];
	kind: "landed" | "conflict" | "failed" | "holding" | "planned";
	at: number;
}

export interface RadarState {
	ready: boolean;
	connected: boolean;
	/** The project does not exist (or is private). */
	missing: boolean;
	/** A replay or fixture that could not be fetched or read. */
	failed: boolean;
	project: RadarSnapshot["project"] | null;
	agents: Record<string, Agent>;
	intents: Record<string, Intent>;
	flights: Record<string, Flight>;
	clearances: Clearance[];
	landings: Record<string, Landing>;
	trunk: TrunkState;
	events: RadarEvent[];
	/** The latest key events (KEY_EVENTS), kept apart so a flood of routine updates can't push them out. */
	keyEvents: RadarEvent[];
	/** Routine events received so far: what the feed hides by default. */
	routine: number;
	stats: Stats;
	flashes: Flash[];
	contrail: ContrailEntry[];
}

type Action =
	| { type: "snapshot"; snapshot: RadarSnapshot }
	| { type: "patch"; entity: string; value: any }
	| { type: "event"; event: RadarEvent }
	| { type: "connected"; value: boolean }
	| { type: "missing" }
	| { type: "failed" }
	| { type: "expire" }
	/** Back to an empty radar, before a replay seeks backwards. */
	| { type: "reset" }
	/** Several actions, one render. `quiet` drops their flashes (a replay seeking). */
	| { type: "batch"; actions: Action[]; quiet?: boolean };

const empty: RadarState = {
	ready: false,
	connected: false,
	missing: false,
	failed: false,
	project: null,
	agents: {},
	intents: {},
	flights: {},
	clearances: [],
	landings: {},
	trunk: { head: null, files: [], landedCount: 0 },
	events: [],
	keyEvents: [],
	routine: 0,
	stats: { repos: 0, landings: 0, conflictsPrevented: 0, conflictsResolved: 0, unioned: 0, planned: 0, holdMs: 0 },
	flashes: [],
	contrail: [],
};

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));

/** What the feed shows by default: outcomes, waits, plans and decisions, not every taxi, take-off and alert. */
const KEY_EVENTS = new Set([
	"landing.landed",
	"landing.ready",
	"landing.conflict",
	"landing.failed",
	"landing.review",
	"landing.reviewed",
	"clearance.holding",
	"flight.planned",
	"project.reset",
	"contrail.read",
	"edge.launched",
	"agent.joined",
	"contrail.plan",
	"contrail.decision",
	"contrail.note",
	"radio",
]);
const isKeyEvent = (type: string) => KEY_EVENTS.has(type);

// The Tower hands out twelve pastel agent colors. Each becomes a CSS variable (--agent-0 … --agent-11)
// whose value suits the appearance: a deeper ink of the same hue on paper, the pastel itself in Dark Mode.
const PALETTE = ["#4fd1c5", "#f6ad55", "#9f7aea", "#68d391", "#fc8181", "#63b3ed", "#f687b3", "#faf089", "#81e6d9", "#d6bcfa", "#fbd38d", "#90cdf4"];
export const tone = (color: string | undefined) => {
	if (!color) return "var(--agent-none)";
	const i = PALETTE.indexOf(color.toLowerCase());
	return i >= 0 ? `var(--agent-${i})` : color;
};
export const toned = <T extends { color: string }>(a: T): T => ({ ...a, color: tone(a.color) });
let flashSeq = 0;

function flashesFor(event: RadarEvent): Flash[] {
	const data = (event.data ?? {}) as any;
	if (event.type === "landing.landed" && Array.isArray(data.changes)) {
		const targets = data.changes.flatMap((c: any) => (c.symbols?.length ? c.symbols.map((s: string) => `${c.path}#${s}`) : [c.path]));
		return [{ id: ++flashSeq, targets, kind: "landed", at: Date.now() }];
	}
	if (event.type === "landing.conflict" && Array.isArray(data.conflicts)) {
		const targets = data.conflicts.flatMap((c: any) => {
			const syms = [...new Set((c.hunks ?? []).flatMap((h: any) => h.symbols ?? []))] as string[];
			return syms.length ? syms.map((s) => `${c.path}#${s}`) : [c.path];
		});
		return [{ id: ++flashSeq, targets, kind: "conflict", at: Date.now() }];
	}
	if (event.type === "flight.planned" && Array.isArray(data.deferred)) {
		return [{ id: ++flashSeq, targets: [...new Set<string>(data.deferred.map((d: any) => d.target))].slice(0, 6), kind: "planned", at: Date.now() }];
	}
	if (event.type === "clearance.holding" && Array.isArray(data.holding)) {
		return [{ id: ++flashSeq, targets: data.holding.map((h: any) => h.target), kind: "holding", at: Date.now() }];
	}
	return [];
}

function reducer(state: RadarState, action: Action): RadarState {
	switch (action.type) {
		case "snapshot": {
			const s = action.snapshot;
			return {
				...state,
				ready: true,
				project: s.project,
				agents: byId(s.agents.map(toned)),
				intents: byId(s.intents),
				flights: byId(s.flights),
				clearances: s.clearances,
				landings: byId(s.landings),
				trunk: s.trunk,
				events: s.events.slice(-300),
				keyEvents: s.events.filter((e) => isKeyEvent(e.type)).slice(-300),
				routine: s.events.filter((e) => !isKeyEvent(e.type)).length,
				stats: s.stats,
			};
		}
		case "patch": {
			const v = action.value;
			switch (action.entity) {
				case "agent":
					return { ...state, agents: { ...state.agents, [v.id]: toned(v) } };
				case "intent":
					return { ...state, intents: { ...state.intents, [v.id]: v } };
				case "flight":
					return { ...state, flights: { ...state.flights, [v.id]: v } };
				case "clearances":
					return { ...state, clearances: v };
				case "landing":
					return { ...state, landings: { ...state.landings, [v.id]: { ...state.landings[v.id], ...v } } };
				case "trunk":
					return { ...state, trunk: v };
				case "stats":
					return { ...state, stats: { ...state.stats, ...v } };
				case "contrail":
					return { ...state, contrail: [...state.contrail.slice(-200), v] };
				default:
					return state;
			}
		}
		case "event": {
			const e = action.event;
			if (state.events.some((x) => x.seq === e.seq)) return state;
			const key = isKeyEvent(e.type);
			return {
				...state,
				events: [...state.events.slice(-299), e],
				keyEvents: key ? [...state.keyEvents.slice(-299), e] : state.keyEvents,
				routine: key ? state.routine : state.routine + 1,
				flashes: [...state.flashes, ...flashesFor(e)],
			};
		}
		case "connected":
			return { ...state, connected: action.value };
		case "missing":
			return { ...state, missing: true };
		case "failed":
			return { ...state, failed: true };
		case "reset":
			return { ...empty, connected: state.connected };
		case "batch": {
			const next = action.actions.reduce(reducer, state);
			return action.quiet ? { ...next, flashes: [] } : next;
		}
		case "expire": {
			const cutoff = Date.now() - 4000;
			const flashes = state.flashes.filter((f) => f.at > cutoff);
			return flashes.length === state.flashes.length ? state : { ...state, flashes };
		}
	}
}

/** A line of a recorded radar stream (scripts/tap.mjs): the message `m`, `t` ms after recording began. */
interface Line {
	t: number;
	m: any;
}

/** A stream message, live or recorded, as a reducer action. */
function toAction(m: any): Action | null {
	if (m?.kind === "snapshot") return { type: "snapshot", snapshot: m.snapshot };
	if (m?.kind === "patch") return { type: "patch", entity: m.entity, value: m.value };
	if (m?.kind === "event") return { type: "event", event: m.event };
	return null;
}

/** In a replay or fixture, the recorded time of the moment on screen: relTime() counts ages back from it. */
let recordedNow: number | null = null;

/**
 * Server time at recording time 0. Events carry the server's clock and reach the recorder a few ms later,
 * so the median of `at - t` over the events estimates it; without events, the snapshot's last event does.
 */
function recordingStart(lines: Line[]): number | null {
	const offsets = lines
		.filter((l) => l.m?.kind === "event" && typeof l.m.event?.at === "number")
		.map((l) => l.m.event.at - l.t)
		.sort((a, b) => a - b);
	if (offsets.length) return offsets[offsets.length >> 1];
	const snap = lines.find((l) => l.m?.kind === "snapshot");
	const last = Math.max(0, ...(snap?.m.snapshot.events ?? []).map((e: RadarEvent) => e.at));
	return snap && last ? last - snap.t : null;
}

/** What replay controls need from a recorded run: a clock over recording time. */
export interface ReplayClock {
	readonly t: number;
	readonly total: number;
	readonly speed: number;
	readonly playing: boolean;
	readonly ended: boolean;
	subscribe(fn: () => void): () => void;
	toggle(): void;
	restart(): void;
	seek(t: number): void;
	setSpeed(speed: number): void;
}

/**
 * Plays a recorded radar stream on a clock. Every tick moves recording time on by the elapsed time ×
 * speed and applies all the lines it passed as one batch: one render per tick, however busy the run.
 */
export class Replay implements ReplayClock {
	/** Recording time on screen, ms. */
	t: number;
	readonly start: number;
	readonly total: number;
	speed: number;
	playing = true;
	private next = 0;
	private last = performance.now();
	private timer: ReturnType<typeof setInterval>;
	private listeners = new Set<() => void>();

	constructor(
		private lines: Line[],
		private dispatch: (action: Action) => void,
		/** Server time at recording time 0, for recorded ages. */
		private base: number | null,
		from: number,
		speed: number,
	) {
		this.start = lines[0].t;
		this.total = lines[lines.length - 1].t;
		this.speed = speed;
		this.t = Math.min(this.total, Math.max(this.start, from));
		// Everything before `from` at once, without animation.
		this.advance(true);
		if (this.ended) this.playing = false;
		this.timer = setInterval(() => this.tick(), 50);
	}

	get ended() {
		return this.next >= this.lines.length;
	}

	subscribe(fn: () => void) {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	/** Play or pause; at the end, play again from the start. */
	toggle() {
		if (this.ended) return this.restart();
		this.playing = !this.playing;
		this.changed();
	}

	setSpeed(speed: number) {
		this.speed = speed;
		this.changed();
	}

	restart() {
		this.playing = true;
		this.seek(this.start);
	}

	/** Jumps to recording time `t` without animation: forwards applies the lines in between, backwards rebuilds from the start. */
	seek(t: number) {
		this.t = Math.min(this.total, Math.max(this.start, t));
		const back = this.next > 0 && this.lines[this.next - 1].t > this.t;
		if (back) this.next = 0;
		this.advance(true, back);
		if (this.ended) this.playing = false;
		this.changed();
	}

	stop() {
		clearInterval(this.timer);
		recordedNow = null;
	}

	private tick() {
		const now = performance.now();
		// A hidden tab ticks about once a second: catch up at most that much at a time.
		const elapsed = Math.min(1000, now - this.last);
		this.last = now;
		if (!this.playing) return;
		this.t = Math.min(this.total, this.t + elapsed * this.speed);
		this.advance(false);
		if (this.ended) this.playing = false;
		this.changed();
	}

	/** Applies every line up to the clock in one batch. */
	private advance(quiet: boolean, reset = false) {
		const actions: Action[] = reset ? [{ type: "reset" }] : [];
		while (this.next < this.lines.length && this.lines[this.next].t <= this.t) {
			const action = toAction(this.lines[this.next++].m);
			if (action) actions.push(action);
		}
		if (actions.length) this.dispatch({ type: "batch", actions, quiet });
		if (this.base !== null) recordedNow = this.base + this.t;
	}

	private changed() {
		for (const fn of this.listeners) fn();
	}
}

/**
 * Plays a recorded time series on a clock: `current` is the latest sample at the clock's time. The
 * monorepo page uses it for a sectored run, sampled once a second.
 */
export class SampleReplay<S extends { t: number }> implements ReplayClock {
	t: number;
	readonly start: number;
	readonly total: number;
	speed: number;
	playing = true;
	private last = performance.now();
	private timer: ReturnType<typeof setInterval>;
	private listeners = new Set<() => void>();

	constructor(
		readonly samples: S[],
		from: number,
		speed: number,
	) {
		this.start = samples[0].t;
		this.total = samples[samples.length - 1].t;
		this.speed = speed;
		this.t = Math.min(this.total, Math.max(this.start, from));
		if (this.ended) this.playing = false;
		this.timer = setInterval(() => this.tick(), 100);
	}

	get ended() {
		return this.t >= this.total;
	}

	/** The latest sample at or before the clock. */
	get current(): S {
		return this.at(this.t);
	}

	/** The latest sample at or before recording time `t`. */
	at(t: number): S {
		let lo = 0;
		let hi = this.samples.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (this.samples[mid].t <= t) lo = mid;
			else hi = mid - 1;
		}
		return this.samples[lo];
	}

	subscribe(fn: () => void) {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}

	toggle() {
		if (this.ended) return this.restart();
		this.playing = !this.playing;
		this.changed();
	}

	setSpeed(speed: number) {
		this.speed = speed;
		this.changed();
	}

	restart() {
		this.playing = true;
		this.seek(this.start);
	}

	seek(t: number) {
		this.t = Math.min(this.total, Math.max(this.start, t));
		if (this.ended) this.playing = false;
		this.changed();
	}

	stop() {
		clearInterval(this.timer);
	}

	private tick() {
		const now = performance.now();
		const elapsed = Math.min(1000, now - this.last);
		this.last = now;
		if (!this.playing) return;
		this.t = Math.min(this.total, this.t + elapsed * this.speed);
		if (this.ended) this.playing = false;
		this.changed();
	}

	private changed() {
		for (const fn of this.listeners) fn();
	}
}

/** A recording from this site only (e.g. /replays/ramda.jsonl.gz), as text; gzipped recordings are unpacked. */
export async function fetchRecording(path: string | null): Promise<string> {
	if (!path || !path.startsWith("/") || path.startsWith("//")) throw new Error("not a recording on this site");
	const res = await fetch(path);
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return new TextDecoder().decode(bytes);
	return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

/** Re-renders the caller when `pick` of the replay changes: the controls follow its clock, the radar only its end. */
export function useReplay<R extends ReplayClock, T>(replay: R | null, pick: (r: R) => T): T | undefined {
	const [, rerender] = useState(0);
	const value = replay ? pick(replay) : undefined;
	const shown = useRef(value);
	shown.current = value;
	useEffect(() => replay?.subscribe(() => pick(replay) !== shown.current && rerender((n) => n + 1)), [replay]);
	return value;
}

/** Server wording, made plain for people: "1 test(s) failed" (in older records) reads "1 test failed". */
export const tidy = (text: string) => text.replace(/\b(\d+) test\(s\)/g, (_, n: string) => `${n} test${n === "1" ? "" : "s"}`);

/** Live state for a project: snapshot over WebSocket, then patches and events; reconnects. Or a recorded run. */
export function useRadar(slug: string, fixture: string | null) {
	const [state, dispatch] = useReducer(reducer, empty);
	const [replay, setReplay] = useState<Replay | null>(null);

	useEffect(() => {
		const timer = setInterval(() => dispatch({ type: "expire" }), 1000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const params = new URLSearchParams(location.search);
		const replayParam = params.get("replay");
		if (replayParam !== null) {
			// Replays a recorded radar stream (scripts/tap.mjs) at `speed`×, starting at `from` seconds.
			const speed = Number(params.get("speed") ?? 1);
			const from = Number(params.get("from") ?? 0) * 1000;
			let cancelled = false;
			let player: Replay | null = null;
			const timers: number[] = [];
			fetchRecording(replayParam)
				.then((text) => {
					if (cancelled) return;
					const lines = text.trim().split("\n").map((l) => JSON.parse(l) as Line);
					if (!lines.some((l) => l.m?.kind === "snapshot")) throw new Error("no snapshot in the recording");
					const base = recordingStart(lines);
					// Filming (video/scenes.mjs): `&paused` waits for window.__replayStart() and `&map` pins recorded
					// seconds to playback seconds, so each line keeps its own timer, as the video was filmed.
					if (params.has("paused") || params.has("map")) {
						const apply = (l: Line) => {
							if (base !== null) recordedNow = base + l.t;
							const action = toAction(l.m);
							if (action) dispatch(action);
						};
						// Fast-forward everything before `from` without animation.
						for (const l of lines) if (l.t <= from) apply(l);
						dispatch({ type: "connected", value: true });
						// `&map=21.3:3,35:8.5` pins recorded seconds to playback seconds (piecewise linear, then `speed`).
						const pins = [[from, 0], ...(params.get("map") ?? "").split(",").filter(Boolean).map((p) => p.split(":").map((x) => Number(x) * 1000))];
						const playbackAt = (t: number) => {
							for (let i = 1; i < pins.length; i++) {
								const [a, pa] = pins[i - 1];
								const [b, pb] = pins[i];
								if (t <= b) return pa + ((t - a) * (pb - pa)) / Math.max(1, b - a);
							}
							const [a, pa] = pins[pins.length - 1];
							return pa + (t - a) / speed;
						};
						const play = () => {
							for (const l of lines) {
								if (l.t <= from) continue;
								timers.push(setTimeout(() => !cancelled && apply(l), playbackAt(l.t)) as unknown as number);
							}
						};
						if (params.has("paused")) (window as any).__replayStart = play;
						else play();
						return;
					}
					dispatch({ type: "connected", value: true });
					player = new Replay(lines, dispatch, base, Number.isFinite(from) ? from : 0, speed > 0 ? speed : 1);
					setReplay(player);
				})
				.catch(() => !cancelled && dispatch({ type: "failed" }));
			return () => {
				cancelled = true;
				player?.stop();
				for (const t of timers) clearTimeout(t);
				recordedNow = null;
			};
		}
		if (fixture) {
			let cancelled = false;
			fetch(`/fixtures/${fixture}.snapshot.json`)
				.then((r) => {
					if (!r.ok) throw new Error(`HTTP ${r.status}`);
					return r.json();
				})
				.then((snapshot: RadarSnapshot) => {
					if (cancelled) return;
					// A fixture is a moment of a past run: ages count back from its latest change.
					recordedNow = Math.max(0, ...snapshot.events.map((e) => e.at), ...snapshot.flights.map((f) => f.updatedAt)) || null;
					dispatch({ type: "snapshot", snapshot });
					dispatch({ type: "connected", value: true });
				})
				.catch(() => !cancelled && dispatch({ type: "failed" }));
			return () => {
				cancelled = true;
				recordedNow = null;
			};
		}
		let ws: WebSocket | null = null;
		let closed = false;
		let opened = false;
		let retry = 500;
		let ping: number | undefined;
		const connect = () => {
			const proto = location.protocol === "https:" ? "wss" : "ws";
			ws = new WebSocket(`${proto}://${location.host}/api/p/${slug}/live`);
			ws.onopen = () => {
				opened = true;
				retry = 500;
				dispatch({ type: "connected", value: true });
				ping = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25000) as unknown as number;
			};
			ws.onmessage = (m) => {
				if (m.data === "pong") return;
				const action = toAction(JSON.parse(m.data));
				if (action) dispatch(action);
			};
			ws.onclose = async () => {
				clearInterval(ping);
				dispatch({ type: "connected", value: false });
				if (closed) return;
				// A socket that never opened may mean there is no such project: ask once before retrying.
				if (!opened) {
					const res = await fetch(`/api/p/${slug}/join-info`).catch(() => null);
					if (res?.status === 404) {
						closed = true;
						dispatch({ type: "missing" });
						return;
					}
				}
				setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
			};
		};
		connect();
		return () => {
			closed = true;
			ws?.close();
		};
	}, [slug, fixture]);

	return { state, replay };
}

export const ACTIVE_STATUSES = ["taxiing", "airborne", "holding", "approach", "diverted"];

const STATUS_LABEL: Record<string, string> = { taxiing: "taxiing", airborne: "in the air", holding: "holding", approach: "landing", diverted: "diverted", landed: "landed", aborted: "aborted" };
export const statusLabel = (status: string) => STATUS_LABEL[status] ?? status;

/** Minutes and seconds, e.g. 3:36. */
export function duration(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function relTime(at: number, now = recordedNow ?? Date.now()): string {
	const s = Math.max(0, Math.round((now - at) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.round(m / 60)}h ago`;
}
