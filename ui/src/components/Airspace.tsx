import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Agent, Clearance, Flight, Intent, TrunkFile } from "../../../src/shared/types";
import { ACTIVE_STATUSES, type Flash } from "../store";

interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface Band extends Rect {
	target: string;
	name: string;
	kind: string;
	depth: number;
}

interface FileBox extends Rect {
	path: string;
	name: string;
	lines: number;
	bands: Band[];
	content: Rect;
}

interface GroupBox extends Rect {
	name: string;
}

const HEADER = 18;
const APRON = 54;

function layout(files: TrunkFile[], width: number, height: number) {
	const groups = new Map<string, TrunkFile[]>();
	for (const f of files) {
		const dir = f.path.includes("/") ? f.path.split("/")[0] : "·";
		if (!groups.has(dir)) groups.set(dir, []);
		groups.get(dir)!.push(f);
	}
	const data = {
		name: "root",
		children: [...groups.entries()].map(([name, fs]) => ({ name, children: fs.map((f) => ({ name: f.path, file: f, value: Math.max(f.lines, 10) })) })),
	};
	// Stable ordering keeps the map from reshuffling as files grow: src/ first, root last, files by path.
	const rank = (name: string) => (name === "src" ? 0 : name === "·" ? 2 : 1);
	const root = hierarchy<any>(data)
		.sum((d) => d.value ?? 0)
		.sort((a, b) => (a.depth === 1 ? rank(a.data.name) - rank(b.data.name) || a.data.name.localeCompare(b.data.name) : a.data.name.localeCompare(b.data.name)));
	treemap<any>().size([width, height]).tile(treemapSquarify.ratio(1.15)).paddingOuter(4).paddingTop(22).paddingInner(5).round(true)(root);

	const groupBoxes: GroupBox[] = [];
	const fileBoxes: FileBox[] = [];
	for (const g of root.children ?? []) {
		const gb = g as any;
		groupBoxes.push({ name: gb.data.name === "·" ? "root" : `${gb.data.name}/`, x: gb.x0, y: gb.y0, w: gb.x1 - gb.x0, h: gb.y1 - gb.y0 });
		for (const leaf of g.children ?? []) {
			const l = leaf as any;
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
				content: { x: l.x0 + 3, y: l.y0 + HEADER, w: l.x1 - l.x0 - 6, h: Math.max(0, l.y1 - l.y0 - HEADER - 3) },
			};
			const lines = Math.max(f.lines, 1);
			for (const s of f.symbols) {
				const depth = s.name.includes(".") ? 1 : 0;
				const y = box.content.y + ((s.start - 1) / lines) * box.content.h;
				const h = Math.max(3, ((s.end - s.start + 1) / lines) * box.content.h);
				box.bands.push({ target: `${f.path}#${s.name}`, name: s.name, kind: s.kind, depth, x: box.content.x + depth * 9, y, w: box.content.w - depth * 9, h });
			}
			fileBoxes.push(box);
		}
	}
	return { groupBoxes, fileBoxes };
}

/** Screen rectangle for a clearance target; unknown symbols (new code) get a stub at the file's end. */
function rectFor(target: string, files: FileBox[], groups: GroupBox[]): Rect | null {
	const [path, symbol] = target.split("#");
	if (path.endsWith("/")) {
		const g = groups.find((g) => g.name === path);
		return g ?? null;
	}
	const file = files.find((f) => f.path === path);
	if (!file) return null;
	if (!symbol) return file.content;
	const band = file.bands.find((b) => b.name === symbol) ?? file.bands.find((b) => symbol.startsWith(`${b.name}.`));
	if (band) return band;
	return { x: file.content.x + file.content.w * 0.55, y: file.content.y + file.content.h - 10, w: file.content.w * 0.45, h: 8 };
}

const center = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

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

export function Airspace({ files, clearances, flights, agents, intents, flashes, selected, onSelect, onWhy }: Props) {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ w: 900, h: 600 });
	const [hover, setHover] = useState<Band | null>(null);
	const headings = useRef(new Map<string, { x: number; y: number; angle: number }>());

	useEffect(() => {
		const el = ref.current!;
		const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
		ro.observe(el);
		setSize({ w: el.clientWidth, h: el.clientHeight });
		return () => ro.disconnect();
	}, []);

	const mapH = Math.max(200, size.h - APRON);
	const { groupBoxes, fileBoxes } = useMemo(() => layout(files, size.w, mapH), [files, size.w, mapH]);

	const active = Object.values(flights).filter((f) => ACTIVE_STATUSES.includes(f.status));
	const claims = clearances
		.map((c) => ({ c, rect: rectFor(c.target, fileBoxes, groupBoxes), flight: flights[c.flightId] }))
		.filter((x) => x.rect && x.flight && ACTIVE_STATUSES.includes(x.flight.status));

	// Where each active flight is drawn.
	const cruising = active.filter((f) => !claims.some((x) => x.c.flightId === f.id));
	const positions = new Map<string, { x: number; y: number; orbit: boolean }>();
	cruising.forEach((f, i) => {
		const slot = (i + 0.5) / Math.max(cruising.length, 1);
		positions.set(f.id, { x: 40 + slot * (size.w - 80), y: APRON / 2 - 4, orbit: false });
	});
	// A flight sits on its primary claim: holding targets first (it circles them), then granted
	// symbols in source files, then anything else. Thin connectors point at its other claims.
	const score = (x: (typeof claims)[number], f: Flight) =>
		(f.status === "holding" && x.c.status === "holding" ? 0 : 10) + (x.c.target.includes("#") ? 0 : 2) + (/^(test|tests|__tests__)\//.test(x.c.target) ? 4 : 0);
	const connectors: { from: string; to: { x: number; y: number }; color: string }[] = [];
	for (const f of active) {
		if (positions.has(f.id)) continue;
		const mine = claims.filter((x) => x.c.flightId === f.id).sort((a, b) => score(a, f) - score(b, f));
		const primary = center(mine[0].rect!);
		positions.set(f.id, { x: primary.x, y: primary.y + APRON, orbit: f.status === "holding" });
		const color = agents[f.agentId]?.color ?? "#94a3b8";
		for (const other of mine.slice(1)) connectors.push({ from: f.id, to: center(other.rect!), color });
	}

	// Flights sharing a spot: the cleared one sits on it, the rest stack in a holding ring around it.
	const buckets = new Map<string, string[]>();
	for (const [id, p] of positions) {
		const key = `${Math.round(p.x / 30)}:${Math.round(p.y / 22)}`;
		buckets.set(key, [...(buckets.get(key) ?? []), id]);
	}
	const showTag = new Set<string>();
	const crowded = active.length > 14;
	for (const ids of buckets.values()) {
		ids.sort((a, b) => (flights[a].status === "holding" ? 1 : 0) - (flights[b].status === "holding" ? 1 : 0) || flights[a].createdAt - flights[b].createdAt);
		const holders = ids.filter((id) => flights[id].status === "holding");
		const others = ids.filter((id) => flights[id].status !== "holding");
		others.forEach((id, i) => {
			const p = positions.get(id)!;
			positions.set(id, { ...p, x: p.x + i * 30, y: p.y + i * 22 });
			if (!crowded || i === 0) showTag.add(id);
		});
		const r = Math.min(80, 24 + holders.length * 4);
		holders.forEach((id, i) => {
			const p = positions.get(id)!;
			const a = (i / Math.max(holders.length, 1)) * Math.PI * 2 - Math.PI / 2;
			positions.set(id, { ...p, x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r * 0.6 });
			if (!crowded || i < 1) showTag.add(id);
		});
	}
	if (selected) showTag.add(selected);
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
		.map(([t, fl]) => ({ t, fl, rect: rectFor(t, fileBoxes, groupBoxes) }))
		.filter((x) => x.rect);

	return (
		<div class="airspace" ref={ref}>
			<div class="sweep" />
			<div class="apron-label">AIRSPACE · flights without clearance cruise here</div>
			<svg width={size.w} height={size.h} class="map">
				<g transform={`translate(0, ${APRON})`}>
					{groupBoxes.map((g) => (
						<g key={g.name}>
							<rect x={g.x} y={g.y} width={g.w} height={g.h} rx={8} class="group" />
							<text x={g.x + 8} y={g.y + 15} class="group-label">
								{g.name}
							</text>
						</g>
					))}
					{fileBoxes.map((f) => (
						<g key={f.path}>
							<rect x={f.x} y={f.y} width={f.w} height={f.h} rx={5} class="file" />
							{f.w > 40 && (
								<text x={f.x + 6} y={f.y + 13} class="file-label">
									{f.name}
									<tspan class="file-lines"> {f.lines}</tspan>
								</text>
							)}
							{f.bands.map((b) => (
								<g key={b.target} class="band-g" onMouseEnter={() => setHover(b)} onMouseLeave={() => setHover(null)} onClick={() => onWhy(b.target)}>
									<rect x={b.x} y={b.y} width={b.w} height={b.h} rx={2} class={`band band-${b.kind}`} />
									{b.h >= 11 && b.w > 50 && !(b.kind === "class" && f.bands.some((m) => m.depth === 1 && m.target.startsWith(`${b.target}.`) && m.y - b.y < 12)) && (
										<text x={b.x + 5} y={b.y + Math.min(b.h / 2 + 4, 12)} class="band-label">
											{b.name.split(".").pop()}
										</text>
									)}
								</g>
							))}
						</g>
					))}
					{claims.map(({ c, rect, flight }) => {
						const agent = agents[flight.agentId];
						const color = agent?.color ?? "#94a3b8";
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
								{rect!.w > 70 && rect!.h >= 10 && (c.status !== "holding" || !crowded) && (
									<text
										x={rect!.x + rect!.w - 4}
										y={c.status === "holding" ? rect!.y + rect!.h - 4 : rect!.y + Math.min(rect!.h / 2 + 4, 12)}
										class="claim-tag"
										style={{ fill: color }}
									>
										{c.status === "holding" ? `⏳ ${flight.code}` : flight.code}
									</text>
								)}
							</g>
						);
					})}
					{connectors.map((k, i) => {
						const p = positions.get(k.from)!;
						return <line key={`k${i}`} x1={p.x} y1={p.y - APRON} x2={k.to.x} y2={k.to.y} class="connector" style={{ stroke: k.color }} />;
					})}
					{[...holdCounts.entries()]
						.filter(([, h]) => h.n > 1)
						.map(([t, h]) => (
							<g key={`hc-${t}`} class="holdcount">
								<rect x={h.x - 34} y={h.y - 8} width={34} height={16} rx={8} />
								<text x={h.x - 17} y={h.y + 4}>
									⏳{h.n}
								</text>
							</g>
						))}
					{flashRects.map(({ t, fl, rect }) => (
						<rect key={`${fl.id}-${t}`} x={rect!.x - 3} y={rect!.y - 3} width={rect!.w + 6} height={rect!.h + 6} rx={4} class={`flash flash-${fl.kind}`} />
					))}
				</g>
			</svg>
			{active.map((f) => {
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
						class={`plane ${f.status} ${selected === f.id ? "selected" : ""}`}
						style={{ transform: `translate(${p.x}px, ${p.y}px)`, "--c": agent?.color ?? "#e2e8f0" } as any}
						onClick={() => onSelect(f.id)}
						title={intent ? `INT-${intent.seq} ${intent.title}` : ""}
					>
						<div class={p.orbit ? "orbit" : "steady"}>
							<svg viewBox="0 0 24 24" class="glyph" style={{ transform: `rotate(${p.orbit ? 90 : angle}deg)` }}>
								<path d="M12 2c.8 0 1.4.7 1.4 1.6v6.1l7.6 4.6v2l-7.6-2.3v4.6l2.1 1.6V22L12 21l-3.5 1v-1.8l2.1-1.6V15L3 17.3v-2l7.6-4.6V3.6C10.6 2.7 11.2 2 12 2z" />
							</svg>
						</div>
						{showTag.has(f.id) && (
							<div class="tag">
								<b>{agent?.callsign ?? "?"}</b> {f.code}
								{f.status !== "airborne" && <span class={`st st-${f.status}`}>{f.status}</span>}
							</div>
						)}
					</div>
				);
			})}
			{hover && (
				<div class="hovercard" style={{ left: Math.min(hover.x + hover.w + 8, size.w - 230), top: hover.y + APRON }}>
					<div class="mono">{hover.target}</div>
					<div class="muted">{hover.kind} · click for its contrail</div>
				</div>
			)}
		</div>
	);
}
