// Three-way text merge with structured conflicts.
//
// On top of a classic diff3 merge, Contrail resolves the most common "false" conflict produced by
// parallel agents: two agents inserting new code at the same spot (both appending a function at
// the end of a file, both adding an import). Those insert/insert hunks are unioned. Everything
// else that overlaps is reported as a structured conflict — base, ours (trunk) and theirs (the
// landing flight) — together with the symbols it touches, so the agent that has to resolve it
// gets the exact functions and the context of whoever changed them.
import { diff3Merge, diffIndices } from "node-diff3";
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

/** A whole import statement on one unindented line (JavaScript, TypeScript or Python). */
const WHOLE_IMPORT = [
	/^import\s.*\bfrom\s*["'][^"']+["'];?\s*$/,
	/^import\s*["'][^"']+["'];?\s*$/,
	/^import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+(?:\s+as\s+\w+)?)*\s*$/,
	/^from\s+\S+\s+import\s+[^(\\]+$/,
];
/** The first line of an import over several lines, and the line that ends it. */
const IMPORT_OPENS: [RegExp, RegExp][] = [
	[/^import\b[^"']*\{[^}]*$/, /^\s*\}.*\bfrom\s*["'][^"']+["'];?\s*$/],
	[/^from\s+\S+\s+import\s*\([^)]*$/, /\)\s*(?:#.*)?$/],
];

/**
 * The import statements in `lines`, each whole (one line or several) with its line span. Both sides adding
 * the same statement keep it once; a line of a multi-line import is only ever compared as part of the whole.
 */
function importStatements(lines: string[]): { from: number; to: number; text: string }[] {
	const out: { from: number; to: number; text: string }[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (WHOLE_IMPORT.some((re) => re.test(lines[i]))) {
			out.push({ from: i, to: i, text: lines[i] });
			continue;
		}
		const ends = IMPORT_OPENS.find(([opens]) => opens.test(lines[i]))?.[1];
		if (!ends) continue;
		const j = lines.findIndex((l, k) => k > i && ends.test(l));
		if (j === -1) continue;
		out.push({ from: i, to: j, text: lines.slice(i, j + 1).join("\n") });
		i = j;
	}
	return out;
}

/** `b` without the import statements `a` has too. */
function withoutSharedImports(a: string[], b: string[]): string[] {
	const ours = new Set(importStatements(a).map((s) => s.text));
	const drop = new Set<number>();
	for (const s of importStatements(b)) if (ours.has(s.text)) for (let k = s.from; k <= s.to; k++) drop.add(k);
	return b.filter((_, k) => !drop.has(k));
}

/** Top-level declarations by language: the name each declares (a type keyword like `enum` is not a name). */
const DECLARATIONS: Record<string, RegExp> = {
	js: /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|class|const\s+enum|enum|const|let|var|interface|type)\s+([\w$]+)/,
	py: /^(?:async\s+)?(?:def|class)\s+(\w+)/,
	go: /^(?:func|type)\s+(\w+)/,
	rust: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait)\s+(\w+)/,
	ruby: /^(?:def|class|module)\s+([\w:]+)/,
};

/** Names both inserts declare at the top level: kept side by side, the file would declare them twice. */
function declaredTwice(path: string, a: string[], b: string[]): string[] {
	const re = DECLARATIONS[languageOf(path)];
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
	const regions = diff3Merge(a, o, b, { excludeFalseConflicts: true });
	const baseSymbols = extractSymbols(path, base);

	const out: string[] = [];
	const conflicts: ConflictHunk[] = [];
	let unioned = 0;
	for (const region of regions) {
		if ("ok" in region && region.ok) {
			out.push(...region.ok);
			continue;
		}
		const c = (region as { conflict: { a: string[]; o: string[]; b: string[]; oIndex: number } }).conflict;
		const twice = c.o.length === 0 ? declaredTwice(path, c.a, c.b) : [];
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
	for (const d of diffIndices(beforeLines, afterLines)) {
		mark(beforeSyms, beforeLines, d.buffer1[0], d.buffer1[1]);
		mark(afterSyms, afterLines, d.buffer2[0], d.buffer2[1]);
	}
	return [...touched].sort();
}

/** Compact unified-style hunks for display: [{ start, removed, added }]. */
export function lineChanges(before: string, after: string) {
	return diffIndices(before.split("\n"), after.split("\n")).map((d) => ({
		start: d.buffer1[0] + 1,
		removed: d.buffer1Content,
		added: d.buffer2Content,
	}));
}
