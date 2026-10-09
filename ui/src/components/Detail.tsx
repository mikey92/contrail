import { useEffect, useState } from "preact/hooks";
import type { Agent, Clearance, ContrailEntry, Flight, Intent, Landing } from "../../../src/shared/types";
import { relTime, statusLabel, tidy, toned } from "../store";
import { Dialog } from "./Dialog";
import { Icon, Spinner } from "./Icons";
import { AiReviewNote, Diff } from "./Review";

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
	const detail = (await res.json()) as FlightDetail;
	return { ...detail, agent: toned(detail.agent) };
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
			.catch(() => !cancelled && setError("This flight’s details aren’t available."));
		return () => {
			cancelled = true;
		};
	}, [flightId, version]);

	if (error && !detail) {
		return (
			<aside class="drawer" aria-label="Flight">
				<CloseButton onClose={onClose} />
				<div class="empty">{error}</div>
			</aside>
		);
	}
	if (!detail)
		return (
			<aside class="drawer loading" aria-label="Flight" aria-busy="true">
				<span role="status">
					<Spinner label="Fetching this flight" />
				</span>
			</aside>
		);
	const { agent, intent, clearances, contrail } = detail;
	const f = flight ?? detail.flight;
	const flightLandings = Object.values(landings)
		.filter((l) => l.flightId === flightId)
		.sort((a, b) => a.seq - b.seq);
	const allLandings = flightLandings.length ? flightLandings : detail.landings;

	return (
		<aside class="drawer" aria-label={`Flight ${f.code}`}>
			<CloseButton onClose={onClose} />
			<div class="d-head" style={{ "--c": agent.color } as any}>
				<h2 class="d-callsign">
					<span class="dot big" style={{ background: agent.color }} aria-hidden="true" />
					{agent.callsign} <span class="mono muted">{f.code}</span>
					<span class={`st st-${f.status}`}>{statusLabel(f.status)}</span>
				</h2>
				<div class="d-model muted">
					{agent.model ?? agent.kind} · workspace <span class="mono">{f.repo}</span>
					{f.retiredAt ? " (deleted an hour after the flight ended)" : ""}
				</div>
				<div class="d-intent">
					<span class="mono muted">INT-{intent.seq}</span> {intent.title}
				</div>
				{intent.body && <div class="d-body">{intent.body}</div>}
			</div>

			{clearances.length > 0 && (
				<section>
					<h3 class="d-h">Clearances</h3>
					<div class="chips">
						{clearances.map((c) => (
							<button
								key={c.id}
								class={`chip ${c.status}`}
								onClick={() => onWhy(c.target)}
								aria-label={`${c.target}, ${c.status === "holding" ? "waiting for it" : "cleared"}. Why it looks the way it does`}
							>
								<span aria-hidden="true">{c.status === "holding" ? "⏳ " : "✓ "}</span>
								{c.target}
							</button>
						))}
					</div>
				</section>
			)}

			{allLandings.map((l) => (
				<section key={l.id} class={`landing ${l.status}`}>
					<h3 class="d-h">
						Landing #{l.seq} · <span class={`lst lst-${l.status}`}>{l.status}</span>
						{l.trunkAfter && <span class="mono muted"> {l.trunkAfter.slice(0, 8)}</span>}
					</h3>
					<div class="summary">{l.summary}</div>
					{l.changes.length > 0 && (
						<div class="changes">
							{l.changes.map((c) => (
								<div key={c.path} class="change">
									<span class={`cst cst-${c.status}`} title={c.status} aria-label={c.status}>
										{c.status[0].toUpperCase()}
									</span>
									<span class="change-what">
										<span class="mono">{c.path}</span>
										{c.symbols.map((s) => (
											<button key={s} class="sym" onClick={() => onWhy(`${c.path}#${s}`)} aria-label={`${s}: why it looks the way it does`}>
												{s}
											</button>
										))}
									</span>
									<span class="plus">+{c.additions}</span>
									<span class="minus">−{c.deletions}</span>
								</div>
							))}
							<details class="diffs">
								<summary>Diff</summary>
								{l.changes.map((c) => (
									<div key={c.path}>
										<div class="mono muted diff-file">{c.path}</div>
										<Diff change={c} />
									</div>
								))}
							</details>
						</div>
					)}
					{l.aiReview && <AiReviewNote review={l.aiReview} />}
					{l.review && (
						<div class={`reviewnote ${l.review.decision ?? "pending"}`}>
							{l.review.decision
								? `${l.review.decision === "approved" ? "Approved" : "Changes requested"} by ${l.review.reviewer}${l.review.comment ? `: ${l.review.comment}` : ""}`
								: l.status === "review"
									? `Waiting for a human${l.review.required.length ? `: ${l.review.required.join(", ")}` : l.aiReview?.verdict === "flag" ? ": the AI reviewer flagged it" : ""}`
									: "Not reviewed: the flight ended first"}
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
							{l.tests.train ? ` · run once for a train of ${l.tests.train} landings` : ""}
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
					{l.error && !l.tests?.failed && <div class="mono fail">{tidy(l.error)}</div>}
				</section>
			))}

			<section>
				<h3 class="d-h">Contrail</h3>
				<div class="timeline">
					{contrail.map((e) => (
						<div key={e.id} class={`tl tl-${e.kind}`}>
							<div class="tl-kind">{KIND_LABEL[e.kind] ?? e.kind}</div>
							<div class="tl-text">{tidy(e.text)}</div>
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
	history: {
		commit: string;
		when: string;
		flight: string;
		agent: string;
		model: string | null;
		intent: string;
		intentBody: string;
		summary: string;
		plan: string | null;
		decisions: string[];
		aiReview?: { model: string; verdict: string; reason: string } | null;
	}[];
	note?: string;
}

export function WhyPanel({ slug, fixture, target, onClose }: { slug: string; fixture: string | null; target: string; onClose: () => void }) {
	const [data, setData] = useState<WhyResult | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		const [path, symbol] = target.split("#");
		const url = fixture ? `/fixtures/${fixture}.why.json` : `/api/p/${slug}/why?path=${encodeURIComponent(path)}${symbol ? `&symbol=${encodeURIComponent(symbol)}` : ""}`;
		let cancelled = false;
		setData(null);
		setError(null);
		fetch(url)
			.then(async (r) => {
				const d = await r.json().catch(() => null);
				if (!r.ok || !Array.isArray(d?.history)) throw new Error(d?.error ?? "");
				return d as WhyResult;
			})
			.then((d) => !cancelled && setData(d))
			.catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
		return () => {
			cancelled = true;
		};
	}, [target]);
	return (
		<Dialog kicker="Why this code looks the way it does" title={target} titleMono wide onClose={onClose}>
			{!data && !error && (
				<div class="muted busy" role="status">
					<Spinner />
					Reading the contrail…
				</div>
			)}
			{error && (
				<div class="why-error" role="alert">
					The contrail couldn’t be read{error ? `: ${error}` : ""}. Try again in a moment.
				</div>
			)}
			{data?.note && <div class="muted">{data.note}</div>}
			{data?.history.map((h) => (
				<div key={h.commit} class="why-item">
					<div class="why-top">
						<span class="mono sha">{h.commit}</span>
						<b>{h.intent}</b>
					</div>
					<div class="muted">
						{h.agent} {h.model ? `(${h.model})` : ""} · {h.flight} · <time dateTime={h.when}>{new Date(h.when).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</time>
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
					{h.aiReview && (
						<div class="why-dec">
							<span class="lbl">AI review</span> {h.aiReview.verdict === "approve" ? "Approved" : h.aiReview.verdict === "flag" ? "Flagged" : "No verdict"} by{" "}
							<span class="mono">{h.aiReview.model}</span>: {h.aiReview.reason}
						</div>
					)}
				</div>
			))}
		</Dialog>
	);
}

/** A shell command with a copy button. Long lines scroll instead of breaking inside a URL. */
export function Command({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const copy = () =>
		navigator.clipboard
			?.writeText(text)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 1500);
			})
			.catch(() => {});
	return (
		<div class="cmd">
			<pre class="code" tabIndex={0} aria-label="Command">
				{text}
			</pre>
			<button class="copy" onClick={copy} aria-label={copied ? "Copied" : "Copy the command"}>
				{copied ? "Copied" : "Copy"}
			</button>
			<span class="sr-only" role="status">
				{copied ? "Copied to the clipboard" : ""}
			</span>
		</div>
	);
}

export function ConnectModal({ slug, onClose }: { slug: string; onClose: () => void }) {
	const origin = location.origin;
	// undefined while asking the tower; null when the airspace has no public join code.
	const [joinCode, setJoinCode] = useState<string | null | undefined>(undefined);
	const [key, setKey] = useState<{ key: string; callsign: string; expiresAt: number } | null>(null);
	const [err, setErr] = useState<string | null>(null);
	useEffect(() => {
		fetch(`/api/p/${slug}/join-info`)
			.then((r) => r.json())
			.then((d) => setJoinCode(d.joinCode ?? null))
			.catch(() => setJoinCode(null));
	}, [slug]);
	const mint = async () => {
		setErr(null);
		try {
			const res = await fetch(`/api/p/${slug}/join`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ joinCode, kind: "claude-code", model: "claude" }) });
			const d = await res.json().catch(() => ({}));
			if (!res.ok || !d.key) return setErr(d.error ? `No key was issued: ${d.error}.` : "No key was issued. Try again in a moment.");
			setKey({ key: d.key, callsign: d.agent.callsign, expiresAt: d.expiresAt });
		} catch {
			setErr("No key was issued: the tower couldn’t be reached. Check your connection and try again.");
		}
	};
	return (
		<Dialog kicker="Join the airspace" title="Connect an Agent" onClose={onClose}>
			<div class="connect">
				<p>Any MCP-capable agent can fly here. It gets its own Artifacts workspace, claims functions before editing, and lands through the runway.</p>
				{joinCode === undefined ? (
					<p class="muted" role="status">
						Asking the tower…
					</p>
				) : joinCode ? (
					key ? (
						<>
							<p>
								Your agent is <b>{key.callsign}</b>. Its key works until{" "}
								<time dateTime={new Date(key.expiresAt).toISOString()}>{new Date(key.expiresAt).toLocaleDateString("en-US", { dateStyle: "medium" })}</time>. Add the server to
								Claude Code:
							</p>
							<Command text={`claude mcp add --transport http contrail ${origin}/mcp/${slug} \\\n  --header "Authorization: Bearer ${key.key}"`} />
							<p>or to Codex (it reads the key from your environment, so keep the export in your shell profile):</p>
							<Command text={`export CONTRAIL_KEY=${key.key}\ncodex mcp add contrail --url ${origin}/mcp/${slug} --bearer-token-env-var CONTRAIL_KEY`} />
							<p class="muted">Then tell it: “Use the contrail tools. Take off, follow the flight protocol, and keep taking off until no intents are left.”</p>
						</>
					) : (
						<button class="btn" onClick={mint}>
							Get an Agent Key
						</button>
					)
				) : (
					<>
						<div class="invite">
							<p>
								<b>This airspace is invite-only.</b> Anyone can connect an agent in the Playground, which has a public join code.
							</p>
							{slug !== "playground" && (
								<a class="btn" href="/p/playground">
									Open the Playground
								</a>
							)}
						</div>
						<h3 class="connect-sub">Have the join code?</h3>
						<p>Operators of this airspace can connect an agent with its join code:</p>
						<Command text={`curl -s ${origin}/api/p/${slug}/join -H 'content-type: application/json' \\\n  -d '{"joinCode":"<join code>","kind":"claude-code"}'`} />
						<Command text={`claude mcp add --transport http contrail ${origin}/mcp/${slug} \\\n  --header "Authorization: Bearer <agent key>"`} />
					</>
				)}
				{err && (
					<div class="fail mono" role="alert">
						{err}
					</div>
				)}
			</div>
		</Dialog>
	);
}

/** The drawer's close button: an icon with a name, 44 pt on touch screens. */
function CloseButton({ onClose }: { onClose: () => void }) {
	return (
		<button class="close" onClick={onClose} aria-label="Close">
			<Icon name="abort" size={16} />
		</button>
	);
}
