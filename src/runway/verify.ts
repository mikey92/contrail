// Verifies a candidate trunk tree by running its test suite inside a fresh Dynamic Worker.
//
// Convention: any `*.test.js` / `*.test.mjs` file is a test module and every exported function is
// one test case (async allowed). Tests may import project modules with relative paths and use
// `node:assert`. The sandbox has no network access. A tree is identified by its git tree oid, so an
// identical tree reuses the same warm isolate.
import type { TestReport } from "../shared/types";

const TEST_FILE = /(^|\/)[^/]+\.(test|spec)\.m?js$/;
const MODULE_FILE = /\.(m?js|json)$/;
const MAX_MODULE_BYTES = 512 * 1024;
const PER_TEST_TIMEOUT_MS = 2000;

export function isTestFile(path: string) {
	return TEST_FILE.test(path);
}

const IMPORT_RE = /(?:import|export)\s[^'"`;]*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

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

/** Relative modules transitively imported by the entry files (including the entries). */
export function reachableModules(entries: string[], files: Map<string, string>): string[] {
	const seen = new Set<string>();
	const stack = [...entries];
	while (stack.length) {
		const path = stack.pop()!;
		if (seen.has(path) || !files.has(path)) continue;
		seen.add(path);
		if (path.endsWith(".json")) continue;
		for (const m of files.get(path)!.matchAll(IMPORT_RE)) {
			const target = resolveRelative(path, m[1] ?? m[2] ?? m[3]);
			if (target && !seen.has(target)) stack.push(target);
		}
	}
	return [...seen];
}

function runnerSource(testFiles: string[]): string {
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
          await withTimeout(Promise.resolve().then(() => fn()), ${PER_TEST_TIMEOUT_MS});
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

export async function verifyTree(loader: WorkerLoader, treeOid: string, files: Map<string, string>): Promise<TestReport> {
	const started = Date.now();
	const testFiles = [...files.keys()].filter(isTestFile).sort();
	if (testFiles.length === 0) return { passed: 0, failed: 0, results: [], ms: 0 };

	// Only modules reachable from the test files are loaded, so stray scripts never break verification.
	const modules: Record<string, string | { js: string } | { json: unknown }> = { "__contrail_runner.js": runnerSource(testFiles) };
	for (const path of reachableModules(testFiles, files)) {
		const content = files.get(path)!;
		if (!MODULE_FILE.test(path) || content.length > MAX_MODULE_BYTES) continue;
		if (path.endsWith(".json")) {
			try {
				modules[path] = { json: JSON.parse(content) };
			} catch {
				// Unparseable JSON simply isn't importable.
			}
		} else {
			modules[path] = { js: content };
		}
	}

	try {
		const worker = loader.get(`contrail-verify:${treeOid}`, async () => ({
			compatibilityDate: "2026-10-01",
			compatibilityFlags: ["nodejs_compat"],
			mainModule: "__contrail_runner.js",
			modules,
			globalOutbound: null,
		}));
		const res = await worker.getEntrypoint().fetch("https://verify.contrail/");
		if (!res.ok) throw new Error(`runner responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
		const results = (await res.json()) as TestReport["results"];
		const failed = results.filter((r) => !r.ok).length;
		return { passed: results.length - failed, failed, results, ms: Date.now() - started };
	} catch (err) {
		// Load failures (syntax errors, bad imports) fail the whole suite.
		const message = err instanceof Error ? err.message : String(err);
		return { passed: 0, failed: 1, results: [], error: message.slice(0, 1000), ms: Date.now() - started };
	}
}
