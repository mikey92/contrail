// A crossing's change, split by sector. The change was made in a fork of the monorepo trunk; each sector
// lands its part through its own runway, which merges onto the sector's own history. So each part becomes
// one commit on that history, on top of the sector commit the monorepo had composed where the workspace
// branched off: the runway's three-way merge then sees exactly what the crossing changed in that sector.
import { commit, findSubtree, listTree, type Person, type Repo, subtreeOid, writeFlatTree } from "../runway/gitops";
import { applyChanges, type PathChange } from "./compose";

/**
 * One sector's part of a crossing as a commit on the sector's history, or null when the sector's trunk
 * (`sectorHead`) has every change already, as after an attempt that landed in this sector but not in another.
 */
export async function sectorPart(
	r: Repo,
	input: { base: string; sectorHead: string; prefix: string; changes: PathChange[]; message: string; author: Person; committer: Person },
): Promise<string | null> {
	const current = await listTree(r, input.sectorHead);
	// The same content and the same mode: a change that only makes a file executable is still a change.
	const same = (c: PathChange) => {
		const have = current.get(c.path);
		return (have?.oid ?? null) === (c.item?.oid ?? null) && (!have || !c.item || have.mode === c.item.mode);
	};
	if (input.changes.every(same)) return null;
	const parent = await findSubtree(r, input.sectorHead, input.prefix, await subtreeOid(r, input.base, input.prefix));
	if (!parent) throw new Error("no commit of the sector matches what the workspace started from");
	const tree = await writeFlatTree(r, applyChanges(await listTree(r, parent), input.changes));
	return commit(r, { tree, parents: [parent], message: input.message, author: input.author, committer: input.committer });
}
