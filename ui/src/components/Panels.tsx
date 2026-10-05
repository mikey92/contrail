import { useState } from "preact/hooks";
import type { Agent, Flight, Intent, Landing, RadarEvent } from "../../../src/shared/types";
import { pressable } from "../a11y";
import { ACTIVE_STATUSES, relTime, statusLabel, tidy } from "../store";
import { KindBadge } from "./Airspace";
import { eventIcon, Icon } from "./Icons";

const TARGET = "[\\w./-]+\\.\\w+#[\\w$.-]+";
const LIST = new RegExp(`${TARGET}(?:, ${TARGET}){2,}`, "g");
const TOKEN = new RegExp(`(FL-\\d{3,}|INT-\\d+|${TARGET})`);

/** `text` shortened to about `max` characters, ending in "…" after the last whole word. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

/** The Tower cuts plans and notes at 140 characters and landing summaries at 120, mid-word. */
const CUT_AT: Record<string, number> = { radio: 140, "landing.queued": 120 };

/** An event's text, with a body the Tower cut short ending at a word and "…". */
function eventText(e: RadarEvent): string {
	const limit = e.type.startsWith("contrail.") && e.type !== "contrail.read" ? 140 : CUT_AT[e.type];
	const i = e.text.indexOf(": ");
	if (!limit || i < 0 || e.text.length - i - 2 !== limit) return tidy(e.text);
	return tidy(e.text.slice(0, i + 2) + clip(e.text.slice(i + 2), limit - 1));
}

/** Long lists of targets read as "a, b and 3 more"; flight codes and targets are set in mono. */
function Text({ text }: { text: string }) {
	const short = text.replace(LIST, (list) => {
		const items = list.split(", ");
		return `${items.slice(0, 2).join(", ")} and ${items.length - 2} more`;
	});
	return (
		<>
			{short.split(TOKEN).map((part, i) => (i % 2 ? <span key={i} class="mono">{part}</span> : part))}
		</>
	);
}

export function Feed({
	events,
	keyEvents,
	routine,
	flights,
	agents,
	onSelect,
}: {
	events: RadarEvent[];
	keyEvents: RadarEvent[];
	routine: number;
	flights: Record<string, Flight>;
	agents: Record<string, Agent>;
	onSelect: (id: string) => void;
}) {
	// Key events by default: landings, conflicts, waits, plans and decisions, not every taxi, take-off and alert.
	const [all, setAll] = useState(false);
	const list = [...(all ? events : keyEvents)].reverse().slice(0, 150);
	return (
		<div class="feed">
			<div class="feed-filter">
				<div class="seg" role="group" aria-label="Events to show">
					<button class={all ? "" : "on"} aria-pressed={!all} onClick={() => setAll(false)}>
						Key Events
					</button>
					<button class={all ? "on" : ""} aria-pressed={all} onClick={() => setAll(true)}>
						All
					</button>
				</div>
				{!all && routine > 0 && (
					<span class="feed-hidden" title="Take-offs, clearances, alerts and runway trains. Choose All to see them.">
						{routine.toLocaleString("en-US")} routine {routine === 1 ? "line" : "lines"} hidden
					</span>
				)}
			</div>
			{list.map((e) => {
				const flight = e.flightId ? flights[e.flightId] : null;
				const agent = flight ? agents[flight.agentId] : e.agentId ? agents[e.agentId] : null;
				return (
					<div key={e.seq} class={`ev ev-${e.type.replace(/\./g, "-")} ${e.flightId ? "go" : ""}`} {...(e.flightId ? pressable(() => onSelect(e.flightId!)) : {})}>
						<span class="ev-icon" aria-hidden="true">
							<Icon name={eventIcon(e.type)} />
						</span>
						<div class="ev-body">
							<div class="ev-text">
								{agent && <span class="dot" style={{ background: agent.color }} title={agent.callsign} />}
								<Text text={eventText(e)} />
							</div>
							<div class="ev-meta">{relTime(e.at)}</div>
						</div>
					</div>
				);
			})}
			{list.length === 0 && <div class="empty">{all || !events.length ? "Waiting for traffic…" : "No key events yet."}</div>}
		</div>
	);
}

export function FlightList({ flights, agents, intents, onSelect }: { flights: Record<string, Flight>; agents: Record<string, Agent>; intents: Record<string, Intent>; onSelect: (id: string) => void }) {
	const all = Object.values(flights).sort((a, b) => b.updatedAt - a.updatedAt);
	const active = all.filter((f) => ACTIVE_STATUSES.includes(f.status));
	const done = all.filter((f) => !ACTIVE_STATUSES.includes(f.status)).slice(0, 30);
	const card = (f: Flight) => {
		const a = agents[f.agentId];
		const i = intents[f.intentId];
		return (
			<div key={f.id} class={`fcard st-border-${f.status}`} {...pressable(() => onSelect(f.id))}>
				<div class="fcard-top">
					<span class="dot" style={{ background: a?.color }} aria-hidden="true" />
					<KindBadge kind={a?.kind} />
					<b>{a?.callsign}</b>
					<span class="mono muted">{f.code}</span>
					<span class={`st st-${f.status}`}>{statusLabel(f.status)}</span>
				</div>
				<div class="fcard-intent">{i ? `INT-${i.seq} ${i.title}` : ""}</div>
				{f.plan && <div class="fcard-plan">{clip(f.plan, 160)}</div>}
				<div class="fcard-meta muted">
					{a?.model ?? a?.kind} · {f.attempts ? `${f.attempts} landing attempt${f.attempts > 1 ? "s" : ""} · ` : ""}
					{relTime(f.updatedAt)}
				</div>
			</div>
		);
	};
	return (
		<div class="flights">
			<h2 class="section-title">
				In the air <span class="n">{active.length}</span>
			</h2>
			{active.map(card)}
			{active.length === 0 && <div class="empty">No active flights.</div>}
			<h2 class="section-title">Landed and closed</h2>
			{done.map(card)}
		</div>
	);
}

export function IntentBoard({ intents, flights, agents, onSelect }: { intents: Record<string, Intent>; flights: Record<string, Flight>; agents: Record<string, Agent>; onSelect: (id: string) => void }) {
	const list = Object.values(intents).sort((a, b) => a.seq - b.seq);
	const landed = list.filter((i) => i.status === "landed").length;
	return (
		<div class="intents">
			<div class="progress-label">
				<b>{landed}</b> of {list.length} intents landed
			</div>
			<div class="progress" role="progressbar" aria-label="Intents landed" aria-valuemin={0} aria-valuemax={list.length} aria-valuenow={landed}>
				<div class="bar" style={{ width: `${list.length ? (landed / list.length) * 100 : 0}%` }} />
			</div>
			{list.map((i) => {
				const f = i.flightId ? flights[i.flightId] : null;
				const a = f ? agents[f.agentId] : null;
				return (
					<div key={i.id} class={`irow is-${i.status} ${f ? "go" : ""}`} {...(f ? pressable(() => onSelect(f.id)) : {})}>
						<span class="mono muted">INT-{i.seq}</span>
						<span class="ititle" title={i.title}>
								{i.title}
							</span>
						<span class={`st st-${i.status === "assigned" && f ? f.status : i.status}`}>{i.status === "assigned" && f ? statusLabel(f.status) : i.status}</span>
						{a && <span class="dot" title={a.callsign} style={{ background: a.color }} aria-hidden="true" />}
					</div>
				);
			})}
		</div>
	);
}

export function Runway({ landings, flights, agents, intents, onSelect }: { landings: Record<string, Landing>; flights: Record<string, Flight>; agents: Record<string, Agent>; intents: Record<string, Intent>; onSelect: (id: string) => void }) {
	const all = Object.values(landings).sort((a, b) => a.seq - b.seq);
	const approach = all.filter((l) => ["queued", "merging", "verifying", "review"].includes(l.status));
	const landed = all.filter((l) => l.status === "landed").slice(-14);
	return (
		<section class="runway" aria-label="Runway">
			<div class="rw-label">
				<span>Runway</span>
				<span class="muted">lands on main</span>
			</div>
			<div class="rw-approach">
				{approach.length > 3 && <div class="rw-more">{approach.length} on approach</div>}
				{approach.slice(0, approach.length > 3 ? 2 : 3).map((l) => {
					const f = flights[l.flightId];
					const a = f && agents[f.agentId];
					return (
						<div key={l.id} class={`rw-chip ${l.status}`} style={{ "--c": a?.color } as any} {...(f ? pressable(() => onSelect(f.id)) : {})}>
							<span class="mono">{f?.code}</span> {l.status === "queued" ? "on approach" : l.status === "review" ? "awaiting review" : l.status === "verifying" ? "testing" : l.status}
						</div>
					);
				})}
			</div>
			<div class="rw-strip">
				{[...landed].reverse().map((l) => {
					const f = flights[l.flightId];
					const a = f && agents[f.agentId];
					const i = f && intents[f.intentId];
					const plus = l.changes.reduce((s, c) => s + c.additions, 0);
					const minus = l.changes.reduce((s, c) => s + c.deletions, 0);
					return (
						<div key={l.id} class="rw-commit" style={{ "--c": a?.color } as any} {...(f ? pressable(() => onSelect(f.id)) : {})}>
							<div class="rw-dot" />
							<div class="rw-sha mono">{l.trunkAfter?.slice(0, 7)}</div>
							<div class="rw-title" title={i ? `INT-${i.seq} ${i.title}` : undefined}>
									{i ? `INT-${i.seq} ${i.title}` : f?.code}
								</div>
							<div class="rw-meta mono">
								{f?.code} <span class="plus">+{plus}</span> <span class="minus">−{minus}</span>
								{l.tests && <span class="ok"> ✓{l.tests.passed}</span>}
								{l.unioned > 0 && <span class="union" title="parallel inserts auto-merged"> +{l.unioned} merged</span>}
							</div>
						</div>
					);
				})}
				{landed.length === 0 && <div class="empty">Nothing has landed yet.</div>}
			</div>
		</section>
	);
}
