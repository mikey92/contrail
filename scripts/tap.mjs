#!/usr/bin/env node
// Records a project's live radar stream (snapshot, patches, events) to JSON lines so the run can be
// replayed in the Radar at any speed:   node scripts/tap.mjs <url> <slug> <out.jsonl>
// Open /p/<slug>?replay=/replays/<file>.jsonl&speed=4 to watch it back. Reconnects if the stream
// drops (a fresh snapshot is recorded); stop it with Ctrl-C or SIGTERM.
import { createWriteStream } from "node:fs";

const [base, slug, out] = process.argv.slice(2);
const file = createWriteStream(out);
const t0 = Date.now();
let count = 0;
let stopping = false;
let ws;
let retry = 500;

function write(message, t) {
  if (stopping) return;
  file.write(`${JSON.stringify({ t, m: message })}\n`);
  if (++count % 100 === 0) console.log(`${count} messages, ${Math.round((Date.now() - t0) / 1000)}s`);
}

// While a resync's snapshot is on its way: the messages that come meanwhile, in order.
let waiting = null;
function take(message, t) {
  if (waiting) return void waiting.push([message, t]);
  if (message.kind !== "resync") return write(message, t);
  // A message too big for the socket: the snapshot it stands for goes in its place, then what came meanwhile
  // (a replay applies those again on top of it, as the radar does live).
  waiting = [];
  fetch(`${base}/api/p/${slug}/snapshot`)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
    .then((snapshot) => write({ kind: "snapshot", snapshot }, t))
    .catch((err) => console.log(`no snapshot for a resync (${err.message})`))
    .finally(() => {
      const queued = waiting;
      waiting = null;
      for (const [m, at] of queued) take(m, at);
    });
}

function connect() {
  ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/p/${slug}/live`);
  ws.onmessage = (m) => {
    retry = 500;
    if (m.data !== "pong") take(JSON.parse(m.data), Date.now() - t0);
  };
  ws.onclose = (e) => {
    if (stopping) return;
    console.log(`stream closed (${e.code}${e.reason ? ` ${e.reason}` : ""}) after ${Math.round((Date.now() - t0) / 1000)}s, reconnecting`);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
}
connect();
const ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), 20000);
const stop = () => {
  stopping = true;
  clearInterval(ping);
  ws.close();
  console.log(`saved ${count} messages to ${out}`);
  file.end(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
