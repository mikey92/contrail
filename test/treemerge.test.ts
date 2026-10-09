import git from "isomorphic-git";
import { describe, expect, it } from "vitest";
import { commit, type FlatTree, GITLINK, listTree, newRepo, type Repo, readText, writeFlatTree, writeText } from "../src/runway/gitops";
import { describeChanges, mergeTrees, truncateHunks } from "../src/runway/treemerge";

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

describe("describeChanges", () => {
	it("says what it can't show as text, shows a deleted file's lines, a mode change and a submodule's commit", async () => {
		const r = newRepo();
		await git.init({ fs: r.fs, dir: r.dir, defaultBranch: "main" });
		const blob = (bytes: Uint8Array) => git.writeBlob({ fs: r.fs, dir: r.dir, blob: bytes });
		const before: FlatTree = new Map([
			["run.sh", { oid: await writeText(r, "echo hi\n"), mode: "100644" }],
			["old.js", { oid: await writeText(r, "export const old = 1;\n"), mode: "100644" }],
			["vendor/lib", { oid: SUB_A, mode: GITLINK }],
		]);
		const after: FlatTree = new Map([
			["run.sh", { oid: before.get("run.sh")!.oid, mode: "100755" }],
			["logo.png", { oid: await blob(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 0xff])), mode: "100644" }],
			["vendor/lib", { oid: SUB_B, mode: GITLINK }],
		]);
		const changes = await describeChanges(r, before, after, 2);
		const by = Object.fromEntries(changes.map((c) => [c.path, c]));
		expect(by["run.sh"]).toMatchObject({ status: "modified", mode: "100644 → 100755", additions: 0, deletions: 0 });
		expect(by["logo.png"]).toMatchObject({ status: "added", binary: true });
		expect(by["old.js"]).toMatchObject({ status: "deleted", deletions: 2 });
		expect(by["old.js"].hunks?.[0].removed).toContain("export const old = 1;");
		expect(by["vendor/lib"].hunks?.[0]).toMatchObject({ removed: [`Subproject commit ${SUB_A}`], added: [`Subproject commit ${SUB_B}`] });
		expect(by["vendor/lib"].binary).toBeUndefined();
	});
});

describe("trees both sides changed", () => {
	async function commitModes(r: Repo, files: Record<string, [string, string]>, parents: string[]) {
		const flat: FlatTree = new Map();
		for (const [path, [text, mode]] of Object.entries(files)) flat.set(path, { oid: await writeText(r, text), mode });
		return commit(r, { tree: await writeFlatTree(r, flat), parents, message: "c", author: who });
	}

	it("keep trunk's new mode when the flight changed only the text", async () => {
		const r = newRepo();
		await git.init({ fs: r.fs, dir: r.dir, defaultBranch: "main" });
		// Lines apart, so the texts merge (changes on lines next to each other conflict, as in git).
		const base = await commitModes(r, { "run.sh": ["echo a\n\necho m\n\necho b\n", "100644"] }, []);
		const trunk = await commitModes(r, { "run.sh": ["echo A\n\necho m\n\necho b\n", "100755"] }, [base]);
		const flight = await commitModes(r, { "run.sh": ["echo a\n\necho m\n\necho B\n", "100644"] }, [base]);
		const m = await mergeTrees(r, base, trunk, flight);
		expect(m.conflicts).toEqual([]);
		expect(m.files.get("run.sh")?.mode).toBe("100755");
		expect(await readText(r, m.files.get("run.sh")!.oid)).toBe("echo A\n\necho m\n\necho B\n");
	});

	it("report a path that is a file on one side and a directory on the other", async () => {
		const r = newRepo();
		await git.init({ fs: r.fs, dir: r.dir, defaultBranch: "main" });
		const base = await commitModes(r, { "README.md": ["# x\n", "100644"] }, []);
		const trunk = await commitModes(r, { "README.md": ["# x\n", "100644"], docs: ["notes\n", "100644"] }, [base]);
		const flight = await commitModes(r, { "README.md": ["# x\n", "100644"], "docs/readme.md": ["# docs\n", "100644"] }, [base]);
		const m = await mergeTrees(r, base, trunk, flight);
		expect(m.conflicts).toMatchObject([{ path: "docs", kind: "file/directory" }]);
	});
});
