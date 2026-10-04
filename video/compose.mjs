#!/usr/bin/env node
// Joins the filmed clips (video/scenes.mjs) and their narration into the final video, with short
// crossfades, loudness-normalised audio, and a matching SRT file.
//   node video/compose.mjs <scenes dir> <out.mp4>
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { LEAD, loadSegments } from "./timing.mjs";

const [dir, out] = process.argv.slice(2).map((p) => resolve(p));
const FADE = 0.4;
const segments = loadSegments();
for (const s of segments) if (!existsSync(join(dir, `${s.id}.mp4`))) throw new Error(`missing clip ${s.id}.mp4`);

const inputs = segments.flatMap((s) => ["-i", join(dir, `${s.id}.mp4`), "-i", s.audio]);
const graph = [];
segments.forEach((s, i) => {
	const T = s.total.toFixed(3);
	graph.push(`[${2 * i}:v]fps=30,format=yuv420p,trim=duration=${T},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1,trim=duration=${T}[v${i}]`);
	const ms = Math.round(LEAD * 1000);
	graph.push(`[${2 * i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${ms}|${ms},apad,atrim=duration=${T},asetpts=PTS-STARTPTS[a${i}]`);
});
let v = "v0";
let a = "a0";
let offset = segments[0].total;
const starts = [0];
for (let i = 1; i < segments.length; i++) {
	offset -= FADE;
	starts.push(offset);
	graph.push(`[${v}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}[x${i}]`);
	graph.push(`[${a}][a${i}]acrossfade=d=${FADE}:c1=tri:c2=tri[y${i}]`);
	v = `x${i}`;
	a = `y${i}`;
	offset += segments[i].total;
}
graph.push(`[${a}]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]`);

execFileSync(
	"ffmpeg",
	["-y", "-loglevel", "error", ...inputs, "-filter_complex", graph.join(";"), "-map", `[${v}]`, "-map", "[aout]", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-profile:v", "high", "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out],
	{ stdio: "inherit" },
);

// Subtitles: each narration split into sentences, timed by length within its segment.
const stamp = (t) => {
	const ms = Math.round(t * 1000);
	const p = (n, w = 2) => String(n).padStart(w, "0");
	return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};
const cues = [];
segments.forEach((s, i) => {
	const parts = s.text.match(/[^.!?:]+[.!?:]?/g).map((p) => p.trim()).filter(Boolean);
	const lines = parts.flatMap((p) => (p.length <= 84 ? [p] : p.split(/,\s+/).map((x, j, all) => (j < all.length - 1 ? `${x},` : x))));
	let t = starts[i] + LEAD;
	for (const line of lines) {
		const d = (s.duration * line.length) / s.text.length;
		cues.push(`${cues.length + 1}\n${stamp(t)} --> ${stamp(t + d)}\n${line}\n`);
		t += d;
	}
});
writeFileSync(out.replace(/\.mp4$/, ".srt"), cues.join("\n"));
console.log(`${out}: ${execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString().trim()}s`);
