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
