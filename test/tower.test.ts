// The Tower Durable Object, run for real on node:sqlite. Its bindings (the runway, Artifacts, edge agents) are
// small fakes and cloudflare:workers is mocked, so no Workers runtime is needed.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { Tower } from "../src/tower/tower";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

type Job = { landingId: string };
type Status = "landed" | "failed" | "conflict" | "review";

const FILES = [
	{
		path: "src/cart.js",
		lines: 30,
		symbols: [
			{ name: "Cart", kind: "class", start: 1, end: 30 },
			{ name: "Cart.add", kind: "method", start: 2, end: 10 },
			{ name: "Cart.remove", kind: "method", start: 11, end: 20 },
		],
	},
];
const ACTIVE = "('taxiing', 'airborne', 'holding', 'approach', 'diverted')";

const tick = () => new Promise((r) => setTimeout(r, 0));

/** What the runway says about a landing. */
function outcome(job: Job, status: Status) {
	return {
		landingId: job.landingId,
		status,
		forkHead: "f1",
		base: "t1",
		trunkBefore: "t1",
		trunkAfter: status === "landed" ? "t2" : null,
		changes: [{ path: "src/cart.js", status: "modified", symbols: ["Cart.add"], additions: 1, deletions: 0 }],
		conflicts: status === "conflict" ? [{ path: "src/cart.js", kind: "content", hunks: [] }] : [],
		tests: null,
		unioned: 0,
		error: status === "failed" ? "1 test failed" : null,
		ms: 1,
	};
}

/** A runway that answers only once the test opens it. */
function gate() {
	let open!: () => void;
	const wait = new Promise<void>((r) => (open = r));
	return { wait, open };
}

interface Options {
	playground?: boolean;
	/** The runway's answer to a train (every landing lands by default). */
	land?: (jobs: Job[]) => Promise<ReturnType<typeof outcome>[]>;
	/** A fork that takes this long (a take-off waits for it). */
	fork?: () => Promise<void>;
	/** Storage an earlier instance left: this one is the same Durable Object after a restart. */
	db?: DatabaseSync;
}

async function airspace(opts: Options = {}) {
	const db = opts.db ?? new DatabaseSync(":memory:");
	const sql = {
		exec(query: string, ...args: unknown[]) {
			const rows = db
				.prepare(query)
				.all(...(args.map((a) => a ?? null) as SQLInputValue[]))
				.map((r) => ({ ...r }));
			return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
		},
	};
	const ctx = {
		storage: { sql, setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} },
		blockConcurrencyWhile: (fn: () => Promise<void>) => fn(),
		waitUntil: (p: Promise<unknown>) => void p.catch(() => {}),
		getWebSockets: () => [],
	};
	const edges = new Map<string, { phase: string; stops: number }>();
	let tower!: Tower;
	const env = {
		RUNWAY: {
			idFromName: (name: string) => name,
			get: () => ({
				land: async (_trunk: string, jobs: Job[]) => ({ outcomes: await (opts.land ?? (async (js: Job[]) => js.map((j) => outcome(j, "landed"))))(jobs), head: "t2", trunk: null }),
				trunkFiles: async () => ({ head: "t1", files: FILES }),
				// Over the network this takes a moment, so a take-off can come in meanwhile.
				restoreFirstTree: () => new Promise((r) => setTimeout(() => r("t0"), 5)),
			}),
		},
		ARTIFACTS: {
			get: async (name: string) => ({
				fork: async () => opts.fork?.(),
				info: async () => ({ remote: `https://artifacts.test/${name}.git` }),
				createToken: async () => ({ plaintext: "token", expiresAt: "2030-01-01T00:00:00Z" }),
				[Symbol.dispose]() {},
			}),
			delete: async () => true,
		},
		EDGE: {
			// "<slug>:<agent id>" names an edge agent.
			idFromName: (name: string) => name.split(":")[1],
			get: (agentId: string) => ({
				start: async () => void edges.set(agentId, { phase: "boarding", stops: 0 }),
				status: async () => ({ phase: edges.get(agentId)?.phase ?? "done" }),
				// Like the real one: it gives its flight back, which the tower refuses while the runway is landing it.
				stop: async () => {
					const e = edges.get(agentId);
					if (e) Object.assign(e, { phase: "stopped", stops: e.stops + 1 });
					await tower.abort(agentId, undefined, "edge agent stopped").catch(() => {});
				},
			}),
		},
	};
	tower = new Tower(ctx as unknown as DurableObjectState, env as unknown as Env);
	await tick();
	const put = (k: string, v: unknown) => db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run(k, JSON.stringify(v));
	if (!opts.db) {
		put("project", { slug: "pg", name: "Playground", description: "", trunkRepo: "pg--trunk", createdAt: Date.now(), public: true, playground: opts.playground ?? false });
		put("ready", true);
		put("trunk", { head: "t1", files: FILES, landedCount: 0 });
		put("testCommandChecked", 2);
	}
	const rows = (query: string, ...args: SQLInputValue[]) => db.prepare(query).all(...args).map((r) => ({ ...r }));
	return {
		tower,
		db,
		edges,
		rows,
		meta: (k: string) => JSON.parse((db.prepare("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | undefined)?.v ?? "null"),
		flight: (id: string) => rows("SELECT status FROM flights WHERE id = ?", id)[0]?.status,
		active: (agentId: string) => rows(`SELECT code FROM flights WHERE agent_id = ? AND status IN ${ACTIVE}`, agentId),
		join: async (callsign: string) => (await tower.join({ callsign })).agent.id,
		fly: async (agentId: string) => {
			const res = await tower.takeOff(agentId);
			if ("idle" in res) throw new Error(res.message);
			return res.flight;
		},
	};
}

describe("Tower", () => {
	it("keeps its edge fleet when a playground starts over by itself, so Stop reaches an agent flying on", async () => {
		const a = await airspace({ playground: true });
		await a.tower.addIntents([{ title: "The only intent" }], "operator");
		const [e1, e2] = (await a.tower.launchEdge({ count: 2, mode: "scripted", limit: 50 })).launched.map((x) => x.id);
		await a.fly(e1);
		expect((await a.tower.requestLanding(e1, { summary: "done" })).landing.status).toBe("landed");
		// e1 has flights left and boards again: nothing is open, so the playground starts over (FL-001 again).
		expect((await a.fly(e1)).code).toBe("FL-001");
		expect(a.meta("edgeFleet")).toEqual([e1, e2]);
		expect(await a.tower.stopEdge()).toEqual({ stopped: 2 });
		expect(a.edges.get(e1)?.stops).toBe(1);
		expect(a.active(e1)).toEqual([]);
		// A later launch leaves the agents that finished out of the fleet.
		const [e3] = (await a.tower.launchEdge({ count: 1, mode: "scripted", limit: 50 })).launched.map((x) => x.id);
		expect(a.meta("edgeFleet")).toEqual([e3]);
		expect(await a.tower.newRound()).toEqual({ open: 1 });
	});

	it("releases a clearance by the name it was asked for", async () => {
		const a = await airspace();
		await a.tower.addIntents([{ title: "One" }, { title: "Two" }], "operator");
		const [x, y] = [await a.join("X"), await a.join("Y")];
		await a.fly(x);
		await a.fly(y);
		expect((await a.tower.requestClearance(x, { targets: ["src/cart.js#add"] })).granted).toEqual(["src/cart.js#Cart.add"]);
		expect((await a.tower.requestClearance(y, { targets: ["src/cart.js#Cart.add"] })).holding).toHaveLength(1);
		expect((await a.tower.releaseClearance(x, { targets: ["src/cart.js#add"] })).released).toEqual(["src/cart.js#Cart.add"]);
		// Y, which held for it, is cleared.
		expect((await a.tower.requestClearance(y, { targets: ["src/cart.js#Cart.add"] })).granted).toEqual(["src/cart.js#Cart.add"]);
	});

	it("releases a clearance for new code by its name, after trunk got code of that name meanwhile", async () => {
		const a = await airspace();
		await a.tower.addIntents([{ title: "One" }, { title: "Two" }], "operator");
		const [x, y] = [await a.join("X"), await a.join("Y")];
		await a.fly(x);
		const fy = await a.fly(y);
		expect((await a.tower.requestClearance(x, { targets: ["src/cart.js#discount"] })).granted).toEqual(["src/cart.js#discount"]);
		await a.tower.requestClearance(y, { targets: ["src/cart.js#discount"] });
		expect(a.flight(fy.id)).toBe("holding");
		// Another flight lands Cart.discount: the name X asked for now resolves to it.
		const files = [{ ...FILES[0], symbols: [...FILES[0].symbols, { name: "Cart.discount", kind: "method", start: 21, end: 29 }] }];
		a.db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run("trunk", JSON.stringify({ head: "t2", files, landedCount: 1 }));
		expect((await a.tower.releaseClearance(x, { targets: ["src/cart.js#discount"] })).released).toEqual(["src/cart.js#discount"]);
		expect(a.flight(fy.id)).toBe("airborne");
	});

	it("reports a take-off that Stop ended once, not twice", async () => {
		const fork = gate();
		const a = await airspace({ fork: () => fork.wait });
		await a.tower.addIntents([{ title: "One" }], "operator");
		const [e1] = (await a.tower.launchEdge({ count: 1, mode: "scripted", limit: 50 })).launched.map((x) => x.id);
		const taking = a.tower.takeOff(e1).catch((err) => err);
		await tick();
		expect(a.rows("SELECT status FROM flights")).toEqual([{ status: "taxiing" }]);
		await a.tower.stopEdge();
		fork.open();
		expect(await taking).toBeInstanceOf(Error);
		expect(a.rows("SELECT status FROM flights")).toEqual([{ status: "aborted" }]);
		expect(a.rows("SELECT type FROM events WHERE type = 'flight.aborted'")).toHaveLength(1);
		expect(a.rows("SELECT status, flight_id FROM intents")).toEqual([{ status: "open", flight_id: null }]);
	});

	describe("ends a flight whose agent can't fly it any more once the runway has had its say", () => {
		async function onRunway(status: Status) {
			const runway = gate();
			const a = await airspace({
				land: async (jobs) => {
					await runway.wait;
					return jobs.map((j) => outcome(j, status));
				},
			});
			await a.tower.addIntents([{ title: "One" }], "operator");
			return { a, runway };
		}
		const ended = (a: Awaited<ReturnType<typeof airspace>>, flightId: string) => {
			expect(a.flight(flightId)).toBe("aborted");
			expect(a.rows("SELECT status, flight_id FROM intents")).toEqual([{ status: "open", flight_id: null }]);
		};

		it.each(["failed", "conflict"] as const)("a revoked key, landing turned away (%s)", async (status) => {
			const { a, runway } = await onRunway(status);
			const x = await a.join("X");
			const f = await a.fly(x);
			const landing = a.tower.requestLanding(x, { summary: "x" });
			await tick();
			await a.tower.revokeKey(x);
			// The runway has the landing: the flight waits for its answer.
			expect(a.flight(f.id)).toBe("approach");
			runway.open();
			expect((await landing).landing.status).toBe(status);
			ended(a, f.id);
		});

		it("a revoked key, landing sent back by a reviewer", async () => {
			const { a, runway } = await onRunway("review");
			const x = await a.join("X");
			const f = await a.fly(x);
			const landing = a.tower.requestLanding(x, { summary: "x" });
			await tick();
			await a.tower.revokeKey(x);
			runway.open();
			const { landing: l } = await landing;
			expect(l.status).toBe("review");
			await a.tower.reviewLanding({ landingId: l.id, decision: "reject", comment: "not this" });
			ended(a, f.id);
		});

		it("a stopped edge agent, landing turned away", async () => {
			const { a, runway } = await onRunway("failed");
			const [e] = (await a.tower.launchEdge({ count: 1, mode: "scripted", limit: 50 })).launched.map((x) => x.id);
			const f = await a.fly(e);
			const landing = a.tower.requestLanding(e, { summary: "x" });
			await tick();
			await a.tower.stopEdge();
			expect(a.flight(f.id)).toBe("approach");
			runway.open();
			await landing;
			ended(a, f.id);
		});
	});

	it("ends a take-off that a restart interrupted, so its intent and its agent can fly again", async () => {
		const a = await airspace({ fork: () => new Promise(() => {}) });
		await a.tower.addIntents([{ title: "One" }], "operator");
		const x = await a.join("X");
		void a.tower.takeOff(x);
		await tick();
		expect(a.rows("SELECT status FROM flights")).toEqual([{ status: "taxiing" }]);
		// The Durable Object restarts (a deploy, say): a new instance on the same storage.
		const b = await airspace({ db: a.db });
		expect(b.rows("SELECT status FROM flights")).toEqual([{ status: "aborted" }]);
		expect(b.rows("SELECT status, flight_id FROM intents")).toEqual([{ status: "open", flight_id: null }]);
		expect((await b.fly(x)).code).toBe("FL-002");
	});

	it("gives an agent one flight when it takes off twice while the playground starts over", async () => {
		const a = await airspace({ playground: true });
		await a.tower.addIntents([{ title: "One" }, { title: "Two" }], "operator");
		// Every intent has landed: the next take-off starts a new round.
		a.db.exec("UPDATE intents SET status = 'landed'");
		const x = await a.join("X");
		const results = await Promise.allSettled([a.tower.takeOff(x), a.tower.takeOff(x)]);
		expect(a.active(x)).toHaveLength(1);
		expect(a.rows("SELECT status FROM intents ORDER BY seq").map((r) => r.status)).toEqual(["assigned", "open"]);
		const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
		expect(refused).toHaveLength(1);
		expect(String(refused[0].reason)).toMatch(/you are already flying FL-001/);
	});

	it("sets a flight that no longer holds for anything back to airborne", async () => {
		const a = await airspace();
		await a.tower.addIntents([{ title: "One" }, { title: "Two" }], "operator");
		const [x, y] = [await a.join("X"), await a.join("Y")];
		await a.fly(x);
		const fy = await a.fly(y);
		await a.tower.requestClearance(x, { targets: ["src/cart.js#Cart.add"] });
		await a.tower.requestClearance(y, { targets: ["src/cart.js#Cart.add"] });
		expect(a.flight(fy.id)).toBe("holding");
		// Y gives its hold back.
		await a.tower.releaseClearance(y, {});
		expect(a.flight(fy.id)).toBe("airborne");
		// Y holds again, then goes quiet past its lease: the alarm drops the hold.
		await a.tower.requestClearance(y, { targets: ["src/cart.js#Cart.add"] });
		expect(a.flight(fy.id)).toBe("holding");
		a.db.prepare("UPDATE clearances SET expires_at = ? WHERE flight_id = ?").run(Date.now() - 1, fy.id);
		await a.tower.alarm();
		expect(a.rows("SELECT id FROM clearances WHERE flight_id = ?", fy.id)).toEqual([]);
		expect(a.flight(fy.id)).toBe("airborne");
	});
});
