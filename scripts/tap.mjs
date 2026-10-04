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

function connect() {
  ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/p/${slug}/live`);
  ws.onmessage = (m) => {
    if (m.data === "pong") return;
    file.write(`${JSON.stringify({ t: Date.now() - t0, m: JSON.parse(m.data) })}\n`);
    if (++count % 100 === 0) console.log(`${count} messages, ${Math.round((Date.now() - t0) / 1000)}s`);
  };
  ws.onclose = (e) => {
    if (stopping) return;
    console.log(`stream closed (${e.code}${e.reason ? ` ${e.reason}` : ""}) after ${Math.round((Date.now() - t0) / 1000)}s, reconnecting`);
    setTimeout(connect, 500);
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
