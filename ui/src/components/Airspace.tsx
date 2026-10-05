import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Agent, Clearance, Flight, Intent, TrunkFile } from "../../../src/shared/types";
import { predictTargets, symbolIndex } from "../../../src/tower/planner";
import { pressable, touch } from "../a11y";
import { ACTIVE_STATUSES, type Flash, statusLabel } from "../store";

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface Band extends Rect {
	target: string;
	/** Unique within the file, which may define two symbols with the same name. */
	key: string;
	name: string;
	kind: string;
	depth: number;
	/** The name as drawn, cut to the band's width; null when the band has no room for it. */
	label: string | null;
}

interface FileBox extends Rect {
	path: string;
	name: string;
	lines: number;
	bands: Band[];
	content: Rect;
	/** The file name as drawn, cut to the box's width, and whether the line count fits after it. */
	label: string | null;
	withLines: boolean;
}

interface GroupBox extends Rect {
	name: string;
	label: string | null;
}

/** The files of a directory that no flight is working on, drawn as one block in a big codebase. */
interface RestBox extends Rect {
	group: string;
	count: number;
	paths: Set<string>;
	/** How much of "N more files no agent here" fits: all of it (2), the count (1) or nothing (0). */
	fits: number;
}

/** Where a label is drawn: from `x` to `end` on the baseline `y`. */
interface Label {
	x: number;
	end: number;
	y: number;
}

const HEADER = 18;
const APRON = 54;
const APRON_LABEL = "Taxiing · agents that have not claimed any code yet";
/** Strip under the map for the legend. */
const LEGEND = 26;
const SOURCE_DIRS = new Set(["src", "source", "lib", "app", "pkg"]);
/** Above this many files every box would be too small to label, so the map shows the files in play. */
const FOCUS_ABOVE = 120;
const groupOf = (path: string) => (path.includes("/") ? path.split("/")[0] : "·");

// The map's labels are measured to fit their boxes, so these match the CSS of .file-label, .band-label, .claim-tag.
const SANS = `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro", system-ui, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`;
const MONO = `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace`;
const LABEL_FONT = `600 12px ${SANS}`;
const LINES_FONT = `400 12px ${SANS}`;
const BAND_FONT = `400 11px ${SANS}`;
const TAG_FONT = `600 11px ${MONO}`;

/** Glyph widths per font, each measured once (and again when the web fonts arrive). */
const glyphs = new Map<string, Map<string, number>>();
let ruler: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
	if (ruler === undefined) ruler = document.createElement("canvas").getContext("2d");
	let widths = glyphs.get(font);
	if (!widths) glyphs.set(font, (widths = new Map()));
	let w = 0;
	for (const ch of text) {
		let g = widths.get(ch);
		if (g === undefined) {
			if (ruler) {
				ruler.font = font;
				g = ruler.measureText(ch).width;
			} else g = 0.6 * Number.parseFloat(font.split(" ")[1]);
			widths.set(ch, g);
		}
		w += g;
	}
	return w;
}

/** `text` cut to `max` px, ending in "…"; null when not even one letter fits. */
function fit(text: string, max: number, font: string): string | null {
	if (textWidth(text, font) <= max) return text;
	const room = max - textWidth("…", font);
	let w = 0;
	let n = 0;
	for (const ch of text) {
		w += textWidth(ch, font);
		if (w > room) break;
		n += ch.length;
	}
	// "inventory…", not "inventory.…"
	const head = text.slice(0, n).replace(/[.\s]+$/, "");
	return head ? `${head}…` : null;
}

/** Baseline of the label at the top of a band (or of a claim tag drawn on it). */
const labelY = (r: Rect) => r.y + Math.min(r.h / 2 + 4, 12);

/**
 * The codebase as a treemap: a block per top-level directory, a box per file, a band per function. In a
 * big codebase only the files in play (`focus`) get a box; the rest of each directory is one block.
 */
function layout(files: TrunkFile[], width: number, height: number, focus: Set<string> | null) {
	const groups = new Map<string, TrunkFile[]>();
	for (const f of files) {
		const dir = groupOf(f.path);
		if (!groups.has(dir)) groups.set(dir, []);
		groups.get(dir)!.push(f);
	}
	const data = {
		name: "root",
		children: [...groups.entries()].map(([name, fs]) => {
			if (!focus) return { name, children: fs.map((f) => ({ name: f.path, file: f, value: Math.max(f.lines, 10) })) };
			const shown = fs.filter((f) => focus.has(f.path));
			const rest = fs.filter((f) => !focus.has(f.path)).map((f) => f.path);
			const children: any[] = shown.map((f) => ({ name: f.path, file: f, value: Math.max(f.lines, 40) }));
			// Sized by file count, but kept smaller than the files in play: it is context, not the story.
			if (rest.length) children.push({ name: "\uffff", rest, value: 40 + rest.length * 1.5 });
			return { name, children };
		}),
	};
	// Stable ordering keeps the map from reshuffling as files grow: the source directory first, then the
	// others from large to small (tiny ones end up together in a corner), root last; files by path.
	const rank = (name: string) => (SOURCE_DIRS.has(name) ? 0 : name === "·" ? 2 : 1);
	const root = hierarchy<any>(data)
		.sum((d) => d.value ?? 0)
		.sort((a, b) =>
			a.depth === 1
				? rank(a.data.name) - rank(b.data.name) || (b.value ?? 0) - (a.value ?? 0) || a.data.name.localeCompare(b.data.name)
				: a.data.name.localeCompare(b.data.name),
		);
	treemap<any>().size([width, height]).tile(treemapSquarify.ratio(1.15)).paddingOuter(4).paddingTop(22).paddingInner(5).round(true)(root);

	const groupBoxes: GroupBox[] = [];
	const fileBoxes: FileBox[] = [];
	const restBoxes: RestBox[] = [];
	// Every label is cut to its box, so none spills into a neighbour; claim tags keep clear of them.
	const labels: Label[] = [];
	for (const g of root.children ?? []) {
		const gb = g as any;
		const name = gb.data.name === "·" ? "root" : `${gb.data.name}/`;
		const group: GroupBox = { name, label: fit(name, gb.x1 - gb.x0 - 16, LABEL_FONT), x: gb.x0, y: gb.y0, w: gb.x1 - gb.x0, h: gb.y1 - gb.y0 };
		if (group.label) labels.push({ x: group.x + 8, end: group.x + 8 + textWidth(group.label, LABEL_FONT), y: group.y + 15 });
		groupBoxes.push(group);
		for (const leaf of g.children ?? []) {
			const l = leaf as any;
			if (l.data.rest) {
				const count = l.data.rest.length;
				const room = l.x1 - l.x0 - 12;
				const head = textWidth(`${count} more ${count === 1 ? "file" : "files"}`, LABEL_FONT);
				const fits = l.x1 - l.x0 > 90 && l.y1 - l.y0 >= 40 ? (head + textWidth(" no agent here", LINES_FONT) <= room ? 2 : head <= room ? 1 : 0) : 0;
				restBoxes.push({ group: gb.data.name, count, paths: new Set(l.data.rest), fits, x: l.x0, y: l.y0, w: l.x1 - l.x0, h: l.y1 - l.y0 });
				continue;
			}
			const f: TrunkFile = l.data.file;
			const box: FileBox = {
				path: f.path,
				name: f.path.split("/").pop()!,
				lines: f.lines,
				x: l.x0,
				y: l.y0,
				w: l.x1 - l.x0,
				h: l.y1 - l.y0,
				bands: [],
				content: { x: l.x0 + 3, y: l.y0 + HEADER, w: Math.max(0, l.x1 - l.x0 - 6), h: Math.max(0, l.y1 - l.y0 - HEADER - 3) },
				label: null,
				withLines: false,
			};
			if (box.w > 40 && box.h >= 18) {
				const room = box.w - 12;
				box.withLines = textWidth(box.name, LABEL_FONT) + textWidth(` ${f.lines}`, LINES_FONT) <= room;
				box.label = box.withLines ? box.name : fit(box.name, room, LABEL_FONT);
				if (box.label) labels.push({ x: box.x + 6, end: box.x + 6 + textWidth(box.label, LABEL_FONT), y: box.y + 13 });
			}
			const lines = Math.max(f.lines, 1);
			const seen = new Map<string, number>();
			for (const s of f.symbols) {
				const depth = s.name.includes(".") ? 1 : 0;
				const y = box.content.y + ((s.start - 1) / lines) * box.content.h;
				const h = Math.max(3, ((s.end - s.start + 1) / lines) * box.content.h);
				const target = `${f.path}#${s.name}`;
				const n = seen.get(target) ?? 0;
				seen.set(target, n + 1);
				box.bands.push({ target, key: n ? `${target}~${n}` : target, name: s.name, kind: s.kind, depth, label: null, x: box.content.x + depth * 9, y, w: Math.max(0, box.content.w - depth * 9), h });
			}
			for (const b of box.bands) {
				// A class whose first method starts right at its top leaves the row to the method's name.
				if (b.h < 11 || b.w <= 50 || (b.kind === "class" && box.bands.some((m) => m.depth === 1 && m.target.startsWith(`${b.target}.`) && m.y - b.y < 12))) continue;
				b.label = fit(b.name.split(".").pop()!, b.w - 10, BAND_FONT);
				if (b.label) labels.push({ x: b.x + 5, end: b.x + 5 + textWidth(b.label, BAND_FONT), y: labelY(b) });
			}
			fileBoxes.push(box);
		}
	}
	return { groupBoxes, fileBoxes, restBoxes, labels };
}

/** Screen rectangle for a clearance target; unknown symbols (new code) get a stub at the file's end. */
function rectFor(target: string, files: FileBox[], groups: GroupBox[], rests: RestBox[]): Rect | null {
	const [path, symbol] = target.split("#");
	if (path.endsWith("/")) {
		const g = groups.find((g) => g.name === path);
		return g ?? null;
	}
	const file = files.find((f) => f.path === path);
	if (!file) {
		// An existing file still folded into its directory's block (the next layout gives it a box).
		// A file that doesn't exist yet has no place on the map until it lands.
		const rest = rests.find((r) => r.paths.has(path));
		return rest ? { x: rest.x + rest.w / 2 - 20, y: rest.y + rest.h / 2 - 5, w: 40, h: 10 } : null;
	}
	if (!symbol) return file.content;
	const band = file.bands.find((b) => b.name === symbol) ?? file.bands.find((b) => symbol.startsWith(`${b.name}.`));
	if (band) return band;
	return { x: file.content.x + file.content.w * 0.55, y: file.content.y + file.content.h - 10, w: file.content.w * 0.45, h: 8 };
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

const KIND: Record<string, [string, string]> = {
	"claude-code": ["CC", "Claude Code"],
	codex: ["CX", "Codex"],
	edge: ["CF", "Edge agent: a Durable Object reasoning on Workers AI"],
	human: ["H", "Human"],
};

export function KindBadge({ kind }: { kind?: string }) {
	const k = KIND[kind ?? ""];
	if (!k) return null;
	return (
		<span class={`kind kind-${kind}`} title={k[1]} aria-hidden="true">
			{k[0]}
		</span>
	);
}

interface Props {
	files: TrunkFile[];
	clearances: Clearance[];
	flights: Record<string, Flight>;
	agents: Record<string, Agent>;
	intents: Record<string, Intent>;
	flashes: Flash[];
	selected: string | null;
	onSelect: (flightId: string) => void;
	onWhy: (target: string) => void;
}

/**
 * Directories, files and their functions: redrawn only when the code or the map's size changes.
 * The functions are one stop for Tab: the arrow keys move between them (in reading order) and Enter or
 * Space asks why one looks the way it does. A tap or click on a file's free space picks its nearest function.
 */
function CodeLayer({ groups, files, rests, onHover, onWhy }: { groups: GroupBox[]; files: FileBox[]; rests: RestBox[]; onHover: (b: Band | null) => void; onWhy: (target: string) => void }) {
	const bands = useMemo(() => files.flatMap((f) => f.bands), [files]);
	const [active, setActive] = useState<string | null>(null);
	const current = bands.find((b) => b.key === active) ?? bands[0];
	const move = (e: KeyboardEvent, b: Band) => {
		const i = bands.indexOf(b);
		const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: bands.length - 1 }[e.key];
		if (e.key === "Enter" || e.key === " ") {
			e.preventDefault();
			onWhy(b.target);
			return;
		}
		if (to === undefined) return;
		e.preventDefault();
		const next = bands[Math.max(0, Math.min(bands.length - 1, to))];
		setActive(next.key);
		const svg = (e.currentTarget as SVGElement).ownerSVGElement;
		(svg?.querySelector(`[data-key="${CSS.escape(next.key)}"]`) as SVGElement | null)?.focus();
	};
	const nearest = (e: MouseEvent, f: FileBox) => {
		if ((e.target as Element).closest(".band-g")) return;
		if (!f.bands.length) return onWhy(f.path);
		const svg = (e.currentTarget as SVGGElement).ownerSVGElement!;
		const y = e.clientY - svg.getBoundingClientRect().top - APRON;
		const b = f.bands.reduce((best, x) => (Math.abs(x.y + x.h / 2 - y) < Math.abs(best.y + best.h / 2 - y) ? x : best));
		onWhy(b.target);
	};
	return (
		<>
			{groups.map((g) => (
				<g key={g.name} data-group={g.name}>
					<rect x={g.x} y={g.y} width={g.w} height={g.h} rx={8} class="group" />
					{g.label && (
						<text x={g.x + 8} y={g.y + 15} class="group-label" aria-hidden="true">
							{g.label}
						</text>
					)}
				</g>
			))}
			{rests.map((r) => (
				<g key={`rest-${r.group}`} class="rest" data-rest={r.group}>
					<title>{`${r.count} ${r.count === 1 ? "file" : "files"} in ${r.group === "·" ? "the root" : `${r.group}/`} that no agent is working on`}</title>
					<rect x={r.x} y={r.y} width={r.w} height={r.h} rx={5} class="file rest-box" />
					{r.w > 24 && r.h > 24 && <rect x={r.x + 4} y={r.y + (r.h >= 40 ? 20 : 4)} width={r.w - 8} height={r.h - (r.h >= 40 ? 24 : 8)} fill="url(#rest-files)" />}
					{r.fits > 0 && (
						<text x={r.x + 6} y={r.y + 13} class="file-label rest-label">
							{r.count} more {r.count === 1 ? "file" : "files"}
							{r.fits > 1 && <tspan class="file-lines"> no agent here</tspan>}
						</text>
					)}
				</g>
			))}
			{files.map((f) => (
				<g key={f.path} data-path={f.path} class="file-g" onClick={(e) => nearest(e as unknown as MouseEvent, f)}>
					<rect x={f.x} y={f.y} width={f.w} height={f.h} rx={5} class="file" />
					{f.label && (
						<text x={f.x + 6} y={f.y + 13} class="file-label" aria-hidden="true">
							{f.label !== f.name && <title>{f.path}</title>}
							{f.label}
							{f.withLines && <tspan class="file-lines"> {f.lines}</tspan>}
						</text>
					)}
					{f.bands.map((b) => (
						<g
							key={b.key}
							class="band-g"
							data-target={b.target}
							data-key={b.key}
							role="button"
							// SVG takes the attribute as written: lowercase, or it is not a tab index.
							{...{ tabindex: b === current ? 0 : -1 }}
							aria-label={`${b.name}, ${b.kind} in ${f.path}`}
							onMouseEnter={() => onHover(b)}
							onMouseLeave={() => onHover(null)}
							onFocus={() => (setActive(b.key), onHover(b))}
							onBlur={() => onHover(null)}
							onClick={() => onWhy(b.target)}
							onKeyDown={(e) => move(e as unknown as KeyboardEvent, b)}
						>
							<rect x={b.x} y={b.y} width={b.w} height={b.h} rx={2} class={`band band-${b.kind}`} />
						</g>
					))}
				</g>
			))}
			{/* Names drawn over the functions, apart from them: a function's accessible name is its full name. */}
			<g class="band-labels" aria-hidden="true">
				{files.flatMap((f) =>
					f.bands
						.filter((b) => b.label)
						.map((b) => (
							<text key={b.key} x={b.x + 5} y={labelY(b)} class="band-label">
								{b.label}
							</text>
						)),
				)}
			</g>
		</>
	);
}

/** Holding planes drawn around one spot; the "N waiting" pill stands for the rest. */
const MAX_CIRCLING = 3;

export function Airspace({ files, clearances, flights, agents, intents, flashes, selected, onSelect, onWhy }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 900, h: 600 });
	const [hover, setHover] = useState<Band | null>(null);
	const [fonts, setFonts] = useState(0);
	const headings = useRef(new Map<string, { x: number; y: number; angle: number }>());

	useEffect(() => {
		const el = ref.current!;
		const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		setSize({ w: el.clientWidth, h: el.clientHeight });
		return () => ro.disconnect();
	}, []);

	// Labels are cut to measured widths: measure again once the web fonts have arrived.
	useEffect(() => {
		const set = document.fonts;
		if (!set) return;
		const loaded = () => {
			glyphs.clear();
			setFonts((n) => n + 1);
		};
		set.ready.then(loaded);
		set.addEventListener("loadingdone", loaded);
		return () => set.removeEventListener("loadingdone", loaded);
	}, []);

	const mapH = Math.max(200, size.h - APRON - LEGEND);
	// In a big codebase, the files in play: those the Tower expects the intents to change, and those
	// flights have claimed or touched. The set only grows, so boxes don't come and go while agents work.
	const inPlay = useRef(new Set<string>());
	const big = files.length > FOCUS_ABOVE;
	const index = useMemo(() => (big ? symbolIndex(files) : null), [files, big]);
	if (index) {
		for (const i of Object.values(intents)) for (const t of predictTargets(i, index)) inPlay.current.add(t.split("#")[0]);
		for (const c of clearances) inPlay.current.add(c.target.split("#")[0]);
		for (const f of Object.values(flights)) for (const p of f.touched ?? []) inPlay.current.add(p);
	}
	const focusKey = big ? inPlay.current.size : -1;
	const { groupBoxes, fileBoxes, restBoxes, labels } = useMemo(() => layout(files, size.w, mapH, big ? inPlay.current : null), [files, size.w, mapH, focusKey, fonts]);
	// The same element while the code is unchanged, so planes and claims moving don't redraw it.
	const codeLayer = useMemo(() => <CodeLayer groups={groupBoxes} files={fileBoxes} rests={restBoxes} onHover={setHover} onWhy={onWhy} />, [groupBoxes, fileBoxes, restBoxes, onWhy]);

	const active = Object.values(flights).filter((f) => ACTIVE_STATUSES.includes(f.status));
	const claims = clearances
		.map((c) => ({ c, rect: rectFor(c.target, fileBoxes, groupBoxes, restBoxes), flight: flights[c.flightId] }))
		.filter((x) => x.rect && x.flight && ACTIVE_STATUSES.includes(x.flight.status));
	// Agents waiting for the same code share one outline: stacked, their fills would bury the function's name.
	const waitingOn = new Map<string, (typeof claims)[number]>();
	for (const x of claims) if (x.c.status === "holding" && (!waitingOn.has(x.c.target) || x.flight.id === selected)) waitingOn.set(x.c.target, x);
	const outlines = claims.filter((x) => x.c.status !== "holding" || waitingOn.get(x.c.target) === x);
	// A claim shows its flight's code at its right end only where that leaves every label whole.
	const tagFits = (r: Rect, code: string) => {
		const end = r.x + r.w - 4;
		const start = end - textWidth(code, TAG_FONT);
		const y = labelY(r);
		return start > r.x + 4 && !labels.some((l) => Math.abs(l.y - y) < 11 && l.x < end && l.end + 6 > start);
	};

	// With dozens of flights, or on a phone, the planes and their colors tell the story; tags would bury the map.
	const tagless = active.length > 30 || size.w < 640;
	// On a phone the planes' 44 pt targets would overlap at desktop spacing: spread them out.
	const spread = size.w < 640 ? 1.6 : 1;
	// Each plane keeps a target of its own: 44 pt for a finger, 28 pt for a pointer.
	const reach = touch || spread > 1 ? 44 : 28;
	// The text size the reader chose: tags and the apron's label grow with it.
	const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
	// A plane's tag, estimated from the CSS of .plane .tag with a little room to spare.
	const fs = 0.6875 * rem;
	const tagH = fs * 1.5 + 6;
	const tagW = (f: Flight) => {
		const agent = agents[f.agentId];
		const kind = KIND[agent?.kind ?? ""];
		return (
			25 +
			(kind ? textWidth(kind[0], `600 ${fs}px ${MONO}`) + 15 : 0) +
			textWidth(agent?.callsign ?? "?", `600 ${fs}px ${SANS}`) +
			4 +
			textWidth(f.code, `500 ${fs}px ${SANS}`) +
			(f.status !== "airborne" ? 20 + textWidth(statusLabel(f.status), `600 ${fs}px ${SANS}`) : 0)
		);
	};
	// Where each active flight is drawn. Taxiing ones line up in the apron after its label, far enough apart
	// for their tags, the last one too; when they need the room, the label says just "Taxiing".
	const cruising = active.filter((f) => !claims.some((x) => x.c.flightId === f.id));
	const positions = new Map<string, { x: number; y: number; orbit: boolean }>();
	const widest = tagless ? 0 : Math.max(0, ...cruising.map(tagW));
	const xEnd = size.w - 40 - widest;
	const after = (label: string) => 44 + textWidth(label, `400 ${0.7188 * rem}px ${SANS}`);
	const roomy = (x: number) => cruising.length <= 1 || (xEnd - x) / (cruising.length - 1) >= Math.max(widest + 27, reach);
	const apronLabel = roomy(after(APRON_LABEL)) ? APRON_LABEL : "Taxiing";
	const x0 = after(apronLabel);
	cruising.forEach((f, i) => {
		const x = cruising.length === 1 ? (x0 + xEnd) / 2 : x0 + (i / (cruising.length - 1)) * (xEnd - x0);
		positions.set(f.id, { x, y: APRON / 2 - 4, orbit: false });
	});
	// A flight sits on its primary claim: holding targets first (it circles them), then granted
	// symbols in source files, then anything else. Its other claims carry its color and code.
	const score = (x: (typeof claims)[number], f: Flight) =>
		(f.status === "holding" && x.c.status === "holding" ? 0 : 10) + (x.c.target.includes("#") ? 0 : 2) + (/^(test|tests|__tests__)\//.test(x.c.target) ? 4 : 0);
	for (const f of active) {
		if (positions.has(f.id)) continue;
		const mine = claims.filter((x) => x.c.flightId === f.id).sort((a, b) => score(a, f) - score(b, f));
		const primary = center(mine[0].rect!);
		positions.set(f.id, { x: primary.x, y: primary.y + APRON, orbit: f.status === "holding" });
	}

	// Flights sharing a spot: the cleared one sits on it, the rest stack in a holding ring around it.
	const buckets = new Map<string, string[]>();
	for (const [id, p] of positions) {
		const key = `${Math.round(p.x / 30)}:${Math.round(p.y / 22)}`;
		buckets.set(key, [...(buckets.get(key) ?? []), id]);
	}
	const showTag = new Set<string>();
	const hidden = new Set<string>();
	const crowded = active.length > 14;
	for (const ids of buckets.values()) {
		ids.sort((a, b) => (flights[a].status === "holding" ? 1 : 0) - (flights[b].status === "holding" ? 1 : 0) || flights[a].createdAt - flights[b].createdAt);
		const holders = ids.filter((id) => flights[id].status === "holding");
		const others = ids.filter((id) => flights[id].status !== "holding");
		others.forEach((id, i) => {
			const p = positions.get(id)!;
			positions.set(id, { ...p, x: p.x + i * 30 * spread, y: p.y + i * 22 * spread });
			if (!crowded || i === 0) showTag.add(id);
		});
		// The first in line circle the spot (and the selected flight, wherever it is in the queue).
		const circling = holders.slice(0, MAX_CIRCLING);
		if (selected && holders.indexOf(selected) >= MAX_CIRCLING) circling[MAX_CIRCLING - 1] = selected;
		for (const id of holders) if (!circling.includes(id)) hidden.add(id);
		const r = Math.min(80, 24 + circling.length * 4) * spread;
		circling.forEach((id, i) => {
			const p = positions.get(id)!;
			const a = (i / Math.max(circling.length, 1)) * Math.PI * 2 - Math.PI / 2;
			positions.set(id, { ...p, x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r * 0.6 });
			if (!crowded || i < 1) showTag.add(id);
		});
	}
	// Every plane stays whole on the map.
	const inside = (p: { x: number; y: number; orbit: boolean }) => ({ ...p, x: Math.min(Math.max(p.x, 22), size.w - 22), y: Math.min(Math.max(p.y, 22), size.h - 22) });
	for (const [id, p] of positions) positions.set(id, inside(p));
	// Planes closer than a target are nudged apart, so each keeps its own.
	const shown = [...positions.keys()].filter((id) => !hidden.has(id));
	for (let round = 0; round < 40; round++) {
		let moved = false;
		for (let i = 0; i < shown.length; i++) {
			for (let j = i + 1; j < shown.length; j++) {
				const a = positions.get(shown[i])!;
				const b = positions.get(shown[j])!;
				const d = Math.hypot(b.x - a.x, b.y - a.y);
				if (d >= reach - 0.5) continue;
				const [ux, uy] = d > 0.5 ? [(b.x - a.x) / d, (b.y - a.y) / d] : [1, 0];
				const push = (reach - d) / 2;
				positions.set(shown[i], inside({ ...a, x: a.x - ux * push, y: a.y - uy * push }));
				positions.set(shown[j], inside({ ...b, x: b.x + ux * push, y: b.y + uy * push }));
				moved = true;
			}
		}
		if (!moved) break;
	}
	if (tagless) showTag.clear();
	if (selected) showTag.add(selected);
	// A tag goes right of its plane and below it, unless that would cover another plane or tag, or leave the
	// map: then it tries above, then the left side, then level with the plane.
	const tagSide = new Map<string, { left: boolean; up: boolean; level: boolean }>();
	if (showTag.size) {
		const h = tagH;
		// A holding plane circles 20 px out from its spot, so its whole circle is taken.
		const planeBoxes = [...positions].filter(([id]) => !hidden.has(id)).map(([id, p]) => {
			const r = p.orbit ? 32 : 12;
			return { id, x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r };
		});
		const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
		// The names of directories, files and functions, and the apron's label: better left readable too.
		const texts = [...labels.map((l) => ({ x: l.x, y: l.y + APRON - 10, w: l.end - l.x, h: 13 })), { x: 14, y: 9, w: x0 - 44, h: 17 }];
		const legend = { x: 0, y: size.h - LEGEND, w: size.w, h: LEGEND };
		const placed: Rect[] = [];
		for (const id of [...showTag].sort((a, b) => (b === selected ? 1 : 0) - (a === selected ? 1 : 0))) {
			const f = flights[id];
			const p = positions.get(id);
			if (!f || !p) continue;
			const w = tagW(f);
			let best: { left: boolean; up: boolean; level: boolean; r: Rect; cost: number } | null = null;
			for (const [left, up, level] of [
				[false, false, false],
				[false, true, false],
				[true, false, false],
				[true, true, false],
				[false, false, true],
				[true, false, true],
			]) {
				const r = { x: left ? p.x - (level ? 18 : 13) - w : p.x + (level ? 18 : 13), y: level ? p.y - h / 2 : up ? p.y - 7 - h : p.y + 7, w, h };
				let cost = r.x < 0 || r.y < 0 || r.x + w > size.w || r.y + h > size.h ? 1e6 : 0;
				// Hiding an agent is worst, then another tag, then a name on the map, then the legend.
				for (const g of planeBoxes) if (g.id !== id) cost += 10 * overlap(r, g);
				for (const t of placed) cost += 2 * overlap(r, t);
				for (const t of texts) cost += 0.5 * overlap(r, t);
				cost += 0.1 * overlap(r, legend);
				if (!best || cost < best.cost) best = { left, up, level, r, cost };
				if (cost === 0) break;
			}
			placed.push(best!.r);
			tagSide.set(id, best!);
		}
	}
	const holdCounts = new Map<string, { x: number; y: number; n: number }>();
	for (const x of claims) {
		if (x.c.status !== "holding") continue;
		const c = center(x.rect!);
		const k = x.c.target;
		holdCounts.set(k, { x: x.rect!.x + x.rect!.w - 4, y: c.y, n: (holdCounts.get(k)?.n ?? 0) + 1 });
	}

	const flashTargets = new Map<string, Flash>();
	for (const fl of flashes) for (const t of fl.targets) flashTargets.set(t, fl);
	const flashRects = [...flashTargets.entries()]
		.map(([t, fl]) => ({ t, fl, rect: rectFor(t, fileBoxes, groupBoxes, restBoxes) }))
		.filter((x) => x.rect);

	// The hover card goes right of the function, or left of it where the map ends.
	const cardX = hover ? (hover.x + hover.w + 8 + 280 <= size.w ? hover.x + hover.w + 8 : Math.max(4, hover.x - 288)) : 0;

	return (
		<div class="airspace" ref={ref}>
			<div class="apron-label">{apronLabel}</div>
			<div class="legend">
				<span>
					<i class="lg-file" /> File
				</span>
				<span>
					<i class="lg-band" /> Function
				</span>
				<span>
					<svg viewBox="0 0 24 24" class="lg-plane" aria-hidden="true">
						<path d="M12 2c.8 0 1.4.7 1.4 1.6v6.1l7.6 4.6v2l-7.6-2.3v4.6l2.1 1.6V22L12 21l-3.5 1v-1.8l2.1-1.6V15L3 17.3v-2l7.6-4.6V3.6C10.6 2.7 11.2 2 12 2z" />
					</svg>{" "}
					<span class="lg-long">Agent on the code it is cleared to change</span>
					<span class="lg-short">Agent on code it may change</span>
				</span>
				<span>
					<i class="lg-hold" /> <span class="lg-long">Waiting for code another agent holds</span>
					<span class="lg-short">Waiting for held code</span>
				</span>
			</div>
			<svg width={size.w} height={size.h} class="map" role="group" aria-label="Map of the codebase: a block per directory, a box per file and a row per function. Arrow keys move between functions; Enter asks why one changed.">
				<defs>
					<pattern id="rest-files" width="9" height="9" patternUnits="userSpaceOnUse">
						<rect x="1" y="1" width="6" height="6" rx="1.2" class="rest-cell" />
					</pattern>
				</defs>
				<g transform={`translate(0, ${APRON})`}>
					{codeLayer}
					{outlines.map(({ c, rect, flight }) => {
						const agent = agents[flight.agentId];
						const color = agent?.color ?? "var(--agent-none)";
						return (
							<g key={c.id} class={`claim ${c.status}`} onClick={() => onSelect(flight.id)}>
								<rect
									x={rect!.x - 1}
									y={rect!.y - 1}
									width={rect!.w + 2}
									height={rect!.h + 2}
									rx={3}
									style={{ fill: color, stroke: color }}
									class={selected === flight.id ? "selected" : ""}
								/>
								{rect!.w > 70 && rect!.h >= 10 && c.status !== "holding" && tagFits(rect!, flight.code) && (
									<text x={rect!.x + rect!.w - 4} y={labelY(rect!)} class="claim-tag" style={{ fill: color }}>
										{flight.code}
									</text>
								)}
							</g>
						);
					})}
					{flashRects.map(({ t, fl, rect }) => (
						<rect key={`${fl.id}-${t}`} x={rect!.x - 3} y={rect!.y - 3} width={rect!.w + 6} height={rect!.h + 6} rx={4} class={`flash flash-${fl.kind}`} />
					))}
				</g>
			</svg>
			{active.map((f) => {
				if (hidden.has(f.id)) return null;
				const p = positions.get(f.id)!;
				const agent = agents[f.agentId];
				const intent = intents[f.intentId];
				const prev = headings.current.get(f.id);
				let angle = prev?.angle ?? -35;
				if (prev && (Math.abs(prev.x - p.x) > 4 || Math.abs(prev.y - p.y) > 4)) angle = (Math.atan2(p.y - prev.y, p.x - prev.x) * 180) / Math.PI + 90;
				headings.current.set(f.id, { x: p.x, y: p.y, angle });
				return (
					<div
						key={f.id}
						data-flight={f.code}
						class={`plane ${f.status} ${selected === f.id ? "selected" : ""}`}
						style={{ transform: `translate(${p.x}px, ${p.y}px)`, "--c": agent?.color ?? "var(--agent-none)" } as any}
						title={intent ? `INT-${intent.seq} ${intent.title}` : ""}
						{...pressable(() => onSelect(f.id))}
						aria-pressed={selected === f.id}
					>
						<div class={p.orbit ? "orbit" : "steady"}>
							<svg viewBox="0 0 24 24" class="glyph" aria-hidden="true" style={{ transform: `rotate(${p.orbit ? 90 : angle}deg)` }}>
								<path d="M12 2c.8 0 1.4.7 1.4 1.6v6.1l7.6 4.6v2l-7.6-2.3v4.6l2.1 1.6V22L12 21l-3.5 1v-1.8l2.1-1.6V15L3 17.3v-2l7.6-4.6V3.6C10.6 2.7 11.2 2 12 2z" />
							</svg>
						</div>
						{showTag.has(f.id) ? (
							<div class={`tag${tagSide.get(f.id)?.left ? " left" : ""}${tagSide.get(f.id)?.up ? " up" : ""}${tagSide.get(f.id)?.level ? " level" : ""}`}>
								<KindBadge kind={agent?.kind} />
								<b>{agent?.callsign ?? "?"}</b> {f.code}
								{f.status !== "airborne" && <span class={`st st-${f.status}`}>{statusLabel(f.status)}</span>}
								{intent && <span class="sr-only">: INT-{intent.seq} {intent.title}</span>}
							</div>
						) : (
							<span class="sr-only">
								{agent?.callsign ?? "Agent"} {f.code}, {statusLabel(f.status)}
								{intent ? `: INT-${intent.seq} ${intent.title}` : ""}
							</span>
						)}
					</div>
				);
			})}
			{[...holdCounts.entries()]
				.filter(([, h]) => h.n > 1)
				.map(([t, h]) => (
					<div key={`hc-${t}`} class="holdcount" style={{ left: `${h.x - 64}px`, top: `${h.y + APRON - 8}px` }}>
						{h.n} waiting
					</div>
				))}
			{hover && (
				<div class="hovercard" style={{ left: `${cardX}px`, top: `${Math.min(hover.y + APRON, size.h - 64)}px` }}>
					<div class="mono">{hover.target}</div>
					<div class="muted">
						{hover.kind} · {touch ? "tap" : "click"} to see why it changed
					</div>
				</div>
			)}
		</div>
	);
}
