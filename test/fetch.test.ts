import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cloneMain, fetchUnrelated, newRepo } from "../src/runway/gitops";

// Real git over smart HTTP: git-http-backend behind a tiny CGI bridge, counting the pack bytes it sends.
let root: string;
let server: Server;
let base: string;
let packBytes = 0;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();

/** A bare repo whose main has `commits` commits that each rewrite one file. */
function makeRepo(name: string, commits: number) {
	const work = join(root, `${name}-work`);
	mkdirSync(work);
	git(work, "init", "-q", "-b", "main");
	for (let i = 0; i < commits; i++) {
		writeFileSync(join(work, `${name}.txt`), `${name} ${i}\n${"x".repeat(2000 + i)}\n`);
		git(work, "add", "-A");
		git(work, "commit", "-q", "-m", `${name} ${i}`);
	}
	git(root, "clone", "-q", "--bare", work, join(root, `${name}.git`));
	return work;
}

function addCommit(name: string, work: string) {
	writeFileSync(join(work, `${name}.txt`), `${name} again ${Date.now()}\n`);
	git(work, "commit", "-qam", `${name} again`);
	git(work, "push", "-q", join(root, `${name}.git`), "main");
	return git(work, "rev-parse", "HEAD");
}

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "contrail-fetch-"));
	server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://x");
		const cgi = spawn("git", ["http-backend"], {
			env: {
				...process.env,
				GIT_PROJECT_ROOT: root,
				GIT_HTTP_EXPORT_ALL: "1",
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
			if (url.pathname.endsWith("/git-upload-pack")) packBytes += body.length;
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

describe("fetchUnrelated", () => {
	it("fetches unrelated histories at once, then only what is new", async () => {
		makeRepo("mono", 2);
		const a = makeRepo("a", 40);
		const b = makeRepo("b", 40);
		const repo = newRepo();
		await cloneMain(repo, `${base}/mono.git`, "t");
		const sources = ["a", "b"].map((name) => ({ name: `sector-${name}`, url: `${base}/${name}.git`, token: "t" }));

		packBytes = 0;
		const first = await fetchUnrelated(repo, sources);
		expect(first).toEqual([git(a, "rev-parse", "HEAD"), git(b, "rev-parse", "HEAD")]);
		const full = packBytes;

		const next = addCommit("a", a);
		packBytes = 0;
		const second = await fetchUnrelated(repo, sources);
		expect(second).toEqual([next, git(b, "rev-parse", "HEAD")]);
		// Only the new commit comes over, not the 40 before it.
		expect(packBytes).toBeLessThan(full / 10);
	}, 30_000);
});
