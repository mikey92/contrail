import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Workspace } from "../src/edge/workspace";
import { addNote, boundedHttp, cloneMain, fetchNotes, newRepo, pushNotes } from "../src/runway/gitops";
import * as iso from "isomorphic-git";

// Edge workspaces and the runway's landing notes against real git over smart HTTP (git-http-backend behind
// a tiny CGI bridge).
let root: string;
let server: Server;
let base: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	}).trim();

/** A bare repo with one commit of `files`, served at `${base}/${name}.git`. */
function makeRepo(name: string, files: Record<string, string>) {
	const work = join(root, `${name}-work`);
	mkdirSync(work);
	git(work, "init", "-q", "-b", "main");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(work, path, ".."), { recursive: true });
		writeFileSync(join(work, path), text);
	}
	git(work, "add", "-A");
	git(work, "commit", "-q", "-m", "start");
	const bare = join(root, `${name}.git`);
	git(root, "clone", "-q", "--bare", work, bare);
	// Let the workspace push to it.
	git(bare, "config", "http.receivepack", "true");
	return { url: `http://x:token@${base.slice("http://".length)}/${name}.git`, bare };
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "contrail-workspace-"));
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const cgi = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
				REMOTE_USER: "x",
				REQUEST_METHOD: req.method,
				PATH_INFO: url.pathname,
				QUERY_STRING: url.search.slice(1),
				CONTENT_TYPE: req.headers["content-type"] ?? "",
			},
		});
		req.pipe(cgi.stdin);
		const chunks: Buffer[] = [];
		cgi.stdout.on("data", (c) => chunks.push(c));
		cgi.on("close", () => {
			const out = Buffer.concat(chunks);
			const split = out.indexOf("\r\n\r\n");
			const head = out.subarray(0, split).toString();
			const body = out.subarray(split + 4);
			const status = Number(/^Status: (\d+)/m.exec(head)?.[1] ?? 200);
			const headers: Record<string, string> = {};
			for (const line of head.split("\r\n")) {
				const [k, ...v] = line.split(": ");
				if (k && k !== "Status") headers[k] = v.join(": ");
			}
			res.writeHead(status, headers).end(body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => {
	server?.close();
	rmSync(root, { recursive: true, force: true });
});

const author = { name: "EDGE-1", email: "edge-1@agents.contrail.dev" };

describe("Workspace", () => {
	it("edits text with dollar signs as written", async () => {
		const { url } = makeRepo("money", { "src/money.js": "export const usd = (d) => `$${d}`;\nexport const x = 1;\n" });
		const ws = await Workspace.open(url, url, author);
		await ws.edit("src/money.js", "export const x = 1;", "export const eur = (d) => '$' + d + `$${d}` + \"$&$'\";");
		expect(await ws.read("src/money.js")).toBe("export const usd = (d) => `$${d}`;\nexport const eur = (d) => '$' + d + `$${d}` + \"$&$'\";\n");
	}, 30_000);

	it("pushes the commit a sync made of its edits when trunk had nothing new", async () => {
		const { url, bare } = makeRepo("wip", { "a.js": "export const a = 1;\n" });
		const ws = await Workspace.open(url, url, author);
		await ws.write("a.js", "export const a = 2;\n");
		const sync = await ws.sync();
		expect(sync.changed).toEqual([]);
		// Nothing new since the sync's commit, but that commit has not reached the fork yet.
		const pushed = await ws.commitAndPush("Bump a");
		expect(pushed).not.toBeNull();
		expect(git(bare, "rev-parse", "main")).toBe(pushed);
		expect(git(bare, "show", "main:a.js")).toBe("export const a = 2;");
		// And once it has, there is nothing to push.
		expect(await ws.commitAndPush("Again")).toBeNull();
	}, 30_000);
});

describe("Workspace sync", () => {
	/** A trunk and a workspace fork of it, both served. */
	function trunkAndFork(name: string, files: Record<string, string>) {
		const trunk = makeRepo(`${name}-trunk`, files);
		const fork = join(root, `${name}-fork.git`);
		git(root, "clone", "-q", "--bare", trunk.bare, fork);
		git(fork, "config", "http.receivepack", "true");
		return { trunk, fork, forkUrl: `http://x:token@${base.slice("http://".length)}/${name}-fork.git`, work: join(root, `${name}-trunk-work`) };
	}
	/** Trunk turns `docs` from a file into a directory (or back), in its own commit. */
	function swapDocs(work: string, bare: string, toFile: boolean, also?: () => void) {
		rmSync(join(work, "docs"), { recursive: true });
		if (toFile) writeFileSync(join(work, "docs"), "see the wiki\n");
		else {
			mkdirSync(join(work, "docs"));
			writeFileSync(join(work, "docs", "readme.md"), "# Docs\n");
		}
		also?.();
		git(work, "add", "-A");
		git(work, "commit", "-qm", "swap docs");
		git(work, "push", "-q", bare, "main");
	}

	for (const toFile of [false, true]) {
		it(`follows trunk turning a file into a directory or back (${toFile ? "to a file" : "to a directory"}), merged or fast-forward`, async () => {
			const start = toFile ? { "a.js": "1\n", "docs/readme.md": "# Docs\n" } : { "a.js": "1\n", docs: "old docs\n" };
			// Merged: the flight has a commit of its own.
			const merged = trunkAndFork(`swap-merge-${toFile}`, start);
			const ws = await Workspace.open(merged.forkUrl, merged.trunk.url, author);
			await ws.write("b.js", "2\n");
			await ws.commitAndPush("flight adds b.js");
			swapDocs(merged.work, merged.trunk.bare, toFile);
			expect((await ws.sync()).conflicts).toEqual([]);
			expect(await ws.read(toFile ? "docs" : "docs/readme.md")).toBe(toFile ? "see the wiki\n" : "# Docs\n");
			// Fast-forward: none yet; the flight's next commit then changes only what it changed.
			const ff = trunkAndFork(`swap-ff-${toFile}`, start);
			const ws2 = await Workspace.open(ff.forkUrl, ff.trunk.url, author);
			swapDocs(ff.work, ff.trunk.bare, toFile);
			expect((await ws2.sync()).fastForward).toBe(true);
			await ws2.write("a.js", "2\n");
			await ws2.commitAndPush("flight edits a.js");
			expect(git(ff.fork, "diff", "--name-status", "main~1", "main")).toBe("M\ta.js");
		}, 30_000);
	}

	it("puts trunk's directory beside a file the flight edited", async () => {
		const { trunk, forkUrl, work } = trunkAndFork("edited-fd", { "a.js": "1\n", docs: "old docs\n" });
		const ws = await Workspace.open(forkUrl, trunk.url, author);
		await ws.write("docs", "old docs, edited\n");
		await ws.commitAndPush("Edit docs");
		swapDocs(work, trunk.bare, false, () => writeFileSync(join(work, "a.js"), "2\n"));
		const sync = await ws.sync();
		expect(sync.clashes).toEqual(["docs"]);
		expect(await ws.read("docs")).toBe("old docs, edited\n");
		expect(await ws.read("docs~trunk/readme.md")).toBe("# Docs\n");
		expect(await ws.read("a.js")).toBe("2\n");
	}, 30_000);

	it("lets the agent keep trunk's file where its own directory was", async () => {
		const { trunk, forkUrl, work } = trunkAndFork("keep-trunk", { "a.js": "1\n" });
		const ws = await Workspace.open(forkUrl, trunk.url, author);
		await ws.write("docs/readme.md", "# Docs\n");
		await ws.commitAndPush("docs dir");
		writeFileSync(join(work, "docs"), "see the wiki\n");
		git(work, "add", "docs");
		git(work, "commit", "-qm", "docs file");
		git(work, "push", "-q", trunk.bare, "main");
		expect((await ws.sync()).clashes).toEqual(["docs"]);
		await ws.remove("docs/readme.md");
		await ws.write("docs", await ws.read("docs~trunk"));
		await ws.remove("docs~trunk");
		expect(await ws.unsettledClashes()).toEqual([]);
		expect(await ws.read("docs")).toBe("see the wiki\n");
	}, 30_000);

	it("puts trunk's side of a file/directory clash beside the workspace's, at path~trunk", async () => {
		// The flight adds docs/readme.md; trunk meanwhile adds a file named docs.
		const { trunk, forkUrl, work } = trunkAndFork("fd", { "a.js": "export const a = 1;\n" });
		const ws = await Workspace.open(forkUrl, trunk.url, author);
		await ws.write("docs/readme.md", "# Docs\n");
		await ws.commitAndPush("Add docs");
		writeFileSync(join(work, "docs"), "see the wiki\n");
		git(work, "add", "docs");
		git(work, "commit", "-qm", "docs file");
		git(work, "push", "-q", trunk.bare, "main");
		const sync = await ws.sync();
		expect(sync.conflicts).toEqual(["docs"]);
		expect(sync.clashes).toEqual(["docs"]);
		expect(await ws.read("docs/readme.md")).toBe("# Docs\n");
		expect(await ws.read("docs~trunk")).toBe("see the wiki\n");
		expect(await ws.unsettledClashes()).toEqual(["docs~trunk"]);
		// The agent keeps both under other names: settled.
		await ws.write("WIKI.md", await ws.read("docs~trunk"));
		await ws.remove("docs~trunk");
		expect(await ws.unsettledClashes()).toEqual([]);
	}, 30_000);

	it("and the other way round: trunk's directory beside the workspace's file", async () => {
		const { trunk, forkUrl, work } = trunkAndFork("df", { "a.js": "export const a = 1;\n" });
		const ws = await Workspace.open(forkUrl, trunk.url, author);
		await ws.write("docs", "see the wiki\n");
		await ws.commitAndPush("docs file");
		mkdirSync(join(work, "docs"));
		writeFileSync(join(work, "docs", "readme.md"), "# Docs\n");
		git(work, "add", "docs");
		git(work, "commit", "-qm", "docs dir");
		git(work, "push", "-q", trunk.bare, "main");
		const sync = await ws.sync();
		expect(sync.clashes).toEqual(["docs"]);
		expect(await ws.read("docs")).toBe("see the wiki\n");
		expect(await ws.read("docs~trunk/readme.md")).toBe("# Docs\n");
		expect(await ws.unsettledClashes()).toEqual(["docs~trunk"]);
	}, 30_000);
});

describe("landing notes", () => {
	it("survive a fresh clone: notes are added to trunk's, never replace them", async () => {
		const { url, bare } = makeRepo("notes", { "a.js": "export const a = 1;\n" });
		const first = newRepo();
		const one = await cloneMain(first, url, "t");
		await fetchNotes(first, "t");
		await addNote(first, one, "first landing");
		expect((await pushNotes(first, "t")).ok).toBe(true);

		// Trunk moves on, and a runway that starts over (a restart) clones it afresh.
		const work = join(root, "notes-work");
		writeFileSync(join(work, "a.js"), "export const a = 2;\n");
		git(work, "commit", "-qam", "two");
		git(work, "push", "-q", bare, "main");
		const second = newRepo();
		const two = await cloneMain(second, url, "t");
		await fetchNotes(second, "t");
		await addNote(second, two, "second landing");
		expect((await pushNotes(second, "t")).ok).toBe(true);

		expect(git(bare, "notes", "--ref=contrail", "show", one)).toBe("first landing");
		expect(git(bare, "notes", "--ref=contrail", "show", two)).toBe("second landing");
	}, 30_000);
});

describe("fetching a workspace", () => {
	it("stops a download over its limit", async () => {
		// Random bytes: they don't compress, so the pack is as big as the file.
		const { url } = makeRepo("big", { "blob.bin": Buffer.from(crypto.getRandomValues(new Uint8Array(30_000))).toString("hex") });
		const repo = newRepo();
		await iso.init({ fs: repo.fs, dir: repo.dir, defaultBranch: "main" });
		await iso.addRemote({ fs: repo.fs, dir: repo.dir, remote: "fork", url });
		const fetch = (max: number) => iso.fetch({ fs: repo.fs, http: boundedHttp(max), dir: repo.dir, remote: "fork", ref: "main", singleBranch: true, cache: repo.cache });
		await expect(fetch(1000)).rejects.toThrow(/too much to land/);
		await expect(fetch(10 * 1024 * 1024)).resolves.toBeTruthy();
	}, 30_000);
});
