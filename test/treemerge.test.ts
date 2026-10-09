import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { commit, type FlatTree, GITLINK, listTree, newRepo, type Repo, readText, writeFlatTree, writeText } from "../src/runway/gitops";
import { mergeTrees, truncateHunks } from "../src/runway/treemerge";

const who = { name: "T", email: "t@t" };
// Commits of the submodule's own repository: this repository never has them.
const SUB_A = "0123456789abcdef0123456789abcdef01234567";
const SUB_B = "89abcdef0123456789abcdef0123456789abcdef";
const SUB_C = "fedcba9876543210fedcba9876543210fedcba98";

async function commitTree(r: Repo, files: Record<string, string>, links: Record<string, string>, parents: string[]) {
	const flat: FlatTree = new Map();
	for (const [path, text] of Object.entries(files)) flat.set(path, { oid: await writeText(r, text), mode: "100644" });
	for (const [path, oid] of Object.entries(links)) flat.set(path, { oid, mode: GITLINK });
	return commit(r, { tree: await writeFlatTree(r, flat), parents, message: "c", author: who });
}

async function setup() {
	const r = newRepo();
	await git.init({ fs: r.fs, dir: r.dir, defaultBranch: "main" });
	const files = { "src/a.js": "export const a = 1;\n", "src/b.js": "export const b = 1;\n" };
	const base = await commitTree(r, files, { "vendor/lib": SUB_A }, []);
	return { r, files, base };
}

describe("submodules (gitlinks)", () => {
	it("are listed and written back as they are", async () => {
		const { r, base } = await setup();
		const flat = await listTree(r, base);
		expect(flat.get("vendor/lib")).toEqual({ oid: SUB_A, mode: GITLINK });
		const { commit: c } = await git.readCommit({ fs: r.fs, dir: r.dir, oid: base });
		expect(await writeFlatTree(r, flat)).toBe(c.tree);
	});

	it("survive a merge that changes other files", async () => {
		const { r, files, base } = await setup();
		const ours = await commitTree(r, { ...files, "src/a.js": "export const a = 2;\n" }, { "vendor/lib": SUB_A }, [base]);
		const theirs = await commitTree(r, { ...files, "src/b.js": "export const b = 2;\n" }, { "vendor/lib": SUB_A }, [base]);
		const m = await mergeTrees(r, base, ours, theirs);
		expect(m.conflicts).toEqual([]);
		expect(m.files.get("vendor/lib")).toEqual({ oid: SUB_A, mode: GITLINK });
		const tree = await writeFlatTree(r, m.files);
		const back = await listTree(r, tree);
		expect(back.get("vendor/lib")).toEqual({ oid: SUB_A, mode: GITLINK });
		expect(await readText(r, back.get("src/b.js")!.oid)).toBe("export const b = 2;\n");
	});

	it("take a flight's submodule update, and report two different updates as a conflict", async () => {
		const { r, files, base } = await setup();
		const ours = await commitTree(r, { ...files, "src/a.js": "export const a = 2;\n" }, { "vendor/lib": SUB_A }, [base]);
		const theirs = await commitTree(r, files, { "vendor/lib": SUB_B }, [base]);
		const m = await mergeTrees(r, base, ours, theirs);
		expect(m.conflicts).toEqual([]);
		expect(m.files.get("vendor/lib")).toEqual({ oid: SUB_B, mode: GITLINK });
		expect(m.changes.map((c) => c.path)).toEqual(["vendor/lib"]);

		const both = await commitTree(r, files, { "vendor/lib": SUB_C }, [base]);
		const clash = await mergeTrees(r, base, both, theirs);
		expect(clash.conflicts).toMatchObject([{ path: "vendor/lib", kind: "binary" }]);
	});
});

describe("truncateHunks", () => {
	const lines = (n: number, c: string) => Array.from({ length: n }, (_, i) => `${c}${i}`);

	it("keeps both sides of a rewrite it cuts short, says so and drops the lines after it", () => {
		const [first, cut] = truncateHunks([
			{ start: 1, removed: lines(10, "a"), added: lines(20, "b"), after: ["ctx"] },
			{ start: 40, removed: lines(40, "r"), added: lines(40, "n"), before: ["above"], after: ["}"] },
		]);
		expect(first).toMatchObject({ removed: lines(10, "a"), added: lines(20, "b"), after: ["ctx"] });
		expect(first.cut).toBeUndefined();
		expect(cut.removed).toHaveLength(15);
		expect(cut.added).toHaveLength(15);
		expect(cut).toMatchObject({ cut: true, before: ["above"] });
		expect(cut.after).toBeUndefined();
	});

	it("gives the room one side doesn't need to the other", () => {
		const [h] = truncateHunks([{ start: 1, removed: lines(2, "r"), added: lines(100, "n") }], 30);
		expect(h.removed).toHaveLength(2);
		expect(h.added).toHaveLength(28);
	});
});
