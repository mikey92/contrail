import { useState } from "preact/hooks";
import { duration, type ReplayClock, useReplay } from "../store";
import { Icon } from "./Icons";

const SPEEDS = [1, 2, 4, 8];

/** Play, pause, speed and a seekable track for a recorded run, in recording time. */
export function ReplayBar({ replay }: { replay: ReplayClock }) {
	useReplay(replay, (r) => `${r.t} ${r.speed} ${r.playing}`);
	// The speed the link asked for (e.g. 6×) stays on offer next to the usual ones.
	const [speeds] = useState(() => [...new Set([...SPEEDS, replay.speed])].sort((a, b) => a - b));
	const { t, total, playing, ended } = replay;
	// While the knob is dragged it and the time follow the pointer; the run jumps there on release.
	const [scrub, setScrub] = useState<number | null>(null);
	const at = (e: PointerEvent) => {
		const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
		return Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)) * total;
	};
	const shown = scrub ?? t;
	const pct = total > 0 ? (shown / total) * 100 : 0;
	// On a phone one button steps through the speeds, as in Podcasts.
	const next = speeds[(speeds.indexOf(replay.speed) + 1) % speeds.length];
	const step = (e: KeyboardEvent) => {
		const to = { ArrowLeft: t - 5000, ArrowRight: t + 5000, Home: 0, End: total }[e.key];
		if (to === undefined) return;
		e.preventDefault();
		replay.seek(to);
	};
	const action = ended ? "Watch again" : playing ? "Pause" : "Play";
	return (
		<section class="replaybar" aria-label="Replay controls">
			<button class="rb-btn" onClick={() => replay.toggle()} title={action} aria-label={action}>
				<Icon name={playing ? "pause" : "play"} />
			</button>
			<button class="rb-btn" onClick={() => replay.restart()} title="Restart" aria-label="Restart">
				<Icon name="release" />
			</button>
			<span class="rb-time">{duration(shown)}</span>
			<div
				class="rb-track"
				role="slider"
				tabIndex={0}
				aria-label="Recording time"
				aria-valuemin={0}
				aria-valuemax={Math.round(total / 1000)}
				aria-valuenow={Math.round(shown / 1000)}
				aria-valuetext={`${duration(shown)} of ${duration(total)}`}
				onPointerDown={(e) => {
					try {
						(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
					} catch {
						// a pointer the browser no longer tracks
					}
					setScrub(at(e));
				}}
				onPointerMove={(e) => scrub !== null && setScrub(at(e))}
				onPointerUp={(e) => {
					if (scrub === null) return;
					replay.seek(at(e));
					setScrub(null);
				}}
				onPointerCancel={() => setScrub(null)}
				onKeyDown={step}
			>
				<div class="rb-fill" style={{ width: `${pct}%` }} />
				<div class="rb-knob" style={{ left: `${pct}%` }} />
			</div>
			<span class="rb-time">{duration(total)}</span>
			<div class="seg rb-speeds" role="group" aria-label="Playback speed">
				{speeds.map((v) => (
					<button key={v} class={v === replay.speed ? "on" : ""} aria-pressed={v === replay.speed} aria-label={`${v}× speed`} onClick={() => replay.setSpeed(v)}>
						{v}×
					</button>
				))}
			</div>
			<button class="rb-btn rb-speed" onClick={() => replay.setSpeed(next)} title="Playback speed" aria-label={`Playback speed ${replay.speed}×`}>
				{replay.speed}×
			</button>
		</section>
	);
}
