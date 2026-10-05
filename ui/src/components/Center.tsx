import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CenterInfo, CenterSnapshot, SectorSummary } from "../../../src/shared/types";
import { duration, fetchRecording, relTime, SampleReplay, useReplay } from "../store";
import { Command } from "./Detail";
import { Logo } from "./Icons";
import { ReplayBar } from "./ReplayBar";

const n = (x: number) => x.toLocaleString("en-US");

/** Recorded runs of a monorepo (scripts/run-sectors.mjs --record), offered on its live page. */
const RECORDINGS: Record<string, string> = { monorepo: "/replays/monorepo.jsonl.gz" };

/** First line of a recording: the center, and the order of each sector's numbers in a sample. */
interface Header {
	t: number;
	kind: "center";
	center: CenterInfo;
	fields: (keyof SectorSummary)[];
	/** Every sector's radar stream was recorded too, next to the center's recording. */
	sectorStreams?: boolean;
}

/** The center once, at recording time `t` (ms) and wall-clock time `at`. */
interface Sample {
	t: number;
	at: number;
	head: string | null;
	composedAt: number | null;
	behind: number;
	compositions: number;
	s: (unknown[] | null)[];
}

function toSnapshot(header: Header, x: Sample): CenterSnapshot {
	return {
		center: header.center,
		head: x.head,
		composedAt: x.composedAt,
		behind: x.behind,
		compositions: x.compositions,
		sectors: header.center.sectors.map((sector, i) => {
			const row = x.s[i];
			return { ...sector, summary: row ? (Object.fromEntries(header.fields.map((f, j) => [f, row[j]])) as unknown as SectorSummary) : null };
		}),
	};
}

const landedIn = (s: CenterSnapshot) => s.sectors.reduce((total, x) => total + (x.summary?.landed ?? 0), 0);

/** The window for "landings per second", here and on the stat tile. */
const RATE_WINDOW = 30_000;
/** The same load test on one trunk: 300 intents by 100 agents in 6:37 (README, "Measured"). */
const ONE_TRUNK_RATE = 300 / 397;

interface RatePoint {
	t: number;
	landed: number;
	/** Landings per second over the RATE_WINDOW before t. */
	rate: number;
}

/** Landed totals at every sample (a sector that did not answer keeps its last count) and the rate behind each. */
function ratePoints(header: Header, samples: Sample[]): RatePoint[] {
	const at = header.fields.indexOf("landed");
	const last = header.center.sectors.map(() => 0);
	const landed = samples.map((x) => {
		x.s.forEach((row, i) => {
			if (row) last[i] = Number(row[at]) || 0;
		});
		return last.reduce((a, b) => a + b, 0);
	});
	const out: RatePoint[] = [];
	let j = 0;
	for (let i = 0; i < samples.length; i++) {
		while (samples[i].t - samples[j].t > RATE_WINDOW) j++;
		const dt = (samples[i].t - samples[j].t) / 1000;
		out.push({ t: samples[i].t, landed: landed[i], rate: dt > 0 ? (landed[i] - landed[j]) / dt : 0 });
	}
	return out;
}

/** A monorepo split into sectors: every sector lands through its own runway, the Center composes one trunk. */
export function Center({ slug }: { slug: string }) {
	const params = new URLSearchParams(location.search);
	const recording = params.get("replay");
	return recording === null ? <CenterLive slug={slug} /> : <CenterReplay slug={slug} path={recording} params={params} />;
}

/** Landed totals over time, to show the live landing rate. */
interface Point {
	t: number;
	landed: number;
}

function CenterLive({ slug }: { slug: string }) {
	const [snap, setSnap] = useState<CenterSnapshot | null>(null);
	const [missing, setMissing] = useState(false);
	const points = useRef<Point[]>([]);

	useEffect(() => {
		let stop = false;
		const load = async () => {
			const res = await fetch(`/api/c/${slug}`).catch(() => null);
			if (stop) return;
			if (res?.status === 404) return setMissing(true);
			if (res?.ok) {
				const s = (await res.json()) as CenterSnapshot;
				points.current = [...points.current.filter((x) => x.t > Date.now() - 60_000), { t: Date.now(), landed: landedIn(s) }];
				setSnap(s);
			}
			if (!stop) setTimeout(load, 2000);
		};
		load();
		return () => {
			stop = true;
		};
	}, [slug]);

	if (missing) return <Boot text={<>There is no public monorepo called <span class="mono">{slug}</span>.</>} link />;
	if (!snap) return <Boot text="Contacting the center…" />;
	const recent = points.current.filter((x) => x.t > Date.now() - 30_000);
	const rate = recent.length > 1 ? (recent[recent.length - 1].landed - recent[0].landed) / ((recent[recent.length - 1].t - recent[0].t) / 1000) : 0;
	return <CenterView slug={slug} snap={snap} rate={rate} now={Date.now()} />;
}

function CenterReplay({ slug, path, params }: { slug: string; path: string; params: URLSearchParams }) {
	const [loaded, setLoaded] = useState<{ header: Header; player: SampleReplay<Sample>; points: RatePoint[] } | null>(null);
	const [failed, setFailed] = useState(false);
	useReplay(loaded?.player ?? null, (r) => r.current);

	useEffect(() => {
		let player: SampleReplay<Sample> | null = null;
		let cancelled = false;
		fetchRecording(path)
			.then((text) => {
				if (cancelled) return;
				const [header, ...samples] = text
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l));
				if (header?.kind !== "center" || !samples.length) throw new Error("not a center recording");
				const speed = Number(params.get("speed") ?? 1);
				player = new SampleReplay<Sample>(samples, Number(params.get("from") ?? 0) * 1000, speed > 0 ? speed : 1);
				setLoaded({ header, player, points: ratePoints(header, samples) });
			})
			.catch(() => !cancelled && setFailed(true));
		return () => {
			cancelled = true;
			player?.stop();
		};
	}, [path]);

	if (failed) return <Boot text="This replay could not be loaded." link />;
	if (!loaded) return <Boot text="Loading the recording…" />;
	const { header, player, points } = loaded;
	const x = player.current;
	const snap = toSnapshot(header, x);
	const i = player.samples.indexOf(x);
	// Each sector's own radar replay, recorded on the same clock: open it at this moment.
	const streams = header.sectorStreams ? path.replace(/\.jsonl(\.gz)?$/, "") : null;
	const sectorHref = streams ? (sector: string) => `/p/${sector}?replay=${streams}/${sector}.jsonl.gz&from=${Math.floor(player.t / 1000)}&speed=${player.speed}` : undefined;
	return (
		<CenterView slug={slug} snap={snap} rate={points[i]?.rate ?? 0} now={x.at + (player.t - x.t)} replay={player} sectorHref={sectorHref}>
			<RateChart points={points} t={player.t} total={player.total} />
		</CenterView>
	);
}

function Boot({ text, link = false }: { text: preact.ComponentChildren; link?: boolean }) {
	return (
		<div class="boot">
			<Logo size={34} />
			<div>{text}</div>
			{link && (
				<a class="btn ghost" href="/">
					See all airspaces
				</a>
			)}
		</div>
	);
}

function CenterView({
	slug,
	snap,
	rate,
	now,
	replay,
	sectorHref,
	children,
}: {
	slug: string;
	snap: CenterSnapshot;
	rate: number;
	now: number;
	replay?: SampleReplay<Sample>;
	sectorHref?: (sector: string) => string;
	children?: preact.ComponentChildren;
}) {
	const [clone, setClone] = useState<string[] | null>(null);
	const openClone = async () => {
		const res = await fetch(`/api/c/${slug}/clone`);
		if (res.ok) setClone(((await res.json()) as { commands: string[] }).commands);
	};

	const sum = (k: "inAir" | "holding" | "landed" | "intents" | "agents") => snap.sectors.reduce((total, s) => total + (s.summary?.[k] ?? 0), 0);
	const starts = snap.sectors.map((s) => s.summary?.firstTakeOff).filter((t): t is number => !!t);
	const ends = snap.sectors.map((s) => s.summary?.lastLanding).filter((t): t is number => !!t);
	const landed = sum("landed");
	const intents = sum("intents");
	const done = intents > 0 && landed === intents;
	// From the first take-off to the last landing, to the nearest second (as the radar's end card counts).
	const span = starts.length && ends.length ? Math.round((Math.max(...ends) - Math.min(...starts)) / 1000) * 1000 : 0;
	const recording = RECORDINGS[slug];

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
				{replay ? (
					<div class="live replay" title="A recorded run, played back in your browser">
						{replay.ended ? "Replay ended" : "Replay"}
					</div>
				) : (
					recording && (
						<a class="btn ghost" href={`/c/${slug}?replay=${recording}&speed=4`} title="Watch the recorded run of every sector">
							Watch the run
						</a>
					)
				)}
				<button class="btn ghost" onClick={openClone} title="Clone the composed monorepo trunk">
					Clone monorepo
				</button>
			</header>
			{replay && <ReplayBar replay={replay} />}

			<main class="wrap center-main">
				<p class="center-lede">
					Each sector owns one directory of this monorepo and lands through its own runway, so sectors land in parallel. The Center folds every sector's
					trunk into one monorepo trunk as soon as it moves{snap.composedAt ? `: last composed ${relTime(snap.composedAt, now)}` : ""}
					{snap.behind ? `, ${snap.behind} sector${snap.behind > 1 ? "s" : ""} to fold in` : ""}.{done && span ? ` All ${n(landed)} intents landed in ${duration(span)}.` : ""}
					{replay && sectorHref ? " Open a sector to watch its radar from this moment." : ""}
				</p>
				<div class="sectors">
					{snap.sectors.map((s) => {
						const m = s.summary;
						const pct = m && m.intents ? Math.round((m.landed / m.intents) * 100) : 0;
						return (
							<a key={s.slug} class="sector" href={sectorHref ? sectorHref(s.slug) : `/p/${s.slug}`} title={sectorHref ? `Watch ${s.name}'s radar from this moment` : `Open ${s.name}'s radar`}>
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
				{children}
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

const clockOf = (ms: number) => duration(Math.round(ms / 1000) * 1000);

/**
 * Landings per second across every sector, drawn up to the replay's clock, against the same load test
 * on one trunk. One series in the accent hue; the reference is a labelled grey rule. Hover reads a point;
 * the table view has the same numbers every 30 s.
 */
function RateChart({ points, t, total }: { points: RatePoint[]; t: number; total: number }) {
	const box = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	const [hover, setHover] = useState<number | null>(null);
	const [table, setTable] = useState(false);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const ro = new ResizeObserver(() => setWidth(el.clientWidth));
		ro.observe(el);
		setWidth(el.clientWidth);
		return () => ro.disconnect();
	}, []);

	const peak = useMemo(() => points.reduce((best, p) => (p.rate > best.rate ? p : best), points[0]), [points]);
	const yMax = Math.max(5, Math.ceil(peak.rate / 5) * 5);
	const H = 200;
	const m = { l: 34, r: 12, t: 10, b: 24 };
	const iw = Math.max(1, width - m.l - m.r);
	const ih = H - m.t - m.b;
	const x = (ms: number) => m.l + (total > 0 ? (ms / total) * iw : 0);
	const y = (v: number) => m.t + ih - (v / yMax) * ih;
	const shown = points.filter((p) => p.t <= t);
	const line = shown.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.rate).toFixed(1)}`).join("");
	const area = shown.length > 1 ? `${line}L${x(shown[shown.length - 1].t).toFixed(1)},${y(0)}L${x(shown[0].t).toFixed(1)},${y(0)}Z` : "";
	const end = shown[shown.length - 1];
	const minutes = Math.max(1, Math.round(total / 60_000 / 6)) * 60_000;
	const xTicks: number[] = [];
	for (let v = 0; v <= total; v += minutes) xTicks.push(v);
	const yTicks = [0, yMax / 4, yMax / 2, (3 * yMax) / 4, yMax].filter((v) => Number.isInteger(v));
	const focus = hover !== null ? shown[hover] : null;

	const onMove = (e: PointerEvent) => {
		if (!shown.length) return;
		const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
		const ms = ((e.clientX - rect.left - m.l) / iw) * total;
		let best = 0;
		for (let i = 1; i < shown.length; i++) if (Math.abs(shown[i].t - ms) < Math.abs(shown[best].t - ms)) best = i;
		setHover(best);
	};
	const rows = points.filter((p, i) => i === points.length - 1 || Math.floor(p.t / 30_000) !== Math.floor((points[i + 1]?.t ?? 0) / 30_000));

	return (
		<figure class="rate-chart">
			<figcaption>
				<div class="rc-title">Landings per second, all sectors</div>
				<div class="rc-sub">
					Peak {peak.rate.toFixed(1)} at {clockOf(peak.t)}, over the 30 seconds before each point. The same load test on one trunk averaged {ONE_TRUNK_RATE.toFixed(2)}.
				</div>
				<button class="rc-toggle" onClick={() => setTable(!table)} aria-pressed={table}>
					{table ? "Chart" : "Table"}
				</button>
			</figcaption>
			{table ? (
				<div class="rc-table">
					<table>
						<thead>
							<tr>
								<th>Time</th>
								<th>Landings/s</th>
								<th>Landed</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((p) => (
								<tr key={p.t}>
									<td>{clockOf(p.t)}</td>
									<td>{p.rate.toFixed(1)}</td>
									<td>{n(p.landed)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<div class="rc-plot" ref={box}>
					{width > 0 && (
						<svg width={width} height={H} role="img" aria-label={`Landings per second over the run, peaking at ${peak.rate.toFixed(1)}`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
							{yTicks.map((v) => (
								<g key={v}>
									<line class="rc-grid" x1={m.l} x2={m.l + iw} y1={y(v)} y2={y(v)} />
									<text class="rc-tick" x={m.l - 8} y={y(v) + 4} text-anchor="end">
										{v}
									</text>
								</g>
							))}
							{xTicks.map((v) => (
								<text key={v} class="rc-tick" x={x(v)} y={H - 6} text-anchor={v === 0 ? "start" : "middle"}>
									{clockOf(v)}
								</text>
							))}
							<line class="rc-ref" x1={m.l} x2={m.l + iw} y1={y(ONE_TRUNK_RATE)} y2={y(ONE_TRUNK_RATE)} />
							<text class="rc-ref-label" x={m.l + iw} y={y(ONE_TRUNK_RATE) - 6} text-anchor="end">
								One trunk, 100 agents
							</text>
							{area && <path class="rc-area" d={area} />}
							{line && <path class="rc-line" d={line} />}
							{end && <circle class="rc-dot" cx={x(end.t)} cy={y(end.rate)} r={4} />}
							{focus && (
								<g>
									<line class="rc-cross" x1={x(focus.t)} x2={x(focus.t)} y1={m.t} y2={m.t + ih} />
									<circle class="rc-dot" cx={x(focus.t)} cy={y(focus.rate)} r={4} />
								</g>
							)}
						</svg>
					)}
					{focus && (
						<div class="rc-tip" style={{ left: `${Math.min(Math.max(x(focus.t), 80), width - 80)}px` }}>
							<b>{focus.rate.toFixed(1)} landings/s</b>
							<span>
								{clockOf(focus.t)} · {n(focus.landed)} landed
							</span>
						</div>
					)}
				</div>
			)}
		</figure>
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
