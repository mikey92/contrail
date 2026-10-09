#!/usr/bin/env node
// Creates a monorepo split into sectors from a directory with a center.json, such as demo/shop:
//   CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/create-center.mjs <slug> <dir> [--private]
// center.json gives the center's name and description, its sectors (slug, name, directory prefix) and
// the crossings to file: changes that span sectors. Each sector becomes a project of its own, <slug>-<sector>,
// holding the files under its prefix; the center's monorepo trunk holds every file.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const [slug, dir] = args.filter((a) => !a.startsWith("--"));
const base = process.env.CONTRAIL_URL?.replace(/\/$/, "");
const admin = process.env.CONTRAIL_ADMIN_KEY;
if (!slug || !dir || !base || !admin) {
  console.error("usage: CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/create-center.mjs <slug> <dir> [--private]");
  process.exit(2);
}
const pub = !args.includes("--private");
const spec = JSON.parse(readFileSync(join(dir, "center.json"), "utf8"));

function walk(root, out = {}) {
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (relative(dir, full) !== "center.json") out[relative(dir, full)] = readFileSync(full, "utf8");
  }
  return out;
}
const files = walk(dir);

async function call(path, body, method = "POST") {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${admin}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// What this run made: if it fails part way, it deletes them, so it can simply be run again.
const slugs = [];
let made = false;
try {
  for (const s of spec.sectors) {
    const sectorSlug = `${slug}-${s.slug}`;
    const own = Object.fromEntries(Object.entries(files).filter(([path]) => path.startsWith(s.prefix)));
    await call("/api/projects", { slug: sectorSlug, name: s.name, description: s.description ?? `Owns ${s.prefix}`, public: pub, center: slug, prefix: s.prefix, source: { kind: "files", files: own } });
    slugs.push(sectorSlug);
    if (s.intents?.length) await call(`/api/p/${sectorSlug}/intents`, { intents: s.intents });
    console.log(`sector ${sectorSlug} owns ${s.prefix}: ${Object.keys(own).length} files`);
  }
  const { center } = await call("/api/centers", { slug, name: spec.name ?? slug, description: spec.description ?? "", public: pub, sectors: slugs, files });
  made = true;
  console.log(`center ${slug}: monorepo trunk ${center.trunkRepo}, ${Object.keys(files).length} files`);
  if (spec.crossings?.length) {
    const { intents } = await call(`/api/c/${slug}/intents`, { intents: spec.crossings });
    for (const i of intents) console.log(`crossing intent INT-${i.seq} ${i.title}`);
  }
} catch (err) {
  console.error(`failed: ${err.message}`);
  const undo = (path) => call(path, undefined, "DELETE").then(() => console.error(`deleted ${path}`), (e) => console.error(`could not delete ${path}: ${e.message}`));
  if (made) await undo(`/api/centers/${slug}`);
  for (const s of slugs.reverse()) await undo(`/api/projects/${s}`);
  if (/: 409 /.test(err.message)) console.error("That name is taken (an earlier run?): delete it with DELETE /api/projects/<slug> or /api/centers/<slug>, or pick another slug.");
  process.exit(1);
}
console.log(`${base}/c/${slug}`);
