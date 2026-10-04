// Throwaway spike: proves Artifacts + isomorphic-git (inside a Durable Object) + Worker Loader
// can carry Contrail's landing pipeline. Delete once the real Runway exists.
import { Buffer } from "node:buffer";
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import { DurableObject } from "cloudflare:workers";
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "../../src/git/memfs";

interface Env {
	ARTIFACTS: Artifacts;
	LOADER: WorkerLoader;
	RUNWAY: DurableObjectNamespace<Runway>;
	SPIKE_KEY: string;
}

const author = { name: "Contrail Spike", email: "spike@contrail.dev" };
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function clock() {
	const start = Date.now();
	let last = start;
	const marks: Record<string, number> = {};
	return {
		mark(label: string) {
			const now = Date.now();
			marks[label] = now - last;
			last = now;
		},
		done() {
			return { ...marks, total: Date.now() - start };
		},
	};
}

async function waitReady(artifacts: Artifacts, name: string) {
	for (let i = 0; i < 40; i++) {
		try {
			const repo = await artifacts.get(name);
			repo[Symbol.dispose]?.();
			return i;
		} catch (err) {
			const code = (err as { code?: string }).code;
			if (code !== "FORK_IN_PROGRESS" && code !== "CREATE_IN_PROGRESS") throw err;
			await new Promise((r) => setTimeout(r, 250));
		}
	}
	throw new Error(`repo ${name} never became ready`);
}

async function mint(artifacts: Artifacts, name: string, scope: "read" | "write") {
	const repo = await artifacts.get(name);
	try {
		return (await repo.createToken(scope, 900)).plaintext;
	} finally {
		repo[Symbol.dispose]?.();
	}
}

const SEED: Record<string, string> = {
	"README.md": "# spike\n",
	"src/math.js": [
		"export function add(a, b) {",
		"  return a + b;",
		"}",
		"",
		"export function sub(a, b) {",
		"  return a - b;",
		"}",
		"",
	].join("\n"),
	"test/math.test.js": [
		'import { add, sub } from "../src/math.js";',
		"",
		"export function addsNumbers() {",
		"  if (add(2, 3) !== 5) throw new Error('add broken');",
		"}",
		"",
		"export function subtractsNumbers() {",
		"  if (sub(5, 3) !== 2) throw new Error('sub broken');",
		"}",
		"",
	].join("\n"),
};

async function writeAll(fs: MemoryFS, dir: string, files: Record<string, string>) {
	for (const [path, content] of Object.entries(files)) {
		const full = `${dir}/${path}`;
		await fs.promises.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
		await fs.promises.writeFile(full, content);
		await git.add({ fs, dir, filepath: path });
	}
}

/** Plays an agent: clone its fork, apply an edit, commit, push. */
async function agentEdit(remote: string, token: string, edit: (src: string) => string, extra: Record<string, string>, message: string) {
	const fs = new MemoryFS();
	const dir = "/w";
	const cache = {};
	await git.clone({ fs, http, dir, url: remote, ref: "main", singleBranch: true, depth: 1, headers: auth(token), cache });
	const path = `${dir}/src/math.js`;
	const src = (await fs.promises.readFile(path, "utf8")) as string;
	await fs.promises.writeFile(path, edit(src));
	await git.add({ fs, dir, filepath: "src/math.js" });
	await writeAll(fs, dir, extra);
	const oid = await git.commit({ fs, dir, message, author, cache });
	await git.push({ fs, http, dir, remote: "origin", ref: "main", headers: auth(token), cache });
	return oid;
}

export class Runway extends DurableObject<Env> {
	private fs: MemoryFS | null = null;
	private cache = {};
	private readonly dir = "/trunk";

	async land(params: { trunk: string; trunkRemote: string; forks: { name: string; remote: string }[] }) {
		const t = clock();
		const { ARTIFACTS } = this.env;
		const writeToken = await mint(ARTIFACTS, params.trunk, "write");
		t.mark("mint trunk token");
		if (!this.fs) {
			this.fs = new MemoryFS();
			await git.clone({ fs: this.fs, http, dir: this.dir, url: params.trunkRemote, ref: "main", singleBranch: true, headers: auth(writeToken), cache: this.cache });
			t.mark("clone trunk (cold)");
		} else {
			await git.fetch({ fs: this.fs, http, dir: this.dir, remote: "origin", ref: "main", singleBranch: true, headers: auth(writeToken), cache: this.cache });
			t.mark("fetch trunk (warm)");
		}
		const fs = this.fs;
		const dir = this.dir;
		const results: unknown[] = [];
		for (const fork of params.forks) {
			const readToken = await mint(ARTIFACTS, fork.name, "read");
			await git.addRemote({ fs, dir, remote: fork.name, url: fork.remote, force: true });
			await git.fetch({ fs, http, dir, remote: fork.name, ref: "main", singleBranch: true, headers: auth(readToken), cache: this.cache });
			t.mark(`fetch ${fork.name}`);
			try {
				const merge = await git.merge({
					fs,
					dir,
					ours: "main",
					theirs: `refs/remotes/${fork.name}/main`,
					fastForward: true,
					author,
					message: `Land ${fork.name}`,
					cache: this.cache,
				});
				t.mark(`merge ${fork.name}`);
				const note = JSON.stringify({ intent: `spike intent for ${fork.name}`, agent: fork.name, landedAt: new Date().toISOString() });
				await git.addNote({ fs, dir, ref: "refs/notes/contrail", oid: merge.oid!, note, author, force: true, cache: this.cache });
				await git.push({ fs, http, dir, remote: "origin", ref: "main", headers: auth(writeToken), cache: this.cache });
				await git.push({ fs, http, dir, remote: "origin", ref: "refs/notes/contrail", remoteRef: "refs/notes/contrail", force: true, headers: auth(writeToken), cache: this.cache });
				t.mark(`push ${fork.name}`);
				results.push({ fork: fork.name, ...merge });
			} catch (err) {
				results.push({ fork: fork.name, error: String(err), data: (err as { data?: unknown }).data });
			}
		}
		// Read the merged tree back out for verification.
		const files: Record<string, string> = {};
		const head = await git.resolveRef({ fs, dir, ref: "main" });
		await git.walk({
			fs,
			dir,
			trees: [git.TREE({ ref: head })],
			cache: this.cache,
			map: async (filepath, [entry]) => {
				if (!entry || filepath === ".") return;
				if ((await entry.type()) === "blob") {
					files[filepath] = new TextDecoder().decode((await entry.content()) as Uint8Array);
				}
				return true;
			},
		});
		t.mark("read merged tree");
		return { head, results, files, timings: t.done(), memBytes: fs.byteSize };
	}
}

/** Runs every exported function of every test/*.test.js file inside a fresh Dynamic Worker. */
async function verify(env: Env, files: Record<string, string>, id: string) {
	const tests = Object.keys(files).filter((p) => p.endsWith(".test.js"));
	const runner = [
		...tests.map((p, i) => `import * as t${i} from "./${p}";`),
		"export default {",
		"  async fetch() {",
		"    const out = [];",
		`    const suites = { ${tests.map((p, i) => `${JSON.stringify(p)}: t${i}`).join(", ")} };`,
		"    for (const [file, mod] of Object.entries(suites)) {",
		"      for (const [name, fn] of Object.entries(mod)) {",
		"        if (typeof fn !== 'function') continue;",
		"        const started = Date.now();",
		"        try { await fn(); out.push({ file, name, ok: true, ms: Date.now() - started }); }",
		"        catch (e) { out.push({ file, name, ok: false, error: String(e && e.message || e) }); }",
		"      }",
		"    }",
		"    return Response.json(out);",
		"  }",
		"};",
	].join("\n");
	const modules: Record<string, string> = { "__contrail_runner.js": runner };
	for (const [path, content] of Object.entries(files)) if (path.endsWith(".js")) modules[path] = content;
	const worker = env.LOADER.get(id, async () => ({
		compatibilityDate: "2026-10-01",
		mainModule: "__contrail_runner.js",
		modules,
		globalOutbound: null,
	}));
	const res = await worker.getEntrypoint().fetch("https://verify.local/");
	return res.json();
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.searchParams.get("key") !== env.SPIKE_KEY) return new Response("not found", { status: 404 });
		if (url.pathname !== "/spike/run") return new Response("not found", { status: 404 });

		const t = clock();
		const suffix = url.searchParams.get("suffix") ?? crypto.randomUUID().slice(0, 6);
		const base = `spike-${suffix}`;
		const A = env.ARTIFACTS;
		try {
			const trunk = await A.create(`${base}-trunk`, { setDefaultBranch: "main", description: "spike trunk" });
			t.mark("create trunk");
			{
				const fs = new MemoryFS();
				const dir = "/seed";
				await git.init({ fs, dir, defaultBranch: "main" });
				await writeAll(fs, dir, SEED);
				await git.commit({ fs, dir, message: "Seed", author });
				await git.push({ fs, http, dir, url: trunk.remote, ref: "main", headers: auth(trunk.token) });
			}
			t.mark("seed trunk");
			const trunkRepo = await A.get(trunk.name);
			const forkA = await trunkRepo.fork(`${base}-a`, { defaultBranchOnly: true, description: "agent a" });
			const forkB = await trunkRepo.fork(`${base}-b`, { defaultBranchOnly: true, description: "agent b" });
			trunkRepo[Symbol.dispose]?.();
			t.mark("fork x2");
			const waits = [await waitReady(A, forkA.name), await waitReady(A, forkB.name)];
			t.mark("forks ready");

			// Agent A appends mul(); agent B edits sub() and adds a test — disjoint hunks, same file.
			const commitA = await agentEdit(
				forkA.remote,
				forkA.token,
				(src) => `${src}\nexport function mul(a, b) {\n  return a * b;\n}\n`,
				{ "test/mul.test.js": 'import { mul } from "../src/math.js";\n\nexport function multiplies() {\n  if (mul(3, 4) !== 12) throw new Error("mul broken");\n}\n' },
				"Add mul()",
			);
			const commitB = await agentEdit(
				forkB.remote,
				forkB.token,
				(src) => src.replace("export function add(a, b) {\n  return a + b;\n}", "export function add(a, b) {\n  // tolerate numeric strings\n  return Number(a) + Number(b);\n}"),
				{},
				"Make add() tolerate numeric strings",
			);
			t.mark("agents push to forks");

			const runway = env.RUNWAY.get(env.RUNWAY.idFromName(trunk.name));
			const landed = (await runway.land({
				trunk: trunk.name,
				trunkRemote: trunk.remote,
				forks: [
					{ name: forkA.name, remote: forkA.remote },
					{ name: forkB.name, remote: forkB.remote },
				],
			})) as unknown as { head: string; results: unknown[]; files: Record<string, string>; timings: Record<string, number>; memBytes: number };
			t.mark("runway land (DO)");

			const tests = await verify(env, landed.files, `${trunk.name}:${landed.head}`);
			t.mark("verify in Dynamic Worker");

			// Read trunk back through the binding to confirm the landed state is visible.
			const check = await A.get(trunk.name);
			const log = await check.log({ ref: "main", limit: 5 });
			const math = await check.readFile({ ref: "main", path: "src/math.js" });
			check[Symbol.dispose]?.();
			t.mark("binding readback");

			return Response.json({
				base,
				waits,
				commits: { a: commitA, b: commitB },
				landed: { head: landed.head, results: landed.results, timings: landed.timings, memBytes: landed.memBytes },
				tests,
				log: log.map((c) => ({ hash: c.hash.slice(0, 8), message: c.message, parents: c.parents.length })),
				math: math ? await math.text() : null,
				timings: t.done(),
			});
		} catch (err) {
			return Response.json({ error: String(err), stack: (err as Error).stack, code: (err as { code?: string }).code, timings: t.done() }, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;
