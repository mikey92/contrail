import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Workspace } from "../src/edge/workspace";

// An edge agent's workspace against real git over smart HTTP (git-http-backend behind a tiny CGI bridge).
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
