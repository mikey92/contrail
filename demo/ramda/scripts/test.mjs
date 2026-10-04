#!/usr/bin/env node
// Runs this repository's tests with no dependencies to install: mocha-style describe/it, CommonJS
// test files, and the ES module source loaded with require() (Node 22.12+). Contrail's test gate
// runs the same suite, configured by contrail.json, in a Dynamic Worker on every landing.
//   npm test                                  every test file
//   node --no-warnings scripts/test.mjs test/add.js test/range.js
import { readFileSync, readdirSync, statSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(join(root, "contrail.json"), "utf8")).tests;
const aliases = config.modules ?? {};
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return resolveFilename.call(this, aliases[request] ? join(root, aliases[request]) : request, ...rest);
};
// require() of an ES module gives its default export when it has one, else the namespace (the way
// Ramda's own build and Contrail's test gate both behave).
const requireModule = Module.prototype.require;
Module.prototype.require = function (id) {
  const m = requireModule.call(this, id);
  return m && m[Symbol.toStringTag] === "Module" && "default" in m ? m.default : m;
};

const SKIP = Symbol("skip");
const ctx = { timeout() { return ctx; }, slow() { return ctx; }, retries() { return ctx; }, skip() { throw SKIP; } };
const newSuite = (title, parent, skip, file) => ({ title, parent, skip, file, suites: [], tests: [], before: [], after: [], beforeEach: [], afterEach: [] });
const top = newSuite("", null, false, "");
let current = top;
let file = "";
const suite = (skip) => (title, fn) => {
  const s = newSuite(String(title), current, skip || current.skip, file);
  current.suites.push(s);
  const parent = current;
  current = s;
  try {
    if (typeof fn === "function") fn.call(ctx);
  } finally {
    current = parent;
  }
};
const test = (skip) => (title, fn) => current.tests.push({ title: String(title), fn, file, skip: skip || current.skip || typeof fn !== "function" });
const g = globalThis;
g.describe = suite(false);
g.describe.skip = suite(true);
g.describe.only = suite(false);
g.context = g.describe;
g.xdescribe = g.describe.skip;
g.it = test(false);
g.it.skip = test(true);
g.it.only = test(false);
g.specify = g.it;
g.xit = g.it.skip;
for (const hook of ["before", "after", "beforeEach", "afterEach"]) g[hook] = (fn) => typeof fn === "function" && current[hook].push(fn);

const ms = config.timeoutMs ?? 2000;
const invoke = (fn) =>
  Promise.race([
    new Promise((res, rej) => {
      if (fn.length > 0) fn.call(ctx, (err) => (err ? rej(err) : res()));
      else Promise.resolve().then(() => fn.call(ctx)).then(res, rej);
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${ms}ms`)), ms).unref()),
  ]);
const titleOf = (s, leaf) => {
  const parts = [leaf];
  for (let x = s; x && x.title; x = x.parent) parts.unshift(x.title);
  return parts.join(" › ");
};
const results = [];
async function runSuite(s, chain) {
  try {
    for (const h of s.before) await invoke(h);
  } catch (e) {
    results.push({ file: s.file, name: titleOf(s, '"before all" hook'), ok: false, error: e });
    return;
  }
  for (const t of s.tests) {
    const name = titleOf(s, t.title);
    if (t.skip) {
      results.push({ file: t.file, name, ok: true, skipped: true });
      continue;
    }
    try {
      for (const x of chain) for (const h of x.beforeEach) await invoke(h);
      await invoke(t.fn);
      for (const x of [...chain].reverse()) for (const h of x.afterEach) await invoke(h);
      results.push({ file: t.file, name, ok: true });
    } catch (e) {
      results.push(e === SKIP ? { file: t.file, name, ok: true, skipped: true } : { file: t.file, name, ok: false, error: e });
    }
  }
  for (const child of s.suites) await runSuite(child, [...chain, child]);
  for (const h of s.after) await invoke(h).catch(() => {});
}

const glob = (pattern) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*\//g, "\u0000").replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, "(?:.*/)?")}$`);
const include = (config.files ?? []).map(glob);
const exclude = (config.exclude ?? []).map(glob);
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === "node_modules" || name === ".git") return [];
    return statSync(full).isDirectory() ? walk(full) : [relative(root, full)];
  });
const files = process.argv.length > 2 ? process.argv.slice(2).map((f) => relative(root, resolve(f))) : walk(root).filter((p) => include.some((r) => r.test(p)) && !exclude.some((r) => r.test(p))).sort();

const require = createRequire(join(root, "package.json"));
for (const f of files) {
  file = f;
  try {
    require(join(root, f));
  } catch (e) {
    results.push({ file: f, name: "(loading the test file)", ok: false, error: e });
  }
}
await runSuite(top, [top]);

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped).length;
for (const r of failed) console.log(`✖ ${r.file} › ${r.name}\n    ${String(r.error?.message ?? r.error).split("\n").join("\n    ")}`);
console.log(`${results.length - failed.length - skipped} passing, ${failed.length} failing${skipped ? `, ${skipped} skipped` : ""} (${files.length} test files)`);
process.exit(failed.length ? 1 : 0);
