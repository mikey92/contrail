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
