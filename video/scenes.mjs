#!/usr/bin/env node
// Films the demo video, one clip per narration segment, from the live deployment and from radar
// streams recorded with scripts/tap.mjs (served by the deployment under /replays/).
//
//   CONTRAIL_ADMIN_KEY=… node video/scenes.mjs <out dir> [segment ids…]
//
// Every clip is LEAD seconds of picture, the narration (video/tts.mjs output in AUDIO_DIR), then
// TAIL seconds (video/timing.mjs). Actions are timed to phrases of the narration. Clips 09 and 10 act on the live site:
// 09 approves the review parked by video/incident.mjs, 10 mints a playground key (masked on screen)
// and launches edge agents.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { record, withBrowser } from "./recorder.mjs";
import { LEAD, loadSegments } from "./timing.mjs";

const OUT = resolve(process.argv[2] ?? join(homedir(), "contrail-video/scenes"));
const ONLY = process.argv.slice(3);
const LIVE = process.env.CONTRAIL_URL ?? "https://contrail.mikey9220.workers.dev";
const SLIDES = `file://${resolve("video/slides.html")}`;
const segments = loadSegments();

/** Seconds into the clip at which the narration reaches `phrase`. */
function cue(s, phrase) {
	const i = s.text.toLowerCase().indexOf(phrase.toLowerCase());
	if (i < 0) throw new Error(`${s.id}: no "${phrase}" in the narration`);
	return LEAD + (s.duration * i) / s.text.length;
}

const replay = (slug, file, from, { speed = 1, pins = [] } = {}) =>
	`${LIVE}/p/${slug}?replay=/replays/${file}&from=${from}&speed=${speed.toFixed(3)}${pins.length ? `&map=${pins.map(([a, b]) => `${a}:${b.toFixed(2)}`).join(",")}` : ""}&paused`;

// ───────────────────────── camera, cursor and overlays ─────────────────────────

function clock(page) {
	const t0 = Date.now();
	return {
		now: () => (Date.now() - t0) / 1000,
		at: async (t) => {
			const ms = t * 1000 - (Date.now() - t0);
			if (ms > 0) await page.waitForTimeout(ms);
		},
	};
}

/** Frames `box` (viewport px) by transforming the app root; null returns to the full view. */
async function camera(page, box, { ms = 1300, ease = "cubic-bezier(.3,.1,.2,1)" } = {}) {
	await page.evaluate(
		({ box, ms, ease }) => {
			const root = document.getElementById("app");
			root.style.transformOrigin = "0 0";
			root.style.transition = `transform ${ms}ms ${ease}`;
			if (!box) {
				root.style.transform = "";
				return;
			}
			const W = innerWidth;
			const H = innerHeight;
			const s = Math.min(W / box.width, H / box.height);
			const tx = Math.min(0, Math.max(W - W * s, W / 2 - (box.x + box.width / 2) * s));
			const ty = Math.min(0, Math.max(H - H * s, H / 2 - (box.y + box.height / 2) * s));
			root.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
		},
		{ box, ms, ease },
	);
}

async function boxOf(page, selector, pad = 0) {
	const b = await page.locator(selector).first().boundingBox();
	if (!b) throw new Error(`nothing matches ${selector}`);
	return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
}

/** Dims everything but `selector` for `ms`. */
async function spotlight(page, selector, { ms = 2600, pad = 8, color = "#5eead4" } = {}) {
	const ok = await page.evaluate(
		({ selector, ms, pad, color }) => {
			const el = document.querySelector(selector);
			if (!el) return false;
			const r = el.getBoundingClientRect();
			const d = document.createElement("div");
			Object.assign(d.style, {
				position: "fixed",
				left: `${r.left - pad}px`,
				top: `${r.top - pad}px`,
				width: `${r.width + 2 * pad}px`,
				height: `${r.height + 2 * pad}px`,
				border: `3px solid ${color}`,
				borderRadius: "12px",
				boxShadow: `0 0 0 9999px rgba(2, 5, 12, 0.5), 0 0 34px ${color}88`,
				pointerEvents: "none",
				zIndex: 99990,
				opacity: "0",
				transition: "opacity 0.45s ease",
			});
			document.body.appendChild(d);
			requestAnimationFrame(() => (d.style.opacity = "1"));
			setTimeout(() => {
				d.style.opacity = "0";
				setTimeout(() => d.remove(), 500);
			}, ms);
			return true;
		},
		{ selector, ms, pad, color },
	);
	if (!ok) console.warn(`  spotlight: nothing matches ${selector}`);
}

async function installCursor(page) {
	await page.evaluate(() => {
		const c = document.createElement("div");
		c.id = "__cursor";
		c.innerHTML =
			'<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 14.8 L11.6 21.5 L14.4 20.3 L11.4 13.8 L17.6 13.6 Z" fill="#f8fafc" stroke="#0b1120" stroke-width="1.3" stroke-linejoin="round"/></svg>';
		Object.assign(c.style, {
			position: "fixed",
			left: "0",
			top: "0",
			zIndex: "100000",
			pointerEvents: "none",
			transform: "translate(1500px, 700px)",
			opacity: "0",
			transition: "transform 0.8s cubic-bezier(.3,.7,.2,1), opacity 0.3s ease",
			filter: "drop-shadow(0 3px 8px rgba(0,0,0,.6))",
		});
		document.body.appendChild(c);
	});
}

/** Moves the visible cursor to the element and clicks it (the element itself, so a list that
 * reorders under a replay can't make the click land on a neighbour). */
async function click(page, target) {
	const loc = typeof target === "string" ? page.locator(target).first() : target;
	await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
	const center = async () => {
		const b = await loc.boundingBox();
		if (!b) throw new Error(`cannot click ${target}`);
		return { x: b.x + b.width / 2, y: b.y + Math.min(b.height / 2, 22) };
	};
	const moveTo = ({ x, y }, ms) =>
		page.evaluate(
			({ x, y, ms }) => {
				const c = document.getElementById("__cursor");
				c.style.transition = `transform ${ms}ms cubic-bezier(.3,.7,.2,1), opacity 0.3s ease`;
				c.style.opacity = "1";
				c.style.transform = `translate(${x - 5}px, ${y - 3}px)`;
			},
			{ x, y, ms },
		);
	await moveTo(await center(), 800);
	await page.waitForTimeout(820);
	const at = await center();
	await moveTo(at, 140);
	await page.waitForTimeout(150);
	await page.evaluate(
		({ x, y }) => {
			const r = document.createElement("div");
			Object.assign(r.style, {
				position: "fixed",
				left: `${x - 20}px`,
				top: `${y - 20}px`,
				width: "40px",
				height: "40px",
				borderRadius: "50%",
				border: "3px solid #5eead4",
				zIndex: "99999",
				pointerEvents: "none",
				transition: "transform .55s ease-out, opacity .55s ease-out",
			});
			document.body.appendChild(r);
			requestAnimationFrame(() => {
				r.style.transform = "scale(1.9)";
				r.style.opacity = "0";
			});
			setTimeout(() => r.remove(), 700);
		},
		at,
	);
	await loc.click({ force: true, timeout: 3000 });
}

/** Shows an HTML card over the page; returns a function that hides it. */
async function overlay(page, html, style = {}) {
	const id = `ov${Math.random().toString(36).slice(2, 8)}`;
	await page.evaluate(
		({ id, html, style }) => {
			const d = document.createElement("div");
			d.id = id;
			d.innerHTML = html;
			Object.assign(d.style, {
				position: "fixed",
				zIndex: "99995",
				background: "rgba(8, 13, 25, 0.96)",
				border: "1px solid #2c3b57",
				borderRadius: "16px",
				boxShadow: "0 30px 80px rgba(0,0,0,.55)",
				color: "#e2e8f0",
				fontFamily: "Inter, system-ui, sans-serif",
				opacity: "0",
				transform: "translateY(14px)",
				transition: "opacity .5s ease, transform .5s cubic-bezier(.2,.7,.2,1)",
				...style,
			});
			document.body.appendChild(d);
			requestAnimationFrame(() => {
				d.style.opacity = "1";
				d.style.transform = "none";
			});
		},
		{ id, html, style },
	);
	return () =>
		page.evaluate((id) => {
			const d = document.getElementById(id);
			if (!d) return;
			d.style.opacity = "0";
			setTimeout(() => d.remove(), 500);
		}, id);
}

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Waits until a recorded stream has loaded (not filmed). */
async function replayReady(page) {
	await page.waitForFunction(() => typeof window.__replayStart === "function", null, { timeout: 60000 });
	await installCursor(page);
}
const startReplay = (page) => page.evaluate(() => window.__replayStart());

async function liveReady(page) {
	await page.waitForSelector(".airspace svg.map", { timeout: 30000 });
	await page.waitForTimeout(800);
	await installCursor(page);
}

function slideScene(id) {
	return {
		url: () => `${SLIDES}#${id}`,
		// Web fonts, but never wait on a stalled font request for long.
		prepare: (page) => page.evaluate(() => Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 5000))]).then(() => true)),
		run: async (page, s) => page.evaluate(({ text, duration, offset }) => window.start({ text, duration, offset }), { text: s.text, duration: s.duration, offset: LEAD }),
	};
}

// ───────────────────────── the scenes ─────────────────────────

const STRESS_END = 406;
// Replay seconds in ramda.jsonl.gz: where filming starts, the first take-off planned around the clamp
// flight, a landing whose test report is shown (and its flight), and the last landing.
const RAMDA = { from: 3, planned: 23.2, landed: 156, flight: "FL-012", end: 220 };
// The load test with flight planning off and on (scripts: /tmp/stress-ab.mjs on the deployment).
const AB = [];
const scenes = {
	"01-hook": {
		url: () => replay("stress", "stress.jsonl.gz", 24, { speed: 3 }),
		prepare: replayReady,
		run: async (page, s) => {
			await startReplay(page);
			// A slow push-in on the whole radar.
			await camera(page, { x: 1920 * 0.03, y: 1080 * 0.03, width: 1920 * 0.94, height: 1080 * 0.94 }, { ms: s.total * 1000, ease: "linear" });
		},
	},
	"01b-title": slideScene("title"),
	"02-problem": slideScene("problem"),
	"03-protocol": slideScene("protocol"),

	"04-swarm": {
		url: (s) => replay("bookshop", "bookshop.jsonl.gz", 8, { speed: (54 - 8) / s.total }),
		prepare: replayReady,
		run: async (page, s, t) => {
			await startReplay(page);
			await t.at(cue(s, "Each block is a file") - 1.4);
			const a = await boxOf(page, '[data-path="src/cart.js"]');
			const b = await boxOf(page, '[data-path="src/pricing.js"]');
			const x = Math.min(a.x, b.x) - 60;
			const y = Math.min(a.y, b.y) - 110;
			await camera(page, { x, y, width: Math.max(a.x + a.width, b.x + b.width) + 60 - x, height: Math.max(a.y + a.height, b.y + b.height) + 60 - y });
			await t.at(cue(s, "Each block is a file"));
			await spotlight(page, '[data-path="src/cart.js"]', { ms: 2000 });
			await t.at(cue(s, "each band inside it"));
			await spotlight(page, '[data-target="src/cart.js#Cart.add"]', { ms: 2200, pad: 4 });
			await t.at(cue(s, "A plane is a flight"));
			await spotlight(page, '[data-target="src/catalog.js#search"]', { ms: 2800, pad: 10 });
			await t.at(cue(s, "Up top, the traffic") - 1.1);
			await camera(page, null, { ms: 1000 });
			await t.at(cue(s, "Up top, the traffic"));
			await spotlight(page, ".topbar .stats", { ms: 3000 });
			await t.at(cue(s, "On the right"));
			await spotlight(page, ".side", { ms: 2200, pad: 0 });
			await t.at(cue(s, "At the bottom"));
			await spotlight(page, ".runway", { ms: 2400, pad: 2 });
		},
	},

	"05-clearance": {
		url: (s) =>
			replay("bookshop", "bookshop.jsonl.gz", 46, {
				pins: [
					[47.7, cue(s, "both need subtotal") - 0.8],
					[51.9, cue(s, "put in a holding pattern") - 0.2],
					[52.0, cue(s, "put in a holding pattern")],
					[71.0, cue(s, "and the radio tells it") - 0.3],
					[72.8, cue(s, "the moment subtotal is free") + 0.3],
				],
			}),
		prepare: replayReady,
		run: async (page, s, t) => {
			await startReplay(page);
			await t.at(0.2);
			const file = await boxOf(page, '[data-path="src/pricing.js"]');
			await camera(page, { x: file.x - 120, y: file.y - 120, width: file.width + 240, height: file.height + 240 });
		},
	},

	"06-landing": {
		url: (s) =>
			replay("bookshop", "bookshop.jsonl.gz", 73, {
				pins: [
					[107.0, cue(s, "That matters") + 0.4],
					[108.1, cue(s, "but failed on the merged tree")],
					[141.2, cue(s, "and landed.")],
				],
			}),
		prepare: replayReady,
		run: async (page, s, t) => {
			await startReplay(page);
			await t.at(LEAD + 0.2);
			await spotlight(page, ".runway", { ms: 2400, pad: 2 });
			await t.at(cue(s, "It fetches the flight's fork") - 1.2);
			await click(page, '.tabs button:has-text("Flights")');
			await page.waitForTimeout(500);
			await click(page, page.locator(".flights .fcard", { hasText: "FL-005" }).first());
			await t.at(cue(s, "runs the merged tree's tests"));
			await spotlight(page, ".drawer .tests", { ms: 3400, pad: 6 });
			await t.at(cue(s, "This Codex agent") - 1.0);
			await click(page, ".drawer .close");
			await page.waitForTimeout(400);
			await click(page, page.locator(".flights .fcard", { hasText: "FL-007" }).first());
			await t.at(cue(s, "but failed on the merged tree") + 0.6);
			await page.locator(".drawer section.landing.failed").first().scrollIntoViewIfNeeded().catch(() => {});
			await spotlight(page, ".drawer section.landing.failed .tests", { ms: 4200, pad: 6, color: "#f87171" });
			await t.at(cue(s, "and landed.") + 0.3);
			await page.locator(".drawer section.landing.landed").first().scrollIntoViewIfNeeded().catch(() => {});
			await spotlight(page, ".drawer section.landing.landed", { ms: 2200, pad: 4, color: "#4ade80" });
			await t.at(cue(s, "And when two agents append") - 0.6);
			await click(page, ".drawer .close");
			await page.waitForTimeout(300);
			await click(page, '.tabs button:has-text("Live")');
			await t.at(cue(s, "simply keeps both") - 0.2);
			await spotlight(page, ".feed .ev-landing-landed", { ms: 3000, pad: 4, color: "#a78bfa" });
		},
	},

	"07-contrail": {
		url: () => `${LIVE}/p/bookshop`,
		prepare: liveReady,
		run: async (page, s, t) => {
			// An excerpt of the real output for trunk commit 37725a51 (… marks what is left out).
			const log = [
				["cmd", "$ git log --notes=contrail -1"],
				["", "commit 37725a51ba9fce51733092b71ebc75bd06cbaa92"],
				["", "Author: CODEX-7 <codex-7@agents.contrail.dev>"],
				["", ""],
				["b", "    Buy 2 get 1 free on paperbacks (INT-16)"],
				["", "    Paperbacks receive every third copy free per line, choosing the lower price …"],
				["", ""],
				["", "    Contrail-Flight: FL-007"],
				["", "    Contrail-Landing: deyr7yrikfx8"],
				["", "    Contrail-Intent: INT-16"],
				["", "    Contrail-Agent: CODEX-7 (codex)"],
				["", ""],
				["n", "Notes (contrail):"],
				["n", '    "plan": "Add per-line buy-two-get-one pricing for paperbacks and compare it with …'],
				["n", "      Subtotal is currently held by the bulk-discount flight, so I will add tests"],
				["n", '      first and integrate its landed implementation after clearance.",'],
				["n", '    "decisions": ["Bulk\'s existing test uses three paperbacks, whose required price'],
				["n", '      now changes under INT-16. Switch that bulk-specific fixture to hardcover, …"],'],
				["n", '    "tests": { "passed": 48, "failed": 0 }'],
			];
			const colors = { cmd: "#5eead4", b: "#f8fafc", n: "#fbbf24", "": "#cbd5e1" };
			const html = `<div style="font-family:'JetBrains Mono',monospace;font-size:19px;line-height:1.55;white-space:pre;padding:28px 34px">${log
				.map(([k, l]) => `<div style="color:${colors[k]}">${escapeHtml(l) || "&nbsp;"}</div>`)
				.join("")}</div>`;
			await t.at(LEAD);
			const hide = await overlay(page, html, { left: "50%", top: "50%", marginLeft: "-590px", marginTop: "-310px", width: "1180px" });
			await t.at(cue(s, "Click any function") - 1.6);
			await hide();
			await page.waitForTimeout(400);
			await click(page, '[data-target="src/pricing.js#subtotal"]');
			await t.at(cue(s, "And because it's plain Git") - 0.4);
			await click(page, ".why .close");
			await page.waitForTimeout(300);
			await spotlight(page, ".topbar .btn.ghost", { ms: 3000, pad: 6 });
		},
	},

	"08-incident": {
		url: (s) =>
			replay("incident", "incident.jsonl.gz", 15, {
				pins: [
					[21.3, cue(s, "is holding for subtotal")],
					[35.0, cue(s, "BULK seven lands first") + 0.3],
					[41.7, cue(s, "returns a structured conflict")],
					[51.9, cue(s, "catches a semantic conflict")],
					[61.6, cue(s, "and lands.")],
				],
			}),
		prepare: replayReady,
		run: async (page, s, t) => {
			await startReplay(page);
			await t.at(0.2);
			const file = await boxOf(page, '[data-path="src/pricing.js"]');
			await camera(page, { x: file.x - 160, y: file.y - 160, width: file.width + 320, height: file.height + 320 });
			await t.at(cue(s, "When PROMO three tries to land") - 0.3);
			await camera(page, null, { ms: 1000 });
			await page.waitForTimeout(1100);
			await click(page, '.tabs button:has-text("Flights")');
			await page.waitForTimeout(400);
			await click(page, page.locator(".flights .fcard", { hasText: "FL-002" }).first());
			await t.at(cue(s, "Flight one, BULK seven") - 0.3);
			await page.locator(".drawer section.landing.conflict").first().scrollIntoViewIfNeeded().catch(() => {});
			await spotlight(page, ".drawer .conflict", { ms: 3800, pad: 4, color: "#fbbf24" });
			await t.at(cue(s, "catches a semantic conflict") + 0.4);
			await page.locator(".drawer section.landing.failed").first().scrollIntoViewIfNeeded().catch(() => {});
			await spotlight(page, ".drawer section.landing.failed", { ms: 3600, pad: 4, color: "#f87171" });
			await t.at(cue(s, "and lands.") + 0.3);
			await page.locator(".drawer section.landing.landed").first().scrollIntoViewIfNeeded().catch(() => {});
			await spotlight(page, ".drawer section.landing.landed", { ms: 3000, pad: 4, color: "#4ade80" });
		},
	},

	"09-review": {
		url: () => `${LIVE}/p/incident`,
		admin: true,
		prepare: liveReady,
		run: async (page, s, t) => {
			await t.at(LEAD);
			await click(page, '.tabs button:has-text("Review")');
			await t.at(cue(s, "waits in the review inbox"));
			await spotlight(page, ".rcard", { ms: 3200, pad: 4, color: "#fbbf24" });
			await t.at(cue(s, "Approve it") - 0.9);
			await click(page, 'button:has-text("Approve & land")');
			await t.at(cue(s, "Everything else") - 0.3);
			await click(page, '.tabs button:has-text("Live")');
		},
	},

	"10-connect": {
		url: () => `${LIVE}/p/playground`,
		prepare: async (page) => {
			await liveReady(page);
			// Agent keys never reach the screen: mask them the moment they are rendered.
			await page.evaluate(() => {
				const mask = (root) => {
					const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
					for (let n = walker.nextNode(); n; n = walker.nextNode()) {
						const v = n.nodeValue.replace(/(Bearer |CONTRAIL_KEY=)(?!<)[^\s"]+/g, (_, p) => `${p}ak_••••••••••••`);
						if (v !== n.nodeValue) n.nodeValue = v;
					}
				};
				new MutationObserver(() => mask(document.body)).observe(document.body, { subtree: true, childList: true, characterData: true });
			});
		},
		run: async (page, s, t) => {
			await t.at(LEAD);
			await click(page, 'button:has-text("Connect an agent")');
			await page.waitForTimeout(700);
			await click(page, 'button:has-text("Get an agent key")');
			await t.at(cue(s, "get twelve tools") - 0.5);
			await spotlight(page, ".connect pre.code", { ms: 3000, pad: 6 });
			await t.at(cue(s, "Or launch edge agents") - 1.0);
			await click(page, ".connect .close");
			await page.waitForTimeout(300);
			await click(page, "button.launch");
			await t.at(cue(s, "In the playground") - 0.5);
			await spotlight(page, ".sky", { ms: 3200, pad: 0 });
		},
	},

	"11-scale": {
		// The busy first two minutes at a watchable speed, then the long tail (hot counters landing one
		// after another) fast-forwarded so the totals are final when the numbers come up.
		url: (s) =>
			replay("stress", "stress.jsonl.gz", 8, {
				pins: [
					[130, cue(s, "Under load")],
					[STRESS_END, cue(s, "Three hundred out of") - 0.3],
				],
			}),
		prepare: replayReady,
		run: async (page, s, t) => {
			await startReplay(page);
			await t.at(cue(s, "the hottest ones") - 1.2);
			const f = await boxOf(page, '[data-path="src/counters.js"]');
			await camera(page, { x: f.x - 20, y: f.y - 80, width: Math.max(f.width + 40, 1000), height: 560 });
			await t.at(cue(s, "Most changes increment") + 0.6);
			await camera(page, null, { ms: 1000 });
			await t.at(cue(s, "landings ride in trains"));
			await spotlight(page, ".runway", { ms: 3200, pad: 2, color: "#f97316" });
			await t.at(cue(s, "Three hundred out of") + 0.1);
			const stat = (n, label, color) =>
				`<div style="padding:8px 0"><div style="font-size:54px;font-weight:800;color:${color};letter-spacing:-.02em">${n}</div><div style="font-size:19px;color:#8193ad;text-transform:uppercase;letter-spacing:.12em;font-family:'JetBrains Mono',monospace">${label}</div></div>`;
			await overlay(
				page,
				`<div style="padding:30px 38px;display:grid;grid-template-columns:1fr 1fr;gap:6px 46px">${[
					stat("300/300", "changes landed", "#4ade80"),
					stat("0", "lost updates", "#5eead4"),
					stat("174", "holds before code", "#fbbf24"),
					stat("61", "parallel inserts merged", "#a78bfa"),
					stat("100", "agents", "#e2e8f0"),
					stat("105", "test runs (trains)", "#f97316"),
				].join("")}</div>`,
				{ right: "430px", top: "200px" },
			);
		},
	},

	"11b-ramda": {
		// The real-codebase run: the planned take-off first, then a landing's test report, then the
		// load-test comparison.
		url: (s) =>
			replay("ramda", "ramda.jsonl.gz", RAMDA.from, {
				pins: [
					[RAMDA.planned - 1.5, cue(s, "First, the tower plans") - 0.5],
					[RAMDA.planned + 0.5, cue(s, "so the second one stays")],
					[RAMDA.landed, cue(s, "Then every landing") - 0.6],
					[RAMDA.end, cue(s, "In the hundred-agent load test") - 0.4],
				],
			}),
		prepare: replayReady,
		run: async (page, s, t) => {
			await startReplay(page);
			await t.at(cue(s, "three hundred and seventy source files") - 0.4);
			await spotlight(page, '[data-group="source/"]', { ms: 2600, pad: 2 });
			await t.at(cue(s, "its own suite") - 0.2);
			await spotlight(page, '[data-group="test/"]', { ms: 2600, pad: 2 });
			await t.at(cue(s, "so the second one stays") - 0.2);
			const clamp = await boxOf(page, '[data-path="source/clamp.js"]');
			await camera(page, { x: clamp.x - 420, y: clamp.y - 260, width: clamp.width + 840, height: clamp.height + 520 });
			await t.at(cue(s, "while other work flies"));
			await camera(page, null, { ms: 1000 });
			await page.waitForTimeout(1050);
			await spotlight(page, ".feed .ev-flight-planned", { ms: 3200, pad: 4, color: "#38bdf8" });
			await t.at(cue(s, "Then every landing") - 0.2);
			await click(page, '.tabs button:has-text("Flights")');
			await page.waitForTimeout(500);
			await click(page, page.locator(".flights .fcard", { hasText: RAMDA.flight }).first());
			await t.at(cue(s, "Ramda's entire test suite"));
			await spotlight(page, ".drawer section.landing.landed .tests", { ms: 3600, pad: 6, color: "#4ade80" });
			await t.at(cue(s, "In the hundred-agent load test") - 0.6);
			await click(page, ".drawer .close");
			const stat = (n, label, color) =>
				`<div style="padding:6px 0"><div style="font-size:50px;font-weight:800;color:${color};letter-spacing:-.02em">${n}</div><div style="font-size:18px;color:#8193ad;text-transform:uppercase;letter-spacing:.12em;font-family:'JetBrains Mono',monospace">${label}</div></div>`;
			await overlay(
				page,
				`<div style="padding:26px 36px"><div style="font-size:20px;color:#cbd5e1;margin-bottom:10px">100 agents · 300 changes · flight planning off → on</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:4px 46px">${AB.map(([n, label, color]) => stat(n, label, color)).join("")}</div></div>`,
				{ right: "430px", top: "220px" },
			);
		},
	},

	"12-architecture": slideScene("architecture"),
	"13-close": slideScene("close"),
};

// ───────────────────────── film ─────────────────────────

const adminKey = process.env.CONTRAIL_ADMIN_KEY;
await withBrowser(async (context) => {
	for (const s of segments) {
		if (ONLY.length && !ONLY.includes(s.id)) continue;
		const scene = scenes[s.id];
		if (!scene) throw new Error(`no scene for ${s.id}`);
		if (scene.admin) {
			if (!adminKey) throw new Error(`${s.id} needs CONTRAIL_ADMIN_KEY`);
			await context.addInitScript((key) => {
				try {
					localStorage.setItem("contrail-admin", key);
				} catch {}
			}, adminKey);
		}
		const out = join(OUT, `${s.id}.mp4`);
		console.log(`${s.id}: ${s.total.toFixed(1)}s → ${out}`);
		const take = () =>
			record(context, {
				url: scene.url(s),
				out,
				prepare: scene.prepare,
				scene: async (page) => {
					const t = clock(page);
					await scene.run(page, s, t);
					await t.at(s.total);
				},
			});
		// One more take if something flaked (a replay that didn't load, a slow page).
		const took = await take().catch(async (err) => {
			console.warn(`  ${s.id} failed (${err.message.split("\n")[0]}), filming it again`);
			for (const p of context.pages()) await p.close().catch(() => {});
			return take();
		});
		if (Math.abs(took - s.total) > 0.6) console.warn(`  ${s.id} ran ${took.toFixed(1)}s instead of ${s.total.toFixed(1)}s`);
	}
});
