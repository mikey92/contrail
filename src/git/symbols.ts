// Lightweight symbol extraction. Contrail reasons about "who is touching what" at the level of
// functions, classes and methods rather than whole files, so two agents editing different
// functions of the same file are never treated as colliding.
//
// This is deliberately heuristic (no full parser). It recognises the common declaration shapes of
// JavaScript/TypeScript, Python, Go, Rust, the Java family (Java, Kotlin, Scala, C#, Swift, Dart,
// PHP), C/C++ and Ruby, and finds their extent by brace matching or indentation. Anything outside a
// recognised declaration belongs to the file's `(top)` symbol.

export interface SymbolSpan {
	/** Qualified name, e.g. `applyDiscount`, `Cart`, `Cart.addItem`, `(top)`. */
	name: string;
	kind: "function" | "class" | "method" | "const" | "export" | "suite" | "top";
	/** 1-based inclusive line range. */
	start: number;
	end: number;
}

export const TOP = "(top)";

type Kind = SymbolSpan["kind"];
type Lang = "js" | "py" | "go" | "rust" | "java" | "c" | "ruby" | "other";

const IDENT = "[A-Za-z_$][\\w$]*";
/** A top-level declaration. `container` declarations (classes, impl blocks) have members. */
interface Decl {
	re: RegExp;
	kind: Kind;
	container?: boolean;
	/** Name from the match (default: the last capture group). */
	name?: (m: RegExpMatchArray) => string;
}

const JS_DECLS: Decl[] = [
	{ re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`), kind: "function" },
	{ re: new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?class\\s+(${IDENT})`), kind: "class", container: true },
	{ re: new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=]+)?=`), kind: "const" },
	{ re: new RegExp(`^\\s*(?:export\\s+)?(?:interface|type|enum)\\s+(${IDENT})`), kind: "const" },
	// Re-exports (an index of a library): `export { default as add } from './add.js'`.
	{ re: new RegExp(`^\\s*export\\s*\\{\\s*(?:default\\s+as\\s+)?(${IDENT})\\s*\\}\\s*from\\b`), kind: "export" },
	{ re: new RegExp(`^\\s*export\\s*\\*\\s*as\\s+(${IDENT})\\s+from\\b`), kind: "export" },
	// Test suites: `describe('range', function () { ... })`.
	{ re: /^\s*(?:describe|context|suite)(?:\.\w+)?\(\s*(['"`])((?:(?!\1).)+)\1/, kind: "suite", name: (m) => m[2].replace(/#/g, "") },
];
const JS_MEMBER = new RegExp(
	`^\\s+(?:(?:public|private|protected|static|readonly|async|override|get|set)\\s+)*\\*?\\s*(#?${IDENT})\\s*(?:<[^>]*>)?\\s*\\(`,
);

const GO_DECLS: Decl[] = [
	// Methods: `func (c *Cart) Add(...)` → Cart.Add
	{ re: /^func\s*\(\s*\w*\s*\*?\s*(\w+)(?:\[[^\]]*\])?\s*\)\s*(\w+)/, kind: "method", name: (m) => `${m[1]}.${m[2]}` },
	{ re: /^func\s+(\w+)/, kind: "function" },
	{ re: /^type\s+(\w+)\s+(?:struct|interface)\b/, kind: "class" },
	{ re: /^type\s+(\w+)/, kind: "const" },
	{ re: /^(?:var|const)\s+(\w+)/, kind: "const" },
];

const RUST_VIS = "(?:pub(?:\\s*\\([^)]*\\))?\\s+)?";
const RUST_FN = `${RUST_VIS}(?:default\\s+)?(?:const\\s+)?(?:async\\s+)?(?:unsafe\\s+)?(?:extern\\s+"[^"]*"\\s+)?fn\\s+(\\w+)`;
const RUST_DECLS: Decl[] = [
	{ re: new RegExp(`^\\s*${RUST_FN}`), kind: "function" },
	// `impl<T> Trait for Cart<T> {` and `impl Cart {` → members are Cart.method
	{ re: /^\s*(?:unsafe\s+)?impl\b(?:\s*<[^>]*>)?\s+(?:[\w:]+(?:<[^>]*>)?\s+for\s+)?(?:[\w:]*::)?(\w+)/, kind: "class", container: true },
	{ re: new RegExp(`^\\s*${RUST_VIS}trait\\s+(\\w+)`), kind: "class", container: true },
	{ re: new RegExp(`^\\s*${RUST_VIS}(?:struct|enum|union)\\s+(\\w+)`), kind: "class" },
	{ re: new RegExp(`^\\s*${RUST_VIS}mod\\s+(\\w+)\\s*\\{`), kind: "class", container: true },
	{ re: new RegExp(`^\\s*${RUST_VIS}(?:const|static)\\s+(?:mut\\s+)?(\\w+)`), kind: "const" },
	{ re: new RegExp(`^\\s*${RUST_VIS}type\\s+(\\w+)`), kind: "const" },
];
const RUST_MEMBER = new RegExp(`^\\s+${RUST_FN}`);

const JAVA_MODS = "(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial|open|data|inner|export|default|readonly|async|override|virtual|unsafe|extern|new|const|lateinit|inline|suspend|operator|synchronized|native|strictfp|transient|volatile|required|convenience|mutating|nonmutating|fileprivate|@\\w+(?:\\([^)]*\\))?)\\s+)*";
const JAVA_DECLS: Decl[] = [
	{ re: new RegExp(`^\\s*${JAVA_MODS}(?:class|interface|enum|struct|record|object|trait|protocol|extension|actor)\\s+(\\w+)`), kind: "class", container: true },
	// Top-level functions: Kotlin `fun`, Swift `func`, PHP `function`, Scala `def`, Dart/C#-style `Type name(...)`.
	{ re: new RegExp(`^\\s*${JAVA_MODS}(?:fun|func|function|def)\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?(\\w+)`), kind: "function" },
];
const JAVA_MEMBER = new RegExp(
	`^\\s+${JAVA_MODS}(?:(?:fun|func|function|def)\\s+(?:<[^>]*>\\s*)?(?:[\\w.]+\\.)?(\\w+)|(?:<[^>]*>\\s*)?(?:[\\w<>\\[\\],.?*&:]+\\s+)+(\\w+)\\s*\\(|(\\w+)\\s*\\()`,
);
const CONTROL = new Set(["if", "for", "while", "switch", "catch", "return", "function", "new", "await", "typeof", "else", "do", "try", "throw", "case", "when", "match", "loop", "sizeof", "synchronized", "using", "lock", "foreach", "fixed", "yield", "super", "this"]);

const C_DECLS: Decl[] = [
	{ re: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union)\s+(\w+)(?:\s*:[^{;]*)?\s*\{?\s*$/, kind: "class", container: true },
	{ re: /^\s*(?:typedef\s+)?enum\s+(?:class\s+)?(\w+)/, kind: "const" },
	// `static int parse_header(const char *s) {`, `Cart::Add(...)` → definitions only (no trailing `;`).
	{ re: /^(?!\s*(?:return|else|if|for|while|switch|case|do)\b)[A-Za-z_][\w\s*&:<>,~]*?\b((?:\w+::)*~?\w+)\s*\([^;]*$/, kind: "function", name: (m) => m[1].replace(/::/g, ".") },
];
const C_MEMBER = /^\s+(?:(?:virtual|static|inline|explicit|constexpr|friend|override)\s+)*(?:[\w<>:,*&~]+\s+)*?(~?\w+)\s*\([^;]*$/;
/** In a C++ namespace, a function's name may start its line (its return type above it), as a member's may. */
const C_NAMESPACE_FUNCTION = /^\s*(?:(?:virtual|static|inline|explicit|constexpr|friend|override)\s+)*(?:[\w<>:,*&~]+\s+)*?(~?\w+)\s*\([^;]*$/;
/** C++ words followed by `(` that start no function. */
const C_NOT_NAMES = new Set(["decltype", "static_assert", "alignas", "alignof", "noexcept", "requires", "typeid", "sizeof", "defined"]);

/**
 * Blocks that only name what they hold (namespaces; C's `extern "C"`): it is read as if it were at the top. In
 * C++ the namespace's name comes first in its symbols' (`util.add`, as `util::add` defined outside it reads);
 * C# and PHP namespaces are folders, and TypeScript's are rare.
 */
const NAMESPACES: Partial<Record<Lang, { re: RegExp; qualify: boolean }>> = {
	js: { re: /^\s*(?:declare\s+global|(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+(?:[\w$.]+|"[^"]*"|'[^']*'))\s*\{\s*$/, qualify: false },
	java: { re: /^\s*namespace(?:\s+[\w.\\]+)?\s*\{?\s*$/, qualify: false },
	c: { re: /^\s*(?:(?:inline\s+)?namespace(?:\s+((?:\w+::(?:inline\s+)?)*\w+))?|extern\s+"C(?:\+\+)?")\s*\{?\s*$/, qualify: true },
};

export function languageOf(path: string): Lang {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (/^(m|c)?(j|t)sx?$/.test(ext)) return "js";
	if (ext === "py") return "py";
	if (ext === "go") return "go";
	if (ext === "rs") return "rust";
	if (["java", "kt", "kts", "scala", "cs", "swift", "dart", "php"].includes(ext)) return "java";
	if (["c", "h", "cc", "cpp", "cxx", "hpp", "hh", "hxx", "m", "mm"].includes(ext)) return "c";
	if (ext === "rb") return "ruby";
	return "other";
}

/** Characters after which a `/` in JavaScript starts a regular expression rather than a division (not `<`: `</` closes a JSX tag). */
const BEFORE_REGEX = new Set("(,=:[!&|?{};+-*%>~^");
const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await", "instanceof"]);

/** Index of the `/` that closes a regular expression literal opened at `i`, or -1 if none on this line. */
function regexEnd(line: string, i: number): number {
	let inClass = false;
	for (let j = i + 1; j < line.length; j++) {
		const c = line[j];
		if (c === "\\") j++;
		else if (c === "[") inClass = true;
		else if (c === "]") inClass = false;
		else if (c === "/" && !inClass) return j;
	}
	return -1;
}

/**
 * Brace depth after each line, ignoring braces inside strings and comments (approximate), and which lines end
 * inside a string that runs on (a template literal), whose next line is the string's, not code.
 */
function braceDepths(lines: string[], lang: Lang): { depths: number[]; open: boolean[] } {
	const depths: number[] = [];
	const open: boolean[] = [];
	let depth = 0;
	let inBlockComment = false;
	let quote: string | null = null; // ', ", or ` (template literals may span lines)
	// JavaScript: open `${…}` expressions of template literals, innermost last, each with the braces opened inside it.
	const expressions: number[] = [];
	// JavaScript: the last character of code and the word it ends, which tell a regular expression from a division.
	let last = "";
	let word = "";
	let inWord = false;
	for (const line of lines) {
		inWord = false;
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
				// (In a Go raw string a backslash is just a backslash.)
				if (ch === "\\" && !(quote === "`" && lang === "go")) {
					i++;
				} else if (quote === "`" && lang === "js" && ch === "$" && next === "{") {
					expressions.push(0);
					quote = null;
					last = "{";
					i++;
				} else if (ch === quote) {
					quote = null;
					last = ch;
				}
				inWord = false;
				continue;
			}
			if (ch === "/" && next === "/") break;
			if (ch === "#" && lang === "java" && line.trimStart().startsWith("#")) break; // PHP comments
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				i++;
				continue;
			}
			if (ch === "/" && lang === "js" && (last === "" || BEFORE_REGEX.has(last) || KEYWORDS_BEFORE_REGEX.has(word))) {
				// A regular expression literal: `/^https?:\/\//` holds no comment and no braces.
				const end = regexEnd(line, i);
				if (end > i) {
					i = end;
					last = ")";
					word = "";
					inWord = false;
					continue;
				}
			}
			if (ch === "'" && lang !== "js") {
				// Character literals ('{', '\n'); a lone quote is a Rust lifetime or a generic, not a string.
				const close = line.indexOf("'", i + 1);
				if (close > i && close <= i + 3) i = close;
				continue;
			}
			if (ch === '"' || ch === "'" || (ch === "`" && (lang === "js" || lang === "go"))) {
				quote = ch;
				inWord = false;
				continue;
			}
			if (ch === "{") {
				if (expressions.length) expressions[expressions.length - 1]++;
				else depth++;
			} else if (ch === "}") {
				if (expressions.length && expressions[expressions.length - 1] === 0) {
					// The `${…}` expression closes: back inside its template literal.
					expressions.pop();
					quote = "`";
					continue;
				}
				if (expressions.length) expressions[expressions.length - 1]--;
				else depth = Math.max(0, depth - 1);
			}
			if (/\s/.test(ch)) {
				inWord = false;
				continue;
			}
			const wordChar = /[\w$]/.test(ch);
			word = wordChar ? (inWord ? word + ch : ch) : "";
			inWord = wordChar;
			last = ch;
		}
		// Single-quoted and double-quoted strings never span lines.
		if (quote === '"' || quote === "'") quote = null;
		depths.push(depth);
		open.push(quote === "`");
	}
	// Still inside one at the end of the file: a backtick was misread somewhere (a regular expression taken
	// for a division, say), so which lines are text can't be told. None are, as before.
	if (quote === "`" || expressions.length) open.fill(false);
	return { depths, open };
}

/** Decorators and annotations stacked on a declaration, by language: they belong to it, not to `(top)`. */
const DECORATOR: Partial<Record<Lang, RegExp>> = {
	js: /^@[\w$.]+/,
	py: /^@[\w.]+/,
	java: /^(?:@[\w.]+|#\[|\[[A-Z][\w.]*(?:\(.*\))?\]\s*$)/,
	rust: /^#\[/,
};

/** First line (0-based) of the decorators or annotations stacked right above the declaration at line `i`. */
function decoratedFrom(lines: string[], i: number, lang: Lang): number {
	const re = DECORATOR[lang];
	if (!re) return i;
	const indent = lines[i].length - lines[i].trimStart().length;
	let start = i;
	for (let j = i - 1; j >= Math.max(0, i - 40); j--) {
		const text = lines[j].trimStart();
		const at = lines[j].length - text.length;
		if (!text) break;
		if (at === indent && re.test(text)) start = j;
		// A decorator's arguments may span lines; anything else above ends the stack.
		else if (!(at > indent || (at === indent && /^[)\]}]/.test(text)))) break;
	}
	return start;
}

function extractBraces(lines: string[], lang: Lang, decls: Decl[], member: RegExp | null): SymbolSpan[] {
	const { depths, open } = braceDepths(lines, lang);
	const out: SymbolSpan[] = [];
	const depthBefore = (i: number) => (i === 0 ? 0 : depths[i - 1]);
	// A line that starts inside a template literal is text: no declaration starts there, nor does one end.
	const inString = (i: number) => i > 0 && open[i - 1];
	const isDecl = (line: string) => decls.some(({ re }) => re.test(line));

	/** Line index where the declaration starting at line `i` (at brace depth d) ends. */
	const blockEnd = (i: number, d: number) => {
		let opened = false;
		for (let j = i; j < lines.length; j++) {
			if (depths[j] > d) opened = true;
			if (opened && depths[j] <= d) return j;
			if (!opened) {
				// A block-less declaration (`const x = 1;`) ends at its statement terminator, a blank
				// line, or the next declaration (semicolon-free style), none of them inside a template literal.
				if (j > i && !inString(j) && isDecl(lines[j])) return j - 1;
				if (open[j]) continue;
				if (/;\s*$/.test(lines[j])) return j;
				if (inString(j)) continue;
				if (j > i && lines[j].trim() === "") return j - 1;
			}
		}
		return lines.length - 1;
	};

	const namespace = NAMESPACES[lang];
	/**
	 * Whether a namespace line at `i` opens its block: its `{` counts there (not in a string or comment), or opens
	 * the next line of code. `extern "C"` alone may introduce just one function.
	 */
	const opens = (i: number, depth: number, to: number) => {
		if (depths[i] > depth) return true;
		let next = i + 1;
		while (next < to && /^\s*(?:$|\/\/|#)/.test(lines[next])) next++;
		return depths[i] === depth && /^\s*\{/.test(lines[next] ?? "");
	};
	/** The declarations from line `from` to `to` at brace depth `depth`, their names after `prefix`. */
	const scan = (from: number, to: number, depth: number, prefix: string) => {
		for (let i = from; i < to; i++) {
			if (depthBefore(i) !== depth) continue;
			const ns = namespace?.re.exec(lines[i]);
			if (ns && opens(i, depth, to)) {
				const end = blockEnd(i, depth);
				scan(i + 1, end, depth + 1, namespace!.qualify && ns[1] ? `${prefix}${ns[1].replace(/::(?:inline\s+)?/g, ".")}.` : prefix);
				i = end;
				continue;
			}
			// A namespace's declarations may be indented (C's are matched at the start of a line).
			const text = depth ? lines[i].trimStart() : lines[i];
			const fn = lang === "c" && depth ? C_NAMESPACE_FUNCTION.exec(text) : null;
			const nsDecl: Decl[] = fn && !CONTROL.has(fn[1]) && !C_NOT_NAMES.has(fn[1]) ? [{ re: C_NAMESPACE_FUNCTION, kind: "function" }] : [];
			for (const decl of [...decls, ...nsDecl]) {
				const m = text.match(decl.re);
				if (!m) continue;
				const name = prefix + (decl.name ? decl.name(m) : m[m.length - 1]);
				// Nothing declared in a namespace ends after its closing line.
				const end = Math.min(blockEnd(i, depth), to);
				out.push({ name, kind: decl.kind, start: decoratedFrom(lines, i, lang) + 1, end: end + 1 });
				if (decl.container && member) {
					for (let j = i + 1; j < end; j++) {
						if (depthBefore(j) !== depth + 1) continue;
						const mm = lines[j].match(member);
						const memberName = mm && (mm[1] ?? mm[2] ?? mm[3]);
						// Keyword-introduced members (Rust `fn new`, Kotlin `fun when`) can't be statements.
						const keyword = lang === "rust" || (lang === "java" && mm?.[1] !== undefined);
						if (!memberName || (!keyword && CONTROL.has(memberName)) || /;\s*$/.test(lines[j])) continue;
						const mEnd = blockEnd(j, depth + 1);
						out.push({ name: `${name}.${memberName}`, kind: "method", start: decoratedFrom(lines, j, lang) + 1, end: mEnd + 1 });
						j = mEnd;
					}
				}
				i = end;
				break;
			}
		}
	};
	scan(0, lines.length, 0, "");
	return out;
}

/** Python: which lines start inside a triple-quoted string (a docstring or text over several lines). */
function inTripleQuotes(lines: string[]): boolean[] {
	const inside: boolean[] = [];
	let open: string | null = null;
	for (const line of lines) {
		inside.push(open !== null);
		for (let i = 0; i < line.length; i++) {
			if (open) {
				if (line[i] === "\\") i++;
				else if (line.startsWith(open, i)) {
					open = null;
					i += 2;
				}
				continue;
			}
			const ch = line[i];
			// A comment runs to the end of the line.
			if (ch === "#") break;
			if (ch !== '"' && ch !== "'") continue;
			if (line.startsWith(ch.repeat(3), i)) {
				open = ch.repeat(3);
				i += 2;
				continue;
			}
			// A one-line string ('"""' in it opens nothing): on to its closing quote.
			for (i++; i < line.length && line[i] !== ch; i++) if (line[i] === "\\") i++;
		}
	}
	return inside;
}

function extractIndented(lines: string[], lang: "py" | "ruby"): SymbolSpan[] {
	const out: SymbolSpan[] = [];
	const indentOf = (l: string) => l.length - l.trimStart().length;
	// Python: a line inside a triple-quoted string, or a comment, says nothing about where a block ends.
	const text = lang === "py" ? inTripleQuotes(lines) : lines.map(() => false);
	const endOf = (i: number, indent: number) => {
		let last = i;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === "") continue;
			if (text[j]) {
				last = j;
				continue;
			}
			if (lang === "py" && /^\s*#/.test(lines[j])) {
				// A comment says nothing about where a block ends, but one indented into it is its own.
				if (indentOf(lines[j]) > indent) last = j;
				continue;
			}
			if (indentOf(lines[j]) <= indent) {
				// Ruby blocks close with an `end` at the declaration's indentation.
				if (lang === "ruby" && indentOf(lines[j]) === indent && /^\s*end\b/.test(lines[j])) last = j;
				break;
			}
			last = j;
		}
		return last;
	};
	/** Where a Python header starting at line `i` ends: a signature may run over several lines until its brackets close. */
	const headerEnd = (i: number) => {
		if (lang !== "py") return i;
		let depth = 0;
		for (let j = i; j < Math.min(lines.length, i + 60); j++) {
			const code = lines[j].replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""').replace(/#.*$/, "");
			for (const ch of code) {
				if (ch === "(" || ch === "[" || ch === "{") depth++;
				else if (ch === ")" || ch === "]" || ch === "}") depth--;
			}
			if (depth <= 0) return j;
		}
		return i;
	};
	const top = lang === "py" ? /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/ : /^(def|class|module)\s+(?:self\.)?([A-Za-z_][\w:]*[?!=]?)/;
	const inner = lang === "py" ? /^(\s+)(?:async\s+)?def\s+([A-Za-z_]\w*)/ : /^(\s+)def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/;
	for (let i = 0; i < lines.length; i++) {
		const m = !text[i] && lines[i].match(top);
		if (!m) continue;
		const end = endOf(headerEnd(i), 0);
		const container = m[1] !== "def";
		out.push({ name: m[2], kind: container ? "class" : "function", start: decoratedFrom(lines, i, lang) + 1, end: end + 1 });
		if (container) {
			for (let j = i + 1; j <= end; j++) {
				const mm = !text[j] && lines[j].match(inner);
				if (!mm) continue;
				const mEnd = endOf(headerEnd(j), mm[1].length);
				out.push({ name: `${m[2]}.${mm[2]}`, kind: "method", start: decoratedFrom(lines, j, lang) + 1, end: mEnd + 1 });
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
	switch (languageOf(path)) {
		case "js":
			return extractBraces(lines, "js", JS_DECLS, JS_MEMBER);
		case "py":
			return extractIndented(lines, "py");
		case "ruby":
			return extractIndented(lines, "ruby");
		case "go":
			return extractBraces(lines, "go", GO_DECLS, null);
		case "rust":
			return extractBraces(lines, "rust", RUST_DECLS, RUST_MEMBER);
		case "java":
			return extractBraces(lines, "java", JAVA_DECLS, JAVA_MEMBER);
		case "c":
			return extractBraces(lines, "c", C_DECLS, C_MEMBER);
		default:
			return [];
	}
}

/** Innermost symbol containing a 1-based line, or `(top)`. */
export function symbolAt(symbols: SymbolSpan[], line: number): string {
	let best: SymbolSpan | null = null;
	for (const s of symbols) {
		if (line >= s.start && line <= s.end && (!best || s.end - s.start <= best.end - best.start)) best = s;
	}
	return best ? best.name : TOP;
}

/**
 * symbolAt of every line from `start` to `end` (1-based, inclusive), as an array from `start` on. A span at a
 * time, widest first (a narrower one, nested in it, then takes its lines): line by line, a long file with many
 * functions would take its lines times its functions.
 */
export function symbolsByLine(symbols: SymbolSpan[], start: number, end: number): string[] {
	const names: string[] = new Array(Math.max(0, end - start + 1)).fill(TOP);
	const width = (s: SymbolSpan) => s.end - s.start;
	// Of two as wide, the later one, as symbolAt picks it.
	const spans = symbols.map((s, i) => [s, i] as const).filter(([s]) => s.end >= start && s.start <= end);
	spans.sort(([x, i], [y, j]) => width(y) - width(x) || i - j);
	for (const [s] of spans) for (let l = Math.max(start, s.start); l <= Math.min(end, s.end); l++) names[l - start] = s.name;
	return names;
}

/** All symbols overlapping a 1-based inclusive line range (innermost spans only), or `(top)`. */
export function symbolsInRange(symbols: SymbolSpan[], start: number, end: number): string[] {
	return [...new Set(symbolsByLine(symbols, start, end))];
}
