import { useEffect, useReducer, useRef } from "preact/hooks";
import type { Agent, Clearance, ContrailEntry, Flight, Intent, Landing, RadarEvent, RadarSnapshot, TrunkState } from "../../src/shared/types";

export type Stats = RadarSnapshot["stats"];

export interface Flash {
	id: number;
	targets: string[];
	kind: "landed" | "conflict" | "failed" | "holding";
	at: number;
}

export interface RadarState {
	ready: boolean;
	connected: boolean;
	project: RadarSnapshot["project"] | null;
	agents: Record<string, Agent>;
	intents: Record<string, Intent>;
	flights: Record<string, Flight>;
	clearances: Clearance[];
	landings: Record<string, Landing>;
	trunk: TrunkState;
	events: RadarEvent[];
	stats: Stats;
	flashes: Flash[];
	contrail: ContrailEntry[];
}

type Action =
	| { type: "snapshot"; snapshot: RadarSnapshot }
	| { type: "patch"; entity: string; value: any }
	| { type: "event"; event: RadarEvent }
	| { type: "connected"; value: boolean }
	| { type: "expire" };

const empty: RadarState = {
	ready: false,
	connected: false,
	project: null,
	agents: {},
	intents: {},
	flights: {},
	clearances: [],
	landings: {},
	trunk: { head: null, files: [], landedCount: 0 },
	events: [],
	stats: { repos: 0, landings: 0, conflictsPrevented: 0, conflictsResolved: 0, unioned: 0 },
	flashes: [],
	contrail: [],
};

const byId = <T extends { id: string }>(list: T[]) => Object.fromEntries(list.map((x) => [x.id, x]));
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
				agents: byId(s.agents),
				intents: byId(s.intents),
				flights: byId(s.flights),
				clearances: s.clearances,
				landings: byId(s.landings),
				trunk: s.trunk,
				events: s.events.slice(-300),
				stats: s.stats,
			};
		}
		case "patch": {
			const v = action.value;
			switch (action.entity) {
				case "agent":
					return { ...state, agents: { ...state.agents, [v.id]: v } };
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
			if (state.events.some((e) => e.seq === action.event.seq)) return state;
			return { ...state, events: [...state.events.slice(-299), action.event], flashes: [...state.flashes, ...flashesFor(action.event)] };
		}
		case "connected":
			return { ...state, connected: action.value };
		case "expire": {
			const cutoff = Date.now() - 4000;
			const flashes = state.flashes.filter((f) => f.at > cutoff);
			return flashes.length === state.flashes.length ? state : { ...state, flashes };
		}
	}
}

/** Live state for a project: snapshot over WebSocket, then patches and events; reconnects. */
export function useRadar(slug: string, fixture: string | null) {
	const [state, dispatch] = useReducer(reducer, empty);
	const replay = useRef<number | null>(null);

	useEffect(() => {
		const timer = setInterval(() => dispatch({ type: "expire" }), 1000);
		return () => clearInterval(timer);
	}, []);

	useEffect(() => {
		const params = new URLSearchParams(location.search);
		const replayUrl = params.get("replay");
		if (replayUrl) {
			// Replays a recorded radar stream (scripts/tap.mjs) at `speed`×, starting at `from` seconds.
			const speed = Number(params.get("speed") ?? 1);
			const from = Number(params.get("from") ?? 0) * 1000;
			let cancelled = false;
			const timers: number[] = [];
			fetch(replayUrl)
				.then((r) => r.text())
				.then((text) => {
					const lines = text.trim().split("\n").map((l) => JSON.parse(l) as { t: number; m: any });
					const apply = (m: any) => {
						if (m.kind === "snapshot") dispatch({ type: "snapshot", snapshot: m.snapshot });
						else if (m.kind === "patch") dispatch({ type: "patch", entity: m.entity, value: m.value });
						else if (m.kind === "event") dispatch({ type: "event", event: { ...m.event, at: Date.now() } });
					};
					// Fast-forward everything before `from` without animation.
					for (const l of lines) if (l.t <= from) apply(l.m);
					dispatch({ type: "connected", value: true });
					for (const l of lines) {
						if (l.t <= from) continue;
						timers.push(setTimeout(() => !cancelled && apply(l.m), (l.t - from) / speed) as unknown as number);
					}
				});
			return () => {
				cancelled = true;
				for (const t of timers) clearTimeout(t);
			};
		}
		if (fixture) {
			fetch(`/fixtures/${fixture}.snapshot.json`)
				.then((r) => r.json())
				.then((snapshot) => {
					dispatch({ type: "snapshot", snapshot });
					dispatch({ type: "connected", value: true });
				});
			return () => {
				if (replay.current) clearInterval(replay.current);
			};
		}
		let ws: WebSocket | null = null;
		let closed = false;
		let retry = 500;
		let ping: number | undefined;
		const connect = () => {
			const proto = location.protocol === "https:" ? "wss" : "ws";
			ws = new WebSocket(`${proto}://${location.host}/api/p/${slug}/live`);
			ws.onopen = () => {
				retry = 500;
				dispatch({ type: "connected", value: true });
				ping = setInterval(() => ws?.readyState === 1 && ws.send("ping"), 25000) as unknown as number;
			};
			ws.onmessage = (m) => {
				if (m.data === "pong") return;
				const msg = JSON.parse(m.data);
				if (msg.kind === "snapshot") dispatch({ type: "snapshot", snapshot: msg.snapshot });
				else if (msg.kind === "patch") dispatch({ type: "patch", entity: msg.entity, value: msg.value });
				else if (msg.kind === "event") dispatch({ type: "event", event: msg.event });
			};
			ws.onclose = () => {
				clearInterval(ping);
				dispatch({ type: "connected", value: false });
				if (!closed) setTimeout(connect, (retry = Math.min(retry * 2, 8000)));
			};
		};
		connect();
		return () => {
			closed = true;
			ws?.close();
		};
	}, [slug, fixture]);

	return state;
}

export const ACTIVE_STATUSES = ["taxiing", "airborne", "holding", "approach", "diverted"];

export function relTime(at: number): string {
	const s = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	return `${Math.round(m / 60)}h ago`;
}
