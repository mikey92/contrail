#!/usr/bin/env node
// Lists the notable moments of a recorded radar stream (scripts/tap.mjs) with their offsets, to
// choreograph video scenes:   node video/moments.mjs ui/public/replays/bookshop.jsonl [types]
import { readFileSync } from "node:fs";

const [file, filter] = process.argv.slice(2);
const types = filter ? new Set(filter.split(",")) : null;
const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
let snapshot = 0;
for (const { t, m } of lines) {
  if (m.kind === "snapshot") {
    console.log(`${(t / 1000).toFixed(1).padStart(6)}s  snapshot #${++snapshot}`);
    continue;
  }
  if (m.kind !== "event") continue;
  const e = m.event;
  if (types && !types.has(e.type)) continue;
  if (!types && ["contrail.plan", "contrail.decision", "contrail.note", "radio.message", "clearance.released"].includes(e.type)) continue;
  console.log(`${(t / 1000).toFixed(1).padStart(6)}s  ${e.type.padEnd(20)} ${e.text.slice(0, 150)}`);
}
console.log(`${lines.length} messages over ${(lines.at(-1).t / 1000).toFixed(1)}s`);
