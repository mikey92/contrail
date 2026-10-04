// Records a Chromium page to an MP4 with the DevTools screencast (sharper than Playwright's video).
// Frames arrive only when the page repaints; each frame is held until the next one, so static
// moments cost nothing and the output keeps real time.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

export async function withBrowser(fn, { width = 1920, height = 1080 } = {}) {
	const browser = await chromium.launch({ args: ["--force-color-profile=srgb", "--hide-scrollbars"] });
	try {
		const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: "dark" });
		return await fn(context);
	} finally {
		await browser.close();
	}
}

/**
 * Records `scene(page)` into `out` (mp4). The scene receives the page after it has loaded `url` and
 * `prepare(page)` (not filmed) has run. Returns the duration in seconds.
 */
export async function record(context, { url, out, scene, prepare, width = 1920, height = 1080, fps = 30, settle = 2500 }) {
	const page = await context.newPage();
	await page.goto(url, { waitUntil: "networkidle" }).catch(() => {});
	await page.waitForTimeout(settle);
	if (prepare) await prepare(page);
	const cdp = await context.newCDPSession(page);
	const dir = mkdtempSync(join(tmpdir(), "contrail-rec-"));
	const frames = [];
	cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
		const file = join(dir, `${String(frames.length).padStart(6, "0")}.jpg`);
		writeFileSync(file, Buffer.from(data, "base64"));
		frames.push({ file, t: metadata.timestamp, received: Date.now() / 1000 });
		await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
	});
	await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
	const started = Date.now() / 1000;
	await scene(page);
	const stopped = Date.now() / 1000;
	await cdp.send("Page.stopScreencast");
	await page.close();
	if (frames.length === 0) throw new Error(`no frames recorded for ${out}`);
	// Screencast timestamps come from Chrome's clock, which can be seconds off Node's: shift them by
	// the smallest observed delivery delay so they line up with `started`/`stopped`.
	const shift = Math.min(...frames.map((f) => f.received - f.t));
	for (const f of frames) f.t += shift;
	while (frames.length > 1 && frames[frames.length - 1].t > stopped) frames.pop();
	// ffmpeg concat list: each frame lasts until the next one (last one until the scene ended).
	const lines = [];
	for (let i = 0; i < frames.length; i++) {
		const from = i === 0 ? Math.min(started, frames[0].t) : frames[i].t;
		const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(stopped, frames[i].t + 1 / fps);
		lines.push(`file '${frames[i].file}'`, `duration ${Math.max(0.001, next - from).toFixed(4)}`);
	}
	lines.push(`file '${frames[frames.length - 1].file}'`);
	const list = join(dir, "frames.txt");
	writeFileSync(list, lines.join("\n"));
	mkdirSync(join(out, ".."), { recursive: true });
	execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-vf", `fps=${fps},scale=${width}:${height}:flags=lanczos,format=yuv420p`, "-c:v", "libx264", "-preset", "slow", "-crf", "16", out]);
	rmSync(dir, { recursive: true, force: true });
	return stopped - started;
}

export const wait = (page, s) => page.waitForTimeout(s * 1000);
