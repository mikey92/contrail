// Three-way text merge with structured conflicts.
//
// On top of a classic diff3 merge, Contrail resolves the most common "false" conflict produced by
// parallel agents: two agents inserting new code at the same spot (both appending a function at
// the end of a file, both adding an import). Those insert/insert hunks are unioned. Everything
// else that overlaps is reported as a structured conflict — base, ours (trunk) and theirs (the
// landing flight) — together with the symbols it touches, so the agent that has to resolve it
// gets the exact functions and the context of whoever changed them.
import { diffIndices } from "node-diff3";
import { extractSymbols, languageOf, symbolsByLine, symbolsInRange, TOP, type SymbolSpan } from "./symbols";

export interface ConflictHunk {
	/** 1-based first base line of the conflicting region (insertion point when baseLines is empty). */
	baseStart: number;
	baseLines: string[];
	ours: string[];
	theirs: string[];
	/** Symbols of the file this hunk touches, e.g. ["applyDiscount"]. */
	symbols: string[];
}

export interface TextMergeResult {
	clean: boolean;
	/** Merged text; with conflict markers when not clean. */
	text: string;
	conflicts: ConflictHunk[];
	/** Insert/insert hunks that were resolved by keeping both sides. */
	unioned: number;
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

/**
 * A line diff takes time growing with the square of the lines, or worse (a lockfile's near-identical lines):
 * texts up to this many lines in all are diffed as they always were; longer ones with Myers' algorithm, quick
 * when little changed, and patience diff's anchors where much did.
 */
export const MAX_DIFF_LINES = 2000;

interface LineDiff {
	buffer1: [number, number];
	buffer1Content: string[];
	buffer2: [number, number];
	buffer2Content: string[];
}

/** Most lines Myers' diff of a stretch may change before the stretch is split at anchors (or is one change). */
const MAX_EDITS = 1000;
/** How many times a stretch is split at anchors, and its parts at their own anchors, at most. */
const MAX_SPLITS = 8;

/**
 * The shortest edit script from `a` to `b` (Myers, as git diffs), as hunks: time grows with the length times the
 * lines changed, so an edit or two to a long file is quick. Null past `maxEdits` changed lines.
 */
function myers(a: string[], b: string[], maxEdits: number): LineDiff[] | null {
	const n = a.length;
	const m = b.length;
	const off = n + m + 1;
	const v = new Int32Array(2 * off + 1);
	// v as it was before each round d, for the way back: only its entries -d…d matter.
	const trace: Int32Array[] = [];
	let found = -1;
	for (let d = 0; d <= Math.min(maxEdits, n + m) && found < 0; d++) {
		trace.push(v.slice(off - d, off + d + 1));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[off + k] = x;
			if (x >= n && y >= m) {
				found = d;
				break;
			}
		}
	}
	if (found < 0) return null;
	// Back from the end: each round added one deletion (a line of `a`) or one insertion (a line of `b`).
	const edits: { del: boolean; ai: number; bi: number }[] = [];
	let x = n;
	let y = m;
	for (let d = found; d > 0; d--) {
		const prev = trace[d];
		const at = (k: number) => prev[k + d];
		const k = x - y;
		const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
		const pk = down ? k + 1 : k - 1;
		const px = at(pk);
		const py = px - pk;
		// From (px, py), one line of `b` inserted (down) or of `a` deleted, then equal lines up to (x, y).
		edits.push({ del: !down, ai: px, bi: py });
		x = px;
		y = py;
	}
	edits.reverse();
	// Edits next to each other make one hunk.
	const out: LineDiff[] = [];
	for (const e of edits) {
		const h = out[out.length - 1];
		const aEnd = h ? h.buffer1[0] + h.buffer1[1] : -1;
		const bEnd = h ? h.buffer2[0] + h.buffer2[1] : -1;
		if (h && e.ai === aEnd && e.bi === bEnd) {
			if (e.del) h.buffer1Content.push(a[e.ai]), h.buffer1[1]++;
			else h.buffer2Content.push(b[e.bi]), h.buffer2[1]++;
		} else
			out.push(
				e.del
					? { buffer1: [e.ai, 1], buffer1Content: [a[e.ai]], buffer2: [e.bi, 0], buffer2Content: [] }
					: { buffer1: [e.ai, 0], buffer1Content: [], buffer2: [e.bi, 1], buffer2Content: [b[e.bi]] },
			);
	}
	return out;
}

/**
 * diffIndices, bounded: texts too long for it are diffed with Myers' algorithm, which is quick when little
 * changed, and split where much did (see stretchDiff).
 */
export function diffLines(a: string[], b: string[]): LineDiff[] {
	return lineDiff(a, b, a.length + b.length > MAX_DIFF_LINES);
}

/**
 * diffLines with the algorithm chosen: diffIndices, or for `long` texts Myers' (from their first different line).
 * A merge diffs both its sides with the same one: one change made on both sides has to line up the same in both
 * diffs (in a run of `}` or blank lines, say), or the merge keeps it twice or drops a line.
 */
function lineDiff(a: string[], b: string[], long: boolean): LineDiff[] {
	// Short texts as they always were (another algorithm can line up a run of blank lines or `}` differently).
	if (!long)
		return diffIndices<string>(a, b).map((d) => ({ buffer1: d.buffer1, buffer1Content: d.buffer1Content, buffer2: d.buffer2, buffer2Content: d.buffer2Content }));
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	const out: LineDiff[] = [];
	stretchDiff(a.slice(head), b.slice(head), head, head, out, 0);
	return out;
}

/**
 * Myers' diff of a stretch (at `aAt` and `bAt` in the whole texts), into `out`. Past MAX_EDITS, patience diff's
 * anchors split it: the lines each side has exactly once, in an order both keep. The parts between them are
 * diffed the same way, and a part with too many changes and no anchor is one hunk. A change both sides of a merge
 * made still lines up as Myers' lines it up: no anchor lies among the lines it could slide over (with the change
 * in, such a line would be there twice).
 */
function stretchDiff(a: string[], b: string[], aAt: number, bAt: number, out: LineDiff[], splits: number): void {
	if (!a.length && !b.length) return;
	const hunks = myers(a, b, MAX_EDITS);
	if (hunks) {
		for (const h of hunks) out.push({ ...h, buffer1: [h.buffer1[0] + aAt, h.buffer1[1]], buffer2: [h.buffer2[0] + bAt, h.buffer2[1]] });
		return;
	}
	const anchors = splits < MAX_SPLITS ? increasing(uniquePairs(a, b)) : [];
	if (!anchors.length) {
		out.push({ buffer1: [aAt, a.length], buffer1Content: a, buffer2: [bAt, b.length], buffer2Content: b });
		return;
	}
	let i = 0;
	let j = 0;
	for (const [ai, bj] of [...anchors, [a.length, b.length]]) {
		stretchDiff(a.slice(i, ai), b.slice(j, bj), aAt + i, bAt + j, out, splits + 1);
		i = ai + 1;
		j = bj + 1;
	}
}

/** The lines `a` and `b` each have exactly once, as [index in a, index in b], in a's order. */
function uniquePairs(a: string[], b: string[]): [number, number][] {
	// Index in a, or -1 for a line a has twice.
	const inA = new Map<string, number>();
	for (let i = 0; i < a.length; i++) inA.set(a[i], inA.has(a[i]) ? -1 : i);
	const inB = new Map<string, number>();
	for (let j = 0; j < b.length; j++) if ((inA.get(b[j]) ?? -1) >= 0) inB.set(b[j], inB.has(b[j]) ? -1 : j);
	const pairs: [number, number][] = [];
	for (const [line, j] of inB) if (j >= 0) pairs.push([inA.get(line)!, j]);
	return pairs.sort((x, y) => x[0] - y[0]);
}

/** The longest run of `pairs` (in a's order) whose indices in b go up too (patience sorting). */
function increasing(pairs: [number, number][]): [number, number][] {
	// tails[n]: the pair ending the best run of n + 1 found so far (the one with the lowest index in b).
	const tails: number[] = [];
	const before = new Int32Array(pairs.length).fill(-1);
	for (let k = 0; k < pairs.length; k++) {
		let lo = 0;
		let hi = tails.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (pairs[tails[mid]][1] < pairs[k][1]) lo = mid + 1;
			else hi = mid;
		}
		if (lo > 0) before[k] = tails[lo - 1];
		tails[lo] = k;
	}
	const run: [number, number][] = [];
	for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = before[k]) run.push(pairs[k]);
	return run.reverse();
}

/** Appends `lines` one by one: spread into one call, a long file's lines overflow the stack. */
function append(out: string[], lines: string[]): void {
	for (const line of lines) out.push(line);
}

type Merged = { ok: string[]; conflict?: undefined } | { conflict: { a: string[]; o: string[]; b: string[]; oIndex: number; aIndex: number; bIndex: number }; ok?: undefined };

/**
 * A diff3 merge (node-diff3's, MIT) over lineDiff: alternating runs of merged lines and conflicts between what
 * `a` and `b` each made of `o`. Both sides making the same change is no conflict.
 */
function diff3(a: string[], o: string[], b: string[]): Merged[] {
	const long = o.length + Math.max(a.length, b.length) > MAX_DIFF_LINES;
	const hunks = [
		...lineDiff(o, a, long).map((h) => ({ side: "a" as const, oStart: h.buffer1[0], oLength: h.buffer1[1], start: h.buffer2[0], length: h.buffer2[1] })),
		...lineDiff(o, b, long).map((h) => ({ side: "b" as const, oStart: h.buffer1[0], oLength: h.buffer1[1], start: h.buffer2[0], length: h.buffer2[1] })),
	].sort((x, y) => x.oStart - y.oStart);
	const out: Merged[] = [];
	let ok: string[] = [];
	const flush = () => {
		if (ok.length) out.push({ ok });
		ok = [];
	};
	let at = 0;
	for (let i = 0; i < hunks.length; ) {
		const first = hunks[i];
		const regionStart = first.oStart;
		let regionEnd = first.oStart + first.oLength;
		const region = [hunks[i++]];
		// Hunks of either side that overlap (or touch) this region join it.
		while (i < hunks.length && hunks[i].oStart <= regionEnd) {
			regionEnd = Math.max(regionEnd, hunks[i].oStart + hunks[i].oLength);
			region.push(hunks[i++]);
		}
		append(ok, o.slice(at, regionStart));
		if (region.length === 1) {
			// One side changed this stretch and the other left it alone.
			append(ok, (first.side === "a" ? a : b).slice(first.start, first.start + first.length));
		} else {
			// Each side's span over the region, corrected for the stretch of `o` its hunks cover. (A side with no
			// hunk here left the region as `o` has it, shifted by what it changed before.)
			const span = (side: "a" | "b", text: string[]) => {
				const mine = region.filter((h) => h.side === side);
				if (!mine.length) {
					const shift = hunks.filter((h) => h.side === side && h.oStart + h.oLength <= regionStart).reduce((n, h) => n + h.length - h.oLength, 0);
					return { start: regionStart + shift, content: o.slice(regionStart, regionEnd) };
				}
				const start = mine[0].start + (regionStart - mine[0].oStart);
				const end = mine.reduce((n, h) => Math.max(n, h.start + h.length), 0) + (regionEnd - mine.reduce((n, h) => Math.max(n, h.oStart + h.oLength), 0));
				return { start, content: text.slice(start, end) };
			};
			const as = span("a", a);
			const bs = span("b", b);
			if (sameLines(as.content, bs.content)) append(ok, as.content);
			else {
				flush();
				out.push({ conflict: { a: as.content, aIndex: as.start, o: o.slice(regionStart, regionEnd), oIndex: regionStart, b: bs.content, bIndex: bs.start } });
			}
		}
		at = regionEnd;
	}
	append(ok, o.slice(at));
	flush();
	return out;
}

/** The first line of an import statement: JavaScript, TypeScript, Python, Go, Java, Kotlin, Swift and the like. */
const IMPORT_LINE = /^(?:import\b|from\s+\S+\s+import\b)/;
/** The first line of an import over several lines, and the line that ends it (both without a trailing comment). */
const IMPORT_OPENS: [RegExp, RegExp][] = [
	// JavaScript: import { … } from "x";
	[/^import\b[^"'{;]*\{[^}]*$/, /^\s*\}\s*from\s*["']/],
	// Python: from x import ( … )
	[/^from\s+\S+\s+import\s*\([^)]*$/, /\)$/],
	// Go: import ( … )
	[/^import\s*\($/, /^\)$/],
];
/** How far an import over several lines is looked for its last line. */
const MAX_IMPORT_LINES = 1000;

/** A line without its trailing comment (`//`, `#` or a block comment after the line's last quote). */
function bare(line: string): string {
	const quote = Math.max(line.lastIndexOf('"'), line.lastIndexOf("'"), line.lastIndexOf("`"));
	let cut = line.length;
	for (const mark of ["//", "#", "/*"]) {
		const at = line.indexOf(mark, quote + 1);
		if (at !== -1 && at < cut) cut = at;
	}
	return line.slice(0, cut).trimEnd();
}

/**
 * The import statements in `lines`, each whole (one line or several) with its line span and a key to compare
 * it by (its lines without comments or indentation). An import over several lines whose last line isn't
 * there (before the next unindented line) is no statement this can compare: its lines are left alone.
 */
function importStatements(lines: string[]): { from: number; to: number; key: string }[] {
	const out: { from: number; to: number; key: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = bare(lines[i]);
		if (!IMPORT_LINE.test(line)) continue;
		const ends = IMPORT_OPENS.find(([opens]) => opens.test(line))?.[1];
		if (!ends) {
			out.push({ from: i, to: i, key: line });
			continue;
		}
		let j = i + 1;
		while (j < lines.length && j - i < MAX_IMPORT_LINES && !ends.test(bare(lines[j])) && !/^\S/.test(lines[j])) j++;
		if (j < lines.length && ends.test(bare(lines[j]))) {
			out.push({ from: i, to: j, key: lines.slice(i, j + 1).map((l) => bare(l).trim()).join("\n") });
			i = j;
		}
	}
	return out;
}

/** `b` without the import statements `a` has too. */
function withoutSharedImports(a: string[], b: string[]): string[] {
	const ours = new Set(importStatements(a).map((s) => s.key));
	const drop = new Set<number>();
	for (const s of importStatements(b)) if (ours.has(s.key)) for (let k = s.from; k <= s.to; k++) drop.add(k);
	return b.filter((_, k) => !drop.has(k));
}

/** Words between `const`, `let`, `var` or `val` and the name (C, C++, Kotlin): types and modifiers, not names. */
const TYPE_WORDS = "enum|val|mut|int|unsigned|signed|long|short|char|float|double|bool|auto|static|struct|volatile|size_t|u?int\\d*_t";
/** Top-level declarations in code without a rule of its own (C, C++, Java, Kotlin, Swift, C#, PHP, Vue and others). */
const ANY_DECLARATION = new RegExp(`^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|def|fn|func|fun|(?:const|let|var|val)(?:\\s+(?:${TYPE_WORDS}))*)\\s+([\\w$]+)`);
/** Top-level declarations by language: the name each declares. */
const DECLARATIONS: Record<string, RegExp> = {
	// Not `interface`: TypeScript merges two interfaces of the same name.
	js: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const\s+enum|enum|const|let|var|type)\s+([\w$]+)/,
	py: /^(?:async\s+)?(?:def|class)\s+(\w+)/,
	go: /^(?:func|type|var|const)\s+(\w+)/,
	rust: /^(?:pub(?:\([^)]*\))?\s+)?(?:const\s+|async\s+|unsafe\s+)*(?:fn|struct|enum|trait|union|type|mod|const|static(?:\s+mut)?)\s+(\w+)/,
	ruby: /^(?:def|class|module)\s+([\w:.]+)/,
};
/** Prose and data: a line there that starts with "let" or "class" declares nothing. */
const PROSE = /\.(?:md|markdown|txt|rst|adoc|org|json|ya?ml|toml|csv|tsv|lock|ini|cfg|conf|xml|svg|html?|css|scss|less)$/i;

/** Names both inserts declare at the top level: kept side by side, the file would declare them twice. */
function declaredTwice(path: string, a: string[], b: string[]): string[] {
	const lang = languageOf(path);
	const re = DECLARATIONS[lang] ?? (PROSE.test(path) ? null : ANY_DECLARATION);
	if (!re) return [];
	const names = (lines: string[]) => new Set(lines.flatMap((l) => re.exec(l)?.[1] ?? []));
	const ours = names(a);
	// `_` names nothing (Go's `var _ Shape = (*Box)(nil)`, Python's `def _` registered for one type), and a Go
	// file may have any number of `init` functions.
	return [...names(b)].filter((n) => ours.has(n) && n !== "_" && !(lang === "go" && n === "init"));
}

/**
 * Languages where two members of one name can't stand side by side: the later replaces the earlier (JavaScript,
 * Python, Ruby) or the code won't build (Go). The Java and C families overload a name by its parameters, and Rust
 * implements one for several traits.
 */
const ONE_MEMBER_PER_NAME = new Set(["js", "py", "ruby", "go"]);

/**
 * A member (method) declared at `s`, keyed by what tells it from others of its name: in JavaScript whether it is
 * static, and a getter and a setter of one name are a pair; in Ruby whether it is the class's own (`def self.x`).
 * Null for a Python property's setter or deleter, an overload or a registered implementation, which share a name
 * by design.
 */
function memberKey(lang: string, lines: string[], s: SymbolSpan): { name: string; key: string; accessor: string | null } | null {
	const short = s.name.slice(s.name.lastIndexOf(".") + 1).replace(/\$/g, "\\$");
	// Decorators come first: the declaration is the first line that names the member.
	const span = lines.slice(s.start - 1, s.end);
	if (lang === "js") {
		const declaration = new RegExp(`^\\s*((?:\\w+\\s+)*)\\*?\\s*${short}\\s*[<(]`);
		const words = declaration.exec(span.find((l) => declaration.test(l)) ?? "")?.[1].split(/\s+/) ?? [];
		return { name: s.name, key: `${words.includes("static") ? "static " : ""}${s.name}`, accessor: words.includes("get") ? "get" : words.includes("set") ? "set" : null };
	}
	if (lang === "py") {
		const decorators = span.slice(0, Math.max(0, span.findIndex((l) => /^\s*(?:async\s+)?def\s/.test(l))));
		if (decorators.some((d) => new RegExp(`^\\s*@(?:(?:typing\\.)?overload\\b|${short}\\.\\w+|[\\w.]+\\.register\\b)`).test(d))) return null;
	}
	if (lang === "ruby" && /^\s*def\s+self\./.test(span.find((l) => /^\s*def\s/.test(l)) ?? "")) return { name: s.name, key: `self.${s.name}`, accessor: null };
	return { name: s.name, key: s.name, accessor: null };
}

export function mergeText(path: string, base: string, ours: string, theirs: string): TextMergeResult {
	if (ours === theirs) return { clean: true, text: ours, conflicts: [], unioned: 0 };
	if (base === ours) return { clean: true, text: theirs, conflicts: [], unioned: 0 };
	if (base === theirs) return { clean: true, text: ours, conflicts: [], unioned: 0 };

	const o = base.split("\n");
	const a = ours.split("\n");
	const b = theirs.split("\n");
	const regions = diff3(a, o, b);
	const baseSymbols = extractSymbols(path, base);
	// Members (methods) each side declares that base doesn't, read when two inserts meet. Top-level names are
	// declaredTwice's (which knows TypeScript merges two interfaces of one name).
	const baseNames = new Set(baseSymbols.map((s) => s.name));
	const lang = languageOf(path);
	let sides: [SymbolSpan[], SymbolSpan[]] | null = null;
	const declaredIn = (symbols: SymbolSpan[], lines: string[], from: number, count: number) =>
		symbols.flatMap((s) => {
			if (s.kind !== "method" || s.start - 1 < from || s.start - 1 >= from + count || baseNames.has(s.name)) return [];
			return memberKey(lang, lines, s) ?? [];
		});

	const out: string[] = [];
	const conflicts: ConflictHunk[] = [];
	let unioned = 0;
	for (const region of regions) {
		if ("ok" in region && region.ok) {
			append(out, region.ok);
			continue;
		}
		const c = region.conflict;
		let twice = c.o.length === 0 ? declaredTwice(path, c.a, c.b) : [];
		if (c.o.length === 0 && !sameLines(c.a, c.b) && ONE_MEMBER_PER_NAME.has(lang)) {
			// Both add a member of the same name at the same point (a method to one class, say): side by side, one
			// would quietly replace the other, or not compile.
			sides ??= [extractSymbols(path, ours), extractSymbols(path, theirs)];
			const mine = declaredIn(sides[0], a, c.aIndex, c.a.length);
			const clash = declaredIn(sides[1], b, c.bIndex, c.b.length).filter((t) => mine.some((m) => m.key === t.key && !(m.accessor && t.accessor && m.accessor !== t.accessor)));
			twice = [...new Set([...twice, ...clash.map((t) => t.name)])];
		}
		if (c.o.length === 0 && twice.length === 0) {
			// Both sides inserted at the same point without touching existing lines: keep both, and an
			// import both added only once.
			append(out, c.a);
			if (!sameLines(c.a, c.b)) append(out, withoutSharedImports(c.a, c.b));
			unioned++;
			continue;
		}
		const start = c.oIndex + 1;
		// Two inserts that declare the same name are a real conflict: one definition has to win.
		const symbols = twice.length ? twice : symbolsInRange(baseSymbols, start, start + Math.max(0, c.o.length - 1));
		conflicts.push({ baseStart: start, baseLines: c.o, ours: c.a, theirs: c.b, symbols });
		out.push("<<<<<<< trunk");
		append(out, c.a);
		out.push("||||||| base");
		append(out, c.o);
		out.push("=======");
		append(out, c.b);
		out.push(">>>>>>> flight");
	}
	return { clean: conflicts.length === 0, text: out.join("\n"), conflicts, unioned };
}

/**
 * Symbols a change touches: base-side symbols whose lines were modified or deleted, plus
 * new-side symbols that were added or modified. `(top)` stands for code outside declarations.
 */
export function touchedSymbols(path: string, before: string | null, after: string | null): string[] {
	if (before === after) return [];
	// A whole file added or deleted touches everything in it.
	if (before === null || after === null) return [...new Set([TOP, ...extractSymbols(path, before ?? after ?? "").map((s) => s.name)])].sort();
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	const beforeSyms = symbolsByLine(extractSymbols(path, before), 1, beforeLines.length);
	const afterSyms = symbolsByLine(extractSymbols(path, after), 1, afterLines.length);
	const touched = new Set<string>();
	// Blank lines are layout, not code: they never make a change touch `(top)` on their own.
	const mark = (syms: string[], lines: string[], start: number, len: number) => {
		for (let i = start; i < start + len; i++) if (lines[i]?.trim()) touched.add(syms[i]);
	};
	for (const d of diffLines(beforeLines, afterLines)) {
		mark(beforeSyms, beforeLines, d.buffer1[0], d.buffer1[1]);
		mark(afterSyms, afterLines, d.buffer2[0], d.buffer2[1]);
	}
	return [...touched].sort();
}

/** Compact unified-style hunks for display: [{ start, removed, added }]. */
export function lineChanges(before: string, after: string) {
	return diffLines(before.split("\n"), after.split("\n")).map((d) => ({
		start: d.buffer1[0] + 1,
		removed: d.buffer1Content,
		added: d.buffer2Content,
	}));
}

/**
 * lineChanges for a reader who has nothing else: each hunk also names the symbols it changes and carries up to
 * `context` unchanged lines on each side (never lines another hunk changes).
 */
export function contextChanges(path: string, before: string, after: string, context = 2) {
	const beforeLines = before.split("\n");
	const afterLines = after.split("\n");
	const beforeSyms = symbolsByLine(extractSymbols(path, before), 1, beforeLines.length);
	const afterSyms = symbolsByLine(extractSymbols(path, after), 1, afterLines.length);
	const diffs = diffLines(beforeLines, afterLines);
	return diffs.map((d, i) => {
		const [bStart, bLen] = d.buffer1;
		const [aStart, aLen] = d.buffer2;
		const symbols = new Set<string>();
		for (let l = bStart; l < bStart + bLen; l++) if (beforeLines[l]?.trim()) symbols.add(beforeSyms[l]);
		for (let l = aStart; l < aStart + aLen; l++) if (afterLines[l]?.trim()) symbols.add(afterSyms[l]);
		const prevEnd = i > 0 ? diffs[i - 1].buffer2[0] + diffs[i - 1].buffer2[1] : 0;
		const nextStart = i + 1 < diffs.length ? diffs[i + 1].buffer2[0] : afterLines.length;
		return {
			start: bStart + 1,
			removed: d.buffer1Content,
			added: d.buffer2Content,
			symbols: [...symbols],
			before: afterLines.slice(Math.max(prevEnd, aStart - context), aStart),
			after: afterLines.slice(aStart + aLen, Math.min(nextStart, aStart + aLen + context)),
		};
	});
}
