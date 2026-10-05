// Runs every sector's tests the way each sector's runway does: every exported function of a
// *.test.js file is one test.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.test\.m?js$/.test(entry)) files.push(path);
  }
})(root);

let passed = 0;
let failed = 0;
for (const file of files.sort()) {
  const tests = await import(pathToFileURL(file).href);
  for (const [name, test] of Object.entries(tests)) {
    if (typeof test !== "function") continue;
    try {
      await test();
      passed++;
      console.log(`ok    ${relative(root, file)} › ${name}`);
    } catch (err) {
      failed++;
      console.log(`FAIL  ${relative(root, file)} › ${name}: ${err.message}`);
    }
  }
}
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
