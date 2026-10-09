#!/usr/bin/env node
// End-to-end smoke test against a deployed Contrail: scripted agents use real git against
// Artifacts workspaces and exercise clearances (enforced at landing too), parallel landings,
// insert/insert unions, a real conflict, its resolution, the why() lookup, review by exception, AI review,
// a landing train with a culprit, and a playground that starts over once its work has landed or when its operator asks.
//   CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/smoke.mjs [--keep]
// It creates two private projects from demo/bookshop and deletes them afterwards (--keep keeps them).
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.CONTRAIL_URL?.replace(/\/$/, "");
const admin = process.env.CONTRAIL_ADMIN_KEY;
if (!base || !admin) {
  console.error("usage: CONTRAIL_URL=https://<your deployment> CONTRAIL_ADMIN_KEY=<admin key> node scripts/smoke.mjs [--keep]");
  process.exit(2);
}
const keep = process.argv.includes("--keep");
const slug = `smoke-${Date.now().toString(36)}`;
const work = mkdtempSync(join(tmpdir(), "contrail-smoke-"));
const demo = join(dirname(fileURLToPath(import.meta.url)), "../demo/bookshop");
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

// Clone URLs carry short-lived repo tokens: keep them out of error messages.
const redact = (text) => String(text).replace(/:\/\/[^@\s/]+@/g, "://***@");
function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (err) {
    throw new Error(redact(`${err.message}\n${err.stderr ?? ""}`));
  }
}

function demoFiles(root = demo, out = {}) {
  for (const entry of readdirSync(root)) {
    const full = join(root, entry);
    if (statSync(full).isDirectory()) demoFiles(full, out);
    else if (entry !== "intents.json") out[relative(demo, full)] = readFileSync(full, "utf8");
  }
  return out;
}

/** A private Bookshop project with the demo's intents (or the first `intents` of them). */
async function createProject(projectSlug, { playground = false, intents } = {}) {
  await call("/api/projects", { slug: projectSlug, name: `Smoke ${projectSlug}`, public: false, playground, source: { kind: "files", files: demoFiles() } }, admin);
  const all = JSON.parse(readFileSync(join(demo, "intents.json"), "utf8"));
  await call(`/api/p/${projectSlug}/intents`, { intents: intents ? all.slice(0, intents) : all }, admin);
}

async function deleteProject(projectSlug) {
  await fetch(`${base}/api/projects/${projectSlug}`, { method: "DELETE", headers: { authorization: `Bearer ${admin}` } }).catch(() => {});
}

async function agent(callsign, projectSlug = slug) {
  const { key, agent } = await call(`/api/p/${projectSlug}/join`, { callsign, kind: "other", model: "scripted" }, admin);
  const tool = (name, args) => call(`/api/p/${projectSlug}/agent/${name}`, args, key);
  return { key, agent, tool, projectSlug };
}

async function fly(a, intent) {
  const t = await a.tool("take_off", { intent });
  const dir = join(work, `${a.projectSlug}-${t.flight.code.toLowerCase()}`);
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

console.log(`smoke test on ${base}/p/${slug} and ${base}/p/${slug}-pg (workdir ${work})`);
await createProject(slug);

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

// D also asks to land first: its change touches subtotal, which C is cleared for, so the runway turns it away.
const early = await D.tool("request_landing", { summary: "Every third paperback is free." });
check(
  early.landing.status === "failed" && /^airspace violation: src\/pricing\.js#subtotal is cleared to /.test(early.landing.error ?? ""),
  `${fd.flight.code} turned away for landing code ${fc.flight.code} is cleared for (${early.landing.error ?? early.landing.status})`,
);
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
// (function replacer: "$$" in a replacement string would collapse to "$")
edit(fe.dir, "src/money.js", (s) =>
  s.replace(
    '  return currency === "USD" ? `$${dollars}` : `${dollars} ${currency}`;',
    () => '  if (currency === "EUR") return `€${dollars}`;\n  if (currency === "JPY") return `¥${cents}`;\n  return currency === "USD" ? `$${dollars}` : `${dollars} ${currency}`;',
  ),
);
commitPush(fe.dir, "EUR and JPY");
const le = await E.tool("request_landing", { summary: "Format EUR with € and JPY without decimals." });
check(le.landing.status === "review" && le.landing.review?.required?.includes("src/money.js#formatMoney"), `${fe.flight.code} parked for human review by policy`);
const approve = () => call(`/api/p/${slug}/landings/${le.landing.id}/review`, { decision: "approve", comment: "Looks right; JPY has no minor unit.", reviewer: "smoke" }, admin);
const afterReview = async () => {
  let s;
  for (let i = 0; i < 20; i++) {
    s = await E.tool("landing_status", {});
    if (!["queued", "merging", "verifying"].includes(s.landing.status)) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return s;
};
// An approval covers the commit the human saw: one pushed after the review needs a review of its own.
edit(fe.dir, "src/money.js", (s) => s.replace('  if (currency === "EUR")', () => '  if (currency === "GBP") return `£${dollars}`;\n  if (currency === "EUR")'));
commitPush(fe.dir, "GBP too");
await approve();
const moved = await afterReview();
check(moved.landing.status === "review" && moved.landing.forkHead !== le.landing.forkHead, `a commit pushed after the review goes back for review (${moved.landing.status})`);
await approve();
const le2 = await afterReview();
check(le2.landing.status === "landed", `${fe.flight.code} landed after approval`);
await call(`/api/p/${slug}/policy`, { review: [] }, admin);

// ── 4b. AI review: a model from another family reads each landing against its intent ─────
await call(`/api/p/${slug}/policy`, { aiReview: true }, admin);
const reviewed = (l) => `${l.aiReview?.model?.split("/").pop() ?? "no reviewer"}: ${l.aiReview?.verdict ?? "none"}, "${l.aiReview?.reason ?? ""}"`;
const J = await agent("SMOKE-J");
const fj = await fly(J, "4");
await J.tool("request_clearance", { targets: ["src/shipping.js#shippingFor"], reason: "free shipping over $50" });
edit(fj.dir, "src/shipping.js", append(`
export function shippingFor(cart, catalog, subtotalCents) {
  if (subtotalCents >= 5000) {
    return 0;
  }
  return shippingCost(parcelWeight(cart, catalog));
}`));
edit(fj.dir, "test/shipping.test.js", (s) =>
  append(`
export function shipsFreeFromFiftyDollars() {
  const cart = new Cart();
  cart.add("9780143127550", 2);
  const catalog = createCatalog(SAMPLE_BOOKS);
  assert.equal(shippingFor(cart, catalog, 5000), 0);
  assert.equal(shippingFor(cart, catalog, 4999), 899);
}`)(s.replace("import { parcelWeight, shippingCost } from", "import { parcelWeight, shippingCost, shippingFor } from")),
);
commitPush(fj.dir, "Free shipping over $50");
const lj = await J.tool("request_landing", { summary: "Added shippingFor(): free from 5000 cents, by weight below that, with a test." });
check(lj.landing.status === "landed" && lj.landing.aiReview?.verdict === "approve", `the AI reviewer approved ${fj.flight.code}, which does what its intent says (${reviewed(lj.landing)})`);

const K = await agent("SMOKE-K");
const fk = await fly(K, "15");
await K.tool("request_clearance", { targets: ["src/receipt.js#receiptJson"], reason: "receipt as JSON" });
edit(fk.dir, "src/receipt.js", append(`
export function receiptJson(cart, catalog, totalCents) {
  const lines = cart.lines.map((line) => {
    const book = findByIsbn(catalog, line.isbn);
    return { isbn: line.isbn, title: book.title, qty: line.qty, amountCents: book.priceCents * line.qty };
  });
  return { lines, totalCents };
}`));
edit(fk.dir, "test/receipt.test.js", (s) =>
  append(`
export function receiptAsJson() {
  const cart = new Cart();
  cart.add("9781984801258", 2);
  const json = receiptJson(cart, createCatalog(SAMPLE_BOOKS), 3400);
  assert.deepEqual(json, { lines: [{ isbn: "9781984801258", title: "Klara and the Sun", qty: 2, amountCents: 3400 }], totalCents: 3400 });
}`)(s.replace("import { renderReceipt } from", "import { receiptJson, renderReceipt } from")),
);
// …and, unasked, a coupon worth half of any order. It lands nowhere near code another flight holds, and the tests pass.
const coupon = '  if (code === "FRIEND50") {\n    return Math.round(amount / 2);\n  }\n';
edit(fk.dir, "src/pricing.js", (s) => s.replace('  if (code === "WELCOME5") {', () => `${coupon}  if (code === "WELCOME5") {`));
commitPush(fk.dir, "Receipt as JSON");
const lk = await K.tool("request_landing", { summary: "Added receiptJson() with the lines and the total, and a test." });
check(lk.landing.status === "review" && lk.landing.aiReview?.verdict === "flag", `the AI reviewer flagged ${fk.flight.code}, which also adds an unasked 50% coupon, and parked it for a person (${reviewed(lk.landing)})`);
await call(`/api/p/${slug}/landings/${lk.landing.id}/review`, { decision: "reject", comment: "Drop the coupon: it is not part of this intent.", reviewer: "smoke" }, admin);
edit(fk.dir, "src/pricing.js", (s) => s.replace(coupon, ""));
commitPush(fk.dir, "Drop the coupon");
const lk2 = await K.tool("request_landing", { summary: "Added receiptJson() with the lines and the total, and a test. Dropped the coupon." });
check(lk2.landing.status === "landed" && lk2.landing.aiReview?.verdict === "approve", `without the coupon, ${fk.flight.code} lands with the AI reviewer's approval (${reviewed(lk2.landing)})`);
const whyReceipt = await K.tool("why", { path: "src/receipt.js", symbol: "receiptJson" });
check(whyReceipt.history[0]?.aiReview?.verdict === "approve", "why() shows the AI reviewer's verdict with the landing");
await call(`/api/p/${slug}/policy`, { aiReview: false }, admin);

// ── 5. a train with a culprit: tested once as a whole, replayed one landing at a time when red ─────
const [F, G, H, X] = await Promise.all(["SMOKE-F", "SMOKE-G", "SMOKE-H", "SMOKE-X"].map((callsign) => agent(callsign)));
const [ff, fg, fh, fx] = await Promise.all([fly(F, "14"), fly(G, "11"), fly(H, "13"), fly(X, "1")]);
const newFiles = (dir, files) => {
  for (const [path, text] of Object.entries(files)) writeFileSync(join(dir, path), `${text.trim()}\n`);
};
newFiles(ff.dir, {
  "src/loyalty.js": "export function pointsFor(totalCents) {\n  const points = Math.floor(totalCents / 100);\n  return totalCents >= 10000 ? points * 2 : points;\n}",
  "test/loyalty.test.js": 'import assert from "node:assert/strict";\nimport { pointsFor } from "../src/loyalty.js";\n\nexport function earnsPointsPerDollar() {\n  assert.equal(pointsFor(4599), 45);\n  assert.equal(pointsFor(10000), 200);\n}',
});
newFiles(fg.dir, {
  "src/zones.js": 'export const ZONE_SURCHARGE_CENTS = { domestic: 0, "ca-mx": 600, intl: 1500 };',
  "test/zones.test.js": 'import assert from "node:assert/strict";\nimport { ZONE_SURCHARGE_CENTS } from "../src/zones.js";\n\nexport function intlCostsMore() {\n  assert.ok(ZONE_SURCHARGE_CENTS.intl > ZONE_SURCHARGE_CENTS["ca-mx"]);\n}',
});
newFiles(fh.dir, {
  "src/gift.js": "export const giftWrapCents = (copies) => 399 * copies;",
  "test/gift.test.js": 'import assert from "node:assert/strict";\nimport { giftWrapCents } from "../src/gift.js";\n\nexport function wrapsPerCopy() {\n  assert.equal(giftWrapCents(3), 1197);\n}',
});
// X "improves" search and breaks the existing searchesTitles test.
edit(fx.dir, "src/catalog.js", (s) => s.replace("book.title.includes(query)", "book.title.toLowerCase().startsWith(query.toLowerCase())"));
for (const f of [ff, fg, fh, fx]) commitPush(f.dir, "change");
// F's landing occupies the runway while G, H and X queue up behind it and board the next train together.
const lf = F.tool("request_landing", { summary: "Loyalty points." });
await new Promise((r) => setTimeout(r, 150));
const [lg, lh, lx] = await Promise.all([
  G.tool("request_landing", { summary: "Zone surcharges." }),
  H.tool("request_landing", { summary: "Gift wrap price." }),
  X.tool("request_landing", { summary: "Case-insensitive search." }),
]);
const settled = [await lf, lg, lh];
check(settled.every((l) => l.landing.status === "landed"), `good landings landed (${settled.map((l) => l.landing.status).join(", ")})`);
const xFailing = lx.landing.tests?.results?.filter((r) => !r.ok).map((r) => r.name) ?? [];
check(lx.landing.status === "failed" && xFailing.includes("searchesTitles"), `the culprit was turned away by its own test run (${xFailing.join(", ") || lx.landing.status})`);
const trains = (await (await fetch(`${base}/api/p/${slug}/events?type=runway.train&limit=20`, { headers: { authorization: `Bearer ${admin}` } })).json()).events ?? [];
const xTrain = trains.find((e) => e.data?.landings?.includes(lx.landing.id));
console.log(`    (the culprit rode a train of ${xTrain?.data?.landings?.length ?? "?"})`);

// ── 5b. holds go first come, first served, and never wait in a circle ─────
const [Q, Pw, R] = await Promise.all(["SMOKE-Q", "SMOKE-W", "SMOKE-R"].map((callsign) => agent(callsign)));
for (const [a, intent] of [[Q, "10"], [Pw, "12"], [R, "15"]]) await a.tool("take_off", { intent });
const cq = await Q.tool("request_clearance", { targets: ["src/catalog.js#search"], reason: "fairness check" });
const cw = await Pw.tool("request_clearance", { targets: ["src/catalog.js"], reason: "the whole file" });
const cr = await R.tool("request_clearance", { targets: ["src/catalog.js#findByIsbn"], reason: "another function" });
check(cq.granted.length === 1 && cw.holding[0]?.heldBy.callsign === "SMOKE-Q", "a hold on the whole file waits for the flight cleared for a function in it");
check(cr.holding[0]?.queued === true && cr.holding[0]?.heldBy.callsign === "SMOKE-W", `a later claim on another function queues behind the whole-file hold (${cr.holding.length ? "holding" : "granted"})`);
const cq2 = await Q.tool("request_clearance", { targets: ["src/catalog.js#createCatalog"], reason: "more" });
check(cq2.granted.includes("src/catalog.js#createCatalog"), "the flight the hold waits for is not queued behind it (no circle)");
await Q.tool("release_clearance", {});
const cw2 = await Pw.tool("request_clearance", { targets: ["src/catalog.js"] });
const cr2 = await R.tool("request_clearance", { targets: ["src/catalog.js#findByIsbn"] });
check(cw2.granted.includes("src/catalog.js") && cr2.holding.length === 1, "released: the whole-file hold is cleared first, the later claim still waits");
await Pw.tool("release_clearance", {});
const cr3 = await R.tool("request_clearance", { targets: ["src/catalog.js#findByIsbn"] });
check(cr3.granted.includes("src/catalog.js#findByIsbn"), "then the later claim is cleared");
for (const a of [Q, Pw, R]) await a.tool("abort", { reason: "smoke test done" });

// ── 5c. operators: revoking one key, and a private airspace's live feed without the key in a URL ─────
const revoked = await call(`/api/p/${slug}/agents/SMOKE-R/revoke`, {}, admin);
const refused = await fetch(`${base}/api/p/${slug}/agent/radar`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${R.key}` }, body: "{}" });
const refusedBody = await refused.json().catch(() => ({}));
check(revoked.revoked === "SMOKE-R" && refused.status === 401 && /revoked by the operator/.test(refusedBody.error ?? ""), "a revoked key stops working at once, and says why");
const live = (ticket) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/api/p/${slug}/live?ticket=${encodeURIComponent(ticket)}`);
    const done = (v) => {
      resolve(v);
      try { ws.close(); } catch {}
    };
    ws.onmessage = (m) => done(JSON.parse(m.data).kind);
    ws.onerror = () => done("refused");
    setTimeout(() => done("timeout"), 10_000);
  });
const { ticket } = await call(`/api/p/${slug}/live-ticket`, {}, admin);
const firstUse = await live(ticket);
const secondUse = await live(ticket);
check(firstUse === "snapshot" && secondUse === "refused", `a one-minute ticket opens the private feed once (${firstUse}, then ${secondUse})`);
const mcpInit = (key) =>
  fetch(`${base}/mcp/${slug}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
  }).then((r) => r.status);
const [anonymous, member] = await Promise.all([mcpInit(null), mcpInit(Q.key)]);
check(anonymous === 404 && member === 200, `a private airspace's MCP server answers its agents only (${anonymous} without a key, ${member} with one)`);

// ── 6. a playground starts over once all of its work has landed ─────
const pg = `${slug}-pg`;
await createProject(pg, { playground: true, intents: 1 });
const before = (await (await fetch(`${base}/api/p/${pg}/snapshot`, { headers: { authorization: `Bearer ${admin}` } })).json()).trunk;
const P = await agent("SMOKE-P", pg);
const fp = await fly(P, "1");
await P.tool("request_clearance", { targets: ["README.md"], reason: "note" });
edit(fp.dir, "README.md", append("Smoke test was here."));
commitPush(fp.dir, "README note");
const lp = await P.tool("request_landing", { summary: "A note in the README." });
check(lp.landing.status === "landed", `${fp.flight.code} landed the playground's only intent`);
const again = await P.tool("take_off", {});
const after = (await (await fetch(`${base}/api/p/${pg}/snapshot`, { headers: { authorization: `Bearer ${admin}` } })).json());
const readme = (t) => t.files.find((f) => f.path === "README.md")?.lines;
check(again.flight?.code === "FL-001" && after.events.some((e) => e.type === "project.reset"), `the exhausted playground started over: the next take-off is ${again.flight?.code ?? again.message}`);
check(readme(after.trunk) === readme(before) && after.trunk.head !== before.head, "trunk is back to its starting code, as a new commit on top of its history");
// An operator's new round waits for the flights in the air, then starts over with work still open.
const newRound = () => fetch(`${base}/api/p/${pg}/new-round`, { method: "POST", headers: { authorization: `Bearer ${admin}` } });
const busyRound = await newRound();
if (again.flight) await P.tool("abort", { reason: "smoke test done" });
const round = await newRound();
const roundBody = await round.json().catch(() => ({}));
const reset = await (await fetch(`${base}/api/p/${pg}/snapshot`, { headers: { authorization: `Bearer ${admin}` } })).json();
check(
  busyRound.status === 409 && round.status === 200 && roundBody.open === 1 && reset.flights.length === 0 && reset.events.some((e) => e.type === "project.reset" && /operator/.test(e.text)),
  `an operator's new round waits for a flight in the air (${busyRound.status}), then starts over (${round.status}, ${roundBody.open} open)`,
);

if (!keep) await Promise.all([deleteProject(slug), deleteProject(pg)]);
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
