// Small line icons for the radar (16px, drawn with currentColor). One per event type.
const PATHS: Record<string, string> = {
	taxi: "M3 8h9M9 4.5 12.5 8 9 11.5",
	plane: "M8 1.6c.5 0 .9.4.9 1v3.8l4.6 2.8v1.3L8.9 9.1v2.8l1.3 1v1.1L8 13.4 5.8 14v-1.1l1.3-1V9.1L2.5 10.5V9.2l4.6-2.8V2.6c0-.6.4-1 .9-1z",
	route: "M3 13c0-3 2-4 5-4s5-1 5-4M10.5 2.8 13 5l-2.5 2.2M3 13h.01",
	check: "M3.2 8.4 6.4 11.4 12.8 4.6",
	clock: "M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2zM8 4.8V8l2.2 1.6",
	release: "M3.5 6.5A4.8 4.8 0 1 1 3.2 9M3.2 3.4v3.2h3.2",
	pen: "M10.6 2.6l2.8 2.8-7.6 7.6-3.4.6.6-3.4 7.6-7.6z",
	radio: "M2.8 3.4h10.4v7H7.4L4.6 12.8v-2.4H2.8z",
	descend: "M3.5 4 11.5 12M11.5 6.5V12H6",
	train: "M2.8 4.2h10.4M2.8 8h10.4M2.8 11.8h10.4",
	landed: "M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2zM5.4 8.2l1.8 1.8 3.4-3.6",
	conflict: "M8 2.4 14 13H2zM8 6.4v3M8 11.2h.01",
	failed: "M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2zM5.9 5.9l4.2 4.2M10.1 5.9 5.9 10.1",
	wave: "M1.8 8.6c1.4 0 1.4-2.4 2.8-2.4s1.4 3.6 2.8 3.6 1.4-3.6 2.8-3.6 1.4 2.4 2.8 2.4",
	join: "M6.2 7.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM1.8 13.6c.4-2.6 2.2-4 4.4-4s4 1.4 4.4 4M12.2 5v4M10.2 7h4",
	intent: "M8 2.4 13.6 8 8 13.6 2.4 8z",
	flag: "M3.4 14V2.6M3.4 3h8.4l-1.6 2.8 1.6 2.8H3.4",
	abort: "M4 4l8 8M12 4l-8 8",
	shield: "M8 1.8 13 3.6v4c0 3.2-2.2 5.4-5 6.6-2.8-1.2-5-3.4-5-6.6v-4z",
	bolt: "M8.8 1.6 3.6 9h4l-.6 5.4L12.4 7h-4z",
	review: "M5.6 7.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8zM1.6 13.4c.4-2.4 2-3.8 4-3.8 1.2 0 2.3.5 3 1.4M9.6 12l1.6 1.6 3-3.2",
	read: "M6.9 2.4a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zM10.2 10.2l3.6 3.6",
	play: "M4.6 2.9v10.2c0 .5.5.8.9.5l7.6-5.1c.4-.3.4-.8 0-1.1L5.5 2.4c-.4-.3-.9 0-.9.5z",
	pause: "M4.2 2.8h2.4v10.4H4.2zM9.4 2.8h2.4v10.4H9.4z",
	clone: "M8 2.4v7.8M4.8 7 8 10.2 11.2 7M3 12.8h10",
};

/** Solid shapes; the other icons are drawn as lines. */
const FILLED = new Set(["plane", "play", "pause"]);

const BY_EVENT: Record<string, string> = {
	"agent.joined": "join",
	"intent.created": "intent",
	"flight.taxiing": "taxi",
	"flight.planned": "route",
	"flight.airborne": "plane",
	"flight.aborted": "abort",
	"clearance.granted": "check",
	"clearance.holding": "clock",
	"clearance.released": "release",
	"contrail.plan": "pen",
	"contrail.decision": "pen",
	"contrail.note": "pen",
	"contrail.handoff": "pen",
	"contrail.read": "read",
	radio: "radio",
	"landing.queued": "descend",
	"landing.ready": "clock",
	"runway.train": "train",
	"landing.landed": "landed",
	"landing.conflict": "conflict",
	"landing.failed": "failed",
	"landing.review": "review",
	"landing.reviewed": "review",
	turbulence: "wave",
	"project.created": "flag",
	"project.reset": "release",
	"policy.updated": "shield",
	"edge.launched": "bolt",
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
	const d = PATHS[name] ?? PATHS.intent;
	const filled = FILLED.has(name);
	return (
		<svg class="icon" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
			<path d={d} fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
		</svg>
	);
}

export const eventIcon = (type: string) => BY_EVENT[type] ?? (type.startsWith("contrail.") ? "pen" : "intent");

/** The Contrail mark: a plane heading up-right with two contrails behind it. */
export function Logo({ size = 26 }: { size?: number }) {
	return (
		<svg class="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
			<g transform="rotate(45 16 16)">
				<path class="contrails" d="M12.6 19.5v10M19.4 19.5v10" stroke-width="2.2" stroke-linecap="round" />
				<path
					class="mark"
					d="M16 2.2c.9 0 1.6.8 1.6 1.8v6.9l8.4 5.1v2.3l-8.4-2.6v5.2l2.3 1.8V25L16 23.9 12.1 25v-2.1l2.3-1.8v-5.2L6 18.4v-2.3l8.4-5.1V4c0-1 .7-1.8 1.6-1.8z"
				/>
			</g>
		</svg>
	);
}
