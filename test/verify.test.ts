import { describe, expect, it, vi } from "vitest";
import { globToRegExp, hasDefaultExport, isTestFile, moduleKind, reachableModules, relativePath, testConfig, testFiles, testWorkerModules, verifyTree } from "../src/runway/verify";

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

	it("runs a tree with the configuration it is given, not the one the tree brings", () => {
		const trunkConfig = testConfig(new Map([["contrail.json", JSON.stringify({ tests: { files: ["test/*.test.js"] } })]]));
		const files = new Map([
			["contrail.json", JSON.stringify({ tests: { files: ["nothing/*.js"] } })],
			["test/a.test.js", "export function works() {}"],
		]);
		expect(testWorkerModules(files).tests).toEqual([]);
		expect(testWorkerModules(files, trunkConfig).tests).toEqual(["test/a.test.js"]);
	});

	it("leaves ES namespaces alone when nothing requires them", () => {
		const files = new Map([
			["test/counters.test.js", "import * as counters from '../src/counters.js';\nexport function allNumbers() { Object.values(counters).forEach((f) => f()); }"],
			["src/counters.js", "export function c00() {\n  return 1;\n}"],
		]);
		const { modules } = testWorkerModules(files);
		expect(modules["src/counters.js"]).toEqual({ js: files.get("src/counters.js") });
	});
});

describe("the test gate", () => {
	const files = new Map([
		["src/a.js", "export const a = 1;\n"],
		["test/a.test.js", 'import { a } from "../src/a.js";\nexport function one() {}\n'],
	]);
	/** A Worker Loader whose runner answers with `results` (or never, for null). */
	const loader = (results: unknown[] | null) =>
		({
			get: () => ({ getEntrypoint: () => ({ fetch: () => (results ? Promise.resolve(Response.json(results)) : new Promise(() => {})) }) }),
		}) as unknown as WorkerLoader;

	it("fails a tree whose tests are all gone or skipped when trunk has a suite", async () => {
		const skipped = [{ file: "test/a.test.js", name: "one", ok: true, skipped: true, ms: 0 }];
		const report = await verifyTree(loader(skipped), "t1", files, undefined, true);
		expect(report.failed).toBe(1);
		expect(report.error).toMatch(/no tests ran/);
		expect((await verifyTree(loader([]), "t2", files, undefined, true)).failed).toBe(1);
		// Without a suite on trunk there is nothing to keep.
		expect((await verifyTree(loader([]), "t3", files, undefined, false)).failed).toBe(0);
		expect((await verifyTree(loader([{ file: "test/a.test.js", name: "one", ok: true, ms: 1 }]), "t4", files, undefined, true)).passed).toBe(1);
	});

	it("gives up on a suite that never finishes", async () => {
		vi.useFakeTimers();
		try {
			const pending = verifyTree(loader(null), "t5", files, undefined, true);
			await vi.advanceTimersByTimeAsync(61_000);
			const report = await pending;
			expect(report.failed).toBe(1);
			expect(report.error).toMatch(/ran longer than 60 s/);
		} finally {
			vi.useRealTimers();
		}
	});

	it("scans imports in linear time", () => {
		const big = new Map([["test/x.test.js", "import ".repeat(80_000)]]);
		const started = Date.now();
		reachableModules(["test/x.test.js"], big);
		expect(Date.now() - started).toBeLessThan(2000);
		// Long import lists still resolve.
		const list = `import {\n${Array.from({ length: 60 }, (_, i) => `  name${i},`).join("\n")}\n} from "../src/a.js";\n`;
		expect(reachableModules(["test/y.test.js"], new Map([["test/y.test.js", list], ["src/a.js", ""]]))).toContain("src/a.js");
	});
});
