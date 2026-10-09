#!/usr/bin/env node
// Builds a monorepo split into sectors for load tests: every sector is a copy of demo/stress under its own
// directory (sector-00/, sector-01/, …) with its own scripted intents. Each sector becomes a project of its
// own (Tower, Runway, trunk repo), and a Center composes the sector trunks into one monorepo trunk.
//   CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/create-sectors.mjs <slug> [--sectors 10] [--intents 300] [--name "…"]
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const slug = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
const sectors = Number(option("--sectors", 10));
const perSector = Number(option("--intents", 300));
const name = option("--name", `Monorepo · ${sectors} sectors`);
const base = process.env.CONTRAIL_URL?.replace(/\/$/, "");
const admin = process.env.CONTRAIL_ADMIN_KEY;
if (!slug || !base || !admin || !(sectors >= 1 && sectors <= 50)) {
  console.error('usage: CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/create-sectors.mjs <slug> [--sectors 10] [--intents 300] [--name "…"]');
  process.exit(2);
}

const template = join(dirname(fileURLToPath(import.meta.url)), "../demo/stress");
function walk(root, out = {}) {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (entry !== "intents.json") out[relative(template, full)] = readFileSync(full, "utf8");
  }
  return out;
}
const sectorFiles = walk(template);

// The same seeded generator as make-stress-intents.mjs, with a different seed per sector.
function intentsFor(prefix, n, seed) {
  const counters = Array.from({ length: 24 }, (_, i) => `c${String(i).padStart(2, "0")}`);
  const weights = counters.map((_, i) => 1 / (i + 1));
  const total = weights.reduce((a, b) => a + b, 0);
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = () => {
    let r = rand() * total;
    for (let i = 0; i < counters.length; i++) if ((r -= weights[i]) <= 0) return counters[i];
    return counters[0];
  };
  const out = [];
  for (let i = 1; i <= n; i++) {
    if (rand() < 0.2) {
      const symbol = `note_${String(i).padStart(4, "0")}`;
      const code = `export function ${symbol}() {\n  return true;\n}`;
      out.push({ title: `Append ${symbol}`, body: `Add a new note function.\nscript: ${JSON.stringify({ op: "append", path: `${prefix}src/notes.js`, symbol, code })}`, priority: 0 });
    } else {
      const symbol = pick();
      out.push({ title: `Increment ${symbol}`, body: `Increment counter ${symbol} by one on the latest trunk.\nscript: ${JSON.stringify({ op: "increment", path: `${prefix}src/counters.js`, symbol })}`, priority: 0 });
    }
  }
  return out;
}

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

const monorepo = {
  "README.md": `# ${name}\n\nA load-test monorepo for Contrail: ${sectors} sectors, each a directory with its own shared counters.\nEvery sector lands in parallel through its own runway; the Center composes them into this trunk.\n`,
};
// What this run made: if it fails part way, it deletes them, so it can simply be run again.
const slugs = [];
try {
  for (let i = 0; i < sectors; i++) {
    const id = String(i).padStart(2, "0");
    const prefix = `sector-${id}/`;
    const files = Object.fromEntries(Object.entries(sectorFiles).map(([p, text]) => [`${prefix}${p}`, text]));
    Object.assign(monorepo, files);
    const sectorSlug = `${slug}-s${id}`;
    await call("POST", "/api/projects", {
      slug: sectorSlug,
      name: `Sector ${id}`,
      description: `Sector ${id} of ${name}: owns ${prefix}`,
      public: true,
      center: slug,
      prefix,
      source: { kind: "files", files },
    });
    slugs.push(sectorSlug);
    await call("POST", `/api/p/${sectorSlug}/intents`, { intents: intentsFor(prefix, perSector, 42 + i) });
    console.log(`sector ${sectorSlug} owns ${prefix}: ${perSector} intents`);
  }
  const { center } = await call("POST", "/api/centers", {
    slug,
    name,
    description: `${sectors} sectors × ${perSector} scripted intents on 24 shared counters each. Sectors land in parallel; the Center composes one monorepo trunk.`,
    public: true,
    sectors: slugs,
    files: monorepo,
  });
  console.log(`center ${slug}: monorepo trunk ${center.trunkRepo}, ${center.sectors.length} sectors`);
} catch (err) {
  console.error(`failed: ${err.message}`);
  for (const s of slugs.reverse()) await call("DELETE", `/api/projects/${s}`).then(() => console.error(`deleted ${s}`), (e) => console.error(`could not delete ${s}: ${e.message}`));
  if (/: 409 /.test(err.message)) console.error("That name is taken (an earlier run?): delete it with DELETE /api/projects/<slug> or /api/centers/<slug>, or pick another slug.");
  process.exit(1);
}
