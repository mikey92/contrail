import { describe, expect, it } from "vitest";
import { isTestFile, reachableModules } from "../src/runway/verify";

describe("verify helpers", () => {
	it("recognises test files", () => {
		expect(isTestFile("test/cart.test.js")).toBe(true);
		expect(isTestFile("src/a.spec.mjs")).toBe(true);
		expect(isTestFile("test/run.mjs")).toBe(false);
	});

	it("loads only modules reachable from tests", () => {
		const files = new Map([
			["test/a.test.js", 'import { a } from "../src/a.js";\nimport cfg from "../config.json" with { type: "json" };'],
			["src/a.js", 'export * from "./b.js";\nimport "./side.js";'],
			["src/b.js", "export const b = 1;"],
			["src/side.js", ""],
			["config.json", "{}"],
			["test/run.mjs", 'import { readdirSync } from "node:fs";'],
			["scripts/x.js", "boom("],
		]);
		expect(reachableModules(["test/a.test.js"], files).sort()).toEqual(["config.json", "src/a.js", "src/b.js", "src/side.js", "test/a.test.js"]);
	});
});
