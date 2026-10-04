// Lightweight symbol extraction. Contrail reasons about "who is touching what" at the level of
// functions, classes and methods rather than whole files, so two agents editing different
// functions of the same file are never treated as colliding.
//
// This is deliberately heuristic (no full parser): it recognises the common declaration shapes of
// JavaScript/TypeScript and Python and finds their extent by brace matching (JS) or indentation
// (Python). Anything outside a recognised declaration belongs to the file's `(top)` symbol.

export interface SymbolSpan {
	/** Qualified name, e.g. `applyDiscount`, `Cart`, `Cart.addItem`, `(top)`. */
	name: string;
	kind: "function" | "class" | "method" | "const" | "top";
	/** 1-based inclusive line range. */
	start: number;
	end: number;
}

export const TOP = "(top)";

const IDENT = "[A-Za-z_$][\\w$]*";
const JS_DECLS: { re: RegExp; kind: SymbolSpan["kind"] }[] = [
	{ re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`), kind: "function" },
	{ re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`), kind: "class" },
	{ re: new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=`), kind: "const" },
	{ re: new RegExp(`^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+(${IDENT})`), kind: "const" },
];
const JS_METHOD = new RegExp(
	`^\\s+(?:(?:public|private|protected|static|readonly|async|override|get|set)\\s+)*\\*?\\s*(#?${IDENT})\\s*(?:<[^>]*>)?\\s*\\(`,
);
const JS_NOT_METHOD = new Set(["if", "for", "while", "switch", "catch", "return", "function", "new", "await", "typeof", "else"]);

export function languageOf(path: string): "js" | "py" | "other" {
	if (/\.(m|c)?(j|t)sx?$/.test(path)) return "js";
	if (/\.py$/.test(path)) return "py";
	return "other";
}

/** Brace depth after each line, ignoring braces inside strings and comments (approximate). */
function braceDepths(lines: string[]): number[] {
	const depths: number[] = [];
	let depth = 0;
	let inBlockComment = false;
	let quote: string | null = null; // ', ", or ` (template literals may span lines)
	for (const line of lines) {
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			const next = line[i + 1];
			if (inBlockComment) {
				if (ch === "*" && next === "/") {
					inBlockComment = false;
					i++;
				}
				continue;
			}
			if (quote) {
				if (ch === "\\") {
					i++;
				} else if (ch === quote) {
					quote = null;
				}
				continue;
			}
			if (ch === "/" && next === "/") break;
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				i++;
				continue;
			}
			if (ch === '"' || ch === "'" || ch === "`") {
				quote = ch;
				continue;
			}
			if (ch === "{") depth++;
			else if (ch === "}") depth = Math.max(0, depth - 1);
		}
		// Single-quoted and double-quoted strings never span lines.
		if (quote === '"' || quote === "'") quote = null;
		depths.push(depth);
	}
	return depths;
}

function extractJs(lines: string[]): SymbolSpan[] {
	const depths = braceDepths(lines);
	const out: SymbolSpan[] = [];
	const depthBefore = (i: number) => (i === 0 ? 0 : depths[i - 1]);

	const isDecl = (line: string) => JS_DECLS.some(({ re }) => re.test(line));

	/** Line index where the declaration starting at line `i` (at brace depth d) ends. */
	const blockEnd = (i: number, d: number) => {
		let opened = false;
		for (let j = i; j < lines.length; j++) {
			if (depths[j] > d) opened = true;
			if (opened && depths[j] <= d) return j;
			if (!opened) {
				// A block-less declaration (`const x = 1;`) ends at its statement terminator, a blank
				// line, or the next declaration (semicolon-free style).
				if (/;\s*$/.test(lines[j])) return j;
				if (j > i && lines[j].trim() === "") return j - 1;
				if (j > i && isDecl(lines[j])) return j - 1;
			}
		}
		return lines.length - 1;
	};

	for (let i = 0; i < lines.length; i++) {
		if (depthBefore(i) !== 0) continue;
		for (const { re, kind } of JS_DECLS) {
			const m = lines[i].match(re);
			if (!m) continue;
			const end = blockEnd(i, 0);
			out.push({ name: m[1], kind, start: i + 1, end: end + 1 });
			if (kind === "class") {
				for (let j = i + 1; j < end; j++) {
					if (depthBefore(j) !== 1) continue;
					const mm = lines[j].match(JS_METHOD);
					if (!mm || JS_NOT_METHOD.has(mm[1])) continue;
					const mEnd = blockEnd(j, 1);
					out.push({ name: `${m[1]}.${mm[1]}`, kind: "method", start: j + 1, end: mEnd + 1 });
					j = mEnd;
				}
			}
			i = end;
			break;
		}
	}
	return out;
}

function extractPy(lines: string[]): SymbolSpan[] {
	const out: SymbolSpan[] = [];
	const indentOf = (l: string) => l.length - l.trimStart().length;
	const endOf = (i: number, indent: number) => {
		let last = i;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === "") continue;
			if (indentOf(lines[j]) <= indent) break;
			last = j;
		}
		return last;
	};
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(/^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/);
		if (!m) continue;
		const end = endOf(i, 0);
		out.push({ name: m[2], kind: m[1] === "def" ? "function" : "class", start: i + 1, end: end + 1 });
		if (m[1] === "class") {
			for (let j = i + 1; j <= end; j++) {
				const mm = lines[j].match(/^(\s+)(?:async\s+)?def\s+([A-Za-z_]\w*)/);
				if (!mm) continue;
				const mEnd = endOf(j, mm[1].length);
				out.push({ name: `${m[2]}.${mm[2]}`, kind: "method", start: j + 1, end: mEnd + 1 });
				j = mEnd;
			}
		}
		i = end;
	}
	return out;
}

/** Symbols declared in a file, outermost first. Methods are listed after their class. */
export function extractSymbols(path: string, text: string): SymbolSpan[] {
	const lines = text.split("\n");
	const lang = languageOf(path);
	if (lang === "js") return extractJs(lines);
	if (lang === "py") return extractPy(lines);
	return [];
}

/** Innermost symbol containing a 1-based line, or `(top)`. */
export function symbolAt(symbols: SymbolSpan[], line: number): string {
	let best: SymbolSpan | null = null;
	for (const s of symbols) {
		if (line >= s.start && line <= s.end && (!best || s.end - s.start <= best.end - best.start)) best = s;
	}
	return best ? best.name : TOP;
}

/** All symbols overlapping a 1-based inclusive line range (innermost spans only), or `(top)`. */
export function symbolsInRange(symbols: SymbolSpan[], start: number, end: number): string[] {
	const hits = new Set<string>();
	for (let line = start; line <= end; line++) hits.add(symbolAt(symbols, line));
	return [...hits];
}
