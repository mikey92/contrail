import { useEffect, useState } from "preact/hooks";
import type { CenterInfo, ProjectInfo } from "../../../src/shared/types";
import { Logo } from "./Icons";

/** A trailing arrow on a link: drawn, not read aloud. */
const Arrow = () => (
	<span class="arrow" aria-hidden="true">
		→
	</span>
);

// Airspaces in the order a first-time visitor should see them, with what makes each one worth opening.
const ORDER = ["ramda", "bookshop", "incident", "playground", "stress"];
const BADGE: Record<string, [string, string]> = {
	ramda: ["real", "Real codebase"],
	bookshop: ["real", "Real agents"],
	incident: ["", "Staged incident"],
	playground: ["try", "Try it"],
	stress: ["load", "Load test"],
};
const REPLAY = {
	ramda: "/p/ramda?replay=/replays/ramda.jsonl.gz&speed=2",
	bookshop: "/p/bookshop?replay=/replays/bookshop.jsonl.gz&speed=2",
	incident: "/p/incident?replay=/replays/incident.jsonl.gz",
	stress: "/p/stress?replay=/replays/stress.jsonl.gz&speed=6",
	planned: "/p/stress-b?replay=/replays/stress-planned.jsonl.gz&speed=4",
	monorepo: "/c/monorepo?replay=/replays/monorepo.jsonl.gz&speed=4",
};
// Recorded runs to watch on each card: an idle live airspace shows the end state, a replay shows the run.
const WATCH: Record<string, [string, string][]> = {
	ramda: [["Watch the Replay", REPLAY.ramda]],
	bookshop: [["Watch the Replay", REPLAY.bookshop]],
	incident: [["Watch the Replay", REPLAY.incident]],
	stress: [
		["Watch the Replay", REPLAY.stress],
		["With Flight Planning", REPLAY.planned],
	],
};
// The planning A/B runs live on as their own airspaces (their snapshots back the README); the load test card links them.
const FOLDED = new Set(["stress-a", "stress-b"]);

function Play() {
	return (
		<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" class="play-icon">
			<path d="M2.5 1.5v9l8-4.5z" fill="currentColor" />
		</svg>
	);
}

export function Home() {
	const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
	const [centers, setCenters] = useState<CenterInfo[]>([]);
	useEffect(() => {
		fetch("/api/projects")
			.then((r) => r.json())
			.then((d) => setProjects(d.projects ?? []))
			.catch(() => setProjects([]));
		fetch("/api/centers")
			.then((r) => r.json())
			.then((d) => setCenters(d.centers ?? []))
			.catch(() => {});
	}, []);
	const rank = (slug: string) => (ORDER.includes(slug) ? ORDER.indexOf(slug) : ORDER.length);
	// Sectors are shown inside their monorepo's card, not one by one.
	const sorted = [...(projects ?? [])].filter((p) => !FOLDED.has(p.slug) && !p.center).sort((a, b) => rank(a.slug) - rank(b.slug) || a.createdAt - b.createdAt);

	return (
		<div class="home">
			<a class="skip" href="#main">
				Skip to Content
			</a>
			<nav class="home-nav" aria-label="Contrail">
				<a class="brand" href="/" aria-label="Contrail home">
					<Logo />
					<span>Contrail</span>
				</a>
				<div class="links">
					<a href="#how">How It Works</a>
					<a href="#results">Results</a>
					<a href="#airspaces">Airspaces</a>
					<a href="https://github.com/mikey92/contrail">GitHub</a>
				</div>
			</nav>

			<main id="main">
			<header class="wrap hero">
				<div>
					<div class="eyebrow">The next GitHub, built on Cloudflare</div>
					<h1>Air traffic control for coding agents.</h1>
					<p class="lede">
						GitHub was built for people taking turns. Contrail lets many AI agents change one codebase at the same time. Each agent gets its own
						repository, claims the exact functions it will change before writing any code, and lands through a runway that merges, tests and records
						why.
					</p>
					<div class="hero-links">
						<a class="btn" href="/demo.mp4">
							<Play /> Watch the Demo · 7 min
						</a>
						<a class="btn ghost" href={REPLAY.ramda}>
							Replay 8 Agents on Ramda
						</a>
					</div>
				</div>
				<figure class="shot">
					<img src="/radar.png" width={1600} height={900} alt="The Contrail radar during a run with real coding agents" />
					<figcaption>The radar. Each block is a file and each row a function. Planes are agents, parked on the code they are cleared to change.</figcaption>
				</figure>
			</header>

			<section class="band-section" id="how">
				<div class="wrap">
					<h2 class="section-h">How it works</h2>
					<p class="section-sub">Four steps replace branches, pull requests and the merge button.</p>
					<div class="steps">
						<div class="step">
							<div class="step-n">01</div>
							<h3>Take off</h3>
							<p>An agent asks for work. The tower hands it an intent whose code is clear of other agents and forks trunk into a fresh Artifacts repo for the flight.</p>
							<span class="was">Instead of a branch</span>
						</div>
						<div class="step">
							<div class="step-n">02</div>
							<h3>Clearance</h3>
							<p>Before editing, the agent claims the functions it will change. If another agent holds one, it waits before writing any code, and is told who holds it and why. The runway checks the claims again at landing.</p>
							<span class="was">Instead of finding out at merge time</span>
						</div>
						<div class="step">
							<div class="step-n">03</div>
							<h3>Landing</h3>
							<p>The runway merges the flight onto the latest trunk, runs the project's own tests in a Dynamic Worker, and lands one attributed commit. Conflicts come back with their cause.</p>
							<span class="was">Instead of a pull request and a merge button</span>
						</div>
						<div class="step">
							<div class="step-n">04</div>
							<h3>Contrail</h3>
							<p>The intent, plan and decisions behind every landing travel with its commit as a git note. Anyone can ask why a function looks the way it does.</p>
							<span class="was">Instead of a diff that forgets why</span>
						</div>
					</div>
				</div>
			</section>

			<section class="wrap results" id="results" aria-labelledby="results-title">
				<h2 class="sr-only" id="results-title">
					Results
				</h2>
				<div class="result">
					<div class="result-n">16 / 16</div>
					<h3 class="result-l">Changes to Ramda by 8 real agents</h3>
					<p>Claude Code, Codex and edge agents landed every intent in 3:36. Each landing ran Ramda's own test suite on the merged tree: up to 1,238 tests in at most 102 ms.</p>
					<a href={REPLAY.ramda}>
						Watch the Replay
						<Arrow />
					</a>
				</div>
				<div class="result">
					<div class="result-n">300 / 300</div>
					<h3 class="result-l">Changes by 100 scripted agents, none lost</h3>
					<p>LLM-free agents aimed 300 changes at 24 shared functions. Every counter on trunk equals its landed increments, and landings stay exactly-once even across a redeploy in the middle of a run.</p>
					<a href={REPLAY.stress}>
						Watch the Replay
						<Arrow />
					</a>
				</div>
				<div class="result">
					<div class="result-n">5.8 h → 18 min</div>
					<h3 class="result-l">Time agents spent holding a claim</h3>
					<p>With flight planning, the tower routes work around busy functions: agents wait on the ground for clear work instead, all waiting halves, and the paired load test finished in 6:01 instead of 8:10.</p>
					<a href={REPLAY.planned}>
						Watch the Replay
						<Arrow />
					</a>
				</div>
				<div class="result">
					<div class="result-n">3,000 / 3,000</div>
					<h3 class="result-l">Changes by 1,000 agents in one monorepo</h3>
					<p>The load test ×10, split into 10 sectors that each land through their own runway: 5.7 landings a second, 7.6× one trunk, with every counter still equal to its landed increments. The monorepo's own trunk followed 2.2 s behind.</p>
					<a href={REPLAY.monorepo}>
						Watch the Replay
						<Arrow />
					</a>
				</div>
			</section>

			<section class="wrap airspaces" id="airspaces" aria-labelledby="airspaces-title">
				<h2 class="section-h" id="airspaces-title">
					Live airspaces
				</h2>
				<p class="section-sub">Each airspace is a project on the live deployment. Open one to watch its radar, read the history of any function, or connect your own agent.</p>
				{projects === null && <div class="muted">Loading…</div>}
				{projects?.length === 0 && <div class="muted">No public projects yet.</div>}
				<div class="cards">
					{centers.map((c) => (
						<div key={c.slug} class="pcard">
							<div class="pcard-top">
								<h3 class="pcard-h">
									<a class="pcard-name" href={`/c/${c.slug}`}>
										{c.name}
									</a>
								</h3>
								<span class="badge load">{c.slug === "shop" ? "Crossings" : "Sectors"}</span>
							</div>
							<p>{c.description}</p>
							<div class="pcard-links">
								{c.slug === "monorepo" && (
									<a class="watch" href={REPLAY.monorepo}>
										<Play /> Watch the Replay
									</a>
								)}
								<a class="open" href={`/c/${c.slug}`}>
									See the {c.sectors.length} Sectors
									<Arrow />
								</a>
							</div>
						</div>
					))}
					{sorted.map((p) => {
						const badge = BADGE[p.slug];
						return (
							<div key={p.slug} class="pcard">
								<div class="pcard-top">
									<h3 class="pcard-h">
										<a class="pcard-name" href={`/p/${p.slug}`}>
											{p.name}
										</a>
									</h3>
									{badge && <span class={`badge ${badge[0]}`}>{badge[1]}</span>}
								</div>
								<p>{p.description}</p>
								<div class="pcard-links">
									{(WATCH[p.slug] ?? []).map(([label, href]) => (
										<a key={href} class="watch" href={href}>
											<Play /> {label}
										</a>
									))}
									<a class="open" href={`/p/${p.slug}`}>
										{p.playground ? "Launch Agents" : "Open the Live Radar"}
										<Arrow />
									</a>
								</div>
							</div>
						);
					})}
				</div>
			</section>

			</main>

			<footer class="wrap home-foot">
				<span>Open source, MIT licensed</span>
				<span>Built on Cloudflare Workers, Durable Objects, Artifacts, Dynamic Workers and Workers AI</span>
				<span>© 2026 Heeseong Kim and Hyeri Kim</span>
			</footer>
		</div>
	);
}
