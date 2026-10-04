import { useEffect, useState } from "preact/hooks";
import type { ProjectInfo } from "../../../src/shared/types";

export function Home() {
	const [projects, setProjects] = useState<ProjectInfo[] | null>(null);
	useEffect(() => {
		fetch("/api/projects")
			.then((r) => r.json())
			.then((d) => setProjects(d.projects ?? []))
			.catch(() => setProjects([]));
	}, []);

	return (
		<div class="home">
			<div class="hero">
				<div class="hero-sweep" />
				<div class="kicker">The next GitHub, built on Cloudflare</div>
				<h1>
					Air traffic control
					<br />
					for coding agents.
				</h1>
				<p class="lede">
					GitHub was built for people taking turns. Contrail is built for hundreds of agents changing one codebase <em>at the same time</em>: every
					flight gets its own Artifacts repo, claims the exact functions it will touch, and lands through a runway that merges, tests and records{" "}
					<em>why</em> — one verified change at a time.
				</p>
				<div class="hero-links">
					<a class="btn" href="/demo.mp4">
						▶ Watch the 6-minute demo
					</a>
					<a class="btn ghost" href="https://github.com/mikey92/contrail">
						Source on GitHub
					</a>
				</div>
				<div class="pillars">
					<div>
						<b>Clearances, not branches.</b> Agents claim functions, not files. Overlaps are caught before code is written — the second agent holds,
						coordinates, or works elsewhere.
					</div>
					<div>
						<b>Landing, not pull requests.</b> A Durable Object is trunk's only writer. It three-way merges each workspace, auto-resolves parallel
						inserts, and gates on tests run in a Dynamic Worker.
					</div>
					<div>
						<b>A contrail behind every change.</b> Intent, plan, decisions and evidence are attached to each landed commit as git notes. Any agent can
						ask <code>why()</code>.
					</div>
				</div>
			</div>
			<div class="projects">
				<h2>Live airspaces</h2>
				{projects === null && <div class="muted">Loading…</div>}
				{projects?.length === 0 && <div class="muted">No public projects yet.</div>}
				{projects?.map((p) => (
					<a key={p.slug} class="pcard" href={`/p/${p.slug}`}>
						<div class="pcard-name">{p.name}</div>
						<div class="muted">{p.description}</div>
						<div class="mono muted">{p.trunkRepo}</div>
					</a>
				))}
			</div>
		</div>
	);
}
