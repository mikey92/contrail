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
	const pct = total > 0 ? (t / total) * 100 : 0;
	const seek = (e: MouseEvent) => {
		const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
		replay.seek(((e.clientX - box.left) / box.width) * total);
	};
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
			<span class="rb-time">{duration(t)}</span>
			<div
				class="rb-track"
				role="slider"
				tabIndex={0}
				aria-label="Recording time"
				aria-valuemin={0}
				aria-valuemax={Math.round(total / 1000)}
				aria-valuenow={Math.round(t / 1000)}
				aria-valuetext={`${duration(t)} of ${duration(total)}`}
				onClick={seek}
				onKeyDown={step}
			>
				<div class="rb-fill" style={{ width: `${pct}%` }} />
				<div class="rb-knob" style={{ left: `${pct}%` }} />
			</div>
			<span class="rb-time">{duration(total)}</span>
			<div class="seg rb-speeds" role="group" aria-label="Playback speed">
				{speeds.map((v) => (
					<button key={v} class={v === replay.speed ? "on" : ""} aria-pressed={v === replay.speed} aria-label={`${v} times speed`} onClick={() => replay.setSpeed(v)}>
						{v}×
					</button>
				))}
			</div>
		</section>
	);
}
