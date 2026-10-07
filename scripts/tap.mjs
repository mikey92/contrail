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

function write(message) {
  file.write(`${JSON.stringify({ t: Date.now() - t0, m: message })}\n`);
  if (++count % 100 === 0) console.log(`${count} messages, ${Math.round((Date.now() - t0) / 1000)}s`);
}

function connect() {
  ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/p/${slug}/live`);
  ws.onmessage = (m) => {
    retry = 500;
    if (m.data === "pong") return;
    const message = JSON.parse(m.data);
    if (message.kind !== "resync") return write(message);
    // A message too big for the socket: record the snapshot it stands for instead.
    fetch(`${base}/api/p/${slug}/snapshot`)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((snapshot) => !stopping && write({ kind: "snapshot", snapshot }))
      .catch((err) => console.log(`no snapshot for a resync (${err.message})`));
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
