#!/usr/bin/env node
// End-to-end test of crossings (one change across sectors of a monorepo) against a deployed Contrail.
// A scripted agent works in a real git clone of a fork of the monorepo trunk and checks that a crossing
// lands in every sector at once and the monorepo gets one commit for it; that failing tests in one sector
// keep every sector where it was; that code a sector flight holds is held across sectors too, then lands
// once it is free (after a real conflict is resolved); and that changes outside every sector are refused.
//   CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node scripts/crossing-smoke.mjs [--keep]
// It creates a private center with two sectors and deletes it afterwards (--keep keeps it).
import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const base = process.env.CONTRAIL_URL?.replace(/\/$/, "");
const admin = process.env.CONTRAIL_ADMIN_KEY;
if (!base || !admin) {
  console.error("usage: CONTRAIL_URL=https://<your deployment> CONTRAIL_ADMIN_KEY=<admin key> node scripts/crossing-smoke.mjs [--keep]");
  process.exit(2);
}
const keep = process.argv.includes("--keep");
const slug = `xs-${Date.now().toString(36)}`;
const work = mkdtempSync(join(tmpdir(), "contrail-crossing-"));
let failures = 0;

function check(cond, label) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failures++;
}

async function request(method, path, body, key = admin) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${typeof json === "string" ? json : JSON.stringify(json)}`);
  return json;
}
const post = (path, body, key) => request("POST", path, body ?? {}, key);
const get = (path) => request("GET", path);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Clone URLs carry short-lived repo tokens: keep them out of error messages.
const redact = (text) => String(text).replace(/:\/\/[^@\s/]+@/g, "://***@");

// What this run created, deleted at the end, or when the run stops on an error (unless --keep).
const created = { center: false, sectors: [] };
async function remove(path) {
  const res = await fetch(`${base}${path}`, { method: "DELETE", headers: { authorization: `Bearer ${admin}` } }).catch((err) => err);
  if (!res?.ok && res?.status !== 404) console.error(`could not delete ${path} (${res?.status ?? res?.message})`);
}
async function cleanUp() {
  if (!keep) {
    if (created.center) await remove(`/api/centers/${slug}`);
    await Promise.all(created.sectors.map((s) => remove(`/api/projects/${s}`)));
  }
  rmSync(work, { recursive: true, force: true });
}
process.on("uncaughtException", async (err) => {
  console.error(`\nthe crossing test stopped: ${redact(err?.stack ?? err)}`);
  await cleanUp().catch(() => {});
  process.exit(1);
});
function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (err) {
    throw new Error(redact(`${err.message}\n${err.stderr ?? ""}`));
  }
}

/** Replaces `from` with `to` in a file of a clone (literally: no $ patterns), and insists that it was there. */
function swap(dir, path, from, to) {
  const full = join(dir, path);
  const text = readFileSync(full, "utf8");
  if (!text.includes(from)) throw new Error(`${path} has no ${JSON.stringify(from)}`);
  writeFileSync(full, text.split(from).join(to));
}

// ── the monorepo: an orders API and the storefront that reads its JSON ─────
const EQUAL = 'function equal(a, b) {\n  if (a !== b) throw new Error(`expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);\n}\n';
const ORDERS = {
  "services/orders/src/orders.js": "export function orderJson(order) {\n  return { id: order.id, total: order.totalCents };\n}\n\nexport function orderTotal(lines) {\n  return lines.reduce((sum, line) => sum + line.priceCents * line.qty, 0);\n}\n",
  "services/orders/test/orders.test.js": `import { orderJson, orderTotal } from "../src/orders.js";\n\n${EQUAL}\nexport function serializesTheTotal() {\n  equal(orderJson({ id: 7, totalCents: 1250 }).total, 1250);\n}\n\nexport function addsLines() {\n  equal(orderTotal([{ priceCents: 500, qty: 2 }, { priceCents: 250, qty: 1 }]), 1250);\n}\n`,
};
const WEB = {
  "web/storefront/src/receipt.js": "export function receiptLine(json) {\n  return `Order ${json.id}: ${(json.total / 100).toFixed(2)}`;\n}\n",
  "web/storefront/test/receipt.test.js": `import { receiptLine } from "../src/receipt.js";\n\n${EQUAL}\nexport function formatsTheTotal() {\n  equal(receiptLine({ id: 7, total: 1250 }), "Order 7: 12.50");\n}\n`,
};
const sectors = [
  { slug: `${slug}-orders`, name: "Orders API", prefix: "services/orders/", files: ORDERS },
  { slug: `${slug}-web`, name: "Storefront", prefix: "web/storefront/", files: WEB },
];
const [orders, web] = sectors;

console.log(`crossing smoke test on ${base}/c/${slug} (workdir ${work})`);
for (const s of sectors) {
  created.sectors.push(s.slug);
  await post("/api/projects", { slug: s.slug, name: s.name, description: `Owns ${s.prefix}`, public: false, center: slug, prefix: s.prefix, source: { kind: "files", files: s.files } });
}
created.center = true;
await post("/api/centers", {
  slug,
  name: `Crossing smoke ${slug}`,
  public: false,
  sectors: sectors.map((s) => s.slug),
  files: { "README.md": "# Shop\n\nThe orders API and the storefront.\n", ...ORDERS, ...WEB },
});
await post(`/api/c/${slug}/intents`, {
  intents: [
    { title: "Rename the order total to totalCents", body: "The orders API sends totalCents instead of total, and the storefront reads totalCents." },
    { title: "Send the total in dollars", body: "The orders API sends totalDollars (a number of dollars); the storefront prints it." },
    { title: "Prefix order ids with #", body: "Order ids read #7 in the API and on receipts." },
    { title: "Explain the shop in the README", body: "A paragraph in the monorepo's README." },
  ],
});

const { key, agent } = await post(`/api/c/${slug}/join`, { callsign: "CROSSER", kind: "other", model: "scripted" });
const tool = (name, args) => post(`/api/c/${slug}/agent/${name}`, args ?? {}, key);
const sectorHead = async (s) => (await get(`/api/p/${s.slug}/snapshot`)).trunk.head;
const monoHead = async () => (await get(`/api/c/${slug}`)).head;
const monoFile = (path) => request("GET", `/api/c/${slug}/file?path=${encodeURIComponent(path)}`);
const sectorFile = (s, path) => request("GET", `/api/p/${s.slug}/file?path=${encodeURIComponent(path)}`);
const lastCommit = async (s) => (await get(`/api/p/${s.slug}/commits?limit=1`)).commits[0];

async function fly(intent) {
  const t = await tool("take_off", { intent });
  const dir = join(work, t.crossing.code.toLowerCase());
  sh(`git clone -q ${t.workspace.cloneUrl} ${dir}`);
  sh(`git remote add upstream ${t.upstream.cloneUrl}`, dir);
  sh(`git config user.name ${agent.callsign} && git config user.email ${agent.callsign.toLowerCase()}@agents.contrail.dev`, dir);
  return { ...t, dir };
}

function commitPush(dir, message) {
  sh(`git add -A && git commit -q -m "${message}" && git push -q origin HEAD:main`, dir);
}

/** Waits until the monorepo trunk has composed every sector's latest landing. */
async function composed() {
  for (let i = 0; i < 60; i++) {
    const snap = await get(`/api/c/${slug}`);
    if (snap.behind === 0 && snap.sectors.every((s) => !s.summary?.lastLanding || (snap.composedAt ?? 0) >= s.summary.lastLanding)) return snap;
    await sleep(1000);
  }
  throw new Error("the monorepo trunk did not catch up");
}

// ── 1. a crossing lands in both sectors at once ─────
const c1 = await fly("1");
check(c1.crossing.code === "CX-001" && c1.sectors.length === 2, `${c1.crossing.code} airborne in a fork of the monorepo trunk, ${c1.sectors.map((s) => `${s.name} ${s.prefix}`).join(", ")}`);
const cl1 = await tool("request_clearance", { targets: ["services/orders/src/orders.js#orderJson", "web/storefront/src/receipt.js#receiptLine"], reason: "rename total to totalCents" });
check(cl1.granted.length === 2 && cl1.holding.length === 0, "clearance granted in both sectors");
await tool("log", { kind: "plan", text: "Rename total to totalCents in orderJson and in receiptLine, and their tests, in one crossing." });
const legs1 = (await tool("landing_status")).crossing.legs;
check(legs1.length === 2, `a leg flies in each sector: ${legs1.map((l) => `${l.name} ${l.flight}`).join(", ")}`);
const legDetail = await get(`/api/p/${web.slug}/flights/${legs1.find((l) => l.sector === web.slug).flight}`);
check(legDetail.contrail.some((e) => e.kind === "plan" && /totalCents/.test(e.text)), "the plan is in the storefront's contrail too");

swap(c1.dir, "services/orders/src/orders.js", "total: order.totalCents", "totalCents: order.totalCents");
swap(c1.dir, "services/orders/test/orders.test.js", "totalCents: 1250 }).total,", "totalCents: 1250 }).totalCents,");
swap(c1.dir, "web/storefront/src/receipt.js", "json.total / 100", "json.totalCents / 100");
swap(c1.dir, "web/storefront/test/receipt.test.js", "{ id: 7, total: 1250 }", "{ id: 7, totalCents: 1250 }");
commitPush(c1.dir, "Rename total to totalCents");
const mono0 = await monoHead();
const l1 = await tool("request_landing", { summary: "The orders API sends totalCents and the storefront reads it." });
check(l1.crossing.status === "landed", `${l1.crossing.code} landed (${l1.crossing.status}${l1.crossing.landing?.error ? `: ${l1.crossing.landing.error}` : ""})`);
check(l1.crossing.legs.every((l) => l.landing?.status === "landed" && l.landing.tests?.passed > 0), `both legs landed green: ${l1.crossing.legs.map((l) => `${l.name} ${l.landing?.tests?.passed ?? 0} tests`).join(", ")}`);
const [ordersCommit, webCommit] = await Promise.all([lastCommit(orders), lastCommit(web)]);
check(/Contrail-Crossing: CX-001/.test(ordersCommit.message) && /Contrail-Crossing: CX-001/.test(webCommit.message), "each sector's trunk has the crossing's commit, with its trailer");
const mono1 = await monoHead();
check(l1.crossing.landing?.commit === mono1 && mono1 !== mono0, `the monorepo trunk moved to the crossing's commit ${mono1?.slice(0, 8)}`);
const monoDir = join(work, "monorepo");
sh((await get(`/api/c/${slug}/clone`)).commands[0].replace(/ \S+$/, ` ${monoDir}`).replace("git clone", "git clone -q"));
const show = sh("git log -1 --format=%s%n%b --name-only", monoDir);
const files = sh("git show --name-only --format= HEAD", monoDir).trim().split("\n").sort();
check(show.startsWith("Land CX-001 Rename the order total to totalCents across Orders API, Storefront"), `one monorepo commit for the crossing: "${show.split("\n")[0]}"`);
check(
  JSON.stringify(files) === JSON.stringify(["services/orders/src/orders.js", "services/orders/test/orders.test.js", "web/storefront/src/receipt.js", "web/storefront/test/receipt.test.js"]),
  `it changes exactly the crossing's four files in both sectors`,
);

// ── 2. tests fail in one sector: no sector moves ─────
const c2 = await fly("2");
await tool("request_clearance", { targets: ["services/orders/src/orders.js#orderJson", "web/storefront/src/receipt.js#receiptLine"], reason: "dollars" });
swap(c2.dir, "services/orders/src/orders.js", "totalCents: order.totalCents", "totalDollars: order.totalCents / 100");
swap(c2.dir, "services/orders/test/orders.test.js", "totalCents: 1250 }).totalCents, 1250", "totalCents: 1250 }).totalDollars, 12.5");
swap(c2.dir, "web/storefront/src/receipt.js", "(json.totalCents / 100).toFixed(2)", "json.totalDollars.toFixed(2)");
commitPush(c2.dir, "Dollars (storefront test not updated)");
const before2 = { orders: await sectorHead(orders), web: await sectorHead(web), mono: await monoHead() };
const l2 = await tool("request_landing", { summary: "The API sends dollars; the storefront prints them." });
const leg2 = (s) => l2.crossing.legs.find((l) => l.sector === s.slug)?.landing;
check(l2.crossing.status === "diverted" && /Not landed anywhere/.test(l2.crossing.landing?.error ?? ""), `${l2.crossing.code} landed nowhere: ${l2.crossing.landing?.error}`);
check(leg2(web)?.status === "failed" && leg2(web)?.tests?.failed > 0, `the storefront's tests failed (${leg2(web)?.tests?.failed} failing)`);
check(leg2(orders)?.error === "held back", "the orders API was merged and green, and held back");
const after2 = { orders: await sectorHead(orders), web: await sectorHead(web), mono: await monoHead() };
check(after2.orders === before2.orders && after2.web === before2.web && after2.mono === before2.mono, "neither sector's trunk nor the monorepo moved");
check(/totalCents: order.totalCents/.test(await sectorFile(orders, "services/orders/src/orders.js")), "the orders API still sends totalCents");

swap(c2.dir, "web/storefront/test/receipt.test.js", "{ id: 7, totalCents: 1250 }", "{ id: 7, totalDollars: 12.5 }");
commitPush(c2.dir, "Update the storefront test");
const l2b = await tool("request_landing", { summary: "The API sends dollars; the storefront prints them." });
check(l2b.crossing.status === "landed" && l2b.crossing.attempts === 2, `fixed and landed in both sectors on attempt ${l2b.crossing.attempts}`);
check(/totalDollars/.test(await monoFile("services/orders/src/orders.js")) && /totalDollars/.test(await monoFile("web/storefront/src/receipt.js")), "the monorepo trunk has both halves");

// ── 3. code a sector flight holds is held across sectors; the crossing lands once it is free ─────
const S = await post(`/api/p/${web.slug}/join`, { callsign: "STORE", kind: "other", model: "scripted" });
const stool = (name, args) => post(`/api/p/${web.slug}/agent/${name}`, args ?? {}, S.key);
await post(`/api/p/${web.slug}/intents`, { intents: [{ title: "Show a dollar sign on receipts", body: "Receipt lines read $12.50." }] });
const sf = await stool("take_off", {});
const sdir = join(work, `store-${sf.flight.code.toLowerCase()}`);
sh(`git clone -q ${sf.workspace.cloneUrl} ${sdir}`);
sh(`git config user.name STORE && git config user.email store@agents.contrail.dev`, sdir);
await stool("request_clearance", { targets: ["web/storefront/src/receipt.js#receiptLine"], reason: "dollar sign" });

const c3 = await fly("3");
const cl3 = await tool("request_clearance", { targets: ["services/orders/src/orders.js#orderJson", "web/storefront/src/receipt.js#receiptLine"], reason: "# before ids" });
check(
  cl3.granted.includes("services/orders/src/orders.js#orderJson") && cl3.holding.length === 1 && cl3.holding[0].sector === "Storefront" && cl3.holding[0].heldBy.callsign === "STORE",
  `${c3.crossing.code} cleared in the orders API, holding in the storefront behind ${cl3.holding[0]?.heldBy.callsign} ${cl3.holding[0]?.heldBy.flight}`,
);
swap(c3.dir, "services/orders/src/orders.js", "id: order.id,", "id: `#${order.id}`,");
swap(c3.dir, "web/storefront/src/receipt.js", "`Order ${json.id}:", "`Order #${String(json.id).replace(/^#/, \"\")}:");
swap(c3.dir, "web/storefront/test/receipt.test.js", '"Order 7: 12.50"', '"Order #7: 12.50"');
commitPush(c3.dir, "Prefix ids (lands without the storefront's clearance)");
const before3 = await sectorHead(orders);
const l3 = await tool("request_landing", { summary: "Order ids read #7." });
check(l3.crossing.status === "diverted" && /airspace violation/.test(l3.crossing.landing?.error ?? ""), `turned away: the storefront's part changes code STORE holds (${l3.crossing.landing?.error?.slice(0, 120)})`);
check((await sectorHead(orders)) === before3, "the orders API did not move either");

swap(sdir, "web/storefront/src/receipt.js", "`Order ${json.id}: ${", "`Order ${json.id}: $${");
swap(sdir, "web/storefront/test/receipt.test.js", '"Order 7: 12.50"', '"Order 7: $12.50"');
sh(`git add -A && git commit -q -m "Dollar sign" && git push -q origin HEAD:main`, sdir);
const sl = await stool("request_landing", { summary: "Receipts show a dollar sign." });
check(sl.landing.status === "landed", `STORE landed its change in the storefront, which frees receiptLine`);
const radio = (await tool("landing_status")).radio;
check(radio.some((m) => m.text.startsWith("[Storefront] Cleared for web/storefront/src/receipt.js#receiptLine")), "the crossing hears over the radio that it is cleared in the storefront");

await composed();
try {
  sh("git pull -q --no-rebase upstream main", c3.dir);
} catch {
  // expected: both changed receiptLine's line
}
writeFileSync(join(c3.dir, "web/storefront/src/receipt.js"), 'export function receiptLine(json) {\n  return `Order #${String(json.id).replace(/^#/, "")}: $${json.totalDollars.toFixed(2)}`;\n}\n');
writeFileSync(
  join(c3.dir, "web/storefront/test/receipt.test.js"),
  `import { receiptLine } from "../src/receipt.js";\n\n${EQUAL}\nexport function formatsTheTotal() {\n  equal(receiptLine({ id: 7, totalDollars: 12.5 }), "Order #7: $12.50");\n}\n`,
);
sh(`git add -A && git commit -q -m "Merge the monorepo trunk: keep the dollar sign"`, c3.dir);
sh("git push -q origin HEAD:main", c3.dir);
const l3b = await tool("request_landing", { summary: "Order ids read #7, in the API and on receipts." });
check(l3b.crossing.status === "landed", `after pulling and resolving, ${l3b.crossing.code} landed (${l3b.crossing.landing?.error ?? "both sectors"})`);
check(/Order #\$\{String/.test(await monoFile("web/storefront/src/receipt.js")) && /\$\$\{json.totalDollars/.test(await monoFile("web/storefront/src/receipt.js")), "the monorepo has both the crossing's # and STORE's dollar sign");

// ── 4. a change outside every sector is refused; aborting closes the legs ─────
const c4 = await fly("4");
await tool("request_clearance", { targets: ["services/orders/src/orders.js"], reason: "a comment" });
writeFileSync(join(c4.dir, "README.md"), `${readFileSync(join(c4.dir, "README.md"), "utf8")}\nOrders and the storefront land together when a change needs both.\n`);
commitPush(c4.dir, "README");
const l4 = await tool("request_landing", { summary: "README paragraph." });
check(/outside every sector/.test(l4.crossing.landing?.error ?? ""), `refused: ${l4.crossing.landing?.error}`);
const leg4 = l4.crossing.legs[0];
await tool("abort", { reason: "the README belongs to no sector" });
const after4 = await get(`/api/p/${orders.slug}/flights/${leg4.flight}`);
check(after4.flight.status === "aborted" && after4.intent.status === "cancelled", `aborting closed its leg ${leg4.flight} (${after4.flight.status}) and cancelled the leg's intent`);
const snap = await get(`/api/c/${slug}`);
check(snap.openIntents === 1 && snap.crossings[0].status === "aborted", "the crossing's intent is open again");

await cleanUp();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
