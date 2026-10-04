import { describe, expect, it } from "vitest";
import { checkPrefixes, composeTree, ownerOf } from "../src/center/compose";

const blob = (oid: string) => ({ oid, mode: "100644" });

describe("checkPrefixes", () => {
	it("accepts disjoint directories", () => {
		expect(checkPrefixes(["services/payments/", "services/search/", "web/"])).toBeNull();
	});

	it("rejects overlapping, repeated or malformed prefixes", () => {
		expect(checkPrefixes(["services/", "services/payments/"])).toMatch(/overlap/);
		expect(checkPrefixes(["web/", "web/"])).toMatch(/twice/);
		expect(checkPrefixes(["web"])).toMatch(/bad prefix/);
		expect(checkPrefixes(["../etc/"])).toMatch(/bad prefix/);
	});
});

describe("composeTree", () => {
	const base = new Map([
		["README.md", blob("r1")],
		["a/src/x.js", blob("a1")],
		["a/src/old.js", blob("a0")],
		["b/src/y.js", blob("b1")],
	]);

	it("replaces a sector's subtree and keeps everything else", () => {
		const a = new Map([
			["a/src/x.js", blob("a2")],
			["a/src/new.js", blob("a3")],
		]);
		const next = composeTree(base, [{ prefix: "a/", tree: a }]);
		expect([...next.entries()].sort()).toEqual(
			[
				["README.md", blob("r1")],
				["a/src/new.js", blob("a3")],
				["a/src/x.js", blob("a2")],
				["b/src/y.js", blob("b1")],
			].sort(),
		);
	});

	it("ignores anything a sector holds outside its prefix", () => {
		const a = new Map([
			["a/src/x.js", blob("a2")],
			["b/src/y.js", blob("evil")],
			["README.md", blob("evil")],
		]);
		const next = composeTree(base, [{ prefix: "a/", tree: a }]);
		expect(next.get("b/src/y.js")).toEqual(blob("b1"));
		expect(next.get("README.md")).toEqual(blob("r1"));
	});

	it("finds the owner of a path", () => {
		const sectors = [{ prefix: "a/" }, { prefix: "b/" }];
		expect(ownerOf("b/src/y.js", sectors)).toEqual({ prefix: "b/" });
		expect(ownerOf("README.md", sectors)).toBeNull();
	});
});
