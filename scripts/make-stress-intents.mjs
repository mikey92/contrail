#!/usr/bin/env node
// Writes demo/stress/intents.json: N scripted intents over 24 shared counters (Zipf-skewed so a few
// are hot) plus appended notes. Usage: node scripts/make-stress-intents.mjs [N=240]
// The tracked file is the 300-intent run measured in the README (the generator is seeded).
import { writeFileSync } from "node:fs";

const n = Number(process.argv[2] ?? 240);
const counters = Array.from({ length: 24 }, (_, i) => `c${String(i).padStart(2, "0")}`);
const weights = counters.map((_, i) => 1 / (i + 1));
const total = weights.reduce((a, b) => a + b, 0);
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = () => {
  let r = rand() * total;
  for (let i = 0; i < counters.length; i++) if ((r -= weights[i]) <= 0) return counters[i];
  return counters[0];
};
const intents = [];
for (let i = 1; i <= n; i++) {
  if (rand() < 0.2) {
    const symbol = `note_${String(i).padStart(4, "0")}`;
    const code = `export function ${symbol}() {\n  return true;\n}`;
    intents.push({ title: `Append ${symbol}`, body: `Add a new note function.\nscript: ${JSON.stringify({ op: "append", path: "src/notes.js", symbol, code })}`, priority: 0 });
  } else {
    const symbol = pick();
    intents.push({ title: `Increment ${symbol}`, body: `Increment counter ${symbol} by one on the latest trunk.\nscript: ${JSON.stringify({ op: "increment", path: "src/counters.js", symbol })}`, priority: 0 });
  }
}
writeFileSync("demo/stress/intents.json", JSON.stringify(intents, null, 1));
const tally = {};
for (const it of intents) if (it.title.startsWith("Increment")) tally[it.title.split(" ")[1]] = (tally[it.title.split(" ")[1]] ?? 0) + 1;
console.log(`${intents.length} intents; increments per counter:`, tally);
