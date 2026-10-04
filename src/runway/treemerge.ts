// Three-way merge of whole trees: trunk ("ours") × a flight's workspace ("theirs") over their merge base.
import { lineChanges, mergeText, touchedSymbols } from "../git/merge";
import type { ConflictReport, FileChange } from "../shared/types";
import { type FlatTree, listTree, readText, type Repo, type TreeItem, writeText } from "./gitops";

export interface TreeMergeResult {
	files: FlatTree;
	/** What the flight changed relative to the merge base. */
	changes: FileChange[];
	conflicts: ConflictReport[];
	unioned: number;
}

const same = (a?: TreeItem, b?: TreeItem) => (!a && !b) || (!!a && !!b && a.oid === b.oid && a.mode === b.mode);

export async function describeChanges(repo: Repo, base: FlatTree, next: FlatTree): Promise<FileChange[]> {
	const changes: FileChange[] = [];
	const paths = new Set([...base.keys(), ...next.keys()]);
	for (const path of [...paths].sort()) {
		const b = base.get(path);
		const n = next.get(path);
		if (same(b, n)) continue;
		const before = b ? await readText(repo, b.oid) : null;
		const after = n ? await readText(repo, n.oid) : null;
		const status: FileChange["status"] = !b ? "added" : !n ? "deleted" : "modified";
		let additions = 0;
		let deletions = 0;
		if (before !== null && after !== null) {
			for (const h of lineChanges(before, after)) {
				additions += h.added.length;
				deletions += h.removed.length;
			}
		} else {
			additions = after?.split("\n").length ?? 0;
			deletions = before?.split("\n").length ?? 0;
		}
		changes.push({ path, status, symbols: touchedSymbols(path, before, after), additions, deletions });
	}
	return changes;
}

export async function mergeTrees(repo: Repo, baseOid: string, oursOid: string, theirsOid: string): Promise<TreeMergeResult> {
	const [B, O, T] = await Promise.all([listTree(repo, baseOid), listTree(repo, oursOid), listTree(repo, theirsOid)]);
	const files: FlatTree = new Map(O);
	const conflicts: ConflictReport[] = [];
	let unioned = 0;

	for (const path of new Set([...B.keys(), ...O.keys(), ...T.keys()])) {
		const b = B.get(path);
		const o = O.get(path);
		const t = T.get(path);
		if (same(t, b) || same(o, t)) continue; // flight didn't touch it, or both made the same change
		if (same(o, b)) {
			// Only the flight changed this path.
			if (t) files.set(path, t);
			else files.delete(path);
			continue;
		}
		// Both trunk and the flight changed this path differently.
		if (!o || !t) {
			conflicts.push({ path, kind: "modify/delete", hunks: [], causedBy: [] });
			continue;
		}
		const [bText, oText, tText] = await Promise.all([b ? readText(repo, b.oid) : "", readText(repo, o.oid), readText(repo, t.oid)]);
		if (bText === null || oText === null || tText === null) {
			conflicts.push({ path, kind: "binary", hunks: [], causedBy: [] });
			continue;
		}
		const merged = mergeText(path, bText, oText, tText);
		unioned += merged.unioned;
		if (!merged.clean) {
			conflicts.push({ path, kind: "content", hunks: merged.conflicts, causedBy: [] });
			continue;
		}
		files.set(path, { oid: await writeText(repo, merged.text), mode: t.mode });
	}

	return { files, changes: await describeChanges(repo, B, T), conflicts, unioned };
}
