// Composing sector trunks into one monorepo trunk. Every sector owns a directory prefix and no prefix
// contains another, so replacing each sector's subtree with the sector's latest trunk never conflicts.
import type { FlatTree } from "../runway/gitops";

/** Prefixes are directories ("services/payments/") and none may contain another. */
export function checkPrefixes(prefixes: string[]): string | null {
	for (const p of prefixes) {
		if (!/^[\w.-]+(\/[\w.-]+)*\/$/.test(p) || p.split("/").includes("..")) return `bad prefix "${p}": use a directory such as "services/payments/"`;
	}
	if (new Set(prefixes).size !== prefixes.length) return "a prefix is listed twice";
	for (const a of prefixes) for (const b of prefixes) if (a !== b && b.startsWith(a)) return `prefixes overlap: "${a}" contains "${b}"`;
	return null;
}

/** The sector that owns a path, if any. */
export function ownerOf<T extends { prefix: string }>(path: string, sectors: T[]): T | null {
	return sectors.find((s) => path.startsWith(s.prefix)) ?? null;
}

/** The monorepo tree with each given sector's subtree replaced by that sector's own tree. */
export function composeTree(base: FlatTree, sectors: { prefix: string; tree: FlatTree }[]): FlatTree {
	const next: FlatTree = new Map();
	for (const [path, item] of base) if (!ownerOf(path, sectors)) next.set(path, item);
	// A sector only contributes paths under its own prefix: it cannot write into another sector.
	for (const s of sectors) for (const [path, item] of s.tree) if (path.startsWith(s.prefix)) next.set(path, item);
	return next;
}
