import { useState } from "preact/hooks";
import { ACTIVE_STATUSES, useRadar } from "../store";
import { Airspace } from "./Airspace";
import { ConnectModal, FlightDrawer, WhyPanel } from "./Detail";
import { ClonePanel, OperatorPanel } from "./Operator";
import { ReviewInbox } from "./Review";
import { Feed, FlightList, IntentBoard, Runway } from "./Panels";

export function Radar({ slug, fixture }: { slug: string; fixture: string | null }) {
	const s = useRadar(slug, fixture);
	const [tab, setTab] = useState<"live" | "flights" | "intents" | "review">("live");
	const [selected, setSelected] = useState<string | null>(null);
	const [why, setWhy] = useState<string | null>(null);
	const [connect, setConnect] = useState(false);
	const [operator, setOperator] = useState(false);
	const [clone, setClone] = useState(false);

	if (!s.ready) {
		return (
			<div class="boot">
				<div class="boot-sweep" />
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
				<a class="brand" href="/">
					<svg viewBox="0 0 32 32" class="logo">
						<path d="M3 23 C 11 21, 15 15, 21 10" stroke="#5eead4" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".6" />
						<path d="M6 27 C 13 25, 18 19, 23 14" stroke="#5eead4" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".3" />
						<path d="M27 5 l-4 8 -5 -2 z" fill="#e2e8f0" />
					</svg>
					<span>Contrail</span>
				</a>
				<div class="proj">
					<div class="proj-name">{s.project?.name}</div>
					<div class="proj-sub mono">
						trunk {s.trunk.head?.slice(0, 8) ?? "—"} · {s.project?.trunkRepo}
					</div>
				</div>
				<div class="stats">
					<Stat label="in the air" value={airborne} accent="#5eead4" />
					<Stat label="holding" value={holding} accent="#fbbf24" />
					<Stat label="landed" value={s.stats.landings} accent="#4ade80" />
					<Stat label="intents done" value={`${landedIntents}/${intents.length}`} />
					<Stat label="collisions avoided" value={s.stats.conflictsPrevented} accent="#fbbf24" />
					<Stat label="planned around" value={s.stats.planned ?? 0} accent="#38bdf8" />
					<Stat label="auto-merged" value={s.stats.unioned} accent="#a78bfa" />
					<Stat label="Artifacts repos" value={s.stats.repos} accent="#f97316" />
				</div>
				<div class={`live ${s.connected ? "on" : ""}`}>{fixture || new URLSearchParams(location.search).has("replay") ? "replay" : s.connected ? "live" : "reconnecting"}</div>
				{s.project?.playground && <LaunchButton slug={slug} />}
				<button class="btn ghost" onClick={() => setClone(true)} title="Clone trunk with its contrail notes">
					Clone trunk
				</button>
				<button class="btn" onClick={() => setConnect(true)}>
					Connect an agent
				</button>
				<button class="icon-btn" onClick={() => setOperator(true)} title="Operator">
					⚙
				</button>
			</header>

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
						{tab === "live" && <Feed events={s.events} flights={s.flights} agents={s.agents} onSelect={setSelected} />}
						{tab === "flights" && <FlightList flights={s.flights} agents={s.agents} intents={s.intents} onSelect={setSelected} />}
						{tab === "intents" && <IntentBoard intents={s.intents} flights={s.flights} agents={s.agents} onSelect={setSelected} />}
						{tab === "review" && <ReviewInbox slug={slug} landings={s.landings} flights={s.flights} agents={s.agents} intents={s.intents} onSelect={setSelected} />}
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
			{msg ?? "⚡ Launch edge agents"}
		</button>
	);
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: string }) {
	return (
		<div class="stat">
			<div class="stat-v" style={accent ? { color: accent } : undefined}>
				{value}
			</div>
			<div class="stat-l">{label}</div>
		</div>
	);
}
