import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { sectorChanges } from "../src/center/compose";
import { sectorPart } from "../src/center/crossing";
import { commit, type FlatTree, listTree, newRepo, type Repo, readText, writeFlatTree, writeText } from "../src/runway/gitops";

const who = { name: "T", email: "t@t" };

async function tree(r: Repo, files: Record<string, string>): Promise<FlatTree> {
	const flat: FlatTree = new Map();
	for (const [path, text] of Object.entries(files)) flat.set(path, { oid: await writeText(r, text), mode: "100644" });
	return flat;
}

async function commitFiles(r: Repo, files: Record<string, string>, parents: string[], message: string) {
	return commit(r, { tree: await writeFlatTree(r, await tree(r, files)), parents, message, author: who });
}

async function text(r: Repo, oid: string, path: string) {
	const item = (await listTree(r, oid)).get(path);
	return item ? readText(r, item.oid) : null;
}

/**
 * One repo holding what the Center's clone holds: the monorepo's history, sector a's own history and a
 * crossing's workspace. Sector a landed a1 after the monorepo composed a0; the workspace branched off m0.
 */
async function setup() {
	const r = newRepo();
	await git.init({ fs: r.fs, dir: r.dir, defaultBranch: "main" });
	const a0Files = { "a/src/x.js": "export const x = 1;\n", "a/src/y.js": "export const y = 1;\n" };
	const a0 = await commitFiles(r, a0Files, [], "a0");
	const a1 = await commitFiles(r, { ...a0Files, "a/src/y.js": "export const y = 2;\n" }, [a0], "a1");
	const m0Files = { "README.md": "# mono\n", ...a0Files, "b/src/z.js": "export const z = 1;\n" };
	const m0 = await commitFiles(r, m0Files, [], "m0");
	const fork = await commitFiles(r, { ...m0Files, "a/src/x.js": "export const x = 10;\n", "b/src/z.js": "export const z = 10;\n" }, [m0], "crossing");
	return { r, a0, a1, m0, fork };
}

describe("sectorPart", () => {
	it("builds the sector's part on the sector commit the workspace started from", async () => {
		const { r, a0, a1, m0, fork } = await setup();
		const { bySector } = sectorChanges(await listTree(r, m0), await listTree(r, fork), [
			{ slug: "a", prefix: "a/" },
			{ slug: "b", prefix: "b/" },
		]);
		expect(bySector.get("a")!.map((c) => c.path)).toEqual(["a/src/x.js"]);
		const part = await sectorPart(r, { base: m0, sectorHead: a1, prefix: "a/", changes: bySector.get("a")!, message: "part", author: who, committer: who });
		const { commit: c } = await git.readCommit({ fs: r.fs, dir: r.dir, oid: part! });
		// On a0, not on the sector's head a1: the runway's three-way merge keeps a1's own change to y.js.
		expect(c.parent).toEqual([a0]);
		expect(await text(r, part!, "a/src/x.js")).toBe("export const x = 10;\n");
		expect(await text(r, part!, "a/src/y.js")).toBe("export const y = 1;\n");
		// Only the sector's own paths: b's change goes to b.
		expect(await text(r, part!, "b/src/z.js")).toBeNull();
	});

	it("is null when the sector's trunk has the part already", async () => {
		const { r, a1, m0, fork } = await setup();
		const changes = sectorChanges(await listTree(r, m0), await listTree(r, fork), [{ slug: "a", prefix: "a/" }]).bySector.get("a")!;
		const landed = await commitFiles(r, { "a/src/x.js": "export const x = 10;\n", "a/src/y.js": "export const y = 2;\n" }, [a1], "landed");
		expect(await sectorPart(r, { base: m0, sectorHead: landed, prefix: "a/", changes, message: "part", author: who, committer: who })).toBeNull();
	});

	it("refuses a base the sector's history never had", async () => {
		const { r, a1, fork } = await setup();
		const changes = [{ path: "a/src/x.js", item: (await listTree(r, fork)).get("a/src/x.js")! }];
		const stray = await commitFiles(r, { "a/src/x.js": "export const x = 99;\n" }, [], "stray");
		await expect(sectorPart(r, { base: stray, sectorHead: a1, prefix: "a/", changes, message: "part", author: who, committer: who })).rejects.toThrow(/no commit of the sector/);
	});
});
