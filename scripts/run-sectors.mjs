#!/usr/bin/env node
// Runs a sectored load test: scripted (LLM-free) agents fly in every sector at once. Prints progress, then
// the throughput, and checks for lost updates in every sector and in the composed monorepo trunk.
//   CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/run-sectors.mjs <center-slug> [--agents 100] [--timeout 1800] [--out result.json]
// With --verify-only it launches nothing and only checks the center as it is. With --record <dir> it also
// records the run for the monorepo page's replay: the center once a second (<dir>/<center>.jsonl.gz) and
// every sector's radar stream (<dir>/<center>/<sector>.jsonl.gz), on one clock.
import { mkdirSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const valued = new Set(["--agents", "--timeout", "--out", "--record"]);
const slug = args.find((a, i) => !a.startsWith("--") && !valued.has(args[i - 1]));
const agents = Number(option("--agents", 100));
const timeoutS = Number(option("--timeout", 1800));
const out = option("--out", null);
const verifyOnly = args.includes("--verify-only");
const record = verifyOnly ? null : option("--record", null);
const base = process.env.CONTRAIL_URL?.replace(/\/$/, "");
const admin = process.env.CONTRAIL_ADMIN_KEY;
if (!slug || !base || !admin) {
  console.error("usage: CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/run-sectors.mjs <center-slug> [--agents 100] [--timeout 1800] [--out result.json] [--record dir] [--verify-only]");
  process.exit(2);
}
const auth = { authorization: `Bearer ${admin}` };
const get = async (path) => {
  const res = await fetch(`${base}${path}`, { headers: auth });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
  return path.includes("/file?") ? res.text() : res.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Minutes and seconds, to the nearest second (as the radar's end card shows them).
const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const first = await get(`/api/c/${slug}`);
const sectors = first.center.sectors;
const t0 = Date.now();

// The recording: one clock (t, ms since t0) for the center's samples and every sector's radar stream.
const FIELDS = ["landed", "inAir", "holding", "intents", "landings", "agents", "conflictsPrevented", "head", "firstTakeOff", "lastLanding"];
const centerLines = [];
const streams = new Map(sectors.map((s) => [s.slug, []]));
const sockets = [];
let recording = false;
const sample = (snap) =>
  centerLines.push({
    t: Date.now() - t0,
    at: Date.now(),
    head: snap.head?.slice(0, 8) ?? null,
    composedAt: snap.composedAt,
    behind: snap.behind,
    compositions: snap.compositions,
    s: snap.sectors.map((x) => (x.summary ? FIELDS.map((f) => (f === "head" ? (x.summary.head?.slice(0, 8) ?? null) : (x.summary[f] ?? null))) : null)),
  });
function tap(sectorSlug) {
  const lines = streams.get(sectorSlug);
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/p/${sectorSlug}/live`);
  sockets.push(ws);
  ws.onmessage = (m) => m.data !== "pong" && lines.push({ t: Date.now() - t0, m: JSON.parse(m.data) });
  ws.onclose = () => recording && setTimeout(() => tap(sectorSlug), 500);
  return new Promise((resolve) => (ws.onopen = resolve));
}
if (record) {
  recording = true;
  centerLines.push({ t: 0, kind: "center", center: first.center, fields: FIELDS, sectorStreams: true });
  await Promise.race([Promise.all(sectors.map((s) => tap(s.slug))), sleep(10_000)]);
  sample(await get(`/api/c/${slug}`));
  console.log(`recording ${sectors.length} sector streams and the center into ${record}`);
}
const ping = record ? setInterval(() => sockets.forEach((ws) => ws.readyState === 1 && ws.send("ping")), 20_000) : null;
if (!verifyOnly) {
  console.log(`${first.center.name}: launching ${agents} scripted agents in each of ${sectors.length} sectors (${agents * sectors.length} agents)`);
  // Agents start landing while the rest are still being launched: keep sampling meanwhile.
  let launching = true;
  const sampler = (async () => {
    while (record && launching) {
      await sleep(1000);
      if (launching) sample(await get(`/api/c/${slug}`));
    }
  })();
  await Promise.all(
    sectors.map(async (s) => {
      const res = await fetch(`${base}/api/p/${s.slug}/edge/launch`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ count: agents, mode: "scripted" }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(`launch ${s.slug}: ${JSON.stringify(body)}`);
    }),
  );
  launching = false;
  await sampler;
  console.log(`launched in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

let snap = first;
let lastPrint = 0;
const history = [];
while (!verifyOnly) {
  await sleep(record ? 1000 : 3000);
  snap = await get(`/api/c/${slug}`);
  if (record) sample(snap);
  const sum = (k) => snap.sectors.reduce((n, s) => n + (s.summary?.[k] ?? 0), 0);
  const landed = sum("landed");
  const intents = sum("intents");
  history.push({ t: Date.now() - t0, landed });
  const recent = history.filter((h) => h.t >= history.at(-1).t - 30_000);
  const rate = recent.length > 1 ? (recent.at(-1).landed - recent[0].landed) / ((recent.at(-1).t - recent[0].t) / 1000) : 0;
  if (Date.now() - lastPrint > 15_000 || landed === intents) {
    console.log(`${clock(Date.now() - t0)}  landed ${landed}/${intents}  in the air ${sum("inAir")}  holding ${sum("holding")}  ${rate.toFixed(1)} landings/s  monorepo behind by ${snap.behind} sector(s)`);
    lastPrint = Date.now();
  }
  if (landed === intents && snap.behind === 0 && snap.composedAt && snap.sectors.every((s) => !s.summary?.lastLanding || snap.composedAt >= s.summary.lastLanding)) break;
  if (Date.now() - t0 > timeoutS * 1000) {
    console.log("timed out");
    break;
  }
}

if (record) {
  // A last look once everything has settled, then save the recording.
  await sleep(2000);
  sample(await get(`/api/c/${slug}`));
  recording = false;
  clearInterval(ping);
  for (const ws of sockets) ws.close();
  mkdirSync(`${record}/${slug}`, { recursive: true });
  const save = (file, lines) => writeFileSync(file, gzipSync(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`, { level: 9 }));
  save(`${record}/${slug}.jsonl.gz`, centerLines);
  for (const [sectorSlug, lines] of streams) save(`${record}/${slug}/${sectorSlug}.jsonl.gz`, lines);
  console.log(`saved ${centerLines.length} center samples and ${[...streams.values()].reduce((n, l) => n + l.length, 0)} sector stream messages`);
}

// Verify: every counter equals its landed increments, in each sector and in the composed monorepo.
let lost = 0;
let mismatched = 0;
for (const s of snap.sectors) {
  const sectorSnap = await get(`/api/p/${s.slug}/snapshot`);
  const expected = {};
  for (const i of sectorSnap.intents) {
    const m = i.title.match(/^Increment (c\d+)$/);
    if (m && i.status === "landed") expected[m[1]] = (expected[m[1]] ?? 0) + 1;
  }
  const path = `${s.prefix}src/counters.js`;
  const sectorFile = await get(`/api/p/${s.slug}/file?path=${encodeURIComponent(path)}`);
  const monoFile = await get(`/api/c/${slug}/file?path=${encodeURIComponent(path)}`);
  if (sectorFile !== monoFile) {
    mismatched++;
    console.log(`  ✗ ${path}: the monorepo trunk differs from ${s.slug}'s trunk`);
  }
  for (const m of sectorFile.matchAll(/export function (c\d+)\(\) \{\n  return (\d+);/g)) {
    if ((expected[m[1]] ?? 0) !== Number(m[2])) {
      lost++;
      console.log(`  ✗ ${s.slug} ${m[1]}: trunk ${m[2]}, landed increments ${expected[m[1]] ?? 0}`);
    }
  }
}

const rows = snap.sectors.map((s) => ({ sector: s.name, landed: s.summary.landed, intents: s.summary.intents, seconds: s.summary.lastLanding && s.summary.firstTakeOff ? Math.round((s.summary.lastLanding - s.summary.firstTakeOff) / 1000) : null }));
const start = Math.min(...snap.sectors.map((s) => s.summary.firstTakeOff ?? Infinity));
const end = Math.max(...snap.sectors.map((s) => s.summary.lastLanding ?? 0));
const landed = rows.reduce((n, r) => n + r.landed, 0);
const result = {
  center: slug,
  sectors: snap.sectors.length,
  agents: snap.sectors.reduce((n, s) => n + s.summary.agents, 0),
  landed,
  intents: rows.reduce((n, r) => n + r.intents, 0),
  seconds: Math.round((end - start) / 1000),
  landingsPerSecond: Number((landed / ((end - start) / 1000)).toFixed(2)),
  compositions: snap.compositions,
  monorepoCaughtUpSeconds: snap.composedAt ? Number(((snap.composedAt - end) / 1000).toFixed(1)) : null,
  lostUpdates: lost,
  monorepoMismatches: mismatched,
  perSector: rows,
};
console.log(`\n${result.landed}/${result.intents} landed by ${result.agents} agents in ${clock(end - start)}: ${result.landingsPerSecond} landings/s across ${result.sectors} sectors`);
console.log(`monorepo trunk: ${result.compositions} compositions, caught up ${result.monorepoCaughtUpSeconds} s after the last landing`);
console.log(lost || mismatched ? `${lost} counter(s) disagree, ${mismatched} monorepo file(s) differ` : "no lost updates: every counter matches its landed increments, in every sector and in the monorepo");
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
process.exit(lost || mismatched ? 1 : 0);
