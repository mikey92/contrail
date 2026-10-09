// Three-way text merge with structured conflicts.
//
// On top of a classic diff3 merge, Contrail resolves the most common "false" conflict produced by
// parallel agents: two agents inserting new code at the same spot (both appending a function at
// the end of a file, both adding an import). Those insert/insert hunks are unioned. Everything
// else that overlaps is reported as a structured conflict — base, ours (trunk) and theirs (the
// landing flight) — together with the symbols it touches, so the agent that has to resolve it
// gets the exact functions and the context of whoever changed them.
import { diffIndices } from "node-diff3";
import { extractSymbols, languageOf, symbolAt, symbolsInRange, TOP, type SymbolSpan } from "./symbols";

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
 * texts up to this many lines in all are diffed whole, as they always were; longer ones only between the lines
 * they share at both ends, and a stretch longer than this between those counts as one change.
 */
export const MAX_DIFF_LINES = 2000;

interface LineDiff {
	buffer1: [number, number];
	buffer1Content: string[];
	buffer2: [number, number];
	buffer2Content: string[];
}

/** How many lines `a` and `b` share at their start, and then at their end. */
function sharedEnds(a: string[], b: string[]): [number, number] {
	const min = Math.min(a.length, b.length);
	let head = 0;
	while (head < min && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < min - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	return [head, tail];
}

/** Most lines a long text's diff may change before the rest of the stretch counts as one change. */
const MAX_EDITS = 1000;

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
 * diffIndices, bounded: texts too long for it are diffed over what they don't share at their ends with Myers'
 * algorithm, which is quick when little changed, and a stretch with too many changes is one hunk.
 */
export function diffLines(a: string[], b: string[]): LineDiff[] {
	// Short texts as they always were (another algorithm can line up a run of blank lines or `}` differently).
	if (a.length + b.length <= MAX_DIFF_LINES)
		return diffIndices<string>(a, b).map((d) => ({ buffer1: d.buffer1, buffer1Content: d.buffer1Content, buffer2: d.buffer2, buffer2Content: d.buffer2Content }));
	const [head, tail] = sharedEnds(a, b);
	const am = a.slice(head, a.length - tail);
	const bm = b.slice(head, b.length - tail);
	if (!am.length && !bm.length) return [];
	const hunks = myers(am, bm, MAX_EDITS) ?? [{ buffer1: [0, am.length] as [number, number], buffer1Content: am, buffer2: [0, bm.length] as [number, number], buffer2Content: bm }];
	return hunks.map((d) => ({ ...d, buffer1: [d.buffer1[0] + head, d.buffer1[1]], buffer2: [d.buffer2[0] + head, d.buffer2[1]] }));
}

type Merged = { ok: string[]; conflict?: undefined } | { conflict: { a: string[]; o: string[]; b: string[]; oIndex: number; aIndex: number; bIndex: number }; ok?: undefined };

/**
 * A diff3 merge (node-diff3's, MIT) over diffLines: alternating runs of merged lines and conflicts between what
 * `a` and `b` each made of `o`. Both sides making the same change is no conflict.
 */
function diff3(a: string[], o: string[], b: string[]): Merged[] {
	const hunks = [
		...diffLines(o, a).map((h) => ({ side: "a" as const, oStart: h.buffer1[0], oLength: h.buffer1[1], start: h.buffer2[0], length: h.buffer2[1] })),
		...diffLines(o, b).map((h) => ({ side: "b" as const, oStart: h.buffer1[0], oLength: h.buffer1[1], start: h.buffer2[0], length: h.buffer2[1] })),
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
		ok.push(...o.slice(at, regionStart));
		if (region.length === 1) {
			// One side changed this stretch and the other left it alone.
			ok.push(...(first.side === "a" ? a : b).slice(first.start, first.start + first.length));
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
				const end = Math.max(...mine.map((h) => h.start + h.length)) + (regionEnd - Math.max(...mine.map((h) => h.oStart + h.oLength)));
				return { start, content: text.slice(start, end) };
			};
			const as = span("a", a);
			const bs = span("b", b);
			if (sameLines(as.content, bs.content)) ok.push(...as.content);
			else {
				flush();
				out.push({ conflict: { a: as.content, aIndex: as.start, o: o.slice(regionStart, regionEnd), oIndex: regionStart, b: bs.content, bIndex: bs.start } });
			}
		}
		at = regionEnd;
	}
	ok.push(...o.slice(at));
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
	const re = DECLARATIONS[languageOf(path)] ?? (PROSE.test(path) ? null : ANY_DECLARATION);
	if (!re) return [];
	const names = (lines: string[]) => new Set(lines.flatMap((l) => re.exec(l)?.[1] ?? []));
	const ours = names(a);
	return [...names(b)].filter((n) => ours.has(n));
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
	let sides: [SymbolSpan[], SymbolSpan[]] | null = null;
	const declaredIn = (symbols: SymbolSpan[], from: number, count: number) =>
		symbols.filter((s) => s.kind === "method" && s.start - 1 >= from && s.start - 1 < from + count && !baseNames.has(s.name)).map((s) => s.name);

	const out: string[] = [];
	const conflicts: ConflictHunk[] = [];
	let unioned = 0;
	for (const region of regions) {
		if ("ok" in region && region.ok) {
			out.push(...region.ok);
			continue;
		}
		const c = region.conflict;
		let twice = c.o.length === 0 ? declaredTwice(path, c.a, c.b) : [];
		if (c.o.length === 0 && !sameLines(c.a, c.b)) {
			// Both add a member of the same name at the same point (a method to one class, say): side by side, one
			// would quietly replace the other, or not compile.
			sides ??= [extractSymbols(path, ours), extractSymbols(path, theirs)];
			const mine = new Set(declaredIn(sides[0], c.aIndex, c.a.length));
			twice = [...new Set([...twice, ...declaredIn(sides[1], c.bIndex, c.b.length).filter((n) => mine.has(n))])];
		}
		if (c.o.length === 0 && twice.length === 0) {
			// Both sides inserted at the same point without touching existing lines: keep both, and an
			// import both added only once.
			out.push(...c.a);
			if (!sameLines(c.a, c.b)) out.push(...withoutSharedImports(c.a, c.b));
			unioned++;
			continue;
		}
		const start = c.oIndex + 1;
		// Two inserts that declare the same name are a real conflict: one definition has to win.
		const symbols = twice.length ? twice : symbolsInRange(baseSymbols, start, start + Math.max(0, c.o.length - 1));
		conflicts.push({ baseStart: start, baseLines: c.o, ours: c.a, theirs: c.b, symbols });
		out.push("<<<<<<< trunk", ...c.a, "||||||| base", ...c.o, "=======", ...c.b, ">>>>>>> flight");
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
	const beforeSyms = extractSymbols(path, before);
	const afterSyms = extractSymbols(path, after);
	const touched = new Set<string>();
	// Blank lines are layout, not code: they never make a change touch `(top)` on their own.
	const mark = (syms: SymbolSpan[], lines: string[], start: number, len: number) => {
		for (let i = start; i < start + len; i++) if (lines[i]?.trim()) touched.add(symbolAt(syms, i + 1));
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
	const beforeSyms = extractSymbols(path, before);
	const afterSyms = extractSymbols(path, after);
	const diffs = diffLines(beforeLines, afterLines);
	return diffs.map((d, i) => {
		const [bStart, bLen] = d.buffer1;
		const [aStart, aLen] = d.buffer2;
		const symbols = new Set<string>();
		for (let l = bStart; l < bStart + bLen; l++) if (beforeLines[l]?.trim()) symbols.add(symbolAt(beforeSyms, l + 1));
		for (let l = aStart; l < aStart + aLen; l++) if (afterLines[l]?.trim()) symbols.add(symbolAt(afterSyms, l + 1));
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
