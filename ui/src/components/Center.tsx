import { useEffect, useRef, useState } from "preact/hooks";
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
	const [loaded, setLoaded] = useState<{ header: Header; player: SampleReplay<Sample> } | null>(null);
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
				setLoaded({ header, player });
			})
			.catch(() => !cancelled && setFailed(true));
		return () => {
			cancelled = true;
			player?.stop();
		};
	}, [path]);

	if (failed) return <Boot text="This replay could not be loaded." link />;
	if (!loaded) return <Boot text="Loading the recording…" />;
	const { header, player } = loaded;
	const x = player.current;
	const snap = toSnapshot(header, x);
	// Landings over the last 30 s of recording time.
	const before = player.at(Math.max(player.start, player.t - 30_000));
	const rate = x.t > before.t ? ((landedIn(snap) - landedIn(toSnapshot(header, before))) * 1000) / (x.t - before.t) : 0;
	// Each sector's own radar replay, recorded on the same clock: open it at this moment.
	const streams = header.sectorStreams ? path.replace(/\.jsonl(\.gz)?$/, "") : null;
	const sectorHref = streams ? (sector: string) => `/p/${sector}?replay=${streams}/${sector}.jsonl.gz&from=${Math.floor(player.t / 1000)}&speed=${player.speed}` : undefined;
	return <CenterView slug={slug} snap={snap} rate={rate} now={x.at + (player.t - x.t)} replay={player} sectorHref={sectorHref} />;
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
}: {
	slug: string;
	snap: CenterSnapshot;
	rate: number;
	now: number;
	replay?: SampleReplay<Sample>;
	sectorHref?: (sector: string) => string;
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
