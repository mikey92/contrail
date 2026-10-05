import { describe, expect, it } from "vitest";
import { applyChanges, checkPrefixes, composeTree, ownerOf, sectorChanges } from "../src/center/compose";

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

describe("sectorChanges and applyChanges", () => {
	const sectors = [
		{ slug: "pay", prefix: "services/payments/" },
		{ slug: "web", prefix: "web/" },
	];
	const base = new Map([
		["README.md", blob("r1")],
		["services/payments/api.js", blob("p1")],
		["services/payments/old.js", blob("p0")],
		["web/checkout.js", blob("w1")],
		["web/other.js", blob("w9")],
	]);
	const head = new Map([
		["README.md", blob("r1")],
		["services/payments/api.js", blob("p2")],
		["web/checkout.js", blob("w2")],
		["web/new.js", blob("w3")],
		["web/other.js", blob("w9")],
	]);

	it("groups a crossing's changes by sector, deletions included", () => {
		const { bySector, outside } = sectorChanges(base, head, sectors);
		expect(outside).toEqual([]);
		expect(bySector.get("pay")).toEqual([
			{ path: "services/payments/api.js", item: blob("p2") },
			{ path: "services/payments/old.js", item: null },
		]);
		expect(bySector.get("web")).toEqual([
			{ path: "web/checkout.js", item: blob("w2") },
			{ path: "web/new.js", item: blob("w3") },
		]);
	});

	it("lists changes no sector owns", () => {
		const { bySector, outside } = sectorChanges(base, new Map([...head, ["README.md", blob("r2")]]), sectors);
		expect(outside).toEqual(["README.md"]);
		expect([...bySector.keys()].sort()).toEqual(["pay", "web"]);
	});

	it("applies a sector's changes onto that sector's own tree", () => {
		// The sector moved since the crossing's base: its other files are kept as they are now.
		const sectorTree = new Map([
			["services/payments/api.js", blob("p1")],
			["services/payments/old.js", blob("p0")],
			["services/payments/fresh.js", blob("p5")],
		]);
		const { bySector } = sectorChanges(base, head, sectors);
		expect(applyChanges(sectorTree, bySector.get("pay")!)).toEqual(
			new Map([
				["services/payments/api.js", blob("p2")],
				["services/payments/fresh.js", blob("p5")],
			]),
		);
	});
});
