import { useState } from "preact/hooks";
import type { Agent, AiReview, FileChange, Flight, Intent, Landing } from "../../../src/shared/types";
import { pressable } from "../a11y";
import { KindBadge } from "./Airspace";

/** The AI reviewer's verdict on a landing: who reviewed it, what it decided and why. */
export function AiReviewNote({ review }: { review: AiReview }) {
	const verdict = review.verdict === "approve" ? "approved it" : review.verdict === "flag" ? "flagged it" : "gave no verdict";
	return (
		<div class={`ainote ${review.verdict}`}>
			<span class="lbl">AI review</span>{" "}
			<span class="mono">{review.model.split("/").pop()}</span> {verdict}: {review.reason}
			{review.concerns.length > 0 && (
				<ul>
					{review.concerns.map((c, i) => (
						<li key={i}>{c}</li>
					))}
				</ul>
			)}
		</div>
	);
}

export function Diff({ change }: { change: FileChange }) {
	if (!change.hunks?.length) return null;
	return (
		<div class="diff">
			{change.hunks.map((h, i) => (
				<div key={i} class="diff-hunk">
					<div class="diff-at mono">@@ line {h.start}</div>
					{h.removed.map((l, j) => (
						<div key={`r${j}`} class="diff-del mono">
							− {l}
						</div>
					))}
					{h.added.map((l, j) => (
						<div key={`a${j}`} class="diff-add mono">
							+ {l}
						</div>
					))}
				</div>
			))}
		</div>
	);
}

function adminKey(): string {
	try {
		return localStorage.getItem("contrail-admin") ?? "";
	} catch {
		return "";
	}
}

export function ReviewInbox({
	slug,
	recorded,
	landings,
	flights,
	agents,
	intents,
	onSelect,
}: {
	slug: string;
	/** A replay or fixture: the decisions were made live, so there is nothing to approve here. */
	recorded: boolean;
	landings: Record<string, Landing>;
	flights: Record<string, Flight>;
	agents: Record<string, Agent>;
	intents: Record<string, Intent>;
	onSelect: (id: string) => void;
}) {
	const waiting = Object.values(landings)
		.filter((l) => l.status === "review")
		.sort((a, b) => a.seq - b.seq);
	const decided = Object.values(landings)
		.filter((l) => l.review?.decision)
		.sort((a, b) => b.seq - a.seq)
		.slice(0, 10);
	return (
		<div class="reviews">
			<h2 class="section-title">Waiting for a human · {waiting.length}</h2>
			{waiting.length === 0 && <div class="empty">Nothing needs a human right now. Green landings land on their own unless they touch code the review policy reserves, change the test gate, or the AI reviewer flags them.</div>}
			{waiting.map((l) => (
				<ReviewCard key={l.id} slug={slug} recorded={recorded} landing={l} flight={flights[l.flightId]} agents={agents} intents={intents} onSelect={onSelect} />
			))}
			{decided.length > 0 && <h2 class="section-title">Recent decisions</h2>}
			{decided.map((l) => {
				const f = flights[l.flightId];
				const i = f && intents[f.intentId];
				return (
					<div key={l.id} class={`rdone ${l.review?.decision} ${f ? "go" : ""}`} {...(f ? pressable(() => onSelect(f.id)) : {})}>
						<span class="mono">{f?.code}</span> {i ? `INT-${i.seq} ${i.title}` : ""} — <b>{l.review?.decision}</b> by {l.review?.reviewer}
						{l.review?.comment ? `: ${l.review.comment}` : ""}
					</div>
				);
			})}
		</div>
	);
}

function ReviewCard({
	slug,
	recorded,
	landing,
	flight,
	agents,
	intents,
	onSelect,
}: {
	slug: string;
	recorded: boolean;
	landing: Landing;
	flight?: Flight;
	agents: Record<string, Agent>;
	intents: Record<string, Intent>;
	onSelect: (id: string) => void;
}) {
	const [comment, setComment] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);
	// Asked for in the card (a password field), never in a browser prompt that shows it as you type.
	const [key, setKey] = useState(adminKey);
	const [knownKey, setKnownKey] = useState(() => !!adminKey());
	const agent = flight && agents[flight.agentId];
	const intent = flight && intents[flight.intentId];
	const decide = async (decision: "approve" | "reject") => {
		if (!key) return setErr("Enter the admin key first.");
		setErr(null);
		setBusy(true);
		try {
			const res = await fetch(`/api/p/${slug}/landings/${landing.id}/review`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
				body: JSON.stringify({ decision, comment: comment || undefined, reviewer: "operator" }),
			});
			// Kept only once the tower takes it, so a wrong key doesn't hide the field it was typed into.
			if (res.status === 401) {
				try {
					localStorage.removeItem("contrail-admin");
				} catch {
					// private mode
				}
				setKnownKey(false);
				setKey("");
				setErr("That admin key wasn’t accepted.");
			} else if (!res.ok) setErr((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
			else
				try {
					localStorage.setItem("contrail-admin", key);
				} catch {
					// private mode
				}
		} catch {
			setErr("The tower didn’t answer. Check your connection and try again.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<div class="rcard">
			<div class="rcard-top" {...(flight ? pressable(() => onSelect(flight.id)) : {})}>
				<span class="dot" style={{ background: agent?.color }} aria-hidden="true" />
				<KindBadge kind={agent?.kind} />
				<b>{agent?.callsign}</b> <span class="mono muted">{flight?.code}</span>
			</div>
			<div class="rcard-intent">{intent ? `INT-${intent.seq} ${intent.title}` : ""}</div>
			{(landing.review?.required.length ?? 0) > 0 && (
				<div class="rcard-why">
					Policy requires a human for{" "}
					{landing.review?.required.map((t) => (
						<span key={t} class="chip holding">
							{t}
						</span>
					))}
				</div>
			)}
			{landing.aiReview?.verdict === "flag" && <AiReviewNote review={landing.aiReview} />}
			<div class="summary">{landing.summary}</div>
			{landing.tests && (
				<div class="tests good">
					Merged onto trunk and verified: {landing.tests.passed} tests green in a Dynamic Worker
				</div>
			)}
			{landing.changes.map((c) => (
				<div key={c.path} class="rchange">
					<div class="change">
						<span class={`cst cst-${c.status}`} title={c.status} aria-label={c.status}>
							{c.status[0].toUpperCase()}
						</span>
						<span class="change-what">
							<span class="mono">{c.path}</span>
							{c.symbols.map((s) => (
								<span key={s} class="sym">
									{s}
								</span>
							))}
						</span>
						<span class="plus">+{c.additions}</span>
						<span class="minus">−{c.deletions}</span>
					</div>
					<Diff change={c} />
				</div>
			))}
			{recorded ? (
				<div class="rrecorded">Recorded replay: this decision was made live.</div>
			) : (
				<>
					<label>
						<span class="sr-only">Comment for the agent</span>
						<textarea class="rcomment" placeholder="Comment for the agent (optional)" value={comment} onInput={(e) => setComment((e.target as HTMLTextAreaElement).value)} />
					</label>
					{!knownKey && <p class="muted rwho">Only the project’s operator, with the admin key, can decide.</p>}
					{!knownKey && (
						<label class="rkey">
							<span>Admin key</span>
							<input type="password" autocomplete="current-password" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} />
						</label>
					)}
					<div class="row">
						<button class="btn" disabled={busy} onClick={() => decide("approve")}>
							Approve &amp; Land
						</button>
						<button class="btn ghost danger" disabled={busy} onClick={() => decide("reject")}>
							Request Changes
						</button>
					</div>
					{err && (
						<div class="fail mono" role="alert">
							{err}
						</div>
					)}
				</>
			)}
		</div>
	);
}
