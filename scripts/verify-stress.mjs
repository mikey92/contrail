#!/usr/bin/env node
// Checks a stress run for lost updates: every counter on trunk must equal the number of landed
// "Increment cXX" intents.   CONTRAIL_URL=… node scripts/verify-stress.mjs <slug>
const slug = process.argv[2];
const base = process.env.CONTRAIL_URL;
const snap = await (await fetch(`${base}/api/p/${slug}/snapshot`)).json();
// A sector of a monorepo keeps its files under its prefix (e.g. sector-03/src/counters.js).
const prefix = snap.project.prefix ?? "";
const src = await (await fetch(`${base}/api/p/${slug}/file?path=${prefix}src/counters.js`)).text();
const expected = {};
for (const i of snap.intents) {
  const m = i.title.match(/^Increment (c\d+)$/);
  if (m && i.status === "landed") expected[m[1]] = (expected[m[1]] ?? 0) + 1;
}
let lost = 0;
for (const m of src.matchAll(/export function (c\d+)\(\) \{\n  return (\d+);/g)) {
  const want = expected[m[1]] ?? 0;
  const got = Number(m[2]);
  if (want !== got) {
    lost++;
    console.log(`  ✗ ${m[1]}: trunk ${got}, landed increments ${want}`);
  }
}
const landed = snap.intents.filter((i) => i.status === "landed").length;
const notes = (await (await fetch(`${base}/api/p/${slug}/file?path=${prefix}src/notes.js`)).text()).match(/export function note_/g)?.length ?? 0;
console.log(`${landed}/${snap.intents.length} intents landed · ${snap.stats.landings} landings · ${snap.stats.conflictsPrevented} holds · ${snap.stats.unioned} auto-merged inserts · ${notes} note functions`);
console.log(lost ? `${lost} counter(s) disagree` : "every counter matches its landed increments: no lost updates");
