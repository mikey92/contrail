#!/usr/bin/env node
// Creates a Contrail project from a local directory and loads its intents.
//   CONTRAIL_URL=https://… CONTRAIL_ADMIN_KEY=… node scripts/create-project.mjs <slug> <dir> [name]
// Files in <dir> (except intents.json) become the initial trunk; <dir>/intents.json is loaded as intents.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const playground = process.argv.includes("--playground");
const [slug, dir, name] = positional;
const base = process.env.CONTRAIL_URL;
const admin = process.env.CONTRAIL_ADMIN_KEY;
if (!slug || !dir || !base || !admin) {
  console.error("usage: CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/create-project.mjs <slug> <dir> [name]");
  process.exit(2);
}

function walk(root, out = {}) {
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out[relative(dir, full)] = readFileSync(full, "utf8");
  }
  return out;
}

const files = walk(dir);
delete files["intents.json"];
const headers = { "content-type": "application/json", authorization: `Bearer ${admin}` };

const res = await fetch(`${base}/api/projects`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    slug,
    name: name ?? slug,
    description: process.env.CONTRAIL_DESCRIPTION ?? `Demo project ${slug}`,
    public: true,
    playground,
    source: { kind: "files", files },
  }),
});
const created = await res.json();
if (!res.ok) {
  console.error("create failed:", created);
  process.exit(1);
}
console.log(`project ${slug} created; trunk repo ${created.project.trunkRepo}`);
console.log(`join code: ${created.joinCode}`);

const intentsPath = join(dir, "intents.json");
if (existsSync(intentsPath)) {
  const intents = JSON.parse(readFileSync(intentsPath, "utf8"));
  const r = await fetch(`${base}/api/p/${slug}/intents`, { method: "POST", headers, body: JSON.stringify({ intents }) });
  const body = await r.json();
  if (!r.ok) {
    console.error("intents failed:", body);
    process.exit(1);
  }
  console.log(`${body.intents.length} intents loaded`);
}
