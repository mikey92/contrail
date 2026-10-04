// Shared timing for the demo video: every clip is LEAD seconds of picture, its narration, then TAIL.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEAD = 0.5;
export const TAIL = 0.8;
export const AUDIO = process.env.AUDIO_DIR ?? join(homedir(), "contrail-video/audio");

export const duration = (file) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString());

/** Narration segments with their audio file, spoken duration and clip length. */
export function loadSegments() {
	return JSON.parse(readFileSync("video/narration.json", "utf8")).segments.map((s) => {
		const audio = join(AUDIO, `${s.id}.mp3`);
		const spoken = duration(audio);
		return { ...s, audio, duration: spoken, total: LEAD + spoken + TAIL };
	});
}
