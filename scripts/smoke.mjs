#!/usr/bin/env node
// End-to-end smoke test against a deployed Contrail: four scripted agents use real git against
// Artifacts workspaces and exercise clearances, parallel landings, insert/insert unions, a real
// conflict, its resolution, and the why() lookup.
//   CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/smoke.mjs <slug>
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const slug = process.argv[2];
const base = process.env.CONTRAIL_URL;
const admin = process.env.CONTRAIL_ADMIN_KEY;
const work = mkdtempSync(join(tmpdir(), "contrail-smoke-"));
let failures = 0;

function check(cond, label) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failures++;
}

async function call(path, body, key) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json;
}

const sh = (cmd, cwd) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

async function agent(callsign) {
  const { key, agent } = await call(`/api/p/${slug}/join`, { callsign, kind: "other", model: "scripted" }, admin);
  const tool = (name, args) => call(`/api/p/${slug}/agent/${name}`, args, key);
  return { key, agent, tool };
}

async function fly(a, intent) {
  const t = await a.tool("take_off", { intent });
  const dir = join(work, t.flight.code.toLowerCase());
  sh(`git clone -q ${t.workspace.cloneUrl} ${dir}`);
  sh(`git remote add upstream ${t.upstream.cloneUrl}`, dir);
  sh(`git config user.name ${a.agent.callsign} && git config user.email ${a.agent.callsign.toLowerCase()}@agents.contrail.dev`, dir);
  return { ...t, dir };
}

function edit(dir, path, fn) {
  const full = join(dir, path);
  writeFileSync(full, fn(readFileSync(full, "utf8")));
}

const append = (text) => (src) => `${src.trimEnd()}\n\n${text.trim()}\n`;

function commitPush(dir, message) {
  sh(`git add -A && git commit -q -m "${message}" && git push -q origin HEAD:main`, dir);
}

console.log(`smoke test on ${base}/p/${slug} (workdir ${work})`);

// ── 1. two flights edit different methods of the same class in parallel ─────
const A = await agent("SMOKE-A");
const B = await agent("SMOKE-B");
const fa = await fly(A, "2");
const fb = await fly(B, "7");
check(fa.flight.status === "airborne" && fb.flight.status === "airborne", `${fa.flight.code} and ${fb.flight.code} airborne in separate workspaces`);

const ca = await A.tool("request_clearance", { targets: ["src/cart.js#Cart.add"], reason: "merge duplicate ISBN lines" });
const cb = await B.tool("request_clearance", { targets: ["src/cart.js#Cart.setQuantity", "src/cart.js#Cart.isEmpty"], reason: "new methods" });
check(ca.granted.length === 1 && cb.granted.length === 2, "sibling methods are cleared independently");
await A.tool("log", { kind: "plan", text: "Look up an existing line for the ISBN and bump its qty; otherwise push a new line." });

edit(fa.dir, "src/cart.js", (s) =>
  s.replace(
    "    this.lines.push({ isbn, qty });",
    "    const existing = this.lines.find((line) => line.isbn === isbn);\n    if (existing) {\n      existing.qty += qty;\n    } else {\n      this.lines.push({ isbn, qty });\n    }",
  ),
);
edit(fa.dir, "test/cart.test.js", append(`export function mergesDuplicateIsbns() {\n  const cart = new Cart();\n  cart.add("x", 1);\n  cart.add("x", 2);\n  assert.equal(cart.lines.length, 1);\n  assert.equal(cart.lines[0].qty, 3);\n}`));
commitPush(fa.dir, "Merge duplicate ISBNs");

edit(fb.dir, "src/cart.js", (s) =>
  s.replace(
    "  count() {\n    return this.lines.reduce((sum, line) => sum + line.qty, 0);\n  }\n}",
    "  count() {\n    return this.lines.reduce((sum, line) => sum + line.qty, 0);\n  }\n\n  setQuantity(isbn, qty) {\n    if (qty < 0) {\n      throw new Error(\"qty must not be negative\");\n    }\n    this.lines = this.lines.filter((line) => line.isbn !== isbn);\n    if (qty > 0) {\n      this.lines.push({ isbn, qty });\n    }\n  }\n\n  isEmpty() {\n    return this.lines.length === 0;\n  }\n}",
  ),
);
edit(fb.dir, "test/cart.test.js", append(`export function setsQuantities() {\n  const cart = new Cart();\n  cart.add("x", 2);\n  cart.setQuantity("x", 5);\n  assert.equal(cart.count(), 5);\n  cart.setQuantity("x", 0);\n  assert.equal(cart.isEmpty(), true);\n}`));
commitPush(fb.dir, "Add setQuantity and isEmpty");

const [la, lb] = await Promise.all([
  A.tool("request_landing", { summary: "Cart.add now merges quantities for an ISBN already in the cart." }),
  B.tool("request_landing", { summary: "Added Cart.setQuantity and Cart.isEmpty." }),
]);
check(la.landing.status === "landed", `${fa.flight.code} landed (${la.landing.status}${la.landing.error ? `: ${la.landing.error}` : ""})`);
check(lb.landing.status === "landed", `${fb.flight.code} landed (${lb.landing.status}${lb.landing.error ? `: ${lb.landing.error}` : ""})`);
check((la.landing.unioned ?? 0) + (lb.landing.unioned ?? 0) >= 1, "parallel test appends were unioned automatically");
check((lb.landing.tests?.passed ?? 0) > 14, `merged tree verified in a Dynamic Worker (${lb.landing.tests?.passed} tests)`);

// ── 2. two flights want the same function: holding, then a real conflict ──
const C = await agent("SMOKE-C");
const D = await agent("SMOKE-D");
const fc = await fly(C, "5");
const fd = await fly(D, "16");
const cc = await C.tool("request_clearance", { targets: ["src/pricing.js#subtotal"], reason: "bulk discount per line" });
const cd = await D.tool("request_clearance", { targets: ["src/pricing.js#subtotal"], reason: "buy 2 get 1 free" });
check(cc.granted.includes("src/pricing.js#subtotal"), `${fc.flight.code} cleared for subtotal`);
check(cd.holding.length === 1 && cd.holding[0].heldBy.flight === fc.flight.code, `${fd.flight.code} put in a holding pattern behind ${fc.flight.code}`);
await C.tool("log", { kind: "decision", text: "Bulk discount rounds per line with Math.round so totals stay in whole cents." });

edit(fc.dir, "src/pricing.js", (s) =>
  s.replace(
    "    total += book.priceCents * line.qty;",
    "    const lineTotal = book.priceCents * line.qty;\n    total += line.qty >= 3 ? Math.round(lineTotal * 0.9) : lineTotal;",
  ),
);
edit(fc.dir, "test/pricing.test.js", append(`export function discountsBulkLines() {\n  const cart = cartOf([\"9781984801258\", 3]);\n  assert.equal(subtotal(cart, catalog), Math.round(1700 * 3 * 0.9));\n}`));
commitPush(fc.dir, "Bulk discount");

// D ignores the hold and edits the same line anyway (agents misbehave too).
edit(fd.dir, "src/pricing.js", (s) =>
  s.replace(
    "    total += book.priceCents * line.qty;",
    "    const paid = book.format === \"paperback\" ? line.qty - Math.floor(line.qty / 3) : line.qty;\n    total += book.priceCents * paid;",
  ),
);
edit(fd.dir, "test/pricing.test.js", append(`export function paperbacksBuyTwoGetOne() {\n  const cart = cartOf([\"9780143127550\", 3]);\n  assert.equal(subtotal(cart, catalog), 1800 * 2);\n}`));
commitPush(fd.dir, "Buy 2 get 1 free");

const lc = await C.tool("request_landing", { summary: "Lines with 3+ copies get 10% off." });
check(lc.landing.status === "landed", `${fc.flight.code} landed`);
const ld = await D.tool("request_landing", { summary: "Every third paperback is free." });
check(ld.landing.status === "conflict", `${fd.flight.code} diverted with a conflict`);
const conflict = ld.landing.conflicts?.[0];
check(conflict?.path === "src/pricing.js" && conflict.hunks[0]?.symbols.includes("subtotal"), "conflict pinpoints src/pricing.js#subtotal");
check(conflict?.causedBy?.[0]?.code === fc.flight.code, `conflict names its cause: ${conflict?.causedBy?.[0]?.code} (${conflict?.causedBy?.[0]?.intent})`);

// D resolves: pull trunk, combine both rules (cheaper of the two), push, land again.
try {
  sh("git pull -q --no-rebase upstream main", fd.dir);
} catch {
  // expected: content conflict
}
edit(fd.dir, "src/pricing.js", (s) =>
  s.replace(
    /<<<<<<<[\s\S]*?>>>>>>> [^\n]*\n/,
    "    const lineTotal = book.priceCents * line.qty;\n    const bulk = line.qty >= 3 ? Math.round(lineTotal * 0.9) : lineTotal;\n    const paid = book.format === \"paperback\" ? line.qty - Math.floor(line.qty / 3) : line.qty;\n    total += Math.min(bulk, book.priceCents * paid);\n",
  ),
);
// git's own merge interleaves the two appended tests; rebuild the file from trunk + our test.
writeFileSync(
  join(fd.dir, "test/pricing.test.js"),
  append(`export function paperbacksBuyTwoGetOne() {\n  const cart = cartOf([\"9780143127550\", 3]);\n  assert.equal(subtotal(cart, catalog), 1800 * 2);\n}`)(sh("git show upstream/main:test/pricing.test.js", fd.dir)),
);
sh(`git add -A && git commit -q -m "Resolve with bulk discount: cheaper rule wins" && git push -q origin HEAD:main`, fd.dir);
await D.tool("log", { kind: "decision", text: "Bulk discount and buy-2-get-1 do not stack: each line pays the cheaper of the two." });
const ld2 = await D.tool("request_landing", { summary: "Every third paperback is free; does not stack with the bulk discount." });
// The textual conflict is gone, but FL-003's test bought 3 paperbacks: the verifier catches the semantic clash.
const failing = ld2.landing.tests?.results?.filter((r) => !r.ok).map((r) => r.name) ?? [];
check(ld2.landing.status === "failed" && failing.includes("discountsBulkLines"), `semantic conflict caught by the test gate (${failing.join(", ") || ld2.landing.status})`);

edit(fd.dir, "test/pricing.test.js", (s) =>
  s.replace('const cart = cartOf(["9781984801258", 3]);\n  assert.equal(subtotal(cart, catalog), Math.round(1700 * 3 * 0.9));', 'const cart = cartOf(["9780593135204", 3]);\n  assert.equal(subtotal(cart, catalog), Math.round(2899 * 3 * 0.9));'),
);
commitPush(fd.dir, "Bulk discount test uses a hardcover: paperbacks now get the cheaper rule");
const ld3 = await D.tool("request_landing", { summary: "Every third paperback is free; does not stack with the bulk discount (cheaper rule wins)." });
check(ld3.landing.status === "landed", `${fd.flight.code} landed after resolving (${ld3.landing.status}${ld3.landing.error ? `: ${ld3.landing.error}` : ""})`);

// ── 3. context: why does subtotal look like this? ─────
const why = await D.tool("why", { path: "src/pricing.js", symbol: "subtotal" });
check(why.history.length >= 2, `why(src/pricing.js#subtotal) returns ${why.history.length} landed intents with their plans and decisions`);
const radar = await A.tool("radar", {});
check(Array.isArray(radar.traffic), "radar works");

// ── 4. review by exception: money formatting needs a human ─────
await call(`/api/p/${slug}/policy`, { review: ["src/money.js#formatMoney"] }, admin);
const E = await agent("SMOKE-E");
const fe = await fly(E, "6");
await E.tool("request_clearance", { targets: ["src/money.js#formatMoney"], reason: "EUR and JPY" });
edit(fe.dir, "src/money.js", (s) =>
  s.replace(
    '  return currency === "USD" ? `$${dollars}` : `${dollars} ${currency}`;',
    '  if (currency === "EUR") return `€${dollars}`;\n  if (currency === "JPY") return `¥${cents}`;\n  return currency === "USD" ? `$${dollars}` : `${dollars} ${currency}`;',
  ),
);
commitPush(fe.dir, "EUR and JPY");
const le = await E.tool("request_landing", { summary: "Format EUR with € and JPY without decimals." });
check(le.landing.status === "review" && le.landing.review?.required?.includes("src/money.js#formatMoney"), `${fe.flight.code} parked for human review by policy`);
await call(`/api/p/${slug}/landings/${le.landing.id}/review`, { decision: "approve", comment: "Looks right; JPY has no minor unit.", reviewer: "smoke" }, admin);
let le2;
for (let i = 0; i < 20; i++) {
  le2 = await E.tool("landing_status", {});
  if (le2.landing.status === "landed") break;
  await new Promise((r) => setTimeout(r, 1500));
}
check(le2.landing.status === "landed", `${fe.flight.code} landed after approval`);
await call(`/api/p/${slug}/policy`, { review: [] }, admin);

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
