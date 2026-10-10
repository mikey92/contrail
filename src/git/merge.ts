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
/** How far from a change a merge looks for what makes it a guess: the same change made nearby, lines it slides over. */
const NEAR = 50;

interface LineDiff {
	buffer1: [number, number];
	buffer1Content: string[];
	buffer2: [number, number];
	buffer2Content: string[];
}

/** Most lines Myers' diff may change: past this, a long text is split at anchors instead (see anchoredDiff). */
const MAX_EDITS = 1000;
/** How many times a text is split at anchors, and its parts at their own anchors, at most. */
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
 * changed, and split at anchors where much did (see anchoredDiff).
 */
export function diffLines(a: string[], b: string[]): LineDiff[] {
	return lineDiff(a, b, a.length + b.length > MAX_DIFF_LINES, false, sharedHead(a, b));
}

/** How many lines `a` and `b` share at their start. */
function sharedHead(a: string[], b: string[]): number {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	return head;
}

/**
 * diffLines with the algorithm chosen: diffIndices, or for `long` texts Myers' from line `head` (one both texts
 * have up to there). A merge diffs both its sides with the same one, from the same line: one change made on both
 * sides has to line up the same in both diffs (in a run of `}` or blank lines, say), or the merge keeps it twice
 * or drops a line.
 */
function lineDiff(a: string[], b: string[], long: boolean, merge: boolean, head: number): LineDiff[] {
	// Short texts as they always were (another algorithm can line up a run of blank lines or `}` differently).
	if (!long)
		return diffIndices<string>(a, b).map((d) => ({ buffer1: d.buffer1, buffer1Content: d.buffer1Content, buffer2: d.buffer2, buffer2Content: d.buffer2Content }));
	const am = a.slice(head);
	const bm = b.slice(head);
	// Myers' diff changes at least the lines one text has more of than the other: past MAX_EDITS, not tried.
	const hunks = fewestEdits(am, bm) <= MAX_EDITS ? myers(am, bm, MAX_EDITS) : null;
	if (hunks) return hunks.map((d) => ({ ...d, buffer1: [d.buffer1[0] + head, d.buffer1[1]], buffer2: [d.buffer2[0] + head, d.buffer2[1]] }));
	const out: LineDiff[] = [];
	anchoredDiff(am, bm, head, head, out, 0, merge);
	return out;
}

/** The fewest lines a diff from `a` to `b` can change: those one has more of than the other. */
function fewestEdits(a: string[], b: string[]): number {
	const count = new Map<string, number>();
	for (const line of a) count.set(line, (count.get(line) ?? 0) + 1);
	let shared = 0;
	for (const line of b) {
		const n = count.get(line);
		if (n) {
			shared++;
			count.set(line, n - 1);
		}
	}
	return a.length + b.length - 2 * shared;
}

/**
 * Too many changes for Myers' diff: patience diff's anchors (the lines each side has exactly once, in an order
 * both keep) split the texts (at `aAt` and `bAt` in the whole), the parts between them are split the same way, and
 * a part that still differs is one hunk, into `out`: for display without the lines its ends share, for a merge
 * whole. (Diffed line by line, a part next to a big rewrite can line up differently on the two sides of a merge,
 * and the merge keep a change twice.) No anchor lies among the lines a change could slide over (with the change
 * in, such a line would be there twice), so changes an anchor parts stay apart.
 */
function anchoredDiff(a: string[], b: string[], aAt: number, bAt: number, out: LineDiff[], splits: number, merge: boolean): void {
	if (sameLines(a, b)) return;
	const anchors = splits < MAX_SPLITS ? increasing(uniquePairs(a, b)) : [];
	if (!anchors.length) {
		let head = 0;
		let tail = 0;
		if (!merge) {
			head = sharedHead(a, b);
			while (tail < Math.min(a.length, b.length) - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
		}
		const am = a.slice(head, a.length - tail);
		const bm = b.slice(head, b.length - tail);
		out.push({ buffer1: [aAt + head, am.length], buffer1Content: am, buffer2: [bAt + head, bm.length], buffer2Content: bm });
		return;
	}
	let i = 0;
	let j = 0;
	for (const [ai, bj] of [...anchors, [a.length, b.length]]) {
		anchoredDiff(a.slice(i, ai), b.slice(j, bj), aAt + i, bAt + j, out, splits + 1, merge);
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

/** A line with a letter or digit in it: code, not a blank line or brackets. */
const hasCode = (line: string) => /[A-Za-z0-9]/.test(line);

/** One side's change to `o`: lines `oStart`…+`oLength` of base became lines `start`…+`length` of the side. */
interface SideHunk {
	oStart: number;
	oLength: number;
	start: number;
	length: number;
}

/**
 * A side's inserts that its diff split around a few lines, put back together where the insert can slide over those
 * lines: its end (or start) is the same lines. A function with a blank line in it, inserted before a blank line;
 * `foo();` inserted before `foo();`, its diff taking the inserted one for base's. Split, the other side's insert at
 * one of the points lands between the halves (a function inside a function), or meets only half of the same change.
 * A half that is the other side's insert at its point, or part of it, stays: there both sides made that insert.
 * (`others`: the other side's inserts by point.)
 */
function compact(hunks: SideHunk[], o: string[], text: string[], others: Map<number, string[]>): SideHunk[] {
	const out: SideHunk[] = [];
	const made = (point: number, half: string[]) => {
		const there = others.get(point);
		return !!there && (sameLines(there, half) || shareCode(there, half, false));
	};
	for (const h of hunks) {
		const prev = out[out.length - 1];
		const gap = prev ? h.oStart - prev.oStart : 0;
		if (prev && !prev.oLength && !h.oLength && gap >= 1 && gap <= 3) {
			const [first, second] = [text.slice(prev.start, prev.start + prev.length), text.slice(h.start, h.start + h.length)];
			if (!made(prev.oStart, first) && !made(h.oStart, second)) {
				// The second half slides up over the lines between (each the line `length` below it), or the first
				// half down.
				let up = 0;
				while (up < gap && text[h.start - 1 - up] === text[h.start + h.length - 1 - up]) up++;
				if (up === gap) {
					out[out.length - 1] = { oStart: prev.oStart, oLength: 0, start: prev.start, length: prev.length + h.length };
					continue;
				}
				let down = 0;
				while (down < gap && text[prev.start + down] === text[prev.start + prev.length + down]) down++;
				if (down === gap) {
					out[out.length - 1] = { oStart: h.oStart, oLength: 0, start: prev.start + gap, length: prev.length + h.length };
					continue;
				}
			}
		}
		out.push(h);
	}
	return out;
}

/** Whether lines `small`…+`n` of one text are, in a row, somewhere in lines `big`…+`m` of another. */
function within(sText: string[], small: number, n: number, bText: string[], big: number, m: number): boolean {
	for (let k = big; k + n <= big + m; k++) {
		let n2 = 0;
		while (n2 < n && bText[k + n2] === sText[small + n2]) n2++;
		if (n2 === n) return true;
	}
	return false;
}

/** A run of merged lines, or a conflict; `unsure` when both sides inserted there and one insert may be part of a change nearby. */
type Merged = { ok: string[]; conflict?: undefined } | { conflict: { a: string[]; o: string[]; b: string[]; oIndex: number; aIndex: number; bIndex: number; unsure?: boolean }; ok?: undefined };

/**
 * A diff3 merge (node-diff3's, MIT) over lineDiff: alternating runs of merged lines and conflicts between what
 * `a` and `b` each made of `o`. Both sides making the same change is no conflict.
 */
function diff3(a: string[], o: string[], b: string[]): Merged[] {
	const long = o.length + Math.max(a.length, b.length) > MAX_DIFF_LINES;
	const head = long ? Math.min(sharedHead(o, a), sharedHead(o, b)) : 0;
	const diffOf = (text: string[]): SideHunk[] => lineDiff(o, text, long, true, head).map((h) => ({ oStart: h.buffer1[0], oLength: h.buffer1[1], start: h.buffer2[0], length: h.buffer2[1] }));
	const [da, db] = [diffOf(a), diffOf(b)];
	const inserts = (hs: SideHunk[], text: string[]) => new Map(hs.filter((h) => !h.oLength).map((h) => [h.oStart, text.slice(h.start, h.start + h.length)]));
	const hunks = [...compact(da, o, a, inserts(db, b)).map((h) => ({ ...h, side: "a" as const })), ...compact(db, o, b, inserts(da, a)).map((h) => ({ ...h, side: "b" as const }))].sort((x, y) => x.oStart - y.oStart);
	const out: Merged[] = [];
	let ok: string[] = [];
	const flush = () => {
		if (ok.length) out.push({ ok });
		ok = [];
	};
	// Two hunks of different sides that add (and remove) the same lines of code, with only lines between them the
	// change could slide over: one change both sides made, which their diffs placed apart (next to a rewrite, in
	// lines that repeat). Applied apart, it would come out twice (or take two lines): they make one region, a
	// conflict unless both read the same.
	type Hunk = (typeof hunks)[number];
	const textOf = (h: Hunk) => (h.side === "a" ? a : b);
	const echoes = (x: Hunk, y: Hunk) => {
		const adds = x.length > 0 && y.length > 0;
		const dels = x.oLength > 0 && y.oLength > 0;
		if (!adds && !dels) return false;
		// The smaller of each pair, with code in it and at most 200 lines, in the larger.
		const [sa, ba] = x.length <= y.length ? [x, y] : [y, x];
		const [sd, bd] = x.oLength <= y.oLength ? [x, y] : [y, x];
		if (adds && (sa.length > 200 || !textOf(sa).slice(sa.start, sa.start + sa.length).some(hasCode) || !within(textOf(sa), sa.start, sa.length, textOf(ba), ba.start, ba.length))) return false;
		if (dels && (sd.oLength > 200 || !o.slice(sd.oStart, sd.oStart + sd.oLength).some(hasCode) || !within(o, sd.oStart, sd.oLength, o, bd.oStart, bd.oLength))) return false;
		const from = x.oStart + x.oLength;
		if (y.oStart - from > 50) return false;
		const moved = new Set([...(adds ? textOf(sa).slice(sa.start, sa.start + sa.length) : []), ...(dels ? o.slice(sd.oStart, sd.oStart + sd.oLength) : [])]);
		for (let k = from; k < y.oStart; k++) if (hasCode(o[k]) && !moved.has(o[k])) return false;
		return true;
	};
	/** How many times `text` has the lines of `run` in a row starting within lines `from`…`to`. */
	const count = (text: string[], run: string[], from: number, to: number) => {
		let n = 0;
		for (let k = Math.max(0, from); k <= to && k + run.length <= text.length; k++) {
			let j = 0;
			while (j < run.length && text[k + j] === run[j]) j++;
			if (j === run.length) n++;
		}
		return n;
	};
	// A change only one side's diff has here may still be the other side's too, placed elsewhere by its diff (in
	// lines that repeat, next to a rewrite): the other side's text has the change's lines, with the lines around
	// them, more often near here than base (or, for lines removed, less often). Applied here as well, it would come
	// out twice: a conflict instead.
	/**
	 * `h` made twice, near where the other side has it (`at`: base's line `h.oStart` in the other side's text). With
	 * `either`, the lines around on one side are enough: an insert both sides made at one point, where one side's
	 * diff took it apart.
	 */
	const madeTwice = (h: Hunk, at: number, either = false) => {
		// (A change of hundreds of lines is no small change a diff places one way or the other.)
		if (h.length > 200 || h.oLength > 200) return false;
		const other = h.side === "a" ? b : a;
		const before = h.oStart > 0 ? [o[h.oStart - 1]] : [];
		const after = h.oStart + h.oLength < o.length ? [o[h.oStart + h.oLength]] : [];
		const runs = (middle: string[]) => (either ? [[...before, ...middle, ...after], [...before, ...middle], [...middle, ...after]] : [[...before, ...middle, ...after]]);
		// How many more times the other side has `run` near here than base has.
		const gained = (run: string[]) => count(other, run, at - NEAR - 1, at + h.oLength + NEAR) - count(o, run, h.oStart - NEAR - 1, h.oStart + h.oLength + NEAR);
		const added = textOf(h).slice(h.start, h.start + h.length);
		if (added.some(hasCode)) return runs(added).some((run) => gained(run) > 0);
		const removed = o.slice(h.oStart, h.oStart + h.oLength);
		return removed.some(hasCode) && runs(removed).some((run) => gained(run) < 0);
	};
	/** How many lines insert or delete `h` can slide up (-1) or down (1), up to `limit`: lines that repeat it. */
	const slide = (h: Hunk, dir: -1 | 1, limit: number) => {
		const [text, s, n] = h.oLength ? [o, h.oStart, h.oLength] : [textOf(h), h.start, h.length];
		let k = 0;
		if (dir < 0) while (k < limit && s - k - 1 >= 0 && text[s - k - 1] === text[s + n - k - 1]) k++;
		else while (k < limit && s + n + k < text.length && text[s + k] === text[s + n + k]) k++;
		return k;
	};
	// Two inserts of different sides a few lines apart, where one can slide over the lines between onto the other's
	// point (its end, or the other's start, is those lines): there they are one change and more, which applied
	// apart comes out twice. They make one region.
	const meets = (x: Hunk, y: Hunk) => {
		const k = y.oStart - x.oStart;
		if (x.oLength || y.oLength || !x.length || !y.length || k < 1 || k > 3) return false;
		const [xt, yt] = [textOf(x), textOf(y)];
		const between = o.slice(x.oStart, y.oStart);
		if (sameLines(yt.slice(y.start - k, y.start), between) && slide(y, -1, k) === k && shareCode(xt.slice(x.start, x.start + x.length), yt.slice(y.start - k, y.start - k + y.length))) return true;
		return sameLines(xt.slice(x.start + x.length, x.start + x.length + k), between) && slide(x, 1, k) === k && shareCode(xt.slice(x.start + k, x.start + k + x.length), yt.slice(y.start, y.start + y.length));
	};
	type Region = { hunks: Hunk[]; start: number; end: number };
	const regions: Region[] = [];
	for (let i = 0; i < hunks.length; ) {
		const first = hunks[i];
		const region: Region = { hunks: [hunks[i++]], start: first.oStart, end: first.oStart + first.oLength };
		// Each side's last hunk in the region: one of the other side's echoes it, or not.
		const last: Partial<Record<"a" | "b", Hunk>> = { [first.side]: first };
		// Hunks of either side that overlap (or touch) this region join it, and ones that echo or meet the other side's.
		for (; i < hunks.length; i++) {
			const h = hunks[i];
			const other = last[h.side === "a" ? "b" : "a"];
			if (h.oStart > region.end && !(other && (echoes(other, h) || meets(other, h)))) break;
			region.end = Math.max(region.end, h.oStart + h.oLength);
			region.hunks.push(h);
			last[h.side] = h;
		}
		regions.push(region);
	}
	// An insert or delete that can slide over the lines between it and a stretch the other side changed (its end is
	// those lines) may be part of that change: where the diffs end the other side's change among those lines is a
	// guess. Two inserts there are no union, and one side's copies of a line added to (or taken from) a run of it
	// there a conflict: `}` added after a rewrite that ends in `}`, with the rewrite taking one more `}`, is the
	// other side's change too, and a line taken from the run may be one the other side's diff put in its rewrite.
	// So is a run that slides to one line short of the other side's rewrite: that line the rewrite's to take too.
	// Blank lines next to a small edit of the other side's are layout, and common: no conflict.
	const changes = (r: Region | undefined, side: "a" | "b") => !!r && r.hunks.some((x) => x.side === side);
	/** The lines an insert adds, or a delete (or replacement) takes. */
	const linesOf = (h: Hunk) => (h.oLength ? o.slice(h.oStart, h.oStart + h.oLength) : textOf(h).slice(h.start, h.start + h.length));
	const blank = (h: Hunk) => (h.oLength === 0 || h.length === 0) && linesOf(h).every((l) => l.trim() === "");
	/** An insert or delete of copies of one line, or of the lines next to it: a run made longer or shorter. */
	const repeats = (h: Hunk) => {
		if (h.oLength && h.length) return false;
		const n = h.oLength + h.length;
		return linesOf(h).every((l, _, all) => l === all[0]) || (n > 1 && (slide(h, -1, n) === n || slide(h, 1, n) === n));
	};
	/** The region of the other side's change next to `h` that `h` slides onto, or -1. */
	const nextTo = (r: number, h: Hunk) => {
		const other = h.side === "a" ? "b" : "a";
		const [before, after] = [regions[r - 1], regions[r + 1]];
		const up = before ? h.oStart - before.end : 0;
		const down = after ? after.start - h.oStart - h.oLength : 0;
		if (changes(before, other) && up <= NEAR && slide(h, -1, up) === up) return r - 1;
		if (changes(after, other) && down <= NEAR && slide(h, 1, down) === down) return r + 1;
		return -1;
	};
	/** Region `r`: a small edit of `side`'s alone, with no other change of its for 10 lines around (not a rewrite). */
	const edit = (r: number, side: "a" | "b") => {
		const n = regions[r];
		if (n.hunks.some((x) => x.side !== side) || n.hunks.reduce((k, x) => k + x.oLength + x.length, 0) > 6) return false;
		for (const m of [regions[r - 1], regions[r + 1]]) if (m && changes(m, side) && Math.max(m.start - n.end, n.start - m.end) <= 10) return false;
		return true;
	};
	const slack = (r: number, h: Hunk) => {
		if (!repeats(h)) return false;
		const other = h.side === "a" ? "b" : "a";
		const n = nextTo(r, h);
		if (n >= 0) return !(blank(h) && edit(n, other));
		const [before, after] = [regions[r - 1], regions[r + 1]];
		const up = before ? h.oStart - before.end : 0;
		const down = after ? after.start - h.oStart - h.oLength : 0;
		if (changes(before, other) && up >= 2 && up <= NEAR && slide(h, -1, up) === up - 1 && !edit(r - 1, other)) return true;
		return changes(after, other) && down >= 2 && down <= NEAR && slide(h, 1, down) === down - 1 && !edit(r + 1, other);
	};
	/** Each side's text over two-sided region `n`. */
	const spans = (n: Region) =>
		(["a", "b"] as const).map((side) => {
			const mine = n.hunks.filter((x) => x.side === side);
			const text = side === "a" ? a : b;
			const start = mine[0].start + (n.start - mine[0].oStart);
			const end = mine.reduce((k, x) => Math.max(k, x.start + x.length), 0) + (n.end - mine.reduce((k, x) => Math.max(k, x.oStart + x.oLength), 0));
			return text.slice(start, end);
		});
	/** Region `n`: one change both sides made, of 3 lines or more (a rewrite both made, or part of one). */
	const same = (n: Region | undefined) => {
		if (!n || !changes(n, "a") || !changes(n, "b")) return false;
		const [sa, sb] = spans(n);
		return sameLines(sa, sb) && sa.length + n.end - n.start >= 3;
	};
	// Lines one side took (or changed) one line, that repeats, from a rewrite both sides made: where both diffs end
	// that rewrite is a guess, and the lines may be the rewrite's own (taken by both, the other side adding its own).
	const nearBoth = (r: number, repeated: (line: string) => boolean) => {
		const region = regions[r];
		if (!region.hunks[0].oLength) return false;
		return [regions[r - 1], regions[r + 1]].some((n) => {
			if (!same(n)) return false;
			const between = n!.end <= region.start ? o.slice(n!.end, region.start) : o.slice(region.end, n!.start);
			return between.length <= 1 && between.every(repeated);
		});
	};
	// A change between two of the other side's, a line or two off each way with only lines that repeat between (`}`,
	// blank lines): there the other side's diff is a rewrite in pieces, and which of its lines are base's a guess. A
	// conflict, blank lines aside.
	const among = (r: number, h: Hunk, repeated: (line: string) => boolean) => {
		const other = h.side === "a" ? "b" : "a";
		const [before, after] = [regions[r - 1], regions[r + 1]];
		if (blank(h) || !changes(before, other) || !changes(after, other) || h.oStart - before!.end > 2 || after!.start - h.oStart - h.oLength > 2) return false;
		return [...o.slice(before!.end, h.oStart), ...o.slice(h.oStart + h.oLength, after!.start)].every(repeated);
	};
	let at = 0;
	// Lines each side's changes so far added (or removed, below 0): base's line k is the side's line k + shift.
	const shift = { a: 0, b: 0 };
	regions.forEach((region, r) => {
		const first = region.hunks[0];
		append(ok, o.slice(at, region.start));
		// Base's line `h.oStart` in the other side's text.
		const mapped = (h: Hunk) => h.oStart + shift[h.side === "a" ? "b" : "a"];
		// A line that repeats near here: in base, or in either side's text.
		const repeated = (l: string) =>
			count(o, [l], region.start - NEAR, region.end + NEAR) > 1 ||
			count(a, [l], region.start + shift.a - NEAR, region.end + shift.a + NEAR) > 1 ||
			count(b, [l], region.start + shift.b - NEAR, region.end + shift.b + NEAR) > 1;
		if (region.hunks.length === 1 && !madeTwice(first, mapped(first)) && !slack(r, first) && !among(r, first, repeated) && !nearBoth(r, repeated)) {
			// One side changed this stretch and the other left it alone.
			append(ok, textOf(first).slice(first.start, first.start + first.length));
		} else {
			// Each side's span over the region, corrected for the stretch of `o` its hunks cover. (A side with no
			// hunk here left the region as `o` has it, shifted by what it changed before.)
			const span = (side: "a" | "b", text: string[]) => {
				const mine = region.hunks.filter((h) => h.side === side);
				if (!mine.length) {
					const shift = hunks.filter((h) => h.side === side && h.oStart + h.oLength <= region.start).reduce((n, h) => n + h.length - h.oLength, 0);
					return { start: region.start + shift, content: o.slice(region.start, region.end) };
				}
				const start = mine[0].start + (region.start - mine[0].oStart);
				const end = mine.reduce((n, h) => Math.max(n, h.start + h.length), 0) + (region.end - mine.reduce((n, h) => Math.max(n, h.oStart + h.oLength), 0));
				return { start, content: text.slice(start, end) };
			};
			const as = span("a", a);
			const bs = span("b", b);
			if (sameLines(as.content, bs.content)) append(ok, as.content);
			else {
				flush();
				// Both sides inserted here: no union a few lines from a stretch both changed (where both diffs end the
				// same rewrite is a guess), with an insert that slides onto the other side's change, or with one the
				// other side has nearby.
				const close = (n: Region | undefined) => changes(n, "a") && changes(n, "b") && Math.max(n!.start - region.end, region.start - n!.end) <= 3;
				const unsure = region.start === region.end && (close(regions[r - 1]) || close(regions[r + 1]) || region.hunks.some((h) => nextTo(r, h) >= 0 || madeTwice(h, mapped(h), true)));
				out.push({ conflict: { a: as.content, aIndex: as.start, o: o.slice(region.start, region.end), oIndex: region.start, b: bs.content, bIndex: bs.start, unsure } });
			}
		}
		at = region.end;
		for (const h of region.hunks) shift[h.side] += h.length - h.oLength;
	});
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

/**
 * Whether two inserts at one point are two versions of one change, whose shared lines side by side would come out
 * twice: one is the other and more (a flight that built on the other's change), or they start with the same three
 * lines of code or more (imports aside). Ends alike are no sign: `return nil }`, a lockfile entry's last fields.
 */
function shareCode(a: string[], b: string[], blanks = true): boolean {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) head++;
	let tail = 0;
	while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
	const imports = new Set(importStatements(a).flatMap((st) => Array.from({ length: st.to - st.from + 1 }, (_, k) => st.from + k)));
	const code = (from: number, to: number) => a.slice(from, to).filter((l, k) => hasCode(l) && !imports.has(from + k)).length;
	// The shorter all of the longer's start and end, the longer only more lines between (or at an end): even `},`
	// or a blank line (unless `blanks` is false) would come out twice side by side. Imports aside, which are kept
	// once anyway.
	const shorter = a.length <= b.length ? a : b;
	const kept = new Set(importStatements(shorter).flatMap((st) => Array.from({ length: st.to - st.from + 1 }, (_, k) => st.from + k)));
	if (head + tail >= shorter.length && shorter.some((l, k) => !kept.has(k) && (blanks || l.trim() !== ""))) return true;
	return code(0, head) >= 3;
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
	// In Go, Python and Rust `_` names nothing (`var _ Shape = (*Box)(nil)`, a `def _` registered for one type,
	// `const _: () = …`), and a Go file may have any number of `init` functions.
	return [...names(b)].filter((n) => ours.has(n) && !(n === "_" && ["go", "py", "rust"].includes(lang)) && !(lang === "go" && n === "init"));
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
		// (One side's insert alone is a conflict only where the other side may have made it too: no union.)
		// (An insert of brackets alone, `}` or `]`, is no change of its own to keep beside another: where it goes is
		// the question.)
		const marks = (x: string[]) => x.some((l) => l.trim() !== "") && !x.some(hasCode);
		if (c.o.length === 0 && c.a.length > 0 && c.b.length > 0 && !c.unsure && !marks(c.a) && !marks(c.b) && twice.length === 0 && !shareCode(c.a, c.b)) {
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
