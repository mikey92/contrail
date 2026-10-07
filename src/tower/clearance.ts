// Clearance targets name the part of the codebase a flight intends to change:
//   "src/cart.js"                 the whole file
//   "src/cart.js#applyDiscount"   one function
//   "src/cart.js#Cart"            a class (covers all of its methods)
//   "src/cart.js#Cart.addItem"    one method
//   "src/payments/"               a directory prefix
// Two targets collide when they could touch the same lines.

export interface Target {
	path: string;
	symbol: string | null;
	isDir: boolean;
}

export function parseTarget(raw: string): Target {
	const trimmed = raw.trim().replace(/^\.\//, "").replace(/^\/+/, "");
	const hash = trimmed.indexOf("#");
	const path = (hash === -1 ? trimmed : trimmed.slice(0, hash)).trim();
	const symbol = hash === -1 ? null : trimmed.slice(hash + 1).trim() || null;
	return { path, symbol, isDir: path.endsWith("/") || path === "" };
}

export function formatTarget(t: Target): string {
	return t.symbol ? `${t.path}#${t.symbol}` : t.path;
}

export function normalizeTarget(raw: string): string {
	return formatTarget(parseTarget(raw));
}

function symbolsOverlap(a: string, b: string): boolean {
	if (a === b) return true;
	// A class covers its members: "Cart" overlaps "Cart.addItem".
	return a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

export function targetsOverlap(rawA: string | Target, rawB: string | Target): boolean {
	const a = typeof rawA === "string" ? parseTarget(rawA) : rawA;
	const b = typeof rawB === "string" ? parseTarget(rawB) : rawB;
	if (a.isDir || b.isDir) {
		const dir = a.isDir ? a : b;
		const other = a.isDir ? b : a;
		return other.path.startsWith(dir.path) || (other.isDir && dir.path.startsWith(other.path));
	}
	if (a.path !== b.path) return false;
	if (!a.symbol || !b.symbol) return true;
	return symbolsOverlap(a.symbol, b.symbol);
}

export interface HeldTarget {
	target: string;
	flightId: string;
}

/** For each requested target, the held targets (owned by other flights) it collides with. */
export function findCollisions(requested: string[], held: HeldTarget[], selfFlightId: string) {
	const collisions: { target: string; with: HeldTarget }[] = [];
	for (const target of requested) {
		const t = parseTarget(target);
		for (const h of held) {
			if (h.flightId === selfFlightId) continue;
			if (targetsOverlap(t, h.target)) collisions.push({ target: formatTarget(t), with: h });
		}
	}
	return collisions;
}

/** A target another flight is cleared to change, as the runway sees it when a landing comes in. */
export interface HeldByOther {
	target: string;
	flight: string;
	callsign: string;
}

/**
 * The cleared targets of other flights that a landing's changes touch. Changes outside any function
 * (imports, top-level statements) only collide with a claim on the whole file.
 */
export function airspaceViolations(held: HeldByOther[], changes: { path: string; symbols: string[] }[]): HeldByOther[] {
	if (!held.length) return [];
	const touched = changes.flatMap((c) => (c.symbols.length ? c.symbols.map((sym) => `${c.path}#${sym}`) : [`${c.path}#(top)`]));
	return held.filter((h) => touched.some((t) => targetsOverlap(h.target, t)));
}

/**
 * The targets of a project's review policy that a landing's changes touch. Code outside any function
 * can change what the functions of its file do, so it counts as touching the whole file.
 */
export function policyTargetsTouched(policy: string[], changes: { path: string; symbols: string[] }[]): string[] {
	if (!policy.length) return [];
	const touched = changes.flatMap((c) => (c.symbols.length && !c.symbols.includes("(top)") ? c.symbols.map((sym) => `${c.path}#${sym}`) : [c.path]));
	return policy.filter((p) => touched.some((t) => targetsOverlap(p, t)));
}

/** A clearance as the Tower keeps it: granted (the flight may change the code) or holding (it waits for it). */
export interface Claim {
	id: string;
	flightId: string;
	target: string;
	status: "granted" | "holding";
	createdAt: number;
}

/**
 * The flights each hold waits for. Flights cleared for overlapping code come first; then, first come first
 * served, flights that asked earlier for overlapping code and still hold for it, so a hold on a whole file
 * is not passed by every later claim on a function in it. A flight never queues behind one that already
 * waits for it, directly or through others: the two would wait for each other forever.
 */
export function holdQueue(claims: Claim[]): Map<string, string[]> {
	const granted = claims.filter((c) => c.status === "granted");
	const holds = claims.filter((c) => c.status === "holding").sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
	const edges = new Map<string, Set<string>>();
	const addEdge = (from: string, to: string) => {
		if (!edges.has(from)) edges.set(from, new Set());
		edges.get(from)!.add(to);
	};
	const reaches = (from: string, to: string) => {
		const seen = new Set([from]);
		const stack = [from];
		while (stack.length) {
			const f = stack.pop()!;
			if (f === to) return true;
			for (const n of edges.get(f) ?? []) {
				if (seen.has(n)) continue;
				seen.add(n);
				stack.push(n);
			}
		}
		return false;
	};
	const waits = new Map<string, Set<string>>();
	for (const h of holds) {
		const on = new Set(granted.filter((g) => g.flightId !== h.flightId && targetsOverlap(g.target, h.target)).map((g) => g.flightId));
		for (const f of on) addEdge(h.flightId, f);
		waits.set(h.id, on);
	}
	holds.forEach((h, k) => {
		const on = waits.get(h.id)!;
		for (const earlier of holds.slice(0, k)) {
			if (earlier.flightId === h.flightId || on.has(earlier.flightId) || !targetsOverlap(earlier.target, h.target)) continue;
			if (reaches(earlier.flightId, h.flightId)) continue;
			addEdge(h.flightId, earlier.flightId);
			on.add(earlier.flightId);
		}
	});
	return new Map([...waits].map(([id, on]) => [id, [...on]]));
}
