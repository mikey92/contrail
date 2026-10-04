#!/usr/bin/env node
// The "incident" scene for the demo video: two scripted git agents want the same function, one
// ignores its hold, the runway catches the textual and then the semantic conflict, and a third
// change waits for a human because of the review policy. Paced so the radar can be filmed.
//   CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node video/incident.mjs <slug>
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const slug = process.argv[2];
const base = process.env.CONTRAIL_URL;
const admin = process.env.CONTRAIL_ADMIN_KEY;
const work = mkdtempSync(join(tmpdir(), "contrail-incident-"));
const pause = (s) => new Promise((r) => setTimeout(r, s * 1000));
const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
const say = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

async function call(path, body, key) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body ?? {}) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json;
}
async function agent(callsign) {
  const { key, agent } = await call(`/api/p/${slug}/join`, { callsign, kind: "other", model: "scripted" }, admin);
  return { agent, tool: (name, args) => call(`/api/p/${slug}/agent/${name}`, args, key) };
}
async function fly(a, intent) {
  const t = await a.tool("take_off", { intent });
  const dir = join(work, t.flight.code.toLowerCase());
  sh(`git clone -q ${t.workspace.cloneUrl} ${dir}`);
  sh(`git remote add upstream ${t.upstream.cloneUrl}`, dir);
  sh(`git config user.name ${a.agent.callsign} && git config user.email ${a.agent.callsign.toLowerCase()}@agents.contrail.dev`, dir);
  return { ...t, dir };
}
const edit = (dir, path, fn) => writeFileSync(join(dir, path), fn(readFileSync(join(dir, path), "utf8")));
const append = (text) => (src) => `${src.trimEnd()}\n\n${text.trim()}\n`;
const push = (dir, msg) => sh(`git add -A && git commit -q -m "${msg}" && git push -q origin HEAD:main`, dir);

const A = await agent("BULK-7");
const B = await agent("PROMO-3");
const fa = await fly(A, "5");
await pause(2);
const fb = await fly(B, "16");
await pause(3);
await A.tool("request_clearance", { targets: ["src/pricing.js#subtotal", "test/pricing.test.js#discountsBulkLines"], reason: "10% off lines with 3+ copies" });
await A.tool("log", { kind: "plan", text: "Apply a 10% discount per line when qty >= 3, rounding each line to whole cents." });
say("A cleared for subtotal");
await pause(4);
const hold = await B.tool("request_clearance", { targets: ["src/pricing.js#subtotal", "test/pricing.test.js#paperbacksBuyTwoGetOne"], reason: "every third paperback free" });
say(`B holding: ${hold.holding.map((h) => h.target).join(", ")}`);
await B.tool("radio", { to: "BULK-7", text: "I need subtotal for buy-2-get-1 — ping me when you land?" });
await pause(8);

// B ignores the hold and edits subtotal anyway.
edit(fb.dir, "src/pricing.js", (s) => s.replace("    total += book.priceCents * line.qty;", () => '    const paid = book.format === "paperback" ? line.qty - Math.floor(line.qty / 3) : line.qty;\n    total += book.priceCents * paid;'));
edit(fb.dir, "test/pricing.test.js", append('export function paperbacksBuyTwoGetOne() {\n  const cart = cartOf(["9780143127550", 3]);\n  assert.equal(subtotal(cart, catalog), 1800 * 2);\n}'));
push(fb.dir, "Buy 2 get 1 free");
say("B pushed anyway");
await pause(3);

edit(fa.dir, "src/pricing.js", (s) => s.replace("    total += book.priceCents * line.qty;", () => "    const lineTotal = book.priceCents * line.qty;\n    total += line.qty >= 3 ? Math.round(lineTotal * 0.9) : lineTotal;"));
edit(fa.dir, "test/pricing.test.js", append('export function discountsBulkLines() {\n  const cart = cartOf(["9781984801258", 3]);\n  assert.equal(subtotal(cart, catalog), Math.round(1700 * 3 * 0.9));\n}'));
push(fa.dir, "Bulk discount");
await A.tool("log", { kind: "decision", text: "Bulk discount rounds per line with Math.round so totals stay in whole cents." });
const la = await A.tool("request_landing", { summary: "Lines with 3 or more copies get 10% off, rounded per line." });
say(`A ${la.landing.status}`);
await pause(6);

const lb = await B.tool("request_landing", { summary: "Every third paperback is free." });
say(`B ${lb.landing.status}: caused by ${lb.landing.conflicts?.[0]?.causedBy?.map((c) => c.code).join(", ")}`);
await pause(8);

try {
  sh("git pull -q --no-rebase upstream main", fb.dir);
} catch {
  // conflict expected
}
edit(fb.dir, "src/pricing.js", (s) =>
  s.replace(/<<<<<<<[\s\S]*?>>>>>>> [^\n]*\n/, () => '    const lineTotal = book.priceCents * line.qty;\n    const bulk = line.qty >= 3 ? Math.round(lineTotal * 0.9) : lineTotal;\n    const paid = book.format === "paperback" ? line.qty - Math.floor(line.qty / 3) : line.qty;\n    total += Math.min(bulk, book.priceCents * paid);\n'),
);
writeFileSync(join(fb.dir, "test/pricing.test.js"), append('export function paperbacksBuyTwoGetOne() {\n  const cart = cartOf(["9780143127550", 3]);\n  assert.equal(subtotal(cart, catalog), 1800 * 2);\n}')(sh("git show upstream/main:test/pricing.test.js", fb.dir)));
sh('git add -A && git commit -q -m "Resolve: the cheaper of the two rules wins" && git push -q origin HEAD:main', fb.dir);
await B.tool("log", { kind: "decision", text: "Bulk discount and buy-2-get-1 do not stack: each line pays the cheaper of the two." });
const lb2 = await B.tool("request_landing", { summary: "Every third paperback is free; does not stack with the bulk discount." });
say(`B ${lb2.landing.status}: ${lb2.landing.tests?.results?.filter((r) => !r.ok).map((r) => r.name).join(", ")}`);
await pause(8);

edit(fb.dir, "test/pricing.test.js", (s) => s.replace('const cart = cartOf(["9781984801258", 3]);\n  assert.equal(subtotal(cart, catalog), Math.round(1700 * 3 * 0.9));', () => 'const cart = cartOf(["9780593135204", 3]);\n  assert.equal(subtotal(cart, catalog), Math.round(2899 * 3 * 0.9));'));
push(fb.dir, "Bulk discount test uses a hardcover: paperbacks get the cheaper rule");
await B.tool("log", { kind: "decision", text: "Updated BULK-7's test to a hardcover: for paperbacks the buy-2-get-1 rule is now cheaper, by design." });
const lb3 = await B.tool("request_landing", { summary: "Every third paperback is free; the cheaper of the two rules wins per line." });
say(`B ${lb3.landing.status}`);
await pause(6);

// Review by exception.
await call(`/api/p/${slug}/policy`, { review: ["src/money.js#formatMoney"] }, admin);
const C = await agent("FX-2");
const fc = await fly(C, "6");
await C.tool("request_clearance", { targets: ["src/money.js#formatMoney", "test/money.test.js#formatsEurosAndYen"], reason: "EUR and JPY formats" });
await C.tool("log", { kind: "plan", text: "EUR gets a € prefix with cents; JPY has no minor unit so it prints whole yen." });
edit(fc.dir, "src/money.js", (s) => s.replace('  return currency === "USD" ? `$${dollars}` : `${dollars} ${currency}`;', () => '  if (currency === "EUR") return `€${dollars}`;\n  if (currency === "JPY") return `¥${cents}`;\n  return currency === "USD" ? `$${dollars}` : `${dollars} ${currency}`;'));
edit(fc.dir, "test/money.test.js", append('export function formatsEurosAndYen() {\n  assert.equal(formatMoney(1234, "EUR"), "€12.34");\n  assert.equal(formatMoney(1234, "JPY"), "¥1234");\n}'));
push(fc.dir, "EUR and JPY");
const lc = await C.tool("request_landing", { summary: "Format EUR with € and JPY without decimals." });
say(`C ${lc.landing.status} (approve it in the review inbox)`);
