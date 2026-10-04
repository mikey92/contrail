#!/usr/bin/env node
// Narration with Workers AI text-to-speech (Deepgram Aura 2) through the Cloudflare REST API.
//   CLOUDFLARE_ACCOUNT_ID=… node video/tts.mjs video/narration.json <out dir>
// Writes <out dir>/<segment id>.mp3 for every segment that doesn't exist yet (FORCE=1 redoes all).
// Uses CLOUDFLARE_API_TOKEN, or wrangler's OAuth token (run `npx wrangler whoami` first so it is
// fresh). The token is never printed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [script, outDir] = process.argv.slice(2);
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
// Wrangler keeps its login in ~/.wrangler (current versions) or the platform config directory (older ones).
const wranglerConfig = [join(homedir(), ".wrangler/config/default.toml"), join(homedir(), "Library/Preferences/.wrangler/config/default.toml")].find(existsSync);
const token = process.env.CLOUDFLARE_API_TOKEN ?? (wranglerConfig ? readFileSync(wranglerConfig, "utf8").match(/^oauth_token = "([^"]+)"/m)?.[1] : undefined);
if (!account || !token) throw new Error("set CLOUDFLARE_ACCOUNT_ID and log in with wrangler (or set CLOUDFLARE_API_TOKEN)");

const { speaker = "thalia", segments } = JSON.parse(readFileSync(script, "utf8"));
mkdirSync(outDir, { recursive: true });
for (const seg of segments) {
  const file = join(outDir, `${seg.id}.mp3`);
  if (existsSync(file) && !process.env.FORCE) continue;
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/deepgram/aura-2-en`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text: seg.text, speaker: seg.speaker ?? speaker, encoding: "mp3" }),
  });
  if (!res.ok) throw new Error(`${seg.id}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const audio = res.headers.get("content-type")?.includes("json")
    ? Buffer.from((await res.json()).result.audio, "base64")
    : Buffer.from(await res.arrayBuffer());
  writeFileSync(file, audio);
  console.log(`${seg.id}: ${seg.text.length} chars → ${audio.length} bytes`);
}
