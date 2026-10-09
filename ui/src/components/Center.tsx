import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CenterInfo, CenterSnapshot, Crossing, CrossingLeg, SectorSummary } from "../../../src/shared/types";
import { useTitle } from "../a11y";
import { duration, fetchRecording, relTime, SampleReplay, tidy, useReplay } from "../store";
import { Command } from "./Detail";
import { Dialog } from "./Dialog";
import { Icon, Logo, Spinner } from "./Icons";
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
		crossings: [],
		landedCrossings: 0,
		openIntents: 0,
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
			// A body that fails to arrive is skipped: polling goes on.
			const s = res?.ok ? ((await res.json().catch(() => null)) as CenterSnapshot | null) : null;
			if (s && !stop) {
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
				const from = Number(params.get("from") ?? 0);
				player = new SampleReplay<Sample>(samples, Number.isFinite(from) && from > 0 ? from * 1000 : 0, speed > 0 ? speed : 1);
				setLoaded({ header, player, points: ratePoints(header, samples) });
			})
			.catch(() => !cancelled && setFailed(true));
		return () => {
			cancelled = true;
			player?.stop();
		};
	}, [path]);

	if (failed) return <Boot text="This replay couldn’t be loaded." link />;
	if (!loaded) return <Boot text="Opening the recording…" />;
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
		<main class="boot" aria-busy={!link}>
			<Logo size={34} />
			{link ? (
				<h1 class="boot-text">{text}</h1>
			) : (
				<div class="boot-text" role="status">
					<Spinner />
					{text}
				</div>
			)}
			{link && (
				<a class="btn ghost" href="/">
					See All Airspaces
				</a>
			)}
		</main>
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
	// The clone commands, or why they could not be had.
	const [clone, setClone] = useState<{ commands: string[] } | { error: string } | null>(null);
	const openClone = async () => {
		try {
			const res = await fetch(`/api/c/${slug}/clone`);
			const d = (await res.json().catch(() => ({}))) as { commands?: string[]; error?: string };
			setClone(res.ok && d.commands ? { commands: d.commands } : { error: `The clone commands aren’t available right now${d.error ? ` (${d.error})` : ""}. Try again in a moment.` });
		} catch {
			setClone({ error: "The clone commands couldn’t be loaded. Check your connection and try again." });
		}
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
	useTitle(`${snap.center.name}${replay ? " (replay)" : ""}`);

	return (
		<div class="center-page">
			<header class="topbar">
				<a class="brand" href="/" title="All airspaces" aria-label="Contrail: all airspaces">
					<Logo />
					<span>Contrail</span>
				</a>
				<div class="proj">
					<h1 class="proj-name">{snap.center.name}</h1>
					<div class="proj-sub" title={`The monorepo trunk is at ${snap.head ?? "—"}, composed from ${sectors(snap.sectors.length)} ${n(snap.compositions)} time${snap.compositions === 1 ? "" : "s"}.`}>
						<span class="mono">monorepo @ {snap.head?.slice(0, 8) ?? "—"}</span> · {sectors(snap.sectors.length)} · {n(snap.compositions)} composition{snap.compositions === 1 ? "" : "s"}
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
				{replay && (
					<div class="live replay" title="A recorded run, played back in your browser" role="status">
						{replay.ended ? "Replay ended" : "Replay"}
					</div>
				)}
				<div class="actions">
					{!replay && recording && (
						<a class="btn ghost" href={`/c/${slug}?replay=${recording}&speed=4`} title="Watch the recorded run of every sector">
							<Icon name="play" size={13} />
							Watch the Run
						</a>
					)}
					<button class="btn ghost" onClick={openClone} title="Clone the composed monorepo trunk">
						<Icon name="clone" size={15} />
						Clone Monorepo…
					</button>
				</div>
			</header>
			{replay && <ReplayBar replay={replay} />}

			<main class="wrap center-main" id="main">
				<p class="center-lede">
					Each sector owns one directory of this monorepo and lands through its own runway, so sectors land in parallel. The Center folds every sector’s
					trunk into one monorepo trunk as soon as it moves{snap.composedAt ? `: last composed ${relTime(snap.composedAt, now)}` : ""}
					{snap.behind ? `, ${snap.behind} sector${snap.behind > 1 ? "s" : ""} to fold in` : ""}.{done && span ? ` All ${n(landed)} intents landed in ${duration(span)}.` : ""}
					{replay && sectorHref ? " Open a sector to watch its radar from this moment." : ""}
				</p>
				<h2 class="sr-only">Sectors</h2>
				<div class="sectors">
					{snap.sectors.map((s) => {
						const m = s.summary;
						const pct = m && m.intents ? Math.round((m.landed / m.intents) * 100) : 0;
						return (
							<a key={s.slug} class="sector" href={sectorHref ? sectorHref(s.slug) : `/p/${s.slug}`} title={sectorHref ? `Watch the ${s.name} radar from this moment` : `Open the ${s.name} radar`}>
								<div class="sector-top">
									<span class="sector-name">{s.name}</span>
									<span class="mono sector-prefix" title={s.prefix}>
										{s.prefix}
									</span>
								</div>
								<div class="sector-bar" title={`${pct}% landed`} role="progressbar" aria-label={`${s.name}: intents landed`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
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
				{!replay && snap.crossings?.length > 0 && <Crossings snap={snap} now={now} />}
			</main>

			{clone && (
				<Dialog kicker="Read-only, valid for an hour" title="Clone Monorepo" onClose={() => setClone(null)}>
					<div class="connect">
						<p>The composed trunk: every sector’s directory at its latest landing. Each commit names the sector heads it folded in.</p>
						{"commands" in clone ? (
							<Command text={clone.commands.join("\n")} />
						) : (
							<div class="muted" role="alert">
								{clone.error}
							</div>
						)}
					</div>
				</Dialog>
			)}
		</div>
	);
}

const sectors = (n: number) => `${n} ${n === 1 ? "sector" : "sectors"}`;

/** A crossing's state in a few words, with the status chip's tone. */
function crossingState(cx: Crossing): { label: string; tone: string } {
	// Sectors where its part landed, in this attempt or an earlier one.
	const landed = new Set([...(cx.landedBefore ?? []), ...cx.legs.filter((l) => l.landing?.status === "landed").map((l) => l.name)]).size;
	if (cx.status === "landed") return { label: `Landed in ${sectors(landed)}${cx.inParts ? "" : " at once"}`, tone: "landed" };
	if (cx.status === "aborted") return { label: "Aborted", tone: "aborted" };
	if (cx.landing?.status === "landing") return { label: "Landing", tone: "approach" };
	if (cx.status === "diverted") {
		// Out of the legs that tried to land: a leg that only asked for clearance had nothing to land.
		const tried = new Set([...(cx.landedBefore ?? []), ...cx.legs.filter((l) => l.landing).map((l) => l.name)]).size;
		return { label: landed ? `Landed in ${landed} of ${sectors(tried)}` : "Landed nowhere", tone: "diverted" };
	}
	return { label: "In the air", tone: "airborne" };
}

function legState(leg: CrossingLeg, crossing: Crossing["status"]): { label: string; tone: string } {
	const l = leg.landing;
	// A leg with no landing is flying, unless its flight is over: the crossing was aborted, or landed (in all its sectors
	// or some) without a change here.
	if (!l && leg.closed) return crossing === "aborted" ? { label: "closed", tone: "aborted" } : { label: "no change", tone: "landed" };
	if (!l) return { label: "flying", tone: "airborne" };
	if (l.status === "landed") return { label: `landed ${l.commit?.slice(0, 8) ?? ""}`, tone: "landed" };
	if (l.status === "verifying") return { label: "ready, held", tone: "approach" };
	if (l.status === "merging" || l.status === "queued") return { label: "merging and testing", tone: "approach" };
	if (l.status === "conflict") return { label: "conflict", tone: "diverted" };
	if (l.error === "held back") return { label: "ready, held back", tone: "aborted" };
	if (l.tests && l.tests.failed > 0) return { label: `${l.tests.failed} test${l.tests.failed > 1 ? "s" : ""} failed`, tone: "diverted" };
	return { label: "turned away", tone: "diverted" };
}

/** Changes that span sectors: each flies a leg in every sector it touches and lands in all of them, or in none. */
function Crossings({ snap, now }: { snap: CenterSnapshot; now: number }) {
	const order = (leg: CrossingLeg) => snap.center.sectors.findIndex((s) => s.slug === leg.sector);
	const landed = snap.landedCrossings ?? snap.crossings.filter((cx) => cx.status === "landed").length;
	return (
		<section class="crossings">
			<h2 class="crossings-title" id="crossings">
				Crossings{" "}
				<span class="crossings-count">
					{landed} landed{snap.openIntents ? ` · ${snap.openIntents} waiting for an agent` : ""}
				</span>
			</h2>
			<p class="crossings-lede">
				A crossing is one change across several sectors. It flies a leg in each sector it touches; every sector’s runway merges and tests its part and
				holds it until all of them are ready, then all of them land and the monorepo gets one commit. If one sector turns its part away, none lands.
			</p>
			<div class="crossing-list">
				{snap.crossings.map((cx) => {
					const state = crossingState(cx);
					return (
						<article key={cx.code} class="crossing">
							<div class="crossing-top">
								<span class="mono crossing-code">{cx.code}</span>
								<span class="crossing-title">{cx.intent.title}</span>
								<span class={`st st-${state.tone}`}>{state.label}</span>
							</div>
							<div class="crossing-sub">
								{cx.callsign}
								{cx.model ? ` · ${cx.model}` : ""} · {relTime(cx.landing?.finishedAt ?? cx.updatedAt, now)}
								{cx.attempts > 1 ? ` · ${cx.attempts} landing attempts` : ""}
							</div>
							{cx.landing?.summary && <p class="crossing-summary">{cx.landing.summary}</p>}
							{cx.legs.length > 0 && (
								<div class="crossing-legs">
									{[...cx.legs].sort((a, b) => order(a) - order(b)).map((leg) => {
										const ls = legState(leg, cx.status);
										return (
											<a key={leg.sector} class="crossing-leg" href={`/p/${leg.sector}`} title={leg.landing?.error ? tidy(leg.landing.error) : `Open the ${leg.name} radar`}>
												<span class="crossing-leg-name">{leg.name}</span>
												<span class="mono muted">{leg.flight}</span>
												<span class={`st st-${ls.tone}`}>{ls.label}</span>
											</a>
										);
									})}
								</div>
							)}
							{cx.landing?.status === "failed" && cx.landing.error && <p class="crossing-error">{tidy(cx.landing.error)}</p>}
							{cx.landing?.status === "landed" && cx.landing.commit && <div class="crossing-foot mono">monorepo {cx.landing.commit.slice(0, 8)}</div>}
						</article>
					);
				})}
			</div>
		</section>
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
	// The right margin holds the reference line's label, past the end of the curve.
	const m = { l: 34, r: 76, t: 10, b: 24 };
	const iw = Math.max(1, width - m.l - m.r);
	const ih = H - m.t - m.b;
	const x = (ms: number) => m.l + (total > 0 ? (ms / total) * iw : 0);
	const y = (v: number) => m.t + ih - (v / yMax) * ih;
	const shown = points.filter((p) => p.t <= t);
	const line = shown.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.rate).toFixed(1)}`).join("");
	const area = shown.length > 1 ? `${line}L${x(shown[shown.length - 1].t).toFixed(1)},${y(0)}L${x(shown[0].t).toFixed(1)},${y(0)}Z` : "";
	const end = shown[shown.length - 1];
	// Whole minutes between ticks, at least 56 px apart.
	const minutes = Math.max(1, Math.ceil(total / 60_000 / Math.max(1, Math.floor(iw / 56)))) * 60_000;
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
				<button class="rc-toggle" onClick={() => setTable(!table)}>
					{table ? "Show Chart" : "Show Table"}
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
							<text class="rc-ref-label" x={m.l + iw + 8} y={y(ONE_TRUNK_RATE) + 4}>
								One trunk
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
