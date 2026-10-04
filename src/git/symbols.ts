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
	{ re: /^\s*(?:template\s*<[^>]*>\s*)?(?:class|struct|union|namespace)\s+(\w+)(?:\s*:[^{;]*)?\s*\{?\s*$/, kind: "class", container: true },
	{ re: /^\s*(?:typedef\s+)?enum\s+(?:class\s+)?(\w+)/, kind: "const" },
	// `static int parse_header(const char *s) {`, `Cart::Add(...)` → definitions only (no trailing `;`).
	{ re: /^(?!\s*(?:return|else|if|for|while|switch|case|do)\b)[A-Za-z_][\w\s*&:<>,~]*?\b((?:\w+::)*~?\w+)\s*\([^;]*$/, kind: "function", name: (m) => m[1].replace(/::/g, ".") },
];
const C_MEMBER = /^\s+(?:(?:virtual|static|inline|explicit|constexpr|friend|override)\s+)*(?:[\w<>:,*&~]+\s+)*?(~?\w+)\s*\([^;]*$/;

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

/** Brace depth after each line, ignoring braces inside strings and comments (approximate). */
function braceDepths(lines: string[], lang: Lang): number[] {
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
			if (ch === "#" && lang === "java" && line.trimStart().startsWith("#")) break; // PHP comments
			if (ch === "/" && next === "*") {
				inBlockComment = true;
				i++;
				continue;
			}
			if (ch === "'" && lang !== "js") {
				// Character literals ('{', '\n'); a lone quote is a Rust lifetime or a generic, not a string.
				const close = line.indexOf("'", i + 1);
				if (close > i && close <= i + 3) i = close;
				continue;
			}
			if (ch === '"' || ch === "'" || (ch === "`" && (lang === "js" || lang === "go"))) {
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

function extractBraces(lines: string[], lang: Lang, decls: Decl[], member: RegExp | null): SymbolSpan[] {
	const depths = braceDepths(lines, lang);
	const out: SymbolSpan[] = [];
	const depthBefore = (i: number) => (i === 0 ? 0 : depths[i - 1]);
	const isDecl = (line: string) => decls.some(({ re }) => re.test(line));

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
		for (const decl of decls) {
			const m = lines[i].match(decl.re);
			if (!m) continue;
			const name = decl.name ? decl.name(m) : m[m.length - 1];
			const end = blockEnd(i, 0);
			out.push({ name, kind: decl.kind, start: i + 1, end: end + 1 });
			if (decl.container && member) {
				for (let j = i + 1; j < end; j++) {
					if (depthBefore(j) !== 1) continue;
					const mm = lines[j].match(member);
					const memberName = mm && (mm[1] ?? mm[2] ?? mm[3]);
					// Keyword-introduced members (Rust `fn new`, Kotlin `fun when`) can't be statements.
					const keyword = lang === "rust" || (lang === "java" && mm?.[1] !== undefined);
					if (!memberName || (!keyword && CONTROL.has(memberName)) || /;\s*$/.test(lines[j])) continue;
					const mEnd = blockEnd(j, 1);
					out.push({ name: `${name}.${memberName}`, kind: "method", start: j + 1, end: mEnd + 1 });
					j = mEnd;
				}
			}
			i = end;
			break;
		}
	}
	return out;
}

function extractIndented(lines: string[], lang: "py" | "ruby"): SymbolSpan[] {
	const out: SymbolSpan[] = [];
	const indentOf = (l: string) => l.length - l.trimStart().length;
	const endOf = (i: number, indent: number) => {
		let last = i;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim() === "") continue;
			if (indentOf(lines[j]) <= indent) {
				// Ruby blocks close with an `end` at the declaration's indentation.
				if (lang === "ruby" && indentOf(lines[j]) === indent && /^\s*end\b/.test(lines[j])) last = j;
				break;
			}
			last = j;
		}
		return last;
	};
	const top = lang === "py" ? /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/ : /^(def|class|module)\s+(?:self\.)?([A-Za-z_][\w:]*[?!=]?)/;
	const inner = lang === "py" ? /^(\s+)(?:async\s+)?def\s+([A-Za-z_]\w*)/ : /^(\s+)def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/;
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i].match(top);
		if (!m) continue;
		const end = endOf(i, 0);
		const container = m[1] !== "def";
		out.push({ name: m[2], kind: container ? "class" : "function", start: i + 1, end: end + 1 });
		if (container) {
			for (let j = i + 1; j <= end; j++) {
				const mm = lines[j].match(inner);
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

/** All symbols overlapping a 1-based inclusive line range (innermost spans only), or `(top)`. */
export function symbolsInRange(symbols: SymbolSpan[], start: number, end: number): string[] {
	const hits = new Set<string>();
	for (let line = start; line <= end; line++) hits.add(symbolAt(symbols, line));
	return [...hits];
}
