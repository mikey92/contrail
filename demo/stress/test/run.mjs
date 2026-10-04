// Local test runner mirroring Contrail's verifier: every exported function of every
// test/*.test.js file is a test case. Usage: node test/run.mjs
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
let failed = 0;
let passed = 0;
for (const file of readdirSync(dir).filter((f) => /\.test\.m?js$/.test(f)).sort()) {
  const mod = await import(pathToFileURL(join(dir, file)).href);
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== "function") continue;
    try {
      await fn();
      passed++;
      console.log(`  ok   ${file} › ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${file} › ${name}\n       ${err.message}`);
    }
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
