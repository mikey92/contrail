// Screenshots a UI route: node scripts/shot.mjs <url> <out.png> [width] [height] [clickSelector]
import { chromium } from "playwright";
const [url, out, w = "1600", h = "900", click] = process.argv.slice(2);
let browser;
try {
  browser = await chromium.launch();
} catch {
  browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
}
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: 1 });
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()));
page.on("pageerror", (e) => console.log("pageerror:", e.message));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
if (click) {
  await page.click(click);
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: out });
await browser.close();
console.log("saved", out);
