import { useEffect, useState } from "preact/hooks";
import { ACTIVE_STATUSES, duration, type RadarState, useRadar, useReplay } from "../store";
import { Airspace } from "./Airspace";
import { Icon, Logo } from "./Icons";
import { ConnectModal, FlightDrawer, WhyPanel } from "./Detail";
import { ClonePanel, OperatorPanel } from "./Operator";
import { ReplayBar } from "./ReplayBar";
import { ReviewInbox } from "./Review";
import { Feed, FlightList, IntentBoard, Runway } from "./Panels";

export function Radar({ slug, fixture }: { slug: string; fixture: string | null }) {
	const { state: s, replay } = useRadar(slug, fixture);
	const [tab, setTab] = useState<"live" | "flights" | "intents" | "review">("live");
	const [selected, setSelected] = useState<string | null>(null);
	const [why, setWhy] = useState<string | null>(null);
	const [connect, setConnect] = useState(false);
	const [operator, setOperator] = useState(false);
	const [clone, setClone] = useState(false);
	const ended = useReplay(replay, (r) => r.ended);
	const [endCard, setEndCard] = useState(true);
	// A recorded run (or a fixture): nothing on screen is happening now, and nothing can be decided here.
	const recorded = fixture !== null || new URLSearchParams(location.search).has("replay");

	// Escape closes the topmost thing that is open: a dialog first, then the flight drawer.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			if (why) setWhy(null);
			else if (connect) setConnect(false);
			else if (operator) setOperator(false);
			else if (clone) setClone(false);
			else if (selected) setSelected(null);
		};
		addEventListener("keydown", onKey);
		return () => removeEventListener("keydown", onKey);
	}, [why, connect, operator, clone, selected]);

	// A closed end card comes back the next time the replay ends.
	useEffect(() => {
		if (!ended) setEndCard(true);
	}, [ended]);

	if (s.failed) {
		return (
			<div class="boot">
				<Logo size={34} />
				<div>This replay could not be loaded.</div>
				<a class="btn ghost" href="/">
					See all airspaces
				</a>
			</div>
		);
	}
	if (s.missing) {
		return (
			<div class="boot">
				<Logo size={34} />
				<div>
					There is no public airspace called <span class="mono">{slug}</span>.
				</div>
				<a class="btn ghost" href="/">
					See all airspaces
				</a>
			</div>
		);
	}
	if (!s.ready) {
		return (
			<div class="boot">
				<Logo size={34} />
				<div>Contacting the tower…</div>
			</div>
		);
	}

	const flights = Object.values(s.flights);
	const airborne = flights.filter((f) => ACTIVE_STATUSES.includes(f.status)).length;
	const holding = flights.filter((f) => f.status === "holding").length;
	const intents = Object.values(s.intents);
	const landedIntents = intents.filter((i) => i.status === "landed").length;
	const reviews = Object.values(s.landings).filter((l) => l.status === "review").length;

	return (
		<div class="radar">
			<header class="topbar">
				<a class="brand" href="/" title="All airspaces">
					<Logo />
					<span>Contrail</span>
				</a>
				<div class="proj">
					<div class="proj-name">{s.project?.name}</div>
					<div class="proj-sub" title={`Trunk is at ${s.trunk.head ?? "—"}. ${s.stats.repos} Artifacts repositories (trunk and one per flight). ${s.stats.unioned} parallel inserts merged automatically.`}>
						<span class="mono">main @ {s.trunk.head?.slice(0, 8) ?? "—"}</span> · {s.stats.repos} Artifacts repos · {s.stats.unioned} auto-merged
					</div>
				</div>
				<div class="stats">
					<Stat label="In the air" value={airborne} tone="air" title="Agents working on an intent right now, including those holding or landing." />
					<Stat label="Holding" value={holding} tone="hold" title="Agents waiting for code that another agent is cleared to change." />
					<Stat label="Landed" value={`${landedIntents}/${intents.length}`} tone="ok" title="Intents whose change has landed on main, out of all intents." />
					<Stat
						label="Collisions avoided"
						value={s.stats.conflictsPrevented}
						tone="hold"
						title="Times an agent was put in a holding pattern before writing code that would have collided with another agent's."
					/>
					<Stat label="Planned around" value={s.stats.planned ?? 0} tone="plan" title="Take-offs the tower routed to other work because that code was already in the air." />
				</div>
				{recorded ? (
					<div class="live replay" title="A recorded run, played back in your browser">
						{ended ? "Replay ended" : "Replay"}
					</div>
				) : (
					<div class={`live ${s.connected ? "on" : ""}`}>{s.connected ? "Live" : "Reconnecting"}</div>
				)}
				{s.project?.playground && <LaunchButton slug={slug} />}
				<button class="btn ghost" onClick={() => setClone(true)} title="Clone trunk with its contrail notes">
					Clone trunk
				</button>
				<button class="btn" onClick={() => setConnect(true)}>
					Connect an agent
				</button>
				<button class="icon-btn" onClick={() => setOperator(true)} title="Operator">
					<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
						<circle cx="3.5" cy="8" r="1.3" fill="currentColor" />
						<circle cx="8" cy="8" r="1.3" fill="currentColor" />
						<circle cx="12.5" cy="8" r="1.3" fill="currentColor" />
					</svg>
				</button>
			</header>
			{replay && <ReplayBar replay={replay} />}

			<main class="main">
				<section class="sky">
					<Airspace
						files={s.trunk.files}
						clearances={s.clearances}
						flights={s.flights}
						agents={s.agents}
						intents={s.intents}
						flashes={s.flashes}
						selected={selected}
						onSelect={setSelected}
						onWhy={setWhy}
					/>
					<Runway landings={s.landings} flights={s.flights} agents={s.agents} intents={s.intents} onSelect={setSelected} />
					{replay && ended && endCard && <EndCard s={s} slug={slug} onRestart={() => replay.restart()} onClose={() => setEndCard(false)} />}
				</section>
				<section class="side">
					<nav class="tabs">
						<button class={tab === "live" ? "on" : ""} onClick={() => setTab("live")}>
							Live
						</button>
						<button class={tab === "flights" ? "on" : ""} onClick={() => setTab("flights")}>
							Flights <span class="count">{airborne}</span>
						</button>
						<button class={tab === "intents" ? "on" : ""} onClick={() => setTab("intents")}>
							Intents <span class="count">{intents.length - landedIntents}</span>
						</button>
						<button class={`${tab === "review" ? "on" : ""} ${reviews ? "attn" : ""}`} onClick={() => setTab("review")}>
							Review <span class="count">{reviews}</span>
						</button>
					</nav>
					<div class="tab-body">
						{tab === "live" && <Feed events={s.events} keyEvents={s.keyEvents} routine={s.routine} flights={s.flights} agents={s.agents} onSelect={setSelected} />}
						{tab === "flights" && <FlightList flights={s.flights} agents={s.agents} intents={s.intents} onSelect={setSelected} />}
						{tab === "intents" && <IntentBoard intents={s.intents} flights={s.flights} agents={s.agents} onSelect={setSelected} />}
						{tab === "review" && (
							<ReviewInbox slug={slug} recorded={recorded} landings={s.landings} flights={s.flights} agents={s.agents} intents={s.intents} onSelect={setSelected} />
						)}
					</div>
					{selected && (
						<FlightDrawer
							slug={slug}
							fixture={fixture}
							flightId={selected}
							flight={s.flights[selected]}
							liveContrail={s.contrail}
							landings={s.landings}
							onClose={() => setSelected(null)}
							onWhy={setWhy}
						/>
					)}
				</section>
			</main>
			{why && <WhyPanel slug={slug} fixture={fixture} target={why} onClose={() => setWhy(null)} />}
			{connect && <ConnectModal slug={slug} onClose={() => setConnect(false)} />}
			{operator && <OperatorPanel slug={slug} onClose={() => setOperator(false)} />}
			{clone && <ClonePanel slug={slug} onClose={() => setClone(false)} />}
		</div>
	);
}

function LaunchButton({ slug }: { slug: string }) {
	const [msg, setMsg] = useState<string | null>(null);
	const launch = async () => {
		setMsg("launching…");
		const res = await fetch(`/api/p/${slug}/edge/launch`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ count: 3 }) });
		const d = await res.json().catch(() => ({}));
		setMsg(res.ok ? `${d.launched?.length ?? 0} agents airborne` : (d.error ?? "busy"));
		setTimeout(() => setMsg(null), 6000);
	};
	return (
		<button class="btn launch" onClick={launch} title="Spawn edge agents (Durable Objects reasoning on Workers AI)">
			<Icon name="bolt" size={14} />
			{msg ?? "Launch edge agents"}
		</button>
	);
}

/** Over the map when a replay has played to its end: what the run achieved, and where to go next. */
function EndCard({ s, slug, onRestart, onClose }: { s: RadarState; slug: string; onRestart: () => void; onClose: () => void }) {
	const intents = Object.values(s.intents);
	const landed = intents.filter((i) => i.status === "landed").length;
	const flights = Object.values(s.flights);
	// From the first agent joining to the last landing, to the nearest second.
	const first = Math.min(...Object.values(s.agents).map((a) => a.joinedAt), ...flights.map((f) => f.createdAt));
	const last = Math.max(...flights.map((f) => f.landedAt ?? 0));
	const avoided = s.stats.conflictsPrevented;
	const summary =
		`${landed} of ${intents.length} ${intents.length === 1 ? "intent" : "intents"} landed` +
		(landed && last > first ? ` in ${duration(Math.round((last - first) / 1000) * 1000)}` : "") +
		(avoided ? `, ${avoided} ${avoided === 1 ? "collision" : "collisions"} avoided` : "") +
		".";
	return (
		<div class="endcard-wrap">
			<div class="endcard" role="dialog" aria-label="Replay finished">
				<button class="close" onClick={onClose} title="Close" aria-label="Close">
					×
				</button>
				<h3>Replay finished</h3>
				<p>{summary}</p>
				<div class="row">
					<button class="btn" onClick={onRestart}>
						<Icon name="release" size={14} />
						Watch again
					</button>
					<a class="btn ghost" href={`/p/${slug}`}>
						Open the live airspace
					</a>
				</div>
			</div>
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
