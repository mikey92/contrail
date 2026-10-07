// Verifies a candidate trunk tree by running its test suite inside a fresh Dynamic Worker.
//
// A project can describe its tests in contrail.json:
//   { "tests": { "style": "mocha", "files": ["test/*.js"], "exclude": [],
//                "modules": { "fast-check": "vendor/fast-check.cjs" }, "command": "npm test" } }
// - style "exports" (the default): every exported function of a test module is one test case.
// - style "mocha": describe/it/before/after/beforeEach/afterEach globals, it.skip, done callbacks.
// Without a config, `*.test.js` / `*.spec.mjs` files are tests in the "exports" style.
// Test files and every module they reach (import or require; ES modules and CommonJS) are loaded
// into a Dynamic Worker with no network access. A tree is identified by its git tree oid, so an
// identical tree reuses the same warm isolate.
import type { TestReport } from "../shared/types";

export interface TestConfig {
	style: "exports" | "mocha";
	/** Globs of test files. */
	files: string[];
	exclude: string[];
	/** Bare module names mapped to files in the repository (vendored test dependencies). */
	modules: Record<string, string>;
	/** How a contributor runs the suite locally (told to agents when they take off). */
	command?: string;
	timeoutMs: number;
}

export const CONFIG_FILE = "contrail.json";
const DEFAULT_CONFIG: TestConfig = {
	style: "exports",
	files: ["**/*.test.js", "**/*.test.mjs", "**/*.spec.js", "**/*.spec.mjs"],
	exclude: ["node_modules/**"],
	modules: {},
	timeoutMs: 2000,
};
const SCRIPT_FILE = /\.(m?js|cjs)$/;
/** CPU budget of one test run: a runaway loop must not stall the runway, trunk's only writer. */
const CPU_LIMIT_MS = 15_000;
const MAX_MODULE_BYTES = 512 * 1024;
/** The whole suite's time on the runway: a test that never settles must not hold every landing behind it. */
const SUITE_TIMEOUT_MS = 60_000;
/** Failures kept in a report (passing results are only counted). */
const MAX_REPORTED_FAILURES = 50;

/** Glob to RegExp: `**` spans directories, `*` and `?` stay within one path segment. */
export function globToRegExp(glob: string): RegExp {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			if (glob[i + 2] === "/") {
				re += "(?:.*/)?";
				i += 2;
			} else {
				re += ".*";
				i += 1;
			}
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`);
}

/** The project's test configuration (contrail.json), or the defaults. */
export function testConfig(files: Map<string, string>): TestConfig {
	const raw = files.get(CONFIG_FILE);
	if (!raw) return DEFAULT_CONFIG;
	try {
		const t = ((JSON.parse(raw) as { tests?: Partial<TestConfig> }).tests ?? {}) as Partial<TestConfig>;
		return {
			style: t.style === "mocha" ? "mocha" : "exports",
			files: Array.isArray(t.files) && t.files.length ? t.files.map(String) : DEFAULT_CONFIG.files,
			exclude: Array.isArray(t.exclude) ? t.exclude.map(String) : DEFAULT_CONFIG.exclude,
			modules: t.modules && typeof t.modules === "object" ? Object.fromEntries(Object.entries(t.modules).map(([k, v]) => [k, String(v)])) : {},
			command: typeof t.command === "string" ? t.command : undefined,
			timeoutMs: typeof t.timeoutMs === "number" ? Math.min(30_000, Math.max(100, t.timeoutMs)) : DEFAULT_CONFIG.timeoutMs,
		};
	} catch {
		return DEFAULT_CONFIG;
	}
}

export function testFiles(config: TestConfig, paths: Iterable<string>): string[] {
	const include = config.files.map(globToRegExp);
	const exclude = config.exclude.map(globToRegExp);
	return [...paths].filter((p) => SCRIPT_FILE.test(p) && include.some((r) => r.test(p)) && !exclude.some((r) => r.test(p))).sort();
}

export function isTestFile(path: string) {
	return testFiles(DEFAULT_CONFIG, [path]).length === 1;
}

// The clause before `from` is bounded: unbounded, a file of many bare "import " words takes quadratic time.
const IMPORT_RE = /(?:import|export)\s[^'"`;]{0,2000}?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/g;

function resolveRelative(from: string, spec: string): string | null {
	if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
	const parts = from.split("/").slice(0, -1);
	for (const seg of spec.split("/")) {
		if (seg === "." || seg === "") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return parts.join("/");
}

/** Modules transitively imported or required by the entry files (including the entries). Bare names
 * listed in `aliases` resolve to their files; other bare names are runtime built-ins. */
export function reachableModules(entries: string[], files: Map<string, string>, aliases: Record<string, string> = {}): string[] {
	const seen = new Set<string>();
	const stack = [...entries, ...Object.values(aliases)];
	while (stack.length) {
		const path = stack.pop()!;
		if (seen.has(path) || !files.has(path)) continue;
		seen.add(path);
		// Modules too big to load are not scanned either.
		if (path.endsWith(".json") || files.get(path)!.length > MAX_MODULE_BYTES) continue;
		for (const m of files.get(path)!.matchAll(IMPORT_RE)) {
			const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
			const target = resolveRelative(path, spec) ?? aliases[spec] ?? null;
			if (target && !seen.has(target)) stack.push(target);
		}
	}
	return [...seen];
}

/** ES module, CommonJS or JSON. Ambiguous `.js` files are ES modules unless they only use require/exports. */
export function moduleKind(path: string, source: string): "js" | "cjs" | "json" {
	if (path.endsWith(".json")) return "json";
	if (path.endsWith(".cjs")) return "cjs";
	if (path.endsWith(".mjs")) return "js";
	if (/^\s*(import\s*[\w{*"']|export\s)/m.test(source)) return "js";
	if (/\brequire\s*\(|\bmodule\.exports\b|\bexports\.[\w$]+\s*=/.test(source)) return "cjs";
	return "js";
}

export function hasDefaultExport(source: string): boolean {
	if (/\bexport\s+default\b/.test(source)) return true;
	for (const m of source.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
		for (const spec of m[1].split(",")) {
			const [local, exported] = spec.trim().split(/\s+as\s+/);
			if ((exported ?? local).trim() === "default") return true;
		}
	}
	return false;
}

/** ES modules that CommonJS modules require, directly or through a vendored alias. */
function requiredByCommonJs(paths: string[], kinds: Map<string, string>, files: Map<string, string>, aliases: Record<string, string>): Set<string> {
	const required = new Set(Object.values(aliases));
	for (const path of paths) {
		if (kinds.get(path) !== "cjs") continue;
		for (const m of files.get(path)!.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) {
			const target = resolveRelative(path, m[1]) ?? aliases[m[1]];
			if (target) required.add(target);
		}
	}
	return required;
}

/** In workerd, require() of an ES module returns its default export. Like Node's require(esm), a
 * CommonJS test that requires a module without one should get the whole namespace. Only modules
 * that CommonJS requires get the shim: ES importers keep the exact namespace. */
function withNamespaceDefault(path: string, source: string): string {
	if (hasDefaultExport(source)) return source;
	const self = `./${path.split("/").pop()}`;
	return `${source}\nimport * as __contrail_self from ${JSON.stringify(self)};\nexport default __contrail_self;\n`;
}

const MOCHA_HARNESS = `
const SKIP = Symbol("skip");
const ctx = { timeout() { return ctx; }, slow() { return ctx; }, retries() { return ctx; }, skip() { throw SKIP; } };
const newSuite = (title, parent, skip, file) => ({ title, parent, skip, file, suites: [], tests: [], before: [], after: [], beforeEach: [], afterEach: [] });
const root = newSuite("", null, false, "");
let current = root;
let file = "";
const suite = (skip) => (title, fn) => {
  const s = newSuite(String(title), current, skip || current.skip, file);
  current.suites.push(s);
  const parent = current;
  current = s;
  try { if (typeof fn === "function") fn.call(ctx); } finally { current = parent; }
};
const test = (skip) => (title, fn) => {
  current.tests.push({ title: String(title), fn, file, skip: skip || current.skip || typeof fn !== "function" });
};
const g = globalThis;
g.describe = suite(false); g.describe.skip = suite(true); g.describe.only = suite(false);
g.context = g.describe; g.xdescribe = g.describe.skip; g.xcontext = g.describe.skip;
g.it = test(false); g.it.skip = test(true); g.it.only = test(false); g.specify = g.it; g.xit = g.it.skip;
for (const hook of ["before", "after", "beforeEach", "afterEach"]) g[hook] = (fn) => { if (typeof fn === "function") current[hook].push(fn); };
const invoke = (fn, ms) => Promise.race([
  new Promise((resolve, reject) => {
    if (fn.length > 0) fn.call(ctx, (err) => (err ? reject(err) : resolve()));
    else Promise.resolve().then(() => fn.call(ctx)).then(resolve, reject);
  }),
  new Promise((_, reject) => setTimeout(() => reject(new Error("timed out after " + ms + "ms")), ms)),
]);
const titleOf = (s, leaf) => { const parts = [leaf]; for (let x = s; x && x.title; x = x.parent) parts.unshift(x.title); return parts.join(" › "); };
const message = (e) => String((e && e.message) || e).slice(0, 500);
async function runSuite(s, chain, results, ms) {
  try { for (const h of s.before) await invoke(h, ms); }
  catch (e) { results.push({ file: s.file, name: titleOf(s, '"before all" hook'), ok: false, ms: 0, error: message(e) }); return; }
  for (const t of s.tests) {
    const name = titleOf(s, t.title);
    if (t.skip) { results.push({ file: t.file, name, ok: true, skipped: true, ms: 0 }); continue; }
    const started = Date.now();
    try {
      for (const x of chain) for (const h of x.beforeEach) await invoke(h, ms);
      await invoke(t.fn, ms);
      for (const x of [...chain].reverse()) for (const h of x.afterEach) await invoke(h, ms);
      results.push({ file: t.file, name, ok: true, ms: Date.now() - started });
    } catch (e) {
      if (e === SKIP) results.push({ file: t.file, name, ok: true, skipped: true, ms: 0 });
      else results.push({ file: t.file, name, ok: false, ms: Date.now() - started, error: message(e) });
    }
  }
  for (const child of s.suites) await runSuite(child, [...chain, child], results, ms);
  for (const h of s.after) await invoke(h, ms).catch(() => {});
}
export function register(path) { file = path; }
export async function run(ms) { const results = []; await runSuite(root, [root], results, ms); return results; }
`;

function mochaRunner(testFiles: string[], timeoutMs: number): string {
	return `import { register, run } from "./__contrail_mocha.js";
const files = ${JSON.stringify(testFiles)};
export default {
  async fetch() {
    const loadErrors = [];
    for (const f of files) {
      register(f);
      try { await import("./" + f); }
      catch (e) { loadErrors.push({ file: f, name: "(loading the test file)", ok: false, ms: 0, error: String((e && e.message) || e).slice(0, 500) }); }
    }
    return Response.json([...loadErrors, ...(await run(${timeoutMs}))]);
  },
};
`;
}

function exportsRunner(testFiles: string[], timeoutMs: number): string {
	const imports = testFiles.map((p, i) => `import * as t${i} from ${JSON.stringify(`./${p}`)};`);
	const suites = testFiles.map((p, i) => `[${JSON.stringify(p)}, t${i}]`).join(", ");
	return `${imports.join("\n")}
const suites = [${suites}];
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out after " + ms + "ms")), ms))]);
export default {
  async fetch() {
    const results = [];
    for (const [file, mod] of suites) {
      const cases = Object.entries(mod).filter(([, fn]) => typeof fn === "function");
      for (const [name, fn] of cases) {
        const started = Date.now();
        try {
          await withTimeout(Promise.resolve().then(() => fn()), ${timeoutMs});
          results.push({ file, name, ok: true, ms: Date.now() - started });
        } catch (e) {
          results.push({ file, name, ok: false, ms: Date.now() - started, error: String((e && e.message) || e).slice(0, 500) });
        }
      }
    }
    return Response.json(results);
  },
};
`;
}

type ModuleSpec = string | { js: string } | { cjs: string } | { json: unknown };

/** Module map for a Dynamic Worker that runs the tests of `files` (path → text). */
export function testWorkerModules(files: Map<string, string>, config = testConfig(files)): { modules: Record<string, ModuleSpec>; tests: string[] } {
	const tests = testFiles(config, files.keys());
	const modules: Record<string, ModuleSpec> = {};
	if (tests.length === 0) return { modules, tests };
	modules["__contrail_runner.js"] = config.style === "mocha" ? mochaRunner(tests, config.timeoutMs) : exportsRunner(tests, config.timeoutMs);
	if (config.style === "mocha") modules["__contrail_mocha.js"] = { js: MOCHA_HARNESS };
	// Only modules reachable from the tests are loaded, so stray scripts never break verification.
	const reachable = reachableModules(tests, files, config.modules).filter((path) => /\.(m?js|cjs|json)$/.test(path) && files.get(path)!.length <= MAX_MODULE_BYTES);
	const kinds = new Map(reachable.map((path) => [path, moduleKind(path, files.get(path)!)]));
	const required = requiredByCommonJs(reachable, kinds, files, config.modules);
	for (const path of reachable) {
		const content = files.get(path)!;
		const kind = kinds.get(path)!;
		if (kind === "json") {
			try {
				modules[path] = { json: JSON.parse(content) };
			} catch {
				// Unparseable JSON simply isn't importable.
			}
		} else if (kind === "cjs") modules[path] = { cjs: content };
		else modules[path] = { js: required.has(path) ? withNamespaceDefault(path, content) : content };
	}
	// Vendored dependencies are reachable under their bare names. workerd resolves a bare require()
	// next to the requiring module, so each alias is placed at the root and in every directory that uses it.
	for (const [name, target] of Object.entries(config.modules)) {
		if (!modules[target]) continue;
		const dirs = new Set([""]);
		for (const path of Object.keys(modules)) {
			const content = files.get(path);
			if (content && new RegExp(`["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(content)) dirs.add(path.split("/").slice(0, -1).join("/"));
		}
		for (const dir of dirs) {
			const at = dir ? `${dir}/${name}` : name;
			if (!modules[at]) modules[at] = { cjs: `module.exports = require(${JSON.stringify(relativePath(dir, target))});` };
		}
	}
	return { modules, tests };
}

/** A short, stable fingerprint (FNV-1a) for cache keys. */
function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return (h >>> 0).toString(36);
}

/** Relative module specifier from directory `fromDir` to file `to` (both repository paths). */
export function relativePath(fromDir: string, to: string): string {
	const from = fromDir ? fromDir.split("/") : [];
	const target = to.split("/");
	let i = 0;
	while (i < from.length && i < target.length - 1 && from[i] === target[i]) i++;
	const up = from.length - i;
	return `${up ? "../".repeat(up) : "./"}${target.slice(i).join("/")}`;
}

/**
 * Runs the test suite of a tree. The runway passes trunk's own configuration, so a change cannot rewrite
 * the rules it is judged by, and `expectTests` when trunk has tests: a tree with none left fails.
 */
export async function verifyTree(loader: WorkerLoader, treeOid: string, files: Map<string, string>, config = testConfig(files), expectTests = false): Promise<TestReport> {
	const started = Date.now();
	const { modules, tests } = testWorkerModules(files, config);
	if (tests.length === 0) {
		if (!expectTests) return { passed: 0, failed: 0, results: [], ms: 0 };
		return { passed: 0, failed: 1, results: [], error: "no tests left to run: trunk has a test suite, but this tree has no files the gate runs", ms: 0 };
	}
	try {
		const worker = loader.get(`contrail-verify:${treeOid}:${hash(JSON.stringify(config))}`, async () => ({
			compatibilityDate: "2026-10-01",
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "__contrail_runner.js",
			modules: modules as Record<string, string>,
			globalOutbound: null,
			limits: { cpuMs: CPU_LIMIT_MS },
		}));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const res = await Promise.race([
			worker.getEntrypoint().fetch("https://verify.contrail/"),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`the test suite ran longer than ${SUITE_TIMEOUT_MS / 1000} s`)), SUITE_TIMEOUT_MS);
			}),
		]).finally(() => clearTimeout(timer));
		if (!res.ok) throw new Error(`runner responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
		const results = (await res.json()) as (TestReport["results"][number] & { skipped?: boolean })[];
		const failures = results.filter((r) => !r.ok);
		const skipped = results.filter((r) => r.skipped).length;
		// Test files emptied out or skipped wholesale are no suite at all.
		if (expectTests && results.length - failures.length - skipped === 0 && failures.length === 0)
			return { passed: 0, failed: 1, skipped: skipped || undefined, results: [], error: "no tests ran: trunk has a test suite, but every test in this tree is gone or skipped", ms: Date.now() - started };
		return {
			passed: results.length - failures.length - skipped,
			failed: failures.length,
			skipped: skipped || undefined,
			// Big suites report thousands of passing cases: keep the failures, count the rest.
			results: results.length > MAX_REPORTED_FAILURES ? failures.slice(0, MAX_REPORTED_FAILURES) : results,
			ms: Date.now() - started,
		};
	} catch (err) {
		// Load failures (syntax errors, bad imports) fail the whole suite.
		const message = err instanceof Error ? err.message : String(err);
		return { passed: 0, failed: 1, results: [], error: message.slice(0, 1000), ms: Date.now() - started };
	}
}
