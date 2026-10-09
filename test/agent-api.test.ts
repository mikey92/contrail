import { describe, expect, it } from "vitest";
import { boundArgs, TOOLS } from "../src/agent-api";

describe("boundArgs", () => {
	it("caps strings, lists, keys and depth", () => {
		const args = boundArgs({ text: "x".repeat(10_000), refs: Array.from({ length: 500 }, (_, i) => `r${i}`), deep: { a: { b: { c: { d: 1 } } } } });
		expect(args.text).toHaveLength(8000);
		expect(args.refs).toHaveLength(100);
		expect(args.deep).toEqual({ a: { b: {} } });
		expect(Object.keys(boundArgs(Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, i]))))).toHaveLength(50);
	});

	it("leaves ordinary arguments as they are", () => {
		const args = { targets: ["src/cart.js#Cart.add"], reason: "merge duplicates", line: 12, wait: true, none: null };
		expect(boundArgs(args)).toEqual(args);
	});
});

describe("list arguments", () => {
	// What a tool hands its Durable Object, for a fake one that only records the call.
	const sent = async (name: string, args: Record<string, unknown>) => {
		let input: any;
		const target = new Proxy({}, { get: () => (_agent: string, i: unknown) => ((input = i), {}) });
		await TOOLS.find((t) => t.name === name)!.run(target as any, "agent", boundArgs(args));
		return input;
	};

	it("takes one value where a list is asked for, as agents often send it", async () => {
		expect((await sent("log", { kind: "plan", text: "p", refs: "src/a.js#f" })).refs).toEqual(["src/a.js#f"]);
		expect((await sent("release_clearance", { targets: "src/a.js#f" })).targets).toEqual(["src/a.js#f"]);
		expect((await sent("release_clearance", { targets: [1, "b"] })).targets).toEqual(["1", "b"]);
	});

	it("keeps a missing list missing: release_clearance without targets releases everything", async () => {
		expect((await sent("release_clearance", {})).targets).toBeUndefined();
		expect((await sent("log", { kind: "note", text: "n" })).refs).toBeUndefined();
	});
});
