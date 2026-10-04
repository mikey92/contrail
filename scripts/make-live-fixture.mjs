#!/usr/bin/env node
// Builds ui/public/fixtures/live.*.json: a synthetic mid-flight radar state over the real Bookshop
// trunk recorded in smoke3, used to develop and screenshot the Radar UI offline.
import { readFileSync, writeFileSync } from "node:fs";

const base = JSON.parse(readFileSync("ui/public/fixtures/smoke3.snapshot.json", "utf8"));
const intentsSrc = JSON.parse(readFileSync("demo/bookshop/intents.json", "utf8"));
const t0 = Date.now() - 9 * 60_000;
const colors = ["#4fd1c5", "#f6ad55", "#9f7aea", "#68d391", "#fc8181", "#63b3ed", "#f687b3", "#faf089"];
const agentDefs = [
  ["CLAUDE-1", "claude-code", "claude-opus-4"],
  ["CLAUDE-2", "claude-code", "claude-sonnet-4"],
  ["CODEX-1", "codex", "gpt-5-codex"],
  ["CLAUDE-3", "claude-code", "claude-opus-4"],
  ["CODEX-2", "codex", "gpt-5-codex"],
  ["CLAUDE-4", "claude-code", "claude-sonnet-4"],
  ["EDGE-1", "edge", "workers-ai"],
  ["CLAUDE-5", "claude-code", "claude-haiku-4"],
];
const agents = agentDefs.map(([callsign, kind, model], i) => ({ id: `a${i + 1}`, callsign, kind, model, color: colors[i], joinedAt: t0, lastSeenAt: Date.now() }));
const intents = intentsSrc.map((it, i) => ({
  id: `i${i + 1}`, seq: i + 1, title: it.title, body: it.body, priority: it.priority, status: "open", labels: [], createdBy: "operator", createdAt: t0, flightId: null, landedCommit: null, dependsOn: [],
}));

const flights = [];
const clearances = [];
const landings = [];
let fseq = 0;
function flight(agentIdx, intentSeq, status, plan, extra = {}) {
  fseq++;
  const f = {
    id: `f${fseq}`, code: `FL-${String(fseq).padStart(3, "0")}`, agentId: agents[agentIdx].id, intentId: `i${intentSeq}`, status,
    repo: `bookshop--fl-${String(fseq).padStart(3, "0")}-x${fseq}`, baseCommit: base.trunk.head, plan, createdAt: t0 + fseq * 20000,
    updatedAt: Date.now() - (10 - fseq) * 15000, landedAt: status === "landed" ? Date.now() - (10 - fseq) * 30000 : null, attempts: extra.attempts ?? (status === "landed" ? 1 : 0), touched: [],
  };
  flights.push(f);
  const intent = intents[intentSeq - 1];
  intent.status = status === "landed" ? "landed" : "assigned";
  intent.flightId = f.id;
  return f;
}
function clear(f, target, status = "granted", reason = null) {
  clearances.push({ id: `c${clearances.length + 1}`, flightId: f.id, target, status, reason, createdAt: Date.now() - 60000, expiresAt: Date.now() + 40 * 60000 });
}
let lseq = 0;
function landing(f, status, extra = {}) {
  lseq++;
  const l = {
    id: `l${lseq}`, seq: lseq, flightId: f.id, status, summary: extra.summary ?? "", forkHead: "f".repeat(40), trunkBefore: base.trunk.head,
    trunkAfter: status === "landed" ? (Math.random().toString(16).slice(2) + "0".repeat(40)).slice(0, 40) : null,
    changes: extra.changes ?? [], conflicts: extra.conflicts ?? [], tests: extra.tests ?? null, error: extra.error ?? null, unioned: extra.unioned ?? 0,
    createdAt: Date.now() - (20 - lseq) * 20000, finishedAt: status === "landed" ? Date.now() - (20 - lseq) * 18000 : null,
  };
  landings.push(l);
  return l;
}
const green = (n) => ({ passed: n, failed: 0, results: [], ms: 18 });

// Landed already.
const f1 = flight(0, 1, "landed", "Lower-case both the query and title/author; keep catalog order.");
landing(f1, "landed", { summary: "Search is case-insensitive and matches authors.", changes: [{ path: "src/catalog.js", status: "modified", symbols: ["search"], additions: 6, deletions: 2 }, { path: "test/catalog.test.js", status: "modified", symbols: ["searchesAuthors"], additions: 5, deletions: 0 }], tests: green(15) });
const f2 = flight(2, 2, "landed", "Find the existing line and bump qty.");
landing(f2, "landed", { summary: "Cart.add merges duplicate ISBNs.", changes: [{ path: "src/cart.js", status: "modified", symbols: ["Cart.add"], additions: 6, deletions: 1 }], tests: green(16), unioned: 1 });
const f3 = flight(4, 6, "landed", "Symbol table per currency; JPY has no minor unit.");
landing(f3, "landed", { summary: "EUR and JPY formatting.", changes: [{ path: "src/money.js", status: "modified", symbols: ["formatMoney"], additions: 9, deletions: 2 }], tests: green(18) });

// In the air.
const f4 = flight(1, 3, "airborne", "Parse SAVE<n>, clamp n to 1..50, round to the nearest cent. WELCOME5 unchanged.");
clear(f4, "src/pricing.js#applyCoupon", "granted", "percentage coupons");
clear(f4, "test/pricing.test.js", "granted");
const f5 = flight(3, 5, "airborne", "Discount a line by 10% when qty >= 3, rounding per line.");
clear(f5, "src/pricing.js#subtotal", "granted", "bulk discount");
const f6 = flight(5, 16, "holding", "Every third paperback free; must not stack with bulk discount.");
clear(f6, "src/pricing.js#subtotal", "holding", "buy 2 get 1");
const f7 = flight(6, 8, "approach", "Move rates to an exported TAX_RATES table.");
clear(f7, "src/pricing.js#tax", "granted");
landing(f7, "merging", { summary: "Per-region sales tax table." });
const f8 = flight(7, 11, "diverted", "Add a zone parameter with surcharges.", { attempts: 1 });
clear(f8, "src/shipping.js#shippingCost", "granted");
landing(f8, "conflict", {
  summary: "International shipping zones.",
  changes: [{ path: "src/shipping.js", status: "modified", symbols: ["shippingCost"], additions: 8, deletions: 2 }],
  conflicts: [{ path: "src/shipping.js", kind: "content", hunks: [{ baseStart: 4, baseLines: ["  if (weightGrams <= 0) {"], ours: ["  if (weightGrams <= 0 || subtotalCents >= 5000) {"], theirs: ["  if (weightGrams <= 0) {", "    // zones apply even to empty parcels"], symbols: ["shippingCost"] }], causedBy: [{ flightId: "f9", code: "FL-009", callsign: "CODEX-2", intent: "INT-4 Free shipping on orders over $50", commit: "9c1d2e7a" }] }],
});
const f9 = flight(4, 4, "landed", "shippingFor() wraps shippingCost and checks the subtotal threshold.");
landing(f9, "landed", { summary: "Free shipping on orders over $50.", changes: [{ path: "src/shipping.js", status: "modified", symbols: ["shippingFor", "shippingCost"], additions: 12, deletions: 1 }], tests: green(19) });
const f10 = flight(0, 7, "airborne", "setQuantity filters the line then re-adds it; isEmpty checks lines.length.");
clear(f10, "src/cart.js#Cart.setQuantity");
clear(f10, "src/cart.js#Cart.isEmpty");
const f11 = flight(2, 12, "airborne", null);
const f12 = flight(5, 10, "taxiing", null);
void f11; void f12;

const events = [];
let seq = 0;
const ev = (type, text, f, data) => events.push({ seq: ++seq, at: Date.now() - (60 - seq) * 9000, type, text, flightId: f?.id, agentId: f?.agentId, data });
ev("flight.airborne", "FL-004 airborne — workspace bookshop--fl-004 forked from trunk", f4);
ev("clearance.granted", "FL-004 cleared for src/pricing.js#applyCoupon, test/pricing.test.js", f4);
ev("clearance.granted", "FL-005 cleared for src/pricing.js#subtotal", f5);
ev("clearance.holding", "FL-006 holding — src/pricing.js#subtotal held by FL-005", f6, { holding: [{ target: "src/pricing.js#subtotal" }] });
ev("radio", "FL-006 → CLAUDE-3: I need subtotal next for buy-2-get-1 — ping me when you land?", f6);
ev("landing.landed", 'FL-009 landed INT-4 "Free shipping on orders over $50" as 9c1d2e7a', f9, { changes: [{ path: "src/shipping.js", symbols: ["shippingFor"] }] });
ev("turbulence", "FL-008 alerted: FL-009 changed src/shipping.js#shippingCost", f8);
ev("landing.conflict", "FL-008 diverted: conflict on src/shipping.js#shippingCost (vs CODEX-2 (FL-009: INT-4 Free shipping on orders over $50))", f8);
ev("contrail.plan", "FL-010 plan: setQuantity filters the line then re-adds it", f10);
ev("runway.train", "Runway: train of 1 landing — FL-007", f7);

const snapshot = {
  project: { ...base.project, slug: "bookshop", name: "Bookshop", trunkRepo: "bookshop--trunk" },
  agents, intents, flights, clearances, landings, trunk: base.trunk, events,
  stats: { repos: 13, landings: 4, conflictsPrevented: 3, conflictsResolved: 1, unioned: 2 },
};
writeFileSync("ui/public/fixtures/live.snapshot.json", JSON.stringify(snapshot));
for (const f of [f4, f6, f8, f9]) {
  writeFileSync(
    `ui/public/fixtures/live.${f.code}.json`,
    JSON.stringify({
      flight: f, agent: agents.find((a) => a.id === f.agentId), intent: intents.find((i) => i.id === f.intentId),
      clearances: clearances.filter((c) => c.flightId === f.id),
      contrail: [
        { id: 1, flightId: f.id, agentId: f.agentId, kind: "intent", text: intents.find((i) => i.id === f.intentId).title, refs: [], at: Date.now() - 400000 },
        { id: 2, flightId: f.id, agentId: f.agentId, kind: "plan", text: f.plan ?? "", refs: [], at: Date.now() - 300000 },
        { id: 3, flightId: f.id, agentId: f.agentId, kind: "decision", text: "Kept integer cents everywhere; rounding happens once per line.", refs: [], at: Date.now() - 200000 },
      ],
      landings: landings.filter((l) => l.flightId === f.id),
    }),
  );
}
writeFileSync("ui/public/fixtures/live.why.json", readFileSync("ui/public/fixtures/smoke3.why.json"));
console.log(`live fixture: ${flights.length} flights, ${clearances.length} clearances, ${landings.length} landings`);
