#!/usr/bin/env node
// Creates a Contrail project from a local directory (or a public GitHub repository) and loads its intents.
//   CONTRAIL_URL=https://… CONTRAIL_ADMIN_KEY=… node scripts/create-project.mjs <slug> <dir | https://github.com/owner/repo> [name]
//     [--playground] [--private] [--intents file.json] [--branch main]
// Text files in <dir> (except intents.json, dotfiles and node_modules) become the initial trunk; <dir>/intents.json
// (or --intents) is loaded as intents. A GitHub URL is imported by Artifacts itself, from --branch (main unless
// you say otherwise); pass its intents with --intents.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && !["--intents", "--branch"].includes(args[i - 1]));
const playground = process.argv.includes("--playground");
// --private keeps the project off the home page (e.g. a take for the video).
const isPublic = !process.argv.includes("--private");
const [slug, dir, name] = positional;
const base = process.env.CONTRAIL_URL;
const admin = process.env.CONTRAIL_ADMIN_KEY;
if (!slug || !dir || !base || !admin) {
  console.error("usage: CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/create-project.mjs <slug> <dir | https://github.com/owner/repo> [name] [--playground] [--private] [--intents file.json] [--branch main]");
  process.exit(2);
}
// The intents are read before anything is created, so a bad file leaves no half-made project behind.
const intentsPath = option("--intents") ?? (dir && !/^https:\/\/github\.com\//.test(dir) ? join(dir, "intents.json") : "");
if (option("--intents") && !existsSync(option("--intents"))) {
  console.error(`no intents file at ${option("--intents")}`);
  process.exit(2);
}
let intents = null;
if (intentsPath && existsSync(intentsPath)) {
  try {
    intents = JSON.parse(readFileSync(intentsPath, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    console.error(`${intentsPath} isn't JSON: ${err.message}`);
    process.exit(2);
  }
}
const github = /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(dir);

// Trunk takes text: a file that isn't UTF-8 (an image, say) is left out, and said so, rather than mangled.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const skipped = [];
function walk(root, out = {}) {
  for (const entry of readdirSync(root)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(root, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else {
      try {
        out[relative(dir, full)] = utf8.decode(readFileSync(full));
      } catch {
        skipped.push(relative(dir, full));
      }
    }
  }
  return out;
}

const files = github ? null : walk(dir);
if (files) delete files["intents.json"];
if (skipped.length) console.warn(`left out ${skipped.length} file(s) that aren't UTF-8 text: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ", …" : ""}`);
const headers = { "content-type": "application/json", authorization: `Bearer ${admin}` };

const res = await fetch(`${base}/api/projects`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    slug,
    name: name ?? slug,
    description: process.env.CONTRAIL_DESCRIPTION ?? `Demo project ${slug}`,
    public: isPublic,
    playground,
    source: github ? { kind: "github", url: dir.replace(/\.git$/, ""), branch: option("--branch") ?? "main" } : { kind: "files", files },
  }),
});
const created = await res.json();
if (!res.ok) {
  console.error("create failed:", created);
  process.exit(1);
}
console.log(`project ${slug} created; trunk repo ${created.project.trunkRepo}`);
console.log(`join code: ${created.joinCode}`);

if (intents) {
  const r = await fetch(`${base}/api/p/${slug}/intents`, { method: "POST", headers, body: JSON.stringify({ intents }) });
  const body = await r.json();
  if (!r.ok) {
    console.error("intents failed:", body);
    process.exit(1);
  }
  console.log(`${body.intents.length} intents loaded`);
}
