import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type LandingJob, Runway } from "../src/runway/runway";

// The real Runway landing workspace forks onto a trunk served by real git over smart HTTP (git-http-backend
// behind a tiny CGI bridge). Artifacts hands out those repos; the Worker Loader runs no code: a suite fails
// when a module it loads says BROKEN.
vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));

let root: string;
let server: Server;
let base: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
	}).trim();

/** A trunk with one commit of `files`, served at `${base}/${name}.git`. Returns its head. */
function makeTrunk(name: string, files: Record<string, string>): string {
	const work = join(root, `${name}-work`);
	mkdirSync(work);
	git(work, "init", "-q", "-b", "main");
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(work, path, ".."), { recursive: true });
		writeFileSync(join(work, path), text);
	}
	git(work, "add", "-A");
	git(work, "commit", "-q", "-m", "start");
	git(root, "clone", "-q", "--bare", work, join(root, `${name}.git`));
	// Let the runway push to it.
	git(join(root, `${name}.git`), "config", "http.receivepack", "true");
	return git(work, "rev-parse", "HEAD");
}

/** A workspace fork of `trunk` with one commit of `edits`. */
function fork(trunk: string, name: string, edits: Record<string, (text: string) => string>) {
	const work = join(root, `${name}-work`);
	git(root, "clone", "-q", join(root, `${trunk}.git`), work);
	for (const [path, edit] of Object.entries(edits)) writeFileSync(join(work, path), edit(readFileSync(join(work, path), "utf8")));
	git(work, "commit", "-qam", `work of ${name}`);
	git(root, "clone", "-q", "--bare", work, join(root, `${name}.git`));
}

function runway() {
	const env = {
		ARTIFACTS: {
			get: async (name: string) => ({
				info: async () => ({ remote: `${base}/${name}.git` }),
				createToken: async () => ({ plaintext: "token", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
			}),
		},
		LOADER: {
			get: (_id: string, load: () => Promise<{ modules: Record<string, unknown> }>) => ({
				getEntrypoint: () => ({
					fetch: async () => {
						const ok = !JSON.stringify((await load()).modules).includes("BROKEN");
						return Response.json([{ file: "test/prices.test.js", name: "prices", ok, ms: 1, ...(ok ? {} : { error: "BROKEN" }) }]);
					},
				}),
			}),
		},
	};
	return new Runway({} as never, env as never);
}

const job = (id: string, repo: string): LandingJob => ({
	landingId: id,
	flightId: id,
	repo,
	message: `Land ${id}\n\nContrail-Flight: FL-${id}\nContrail-Landing: ${id}`,
	author: { name: id, email: `${id.toLowerCase()}@agents.contrail.dev` },
	note: {},
});

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "contrail-runway-"));
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
			const headers: Record<string, string> = {};
			for (const line of head.split("\r\n")) {
				const [k, ...v] = line.split(": ");
				if (k && k !== "Status") headers[k] = v.join(": ");
			}
			res.writeHead(Number(/^Status: (\d+)/m.exec(head)?.[1] ?? 200), headers).end(out.subarray(split + 4));
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

describe("the runway", () => {
	const PRICES = "export function price(qty) {\n  return qty * 10;\n}\n\nexport function shipping(total) {\n  return total > 100 ? 0 : 5;\n}\n";
	const TEST = 'import { price, shipping } from "../src/prices.js";\n\nexport function adds() {\n  if (price(2) + shipping(20) !== 25) throw new Error("wrong total");\n}\n';

	it("judges a train's later landings on trunk as it was when the one landing aboard fails its tests", async () => {
		const start = makeTrunk("shop", { "src/prices.js": PRICES, "test/prices.test.js": TEST });
		// A breaks the suite while changing price() and shipping(). B changes price() too, so it conflicts with
		// A's line only; C makes A's change to shipping(), so on top of A it has nothing left to land.
		fork("shop", "shop-a", { "src/prices.js": (t) => t.replace("qty * 10;", "qty * 12; // BROKEN").replace("total > 100", "total > 50") });
		fork("shop", "shop-b", { "src/prices.js": (t) => t.replace("qty * 10;", "qty * 11;") });
		fork("shop", "shop-c", { "src/prices.js": (t) => t.replace("total > 100", "total > 50") });

		const { outcomes, head } = await runway().land("shop", [job("A", "shop-a"), job("B", "shop-b"), job("C", "shop-c")]);
		const [a, b, c] = outcomes;
		expect(a).toMatchObject({ landingId: "A", status: "failed", error: "1 test failed", trunkAfter: null });
		// Not a conflict with A's line, which never reached trunk.
		expect(b).toMatchObject({ landingId: "B", status: "landed", trunkBefore: start, conflicts: [] });
		// Not "nothing to land: trunk already contains these changes".
		expect(c).toMatchObject({ landingId: "C", status: "landed", error: null });
		expect(git(join(root, "shop.git"), "rev-parse", "main")).toBe(head);
		expect(git(join(root, "shop.git"), "show", "main:src/prices.js")).toBe(PRICES.replace("qty * 10;", "qty * 11;").replace("total > 100", "total > 50").trim());
	}, 60_000);

	it("lands a one-line change to a long file in moments", async () => {
		// 10,500 lines: a price table with a blank line after every six rows. Its line diff used to take half a minute.
		const rows = Array.from({ length: 9_000 }, (_, i) => `  sku${i}: ${(i * 37) % 1000},${i % 6 === 5 ? "\n" : ""}`);
		makeTrunk("catalog", { "src/table.js": `export const PRICES = {\n${rows.join("\n")}\n};\n` });
		fork("catalog", "catalog-a", { "src/table.js": (t) => t.replace("  sku4500: 500,", "  sku4500: 450,") });

		const t0 = Date.now();
		const { outcomes } = await runway().land("catalog", [job("L", "catalog-a")]);
		expect(outcomes[0]).toMatchObject({ status: "landed", changes: [{ path: "src/table.js", additions: 1, deletions: 1, symbols: ["PRICES"] }] });
		expect(Date.now() - t0).toBeLessThan(5_000);
	}, 120_000);
});
