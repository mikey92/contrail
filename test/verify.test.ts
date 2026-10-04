import { describe, expect, it } from "vitest";
import { globToRegExp, hasDefaultExport, isTestFile, moduleKind, reachableModules, relativePath, testConfig, testFiles, testWorkerModules } from "../src/runway/verify";

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

	it("follows require() and vendored aliases", () => {
		const files = new Map([
			["test/add.js", "var R = require('../source/index.js');\nvar fc = require('fast-check');"],
			["source/index.js", "export { default as add } from './add.js';"],
			["source/add.js", "export default (a, b) => a + b;"],
			["vendor/fc.cjs", "module.exports = {};"],
		]);
		expect(reachableModules(["test/add.js"], files, { "fast-check": "vendor/fc.cjs" }).sort()).toEqual(["source/add.js", "source/index.js", "test/add.js", "vendor/fc.cjs"]);
	});

	it("matches globs", () => {
		expect(globToRegExp("test/*.js").test("test/add.js")).toBe(true);
		expect(globToRegExp("test/*.js").test("test/shared/eq.js")).toBe(false);
		expect(globToRegExp("**/*.test.js").test("a/b/c.test.js")).toBe(true);
		expect(globToRegExp("**/*.test.js").test("c.test.js")).toBe(true);
	});

	it("reads contrail.json", () => {
		const files = new Map([["contrail.json", JSON.stringify({ tests: { style: "mocha", files: ["test/*.js"], command: "npm test" } })]]);
		const config = testConfig(files);
		expect(config.style).toBe("mocha");
		expect(config.command).toBe("npm test");
		expect(testFiles(config, ["test/add.js", "test/shared/eq.js", "source/add.js"])).toEqual(["test/add.js"]);
		expect(testConfig(new Map([["contrail.json", "{"]])).style).toBe("exports");
	});

	it("tells ES modules from CommonJS", () => {
		expect(moduleKind("a.js", "import x from './x.js';")).toBe("js");
		expect(moduleKind("a.js", "var x = require('./x.js');\nmodule.exports = x;")).toBe("cjs");
		expect(moduleKind("a.cjs", "export default 1")).toBe("cjs");
		expect(moduleKind("a.json", "{}")).toBe("json");
	});

	it("finds default exports", () => {
		expect(hasDefaultExport("var add = 1;\nexport default add;")).toBe(true);
		expect(hasDefaultExport("export { add as default };")).toBe(true);
		expect(hasDefaultExport("export { default } from './x.js';")).toBe(true);
		expect(hasDefaultExport("export { default as add } from './add.js';")).toBe(false);
	});

	it("computes relative specifiers", () => {
		expect(relativePath("test", "vendor/fc.cjs")).toBe("../vendor/fc.cjs");
		expect(relativePath("", "vendor/fc.cjs")).toBe("./vendor/fc.cjs");
		expect(relativePath("vendor", "vendor/fc.cjs")).toBe("./fc.cjs");
		expect(relativePath("a/b", "a/c/d.js")).toBe("../c/d.js");
	});

	it("builds a mocha worker with namespace defaults and vendored aliases", () => {
		const files = new Map([
			["contrail.json", JSON.stringify({ tests: { style: "mocha", files: ["test/*.js"], modules: { "fast-check": "vendor/fc.cjs" } } })],
			["test/add.js", "var R = require('../source/index.js');\nvar fc = require('fast-check');\ndescribe('add', () => it('adds', () => {}));"],
			["source/index.js", "export { default as add } from './add.js';"],
			["source/add.js", "export default (a, b) => a + b;"],
			["vendor/fc.cjs", "module.exports = {};"],
		]);
		const { modules, tests } = testWorkerModules(files);
		expect(tests).toEqual(["test/add.js"]);
		expect(modules["test/add.js"]).toEqual({ cjs: files.get("test/add.js") });
		expect((modules["source/index.js"] as { js: string }).js).toContain("export default __contrail_self");
		expect((modules["source/add.js"] as { js: string }).js).not.toContain("__contrail_self");
		expect(modules["test/fast-check"]).toEqual({ cjs: 'module.exports = require("../vendor/fc.cjs");' });
		expect(modules["fast-check"]).toEqual({ cjs: 'module.exports = require("./vendor/fc.cjs");' });
		expect(modules["__contrail_mocha.js"]).toBeTruthy();
	});
});
