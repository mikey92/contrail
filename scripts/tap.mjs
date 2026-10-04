#!/usr/bin/env node
// Records a project's live radar stream (snapshot, patches, events) to JSON lines so the run can be
// replayed in the Radar at any speed:   node scripts/tap.mjs <url> <slug> <out.jsonl>
// Open /p/<slug>?replay=/replays/<file>.jsonl&speed=4 to watch it back.
import { createWriteStream } from "node:fs";

const [base, slug, out] = process.argv.slice(2);
const file = createWriteStream(out);
const t0 = Date.now();
let count = 0;
const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/p/${slug}/live`);
ws.onmessage = (m) => {
  if (m.data === "pong") return;
  file.write(`${JSON.stringify({ t: Date.now() - t0, m: JSON.parse(m.data) })}\n`);
  if (++count % 100 === 0) console.log(`${count} messages, ${Math.round((Date.now() - t0) / 1000)}s`);
};
ws.onclose = () => {
  console.log("stream closed");
  file.end();
  process.exit(0);
};
const ping = setInterval(() => ws.readyState === 1 && ws.send("ping"), 20000);
process.on("SIGINT", () => {
  clearInterval(ping);
  console.log(`saved ${count} messages to ${out}`);
  file.end(() => process.exit(0));
});
