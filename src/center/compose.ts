// Composing sector trunks into one monorepo trunk. Every sector owns a directory prefix and no prefix
// contains another, so replacing each sector's subtree with the sector's latest trunk never conflicts.
import type { FlatTree, TreeItem } from "../runway/gitops";

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

/** One path a crossing changed: its new tree entry, or null when it was deleted. */
export interface PathChange {
	path: string;
	item: TreeItem | null;
}

/**
 * What a crossing's workspace changed since `base`, by the sector that owns each path. Paths no sector
 * owns are listed apart: they cannot land through any runway.
 */
export function sectorChanges<T extends { slug: string; prefix: string }>(base: FlatTree, head: FlatTree, sectors: T[]): { bySector: Map<string, PathChange[]>; outside: string[] } {
	const bySector = new Map<string, PathChange[]>();
	const outside: string[] = [];
	for (const path of new Set([...base.keys(), ...head.keys()])) {
		const was = base.get(path);
		const now = head.get(path);
		if (was?.oid === now?.oid && was?.mode === now?.mode) continue;
		const owner = ownerOf(path, sectors);
		if (!owner) {
			outside.push(path);
			continue;
		}
		const list = bySector.get(owner.slug) ?? [];
		list.push({ path, item: now ?? null });
		bySector.set(owner.slug, list);
	}
	for (const list of bySector.values()) list.sort((a, b) => a.path.localeCompare(b.path));
	return { bySector, outside: outside.sort() };
}

/** A sector's tree with a crossing's changes to its paths applied. */
export function applyChanges(tree: FlatTree, changes: PathChange[]): FlatTree {
	const next: FlatTree = new Map(tree);
	for (const c of changes) {
		if (c.item) next.set(c.path, c.item);
		else next.delete(c.path);
	}
	return next;
}
