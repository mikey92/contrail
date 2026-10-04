import { useEffect, useState } from "preact/hooks";
import type { Agent, Clearance, ContrailEntry, Flight, Intent, Landing } from "../../../src/shared/types";
import { relTime } from "../store";
import { Diff } from "./Review";

interface FlightDetail {
	flight: Flight;
	agent: Agent;
	intent: Intent;
	clearances: Clearance[];
	contrail: ContrailEntry[];
	landings: Landing[];
}

const KIND_LABEL: Record<string, string> = {
	intent: "Intent",
	plan: "Plan",
	decision: "Decision",
	note: "Note",
	radio: "Radio",
	clearance: "Clearance",
	landing: "Landed",
	conflict: "Conflict",
	test: "Tests",
	handoff: "Handoff",
};

async function load(slug: string, fixture: string | null, ref: string, code: string | undefined) {
	const url = fixture ? `/fixtures/${fixture}.${code}.json` : `/api/p/${slug}/flights/${encodeURIComponent(ref)}`;
	const res = await fetch(url);
	if (!res.ok) throw new Error("not available");
	return (await res.json()) as FlightDetail;
}

export function FlightDrawer({
	slug,
	fixture,
	flightId,
	flight,
	liveContrail,
	landings,
	onClose,
	onWhy,
}: {
	slug: string;
	fixture: string | null;
	flightId: string;
	flight: Flight | undefined;
	liveContrail: ContrailEntry[];
	landings: Record<string, Landing>;
	onClose: () => void;
	onWhy: (t: string) => void;
}) {
	const [detail, setDetail] = useState<FlightDetail | null>(null);
	const [error, setError] = useState<string | null>(null);
	const version = `${flight?.status}-${flight?.updatedAt}-${liveContrail.filter((c) => c.flightId === flightId).length}`;

	useEffect(() => {
		let cancelled = false;
		load(slug, fixture, flightId, flight?.code)
			.then((d) => !cancelled && (setDetail(d), setError(null)))
			.catch((e) => !cancelled && setError(String(e.message ?? e)));
		return () => {
			cancelled = true;
		};
	}, [flightId, version]);

	if (error && !detail) {
		return (
			<aside class="drawer">
				<button class="close" onClick={onClose}>
					×
				</button>
				<div class="empty">{error}</div>
			</aside>
		);
	}
	if (!detail) return <aside class="drawer loading">Loading flight…</aside>;
	const { agent, intent, clearances, contrail } = detail;
	const f = flight ?? detail.flight;
	const flightLandings = Object.values(landings)
		.filter((l) => l.flightId === flightId)
		.sort((a, b) => a.seq - b.seq);
	const allLandings = flightLandings.length ? flightLandings : detail.landings;

	return (
		<aside class="drawer">
			<button class="close" onClick={onClose}>
				×
			</button>
			<div class="d-head" style={{ "--c": agent.color } as any}>
				<div class="d-callsign">
					<span class="dot big" style={{ background: agent.color }} />
					{agent.callsign} <span class="mono muted">{f.code}</span>
					<span class={`st st-${f.status}`}>{f.status}</span>
				</div>
				<div class="d-model muted">
					{agent.model ?? agent.kind} · workspace <span class="mono">{f.repo}</span>
				</div>
				<div class="d-intent">
					<span class="mono muted">INT-{intent.seq}</span> {intent.title}
				</div>
				{intent.body && <div class="d-body">{intent.body}</div>}
			</div>

			{clearances.length > 0 && (
				<section>
					<h4>Clearances</h4>
					<div class="chips">
						{clearances.map((c) => (
							<span key={c.id} class={`chip ${c.status}`} onClick={() => onWhy(c.target)}>
								{c.status === "holding" ? "⏳ " : "✓ "}
								{c.target}
							</span>
						))}
					</div>
				</section>
			)}

			{allLandings.map((l) => (
				<section key={l.id} class={`landing ${l.status}`}>
					<h4>
						Landing #{l.seq} · <span class={`lst lst-${l.status}`}>{l.status}</span>
						{l.trunkAfter && <span class="mono muted"> {l.trunkAfter.slice(0, 8)}</span>}
					</h4>
					<div class="summary">{l.summary}</div>
					{l.changes.length > 0 && (
						<div class="changes">
							{l.changes.map((c) => (
								<div key={c.path} class="change">
									<span class={`cst cst-${c.status}`}>{c.status[0].toUpperCase()}</span>
									<span class="mono">{c.path}</span>
									<span class="syms">{c.symbols.map((s) => <span key={s} class="sym" onClick={() => onWhy(`${c.path}#${s}`)}>{s}</span>)}</span>
									<span class="plus">+{c.additions}</span>
									<span class="minus">−{c.deletions}</span>
								</div>
							))}
							<details class="diffs">
								<summary>Show diff</summary>
								{l.changes.map((c) => (
									<div key={c.path}>
										<div class="mono muted diff-file">{c.path}</div>
										<Diff change={c} />
									</div>
								))}
							</details>
						</div>
					)}
					{l.review && (
						<div class={`reviewnote ${l.review.decision ?? "pending"}`}>
							{l.review.decision ? `${l.review.decision === "approved" ? "Approved" : "Changes requested"} by ${l.review.reviewer}${l.review.comment ? `: ${l.review.comment}` : ""}` : `Waiting for a human: ${l.review.required.join(", ")}`}
						</div>
					)}
					{l.conflicts.map((c) => (
						<div key={c.path} class="conflict">
							<div class="conflict-head">
								⚠ {c.kind} conflict in <span class="mono">{c.path}</span>
								{c.causedBy.length > 0 && (
									<span>
										{" "}
										— trunk was changed by {c.causedBy.map((b) => `${b.callsign} ${b.code} (${b.intent})`).join(", ")}
									</span>
								)}
							</div>
							{c.hunks.slice(0, 3).map((h, i) => (
								<div key={i} class="hunk">
									<div class="hunk-meta mono">
										line {h.baseStart} · {h.symbols.join(", ")}
									</div>
									<pre class="ours">{h.ours.map((l) => `trunk  │ ${l}`).join("\n")}</pre>
									<pre class="theirs">{h.theirs.map((l) => `flight │ ${l}`).join("\n")}</pre>
								</div>
							))}
						</div>
					))}
					{l.tests && (
						<div class={`tests ${l.tests.failed ? "bad" : "good"}`}>
							Tests in a Dynamic Worker: {l.tests.passed} passed{l.tests.failed ? `, ${l.tests.failed} failed` : ""} · {l.tests.ms}ms
							{l.tests.results
								.filter((r) => !r.ok)
								.slice(0, 5)
								.map((r) => (
									<div key={r.name} class="mono fail">
										✖ {r.file} › {r.name}: {r.error}
									</div>
								))}
							{l.tests.error && <div class="mono fail">{l.tests.error}</div>}
						</div>
					)}
					{l.error && !l.tests?.failed && <div class="mono fail">{l.error}</div>}
				</section>
			))}

			<section>
				<h4>Contrail</h4>
				<div class="timeline">
					{contrail.map((e) => (
						<div key={e.id} class={`tl tl-${e.kind}`}>
							<div class="tl-kind">{KIND_LABEL[e.kind] ?? e.kind}</div>
							<div class="tl-text">{e.text}</div>
							<div class="tl-at muted">{relTime(e.at)}</div>
						</div>
					))}
				</div>
			</section>
		</aside>
	);
}

interface WhyResult {
	target: string;
	history: { commit: string; when: string; flight: string; agent: string; model: string | null; intent: string; intentBody: string; summary: string; plan: string | null; decisions: string[] }[];
	note?: string;
}

export function WhyPanel({ slug, fixture, target, onClose }: { slug: string; fixture: string | null; target: string; onClose: () => void }) {
	const [data, setData] = useState<WhyResult | null>(null);
	useEffect(() => {
		const [path, symbol] = target.split("#");
		const url = fixture ? `/fixtures/${fixture}.why.json` : `/api/p/${slug}/why?path=${encodeURIComponent(path)}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ""}`;
		setData(null);
		fetch(url)
			.then((r) => r.json())
			.then(setData);
	}, [target]);
	return (
		<div class="why-backdrop" onClick={onClose}>
			<div class="why" onClick={(e) => e.stopPropagation()}>
				<button class="close" onClick={onClose}>
					×
				</button>
				<div class="why-kicker">why()</div>
				<h3 class="mono">{target}</h3>
				{!data && <div class="muted">Reading the contrail…</div>}
				{data?.note && <div class="muted">{data.note}</div>}
				{data?.history.map((h) => (
					<div key={h.commit} class="why-item">
						<div class="why-top">
							<span class="mono sha">{h.commit}</span>
							<b>{h.intent}</b>
						</div>
						<div class="muted">
							{h.agent} {h.model ? `(${h.model})` : ""} · {h.flight} · {new Date(h.when).toLocaleString()}
						</div>
						<div class="why-summary">{h.summary}</div>
						{h.plan && (
							<div class="why-plan">
								<span class="lbl">Plan</span> {h.plan}
							</div>
						)}
						{h.decisions.map((d, i) => (
							<div key={i} class="why-dec">
								<span class="lbl">Decision</span> {d}
							</div>
						))}
					</div>
				))}
			</div>
		</div>
	);
}

export function ConnectModal({ slug, onClose }: { slug: string; onClose: () => void }) {
	const origin = location.origin;
	return (
		<div class="why-backdrop" onClick={onClose}>
			<div class="why connect" onClick={(e) => e.stopPropagation()}>
				<button class="close" onClick={onClose}>
					×
				</button>
				<div class="why-kicker">Join the airspace</div>
				<h3>Connect a coding agent</h3>
				<p>Any MCP-capable agent can fly in this project. Get an agent key with the project's join code, then add the MCP server:</p>
				<pre class="code">{`curl -s ${origin}/api/p/${slug}/join \\
  -H 'content-type: application/json' \\
  -d '{"joinCode":"<join code>","kind":"claude-code","model":"claude"}'`}</pre>
				<pre class="code">{`claude mcp add --transport http contrail ${origin}/mcp/${slug} \\
  --header "Authorization: Bearer <agent key>"`}</pre>
				<p class="muted">Then tell the agent: “Use the contrail tools: take_off, follow the flight protocol, and keep taking off until there are no open intents.”</p>
			</div>
		</div>
	);
}
