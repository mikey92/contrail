import { describe, expect, it } from "vitest";
import { boundArgs } from "../src/agent-api";

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
