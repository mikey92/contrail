import { useEffect, useRef, useState } from "preact/hooks";
import type { CenterSnapshot } from "../../../src/shared/types";
import { duration, relTime } from "../store";
import { Command } from "./Detail";
import { Logo } from "./Icons";

const n = (x: number) => x.toLocaleString("en-US");

/** Landed totals over time, to show the monorepo's landing rate. */
interface Sample {
	t: number;
	landed: number;
}

/** A monorepo split into sectors: every sector lands through its own runway, the Center composes one trunk. */
export function Center({ slug }: { slug: string }) {
	const [snap, setSnap] = useState<CenterSnapshot | null>(null);
	const [missing, setMissing] = useState(false);
	const [clone, setClone] = useState<string[] | null>(null);
	const samples = useRef<Sample[]>([]);

	useEffect(() => {
		let stop = false;
		const load = async () => {
			const res = await fetch(`/api/c/${slug}`).catch(() => null);
			if (stop) return;
			if (res?.status === 404) return setMissing(true);
			if (res?.ok) {
				const s = (await res.json()) as CenterSnapshot;
				const landed = s.sectors.reduce((n, x) => n + (x.summary?.landed ?? 0), 0);
				samples.current = [...samples.current.filter((x) => x.t > Date.now() - 60_000), { t: Date.now(), landed }];
				setSnap(s);
			}
			if (!stop) setTimeout(load, 2000);
		};
		load();
		return () => {
			stop = true;
		};
	}, [slug]);

	const openClone = async () => {
		const res = await fetch(`/api/c/${slug}/clone`);
		if (res.ok) setClone(((await res.json()) as { commands: string[] }).commands);
	};

	if (missing) {
		return (
			<div class="boot">
				<Logo size={34} />
				<div>
					There is no public monorepo called <span class="mono">{slug}</span>.
				</div>
				<a class="btn ghost" href="/">
					See all airspaces
				</a>
			</div>
		);
	}
	if (!snap) {
		return (
			<div class="boot">
				<Logo size={34} />
				<div>Contacting the center…</div>
			</div>
		);
	}

	const sum = (k: "inAir" | "holding" | "landed" | "intents" | "agents" | "conflictsPrevented") => snap.sectors.reduce((n, s) => n + (s.summary?.[k] ?? 0), 0);
	const recent = samples.current.filter((x) => x.t > Date.now() - 30_000);
	const rate = recent.length > 1 ? (recent[recent.length - 1].landed - recent[0].landed) / ((recent[recent.length - 1].t - recent[0].t) / 1000) : 0;
	const starts = snap.sectors.map((s) => s.summary?.firstTakeOff).filter((t): t is number => !!t);
	const ends = snap.sectors.map((s) => s.summary?.lastLanding).filter((t): t is number => !!t);
	const landed = sum("landed");
	const intents = sum("intents");
	const done = intents > 0 && landed === intents;
	const span = starts.length && ends.length ? Math.max(...ends) - Math.min(...starts) : 0;

	return (
		<div class="center-page">
			<header class="topbar">
				<a class="brand" href="/" title="All airspaces">
					<Logo />
					<span>Contrail</span>
				</a>
				<div class="proj">
					<div class="proj-name">{snap.center.name}</div>
					<div class="proj-sub">
						<span class="mono">monorepo @ {snap.head?.slice(0, 8) ?? "—"}</span> · {snap.sectors.length} sectors · {n(snap.compositions)} compositions
					</div>
				</div>
				<div class="stats">
					<Stat label="Agents" value={n(sum("agents"))} title="Agents that joined any sector" />
					<Stat label="In the air" value={n(sum("inAir"))} tone="air" title="Flights working right now, across all sectors" />
					<Stat label="Holding" value={n(sum("holding"))} tone="hold" title="Flights waiting for code another flight in their sector holds" />
					<Stat label="Landed" value={`${n(landed)}/${n(intents)}`} tone="ok" title="Intents landed, across all sectors" />
					<Stat
						label={done ? "Landings/s overall" : "Landings/s now"}
						value={(done && span ? landed / (span / 1000) : rate).toFixed(1)}
						tone="plan"
						title={done ? "Landed intents divided by the time from the first take-off to the last landing" : "Landings per second over the last 30 seconds"}
					/>
				</div>
				<button class="btn ghost" onClick={openClone} title="Clone the composed monorepo trunk">
					Clone monorepo
				</button>
			</header>

			<main class="wrap center-main">
				<p class="center-lede">
					Each sector owns one directory of this monorepo and lands through its own runway, so sectors land in parallel. The Center folds every sector's
					trunk into one monorepo trunk as soon as it moves{snap.composedAt ? `: last composed ${relTime(snap.composedAt)}` : ""}
					{snap.behind ? `, ${snap.behind} sector${snap.behind > 1 ? "s" : ""} to fold in` : ""}.{done && span ? ` All ${n(landed)} intents landed in ${duration(span)}.` : ""}
				</p>
				<div class="sectors">
					{snap.sectors.map((s) => {
						const m = s.summary;
						const pct = m && m.intents ? Math.round((m.landed / m.intents) * 100) : 0;
						return (
							<a key={s.slug} class="sector" href={`/p/${s.slug}`}>
								<div class="sector-top">
									<span class="sector-name">{s.name}</span>
									<span class="mono sector-prefix">{s.prefix}</span>
								</div>
								<div class="sector-bar" title={`${pct}% landed`}>
									<i style={{ width: `${pct}%` }} />
								</div>
								{m ? (
									<div class="sector-stats">
										<span>
											<b>{m.landed}</b>/{m.intents} landed
										</span>
										<span class="t-air">{m.inAir} in the air</span>
										<span class="t-hold">{m.holding} holding</span>
									</div>
								) : (
									<div class="sector-stats muted">no answer from this sector</div>
								)}
								<div class="sector-foot mono">trunk {m?.head?.slice(0, 8) ?? "—"}</div>
							</a>
						);
					})}
				</div>
			</main>

			{clone && (
				<div class="why-backdrop" onClick={() => setClone(null)}>
					<div class="why connect" onClick={(e) => e.stopPropagation()}>
						<button class="close" onClick={() => setClone(null)}>
							×
						</button>
						<div class="why-kicker">Read-only, valid for an hour</div>
						<h3>Clone the monorepo</h3>
						<p>The composed trunk: every sector's directory at its latest landing. Each commit names the sector heads it folded in.</p>
						<Command text={clone.join("\n")} />
					</div>
				</div>
			)}
		</div>
	);
}

function Stat({ label, value, tone, title }: { label: string; value: string | number; tone?: "air" | "hold" | "ok" | "plan"; title: string }) {
	return (
		<div class={`stat ${tone ? `t-${tone}` : ""}`} title={title}>
			<div class="stat-v">{value}</div>
			<div class="stat-l">{label}</div>
		</div>
	);
}
