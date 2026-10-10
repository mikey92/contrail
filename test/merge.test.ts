import { describe, expect, it } from "vitest";
import { contextChanges, mergeText, touchedSymbols } from "../src/git/merge";

const BASE = `export function add(a, b) {
  return a + b;
}

export function sub(a, b) {
  return a - b;
}
`;

describe("mergeText", () => {
	it("merges disjoint edits in different functions", () => {
		const ours = BASE.replace("return a + b;", "return Number(a) + Number(b);");
		const theirs = BASE.replace("return a - b;", "return Number(a) - Number(b);");
		const r = mergeText("m.js", BASE, ours, theirs);
		expect(r.clean).toBe(true);
		expect(r.text).toContain("Number(a) + Number(b)");
		expect(r.text).toContain("Number(a) - Number(b)");
	});

	it("unions two agents appending functions at the end of a file", () => {
		const ours = `${BASE}\nexport function mul(a, b) {\n  return a * b;\n}\n`;
		const theirs = `${BASE}\nexport function div(a, b) {\n  return a / b;\n}\n`;
		const r = mergeText("m.js", BASE, ours, theirs);
		expect(r.clean).toBe(true);
		expect(r.unioned).toBe(1);
		expect(r.text).toContain("function mul");
		expect(r.text).toContain("function div");
		expect(r.text.indexOf("function mul")).toBeLessThan(r.text.indexOf("function div"));
	});

	it("reports a structured conflict with the touched symbol", () => {
		const ours = BASE.replace("return a + b;", "return a + b + 0;");
		const theirs = BASE.replace("return a + b;", "return (a + b) | 0;");
		const r = mergeText("m.js", BASE, ours, theirs);
		expect(r.clean).toBe(false);
		expect(r.conflicts).toHaveLength(1);
		expect(r.conflicts[0]).toMatchObject({
			baseStart: 2,
			baseLines: ["  return a + b;"],
			ours: ["  return a + b + 0;"],
			theirs: ["  return (a + b) | 0;"],
			symbols: ["add"],
		});
	});

	it("keeps one copy when both sides insert the same lines", () => {
		const ours = `import x from "x";\n${BASE}`;
		const r = mergeText("m.js", BASE, ours, ours.replace("", ""));
		expect(r.clean).toBe(true);
		expect(r.text.match(/import x/g)).toHaveLength(1);
	});
});

describe("touchedSymbols", () => {
	it("lists modified and added symbols", () => {
		const after = BASE.replace("return a - b;", "return b - a;") + "\nexport function mul(a, b) {\n  return a * b;\n}\n";
		expect(touchedSymbols("m.js", BASE, after)).toEqual(["mul", "sub"]);
	});
	it("treats file creation as (top)", () => {
		expect(touchedSymbols("m.js", null, "x")).toEqual(["(top)"]);
	});
	it("counts every function of a file that is added or deleted as touched", () => {
		// A deleted file changes the functions others may be cleared for.
		expect(touchedSymbols("m.js", BASE, null)).toEqual(["(top)", "add", "sub"]);
		expect(touchedSymbols("m.js", null, BASE)).toEqual(["(top)", "add", "sub"]);
	});
});

describe("mergeText inserts", () => {
	const base = 'import { a } from "./a.js";\n\nexport function one() {\n  return a;\n}\n';
	it("keeps an import both sides added once", () => {
		const ours = base.replace('import { a } from "./a.js";\n', 'import { a } from "./a.js";\nimport { z } from "./z.js";\nimport { x } from "./x.js";\n');
		const theirs = base.replace('import { a } from "./a.js";\n', 'import { a } from "./a.js";\nimport { z } from "./z.js";\nimport { y } from "./y.js";\n');
		const r = mergeText("m.js", base, ours, theirs);
		expect(r.clean).toBe(true);
		expect(r.text.match(/import \{ z \}/g)).toHaveLength(1);
		expect(r.text).toContain('import { x } from "./x.js";');
		expect(r.text).toContain('import { y } from "./y.js";');
	});
	it("reports two inserts that declare the same name as a conflict", () => {
		const ours = `${base}\nexport function clamp(x) {\n  return Math.max(0, x);\n}\n`;
		const theirs = `${base}\nexport function clamp(x) {\n  return Math.min(1, x);\n}\n`;
		const r = mergeText("m.js", base, ours, theirs);
		expect(r.clean).toBe(false);
		expect(r.conflicts[0].symbols).toEqual(["clamp"]);
	});
});

describe("mergeText inserts, by language", () => {
	const base = 'import { a } from "./a.js";\n\nexport function one() {\n  return a;\n}\n';
	it("keeps both multi-line imports whole", () => {
		const ours = base.replace('import { a } from "./a.js";\n', 'import { a } from "./a.js";\nimport {\n  x,\n} from "./x.js";\n');
		const theirs = base.replace('import { a } from "./a.js";\n', 'import { a } from "./a.js";\nimport {\n  y,\n} from "./y.js";\n');
		const r = mergeText("m.js", base, ours, theirs);
		expect(r.clean).toBe(true);
		expect(r.text).toContain('import {\n  x,\n} from "./x.js";');
		expect(r.text).toContain('import {\n  y,\n} from "./y.js";');
	});
	it("does not take two const enums for the same name", () => {
		const ours = `${base}\nexport const enum Color {\n  Red,\n}\n`;
		const theirs = `${base}\nexport const enum Size {\n  Small,\n}\n`;
		const r = mergeText("m.ts", base, ours, theirs);
		expect(r.clean).toBe(true);
		expect(r.text).toContain("enum Color");
		expect(r.text).toContain("enum Size");
	});
	it("reads declarations in the file's own language only", () => {
		// Prose that starts with "let" declares nothing.
		const r = mergeText("NOTES.md", "# Notes\n", "# Notes\nlet me know first\n", "# Notes\nlet me in later\n");
		expect(r.clean).toBe(true);
		const py = mergeText("m.py", "import os\n", "import os\n\ndef clamp(x):\n    return max(0, x)\n", "import os\n\ndef clamp(x):\n    return min(1, x)\n");
		expect(py.clean).toBe(false);
		expect(py.conflicts[0].symbols).toEqual(["clamp"]);
	});
});

describe("mergeText inserts that share an import", () => {
	it("keeps a multi-line import both sides added once, with both sides' code", () => {
		const base = "export const k = 1;\n";
		const ours = `${base}import {\n  a,\n} from "./a.js";\nexport function fa() {\n  return a;\n}\n`;
		const theirs = `${base}import {\n  a,\n} from "./a.js";\nexport function fb() {\n  return a;\n}\n`;
		const r = mergeText("src/x.js", base, ours, theirs);
		expect(r.clean).toBe(true);
		expect(r.text.match(/from "\.\/a\.js"/g)).toHaveLength(1);
		expect(r.text).toContain('import {\n  a,\n} from "./a.js";\nexport function fa()');
		expect(r.text).toContain("export function fb()");
	});
	it("keeps a parenthesized Python import both sides added once", () => {
		const base = "x = 1\n";
		const ours = `${base}from helpers import (\n    alpha,\n)\ndef test_a():\n    assert alpha()\n`;
		const theirs = `${base}from helpers import (\n    alpha,\n)\ndef test_b():\n    assert alpha()\n`;
		const r = mergeText("tests/test_x.py", base, ours, theirs);
		expect(r.clean).toBe(true);
		expect(r.text.match(/from helpers import/g)).toHaveLength(1);
		expect(r.text).toContain("def test_a():");
		expect(r.text).toContain("def test_b():");
	});
});

describe("mergeText inserts across languages", () => {
	const insert = (path: string, base: string, a: string, b: string) => mergeText(path, base, `${base}${a}`, `${base}${b}`);
	it("keeps one copy of an import both add, with a comment, attributes or import-equals", () => {
		for (const line of ['import { z } from "zod"; // validation', 'import data from "./data.json" with { type: "json" };', 'import fs = require("fs");']) {
			const r = insert("src/x.ts", "export const k = 1;\n", `${line}\nexport const a = 1;\n`, `${line}\nexport const b = 2;\n`);
			expect(r.clean).toBe(true);
			expect(r.text.split(line)).toHaveLength(2);
		}
	});
	it("keeps one copy of a multi-line import whose lines carry comments", () => {
		const js = 'import {\n  a, // the a\n} from "./a.js"; // ours\n';
		const r = insert("src/m.js", "export const k = 1;\n", `${js}export function fa() {\n  return a;\n}\n`, `${js}export function fb() {\n  return a;\n}\n`);
		expect(r.clean).toBe(true);
		expect(r.text.match(/from "\.\/a\.js"/g)).toHaveLength(1);
		const py = "from helpers import (\n    alpha,  # see (docs)\n    beta,\n)\n";
		const p = insert("tests/test_x.py", "x = 1\n", `${py}def test_a():\n    assert alpha()\n`, `${py}def test_b():\n    assert beta()\n`);
		expect(p.clean).toBe(true);
		expect(p.text.match(/from helpers import/g)).toHaveLength(1);
	});
	it("reports a name declared twice in Go, Rust, Swift, Kotlin, PHP and Vue", () => {
		const cases: [string, string, string][] = [
			["errors.go", 'var ErrGone = errors.New("gone")\n', 'var ErrGone = errors.New("gone away")\n'],
			["src/lib.rs", "const MAX: usize = 10;\n", "const MAX: usize = 20;\n"],
			["Sources/Clamp.swift", "func clamp(_ x: Int) -> Int { x }\n", "func clamp(_ x: Int) -> Int { 0 }\n"],
			["src/Money.kt", "class Money(val cents: Long)\n", "class Money(val amount: Double)\n"],
			["src/slug.php", "function slugify($s) { return $s; }\n", "function slugify($s) { return strtolower($s); }\n"],
			["src/App.vue", "const count = ref(0)\n", "const count = ref(1)\n"],
		];
		for (const [path, a, b] of cases) expect(insert(path, "// top\n", a, b).clean, path).toBe(false);
	});
	it("keeps names a file may declare more than once", () => {
		expect(insert("main.go", "package main\n", 'func init() {\n\tregister("a")\n}\n', 'func init() {\n\tregister("b")\n}\n').clean).toBe(true);
		expect(insert("shapes.go", "package shapes\n", "var _ Shape = (*Box)(nil)\n", "var _ Shape = (*Circle)(nil)\n").clean).toBe(true);
		expect(insert("fmt.py", "import functools\n", "@show.register\ndef _(x: int):\n    return str(x)\n", "@show.register\ndef _(x: list):\n    return ', '.join(x)\n").clean).toBe(true);
		// In JavaScript `_` is a name like any other (lodash): declared twice, the file doesn't parse.
		expect(insert("src/util.js", 'const fs = require("fs");\n', 'const _ = require("lodash");\nconst sum = (xs) => _.sum(xs);\n', 'const _ = require("lodash");\nconst uniq = (xs) => _.uniq(xs);\n').clean).toBe(false);
	});
	it("does not take a type or a merged interface for a name declared twice", () => {
		expect(insert("src/x.c", "int main(void);\n", "const int MAX_A = 1;\n", "const int MAX_B = 2;\n").clean).toBe(true);
		expect(insert("src/x.kt", "package x\n", "const val A = 1\n", "const val B = 2\n").clean).toBe(true);
		expect(insert("src/global.d.ts", "export {};\n", "interface Window {\n  a: string;\n}\n", "interface Window {\n  b: number;\n}\n").clean).toBe(true);
	});
	it("stays fast on hostile inserts", () => {
		const t0 = Date.now();
		insert("src/x.js", "export const k = 1;\n", `import ${"{".repeat(40_000)}\n`, `import ${"{".repeat(40_001)}\n`);
		insert("src/y.js", "export const k = 1;\n", "import {\n".repeat(20_000), "import { x }\n".repeat(20_000));
		expect(Date.now() - t0).toBeLessThan(1000);
	});
});

describe("contextChanges", () => {
	const before = 'export function coupon(amount, code) {\n  if (code === "A") {\n    return amount - 5;\n  }\n  return amount;\n}\n\nexport function tax(amount) {\n  return amount * 0.07;\n}\n';
	const after = before.replace('  if (code === "A") {', '  if (code === "HALF") {\n    return amount / 2;\n  }\n  if (code === "A") {').replace("amount * 0.07", "amount * RATE");

	it("names the symbol each hunk changes and shows the lines around it", () => {
		const [half, rate] = contextChanges("src/pricing.js", before, after, 2);
		expect(half).toMatchObject({ start: 2, removed: [], added: ['  if (code === "HALF") {', "    return amount / 2;", "  }"], symbols: ["coupon"] });
		expect(half.before).toEqual(["export function coupon(amount, code) {"]);
		expect(half.after).toEqual(['  if (code === "A") {', "    return amount - 5;"]);
		expect(rate).toMatchObject({ removed: ["  return amount * 0.07;"], added: ["  return amount * RATE;"], symbols: ["tax"] });
		expect(rate.before).toEqual(["", "export function tax(amount) {"]);
	});

	it("never shows a line another hunk changes as context", () => {
		const a = "one\ntwo\nthree\nfour\n";
		const hunks = contextChanges("notes.txt", a, a.replace("one", "ONE").replace("three", "THREE"), 3);
		expect(hunks).toHaveLength(2);
		expect(hunks[0].after).toEqual(["two"]);
		expect(hunks[1].before).toEqual(["two"]);
		expect(hunks[0].symbols).toEqual(["(top)"]);
	});
});

describe("big files", () => {
	// A long file of near-identical lines: the worst case for a line diff (a lockfile, a generated file).
	const long = (n: number, tag = "") => Array.from({ length: n }, (_, i) => `  "pkg-${i % 7}": "^1.${i % 3}.0",${tag}`).join("\n");

	it("diffs one edit to a long file by its few lines, fast", () => {
		const before = long(18_000);
		const lines = before.split("\n");
		lines[9_000] = '  "left-pad": "^1.3.0",';
		const t0 = Date.now();
		const symbols = touchedSymbols("package-lock.json", before, lines.join("\n"));
		const hunks = contextChanges("src/big.js", before, lines.join("\n"));
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(symbols).toEqual(["(top)"]);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].start).toBe(9_001);
		expect(hunks[0].added).toEqual(['  "left-pad": "^1.3.0",']);
	});

	it("counts a span too long to diff as one change, without stalling", () => {
		const t0 = Date.now();
		const hunks = contextChanges("src/big.js", `first\n${long(4_000)}\nlast`, `first\n${long(4_000, " ")}\nlast`);
		expect(Date.now() - t0).toBeLessThan(1000);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].start).toBe(2);
		expect(hunks[0].removed).toHaveLength(4_000);
		expect(hunks[0].added).toHaveLength(4_000);
	});

	it("merges edits to a long file at either end, and calls a long span both sides rewrote a conflict", () => {
		const base = long(18_000);
		const ours = `// trunk\n${base}`;
		const theirs = `${base}\n// flight`;
		const t0 = Date.now();
		const merged = mergeText("package-lock.json", base, ours, theirs);
		expect(merged.clean).toBe(true);
		expect(merged.text).toBe(`// trunk\n${base}\n// flight`);
		const both = mergeText("package-lock.json", `a\n${long(4_000)}\nz`, `a\n${long(4_000, " ")}\nz`, `a\n${long(4_000, "  ")}\nz`);
		expect(Date.now() - t0).toBeLessThan(2000);
		expect(both.clean).toBe(false);
		expect(both.conflicts[0].baseStart).toBe(2);
		expect(both.text.startsWith("a\n<<<<<<< trunk\n")).toBe(true);
		expect(both.text.endsWith("\n>>>>>>> flight\nz")).toBe(true);
	});

	it("names only the functions a change to a long file touches", () => {
		const fns = Array.from({ length: 700 }, (_, i) => [`function f${i}() {`, `  return ${i};`, "}"]).flat();
		const before = ["// header", ...fns, ""].join("\n");
		const after = ["// header, edited", ...fns, "", "function g() {", "  return -1;", "}", ""].join("\n");
		expect(touchedSymbols("src/fns.js", before, after)).toEqual(["(top)", "g"]);
	});

	it("keeps edits far apart in a long file one side rewrote much of", () => {
		// Trunk rewrites 501 lines at both ends of 1,100: more than Myers' diff takes on, so it splits at the
		// lines both keep; the flight's edit in the middle stays its own.
		const base = Array.from({ length: 1_100 }, (_, i) => `const v${i} = ${i};`);
		const ours = base.map((l, i) => (i < 251 || i >= 850 ? l.replace("const", "let") : l));
		const theirs = base.map((l, i) => (i === 600 ? "const v600 = 'six hundred';" : l));
		const merged = mergeText("src/values.js", base.join("\n"), ours.join("\n"), theirs.join("\n"));
		expect(merged.clean).toBe(true);
		expect(merged.text).toBe(ours.map((l, i) => (i === 600 ? theirs[600] : l)).join("\n"));
	});

	it("stays fast when every line of a long file changed", () => {
		const base = Array.from({ length: 100_000 }, (_, i) => `const v${i} = ${i};`);
		const t0 = Date.now();
		const merged = mergeText("src/values.js", base.join("\n"), base.map((l) => l.replace("const", "let")).join("\n"), base.map((l, i) => (i === 50_000 ? "const v = 0;" : l)).join("\n"));
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(merged.conflicts).toHaveLength(1);
		expect(merged.conflicts[0].symbols.length).toBeGreaterThan(1);
	});

	it("merges a file too long to spread into one call", () => {
		const base = Array.from({ length: 140_000 }, (_, i) => `line ${i}`).join("\n");
		const merged = mergeText("data.txt", base, base.replace("line 10\n", "line ten\n"), base.replace("line 139990\n", "line 139,990\n"));
		expect(merged.clean).toBe(true);
		expect(merged.text).toBe(base.replace("line 10\n", "line ten\n").replace("line 139990\n", "line 139,990\n"));
		const both = mergeText("data.txt", base, base.replaceAll("line", "Line"), base.replaceAll("line", "LINE"));
		expect(both.conflicts).toHaveLength(1);
		expect(both.conflicts[0].ours).toHaveLength(140_000);
	});
});

describe("one change both sides made, in a long file", () => {
	// A package-lock.json with 600 packages (2,405 lines): every package ends on the same lines as the one before it.
	const names = Array.from({ length: 600 }, (_, i) => `p${String(i).padStart(4, "0")}`);
	const lock = (after: string[]) =>
		[
			"{",
			'  "lockfileVersion": 3,',
			'  "packages": {',
			...names
				.flatMap((n) => (after.includes(n) ? [n, `${n}a`] : [n]))
				.flatMap((n, i, all) => [`    "node_modules/${n}": {`, '      "version": "1.0.0",', '      "license": "MIT"', i === all.length - 1 ? "    }" : "    },"]),
			"  }",
			"}",
		].join("\n");

	it("keeps a package both sides added once, when one side also added another before it", () => {
		const merged = mergeText("package-lock.json", lock([]), lock(["p0010", "p0500"]), lock(["p0500"]));
		expect(merged.clean).toBe(true);
		expect(merged.text).toBe(lock(["p0010", "p0500"]));
	});

	it("drops a line both sides deleted once, when one side also changed the first line", () => {
		const cases = Array.from({ length: 700 }, (_, i) => [`test("case ${i}", () => {`, `  expect(run(${i})).toBe(${i});`, "});"]).flat();
		const base = [...cases, 'test("waits", async () => {', "  await tick();", "  await tick();", "  await tick();", "});", ""].join("\n");
		const theirs = base.replace("  await tick();\n", "");
		const ours = theirs.replace('test("case 0"', 'test("case zero"');
		const merged = mergeText("test/wait.test.js", base, ours, theirs);
		expect(merged.clean).toBe(true);
		expect(merged.text).toBe(ours);
	});

	it("lines the change up the same on both sides when only one side's diff is long", () => {
		// base + ours fits the short diff, base + theirs doesn't: both sides still go through one algorithm. Both
		// drop one of three `}` in a row; theirs also adds lines at the top.
		const base = Array.from({ length: 990 }, (_, i) => (i >= 800 && i < 803 ? "}" : `line ${i}`));
		const ours = base.filter((_, i) => i !== 801);
		const theirs = [...Array.from({ length: 30 }, (_, i) => `new ${i}`), ...ours];
		const merged = mergeText("x.txt", base.join("\n"), ours.join("\n"), theirs.join("\n"));
		expect(merged.clean).toBe(true);
		expect(merged.text).toBe(theirs.join("\n"));
	});

	it("applies both sides' changes when a side rewrote too much for one diff", () => {
		// Over 1,000 changed lines: a side's diff splits at the lines both keep. A change both made, and each side's
		// rewrite far from it, still merge clean.
		let seed = 5;
		const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		const vocab = ["}", "", "  }", "  await tick();", "},", "    return x;"];
		const line = () => (rnd() < 0.5 ? vocab[Math.floor(rnd() * vocab.length)] : `line ${Math.floor(rnd() * 1e9)}`);
		const block = (n: number) => Array.from({ length: n }, line);
		// New lines all different from the old: 1,200 changes.
		const rewrite = (lines: string[], at: number, n: number) => [...lines.slice(0, at), ...Array.from({ length: n }, () => `new ${Math.floor(rnd() * 1e9)}`), ...lines.slice(at + n)];
		const wrong: string[] = [];
		for (let t = 0; t < 40; t++) {
			const base = block(3_000);
			const at = 1_400 + Math.floor(rnd() * 200);
			// The change both made: a line deleted, or a copy of the four above it added.
			const theirs = rnd() < 0.5 ? [...base.slice(0, at), ...base.slice(at + 1)] : [...base.slice(0, at), ...base.slice(at - 4, at), ...base.slice(at)];
			const before = rnd() < 0.5;
			const ours = rewrite(theirs, before ? 200 : 2_000, 600);
			const both = t % 2 ? rewrite(theirs, before ? 2_000 : 200, 600) : theirs;
			const expected = t % 2 ? (before ? [...ours.slice(0, 1_700), ...both.slice(1_700)] : [...both.slice(0, 1_700), ...ours.slice(1_700)]) : ours;
			const merged = mergeText("x.txt", base.join("\n"), ours.join("\n"), both.join("\n"));
			if (!merged.clean || merged.text !== expected.join("\n")) wrong.push(`${t}: ${merged.clean ? "wrong text" : "conflict"}`);
		}
		expect(wrong).toEqual([]);
	});

	it("calls a change both sides made right below a big rewrite a conflict, never merges it twice", () => {
		// Only lines that repeat (`- done`, blank lines) between the rewrite and the change: the two sides' diffs can
		// place the change differently. A conflict, at any size, not a clean merge with lines twice.
		for (const size of [40, 200, 1_100]) {
			const header = Array.from({ length: 20 }, (_, i) => `intro line ${i}`);
			const oldBlock = Array.from({ length: size }, (_, i) => (i === size - 10 ? "kept line" : `old line ${i}`));
			const newBlock = Array.from({ length: Math.ceil(size / 4) }, (_, i) => [`## Section ${i}`, `- item ${i}`, "- done", ""]).flat();
			newBlock.splice(Math.floor(newBlock.length / 2), 0, "kept line");
			const tail = Array.from({ length: 900 }, (_, i) => `tail line ${i}`);
			const base = [...header, ...oldBlock, "- done", "", "## End", ...tail].join("\n");
			// Both made the rewrite, trunk also deleted the blank line below it.
			const sameRewrite = mergeText("NOTES.md", base, [...header, ...newBlock, "- done", "## End", ...tail].join("\n"), [...header, ...newBlock, "- done", "", "## End", ...tail].join("\n"));
			expect(sameRewrite.clean, `${size}: same rewrite`).toBe(false);
			// Trunk made the rewrite, both added the same note below it.
			const note = mergeText("NOTES.md", base, [...header, ...newBlock, "- done", "- note", "", "## End", ...tail].join("\n"), [...header, ...oldBlock, "- done", "- note", "", "## End", ...tail].join("\n"));
			expect(note.clean, `${size}: note`).toBe(false);
		}
	});

	it("shows a long rewrite's change without the lines its ends share", () => {
		const before = [...Array.from({ length: 1_500 }, (_, i) => `const v${i} = ${i};`), ...Array.from({ length: 600 }, () => "}")];
		const after = [...Array.from({ length: 1_500 }, (_, i) => `let v${i} = ${i};`), ...Array.from({ length: 600 }, () => "}")];
		const hunks = contextChanges("src/values.js", before.join("\n"), after.join("\n"));
		expect(hunks.map((h) => [h.start, h.removed.length, h.added.length])).toEqual([[1, 1_500, 1_500]]);
	});

	it("stays fast when a long file splits into many parts", () => {
		// Every part between section markers rewritten on both sides, and a run of lines that repeat at each marker.
		const base: string[] = [];
		const ours: string[] = [];
		const theirs: string[] = [];
		for (let c = 0; base.length < 100_000; c++) {
			const head = Array.from({ length: 8 }, (_, k) => [`z${k + 1}`, `z${k}`]).flat();
			const fill = (tag: string) => Array.from({ length: 505 }, (_, i) => `${tag} ${c} ${i}`);
			base.push(`block ${c}`, ...head, ...fill("o"));
			ours.push(`block ${c}`, ...head, ...fill("a"));
			theirs.push(`block ${c}`, ...head, ...fill("b"));
		}
		const t0 = Date.now();
		const merged = mergeText("x.txt", base.join("\n"), ours.join("\n"), theirs.join("\n"));
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(merged.clean).toBe(false);
	});

	it("applies both sides' changes whatever else one side changed far from them", () => {
		// Long files of lines that repeat (`}`, blank lines, a lockfile's lines), one change made on both sides and
		// one more on one side, before or after it: the merge is that one change plus the other, clean.
		let seed = 7;
		const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
		const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
		const vocab = ["}", "", "  }", "  await tick();", "},", '      "license": "MIT"', "    return x;", "  });"];
		const block = (n: number) => Array.from({ length: n }, () => (rnd() < 0.55 ? pick(vocab) : `line ${Math.floor(rnd() * 400)}`));
		const change = (lines: string[], at: number) => {
			const out = lines.slice();
			const kind = pick(["insert", "delete", "replace", "copy"]);
			if (kind === "insert") out.splice(at, 0, ...block(1 + Math.floor(rnd() * 5)));
			else if (kind === "delete") out.splice(at, 1 + Math.floor(rnd() * 3));
			else if (kind === "replace") out.splice(at, 1 + Math.floor(rnd() * 3), ...block(1 + Math.floor(rnd() * 3)));
			else out.splice(at, 0, ...lines.slice(at - 4, at));
			return out;
		};
		const wrong: number[] = [];
		for (let t = 0; t < 150; t++) {
			const base = block(1050 + Math.floor(rnd() * 600));
			const at = 100 + Math.floor(rnd() * (base.length - 200));
			const theirs = change(base, at);
			let ours: string[];
			if (rnd() < 0.5) ours = [...change(base.slice(0, at), Math.floor(rnd() * (at - 40))), ...theirs.slice(at)];
			else {
				const after = at + 10 + theirs.length - base.length;
				ours = change(theirs, Math.min(theirs.length - 1, after + 30 + Math.floor(rnd() * Math.max(1, theirs.length - after - 40))));
			}
			const merged = mergeText("x.txt", base.join("\n"), ours.join("\n"), theirs.join("\n"));
			if (!merged.clean || merged.text !== ours.join("\n")) wrong.push(t);
		}
		expect(wrong).toEqual([]);
	});
});

describe("two flights add a method of the same name", () => {
	it("is a conflict, not two definitions side by side, in every language", () => {
		const cases: [string, string, string, string][] = [
			["src/cart.js", "export class Cart {\n  add(x) {\n    this.items.push(x);\n  }\n}\n", "  validate() {\n    return true;\n  }\n", "  validate() {\n    return this.items.length > 0;\n  }\n"],
			["cart.py", "class Cart:\n    def add(self, x):\n        self.items.append(x)\n", "\n    def validate(self):\n        return True\n", "\n    def validate(self):\n        return len(self.items) > 0\n"],
			["cart.go", "package cart\n\nfunc (c *Cart) Add(x int) {\n\tc.items = append(c.items, x)\n}\n", "\nfunc (c *Cart) Validate() bool {\n\treturn true\n}\n", "\nfunc (c *Cart) Validate() bool {\n\treturn len(c.items) > 0\n}\n"],
		];
		for (const [path, base, a, b] of cases) {
			// Each side inserts its method at the same point: the end of the class (or of the file, for Go).
			const at = path.endsWith(".js") ? base.lastIndexOf("}\n") : base.length;
			const merged = mergeText(path, base, base.slice(0, at) + a + base.slice(at), base.slice(0, at) + b + base.slice(at));
			expect(merged.clean, path).toBe(false);
			expect(merged.conflicts[0].symbols.join(), path).toMatch(/[Vv]alidate/);
		}
	});

	it("keeps members that share a name by design", () => {
		const cases: [string, string, string, string][] = [
			// A getter and a setter, a static and an instance method.
			["src/cart.js", "export class Cart {\n  add(x) {\n    this.items.push(x);\n  }\n}\n", "  get total() {\n    return this.sum;\n  }\n", "  set total(v) {\n    this.sum = v;\n  }\n"],
			["src/cart.ts", "export class Cart {\n  add(x) {\n    this.items.push(x);\n  }\n}\n", "  static create() {\n    return new Cart();\n  }\n", "  create() {\n    return this;\n  }\n"],
			// Overloads.
			["src/Log.java", "public class Log {\n  void info(String m) {\n    out(m);\n  }\n}\n", "  void warn(String m) {\n    out(m);\n  }\n", "  void warn(String m, Throwable t) {\n    out(m + t);\n  }\n"],
			["src/shape.cpp", "class Shape {\n  void move(int x) {\n    this->x = x;\n  }\n};\n", "  void scale(int f) {\n    w *= f;\n  }\n", "  void scale(double f) {\n    w = w * f;\n  }\n"],
			// A property's getter and setter; a class method and an instance method.
			["cart.py", "class Cart:\n    def add(self, x):\n        self.items.append(x)\n", "\n    @property\n    def total(self):\n        return self._total\n", "\n    @total.setter\n    def total(self, v):\n        self._total = v\n"],
			["cart.rb", "class Cart\n  def add(x)\n    @items << x\n  end\nend\n", "  def self.build\n    new\n  end\n", "  def build\n    self\n  end\n"],
		];
		for (const [path, base, a, b] of cases) {
			// Each side inserts at the same point: the end of the class.
			const at = path.endsWith(".py") ? base.length : base.lastIndexOf(path.endsWith(".rb") ? "end\n" : "}");
			const merged = mergeText(path, base, base.slice(0, at) + a + base.slice(at), base.slice(0, at) + b + base.slice(at));
			expect(merged.clean, path).toBe(true);
			expect(merged.text, path).toContain(a.trim().split("\n")[0].trim());
			expect(merged.text, path).toContain(b.trim().split("\n")[0].trim());
		}
		// The same trait method for two traits.
		const rs = "pub struct Money(i64);\n";
		const display = "\nimpl fmt::Display for Money {\n    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {\n        write!(f, \"{}\", self.0)\n    }\n}\n";
		const debug = "\nimpl fmt::Debug for Money {\n    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {\n        write!(f, \"Money({})\", self.0)\n    }\n}\n";
		expect(mergeText("src/money.rs", rs, rs + display, rs + debug).clean).toBe(true);
	});

	it("still calls a getter against a method of its name a conflict", () => {
		const base = "export class Cart {\n  add(x) {\n    this.items.push(x);\n  }\n}\n";
		const at = base.lastIndexOf("}");
		const merged = mergeText("src/cart.js", base, `${base.slice(0, at)}  get total() {\n    return 1;\n  }\n${base.slice(at)}`, `${base.slice(0, at)}  total() {\n    return 2;\n  }\n${base.slice(at)}`);
		expect(merged.clean).toBe(false);
		expect(merged.conflicts[0].symbols).toEqual(["Cart.total"]);
	});

	it("still keeps two different methods added at the same point", () => {
		const base = "export class Cart {\n  add(x) {\n    this.items.push(x);\n  }\n}\n";
		const at = base.lastIndexOf("}\n");
		const merged = mergeText("src/cart.js", base, `${base.slice(0, at)}  size() {\n    return this.items.length;\n  }\n${base.slice(at)}`, `${base.slice(0, at)}  clear() {\n    this.items = [];\n  }\n${base.slice(at)}`);
		expect(merged.clean).toBe(true);
		expect(merged.text).toContain("size()");
		expect(merged.text).toContain("clear()");
	});
});

describe("changes at one point or a few lines apart", () => {
	it("keeps two functions added at one point whole when one has a blank line in it", () => {
		// The diff can split such an insert around a base blank line; the other function must not land in between.
		const base = "def a():\n    return 1\n\n\ndef b():\n    return 2\n";
		const at = base.indexOf("\n\n\ndef b");
		const load = "\n\ndef load(path):\n    text = open(path).read()\n\n    return text.strip()";
		const save = "\n\ndef save(path, text):\n    open(path, 'w').write(text)";
		const merged = mergeText("io.py", base, base.slice(0, at) + load + base.slice(at), base.slice(0, at) + save + base.slice(at));
		expect(merged.clean).toBe(true);
		expect(merged.text).toBe(base.slice(0, at) + load + save + base.slice(at));
	});

	it("keeps edits to nearby lines that read the same", () => {
		const cases: [string, string, (t: string) => string, (t: string) => string][] = [
			['stubs.ts', 'export function parse(s: string) {\n  throw new Error("not implemented");\n}\n\nexport function format(x: Node) {\n  throw new Error("not implemented");\n}\n', (t) => t.replace('throw new Error("not implemented");\n}\n\nexport function format', 'return JSON.parse(s);\n}\n\nexport function format'), (t) => t.replace(/throw new Error\("not implemented"\);\n\}\n$/, "return JSON.stringify(x);\n}\n")],
			["stubs.py", "def load(path):\n    pass\n\n\ndef save(path, data):\n    pass\n", (t) => t.replace("    pass\n\n\ndef save", "    with open(path) as f:\n        return f.read()\n\n\ndef save"), (t) => t.replace(/    pass\n$/, "    with open(path, 'w') as f:\n        f.write(data)\n")],
			["flags.yml", "search:\n  enabled: false\nexport:\n  enabled: false\n", (t) => t.replace("search:\n  enabled: false", "search:\n  enabled: true"), (t) => t.replace("export:\n  enabled: false", "export:\n  enabled: true")],
			["theme.css", ".btn {\n  color: red;\n}\n.link {\n  color: red;\n}\n", (t) => t.replace(".btn {\n  color: red;", ".btn {\n  color: blue;"), (t) => t.replace(".link {\n  color: red;", ".link {\n  color: green;")],
			["route.js", 'switch (kind) {\n  case "a":\n    return null;\n  case "b":\n    return null;\n}\n', (t) => t.replace('"a":\n    return null;', '"a":\n    return makeA();'), (t) => t.replace('"b":\n    return null;', '"b":\n    return makeB();')],
		];
		for (const [path, base, ours, theirs] of cases) {
			const merged = mergeText(path, base, ours(base), theirs(base));
			expect(merged.clean, path).toBe(true);
			expect(merged.text, path).toBe(theirs(ours(base)));
		}
	});

	it("keeps two inserts at one point that only end alike", () => {
		// Go's error handling, a try/catch, a lockfile entry's last fields.
		const go = 'package store\n\n\nfunc Open(dsn string) (*sql.DB, error) {\n\treturn sql.Open("postgres", dsn)\n}\n';
		const goFn = (name: string, sql: string) => `\nfunc (s *Store) ${name}(id int) error {\n\t_, err := s.db.Exec("${sql}", id)\n\tif err != nil {\n\t\treturn err\n\t}\n\treturn nil\n}\n`;
		expect(mergeText("store.go", go, go + goFn("SaveUser", "INSERT"), go + goFn("DeleteOrder", "DELETE")).text).toBe(go + goFn("SaveUser", "INSERT") + goFn("DeleteOrder", "DELETE"));
		const ts = 'import { api } from "./api";\n';
		const tsFn = (name: string, call: string) => `\nexport async function ${name}(id: string) {\n  try {\n    return await ${call}(id);\n  } catch (error) {\n    console.error(error);\n    throw error;\n  }\n}\n`;
		expect(mergeText("src/load.ts", ts, ts + tsFn("loadUser", "api.getUser"), ts + tsFn("loadOrder", "api.getOrder")).text).toBe(ts + tsFn("loadUser", "api.getUser") + tsFn("loadOrder", "api.getOrder"));
		const entry = (name: string, v: string) => [`    "node_modules/${name}": {`, `      "version": "${v}",`, `      "resolved": "https://registry.npmjs.org/${name}/-/${name}-${v}.tgz",`, '      "dev": true,', '      "license": "MIT",', '      "engines": {', '        "node": ">=18"', "      }", "    },"];
		const lock = ["{", '  "lockfileVersion": 3,', '  "packages": {', ...entry("acorn", "8.12.0"), ...entry("zod", "3.23.8").map((l) => l.replace("    },", "    }")), "  }", "}", ""];
		const at = 12;
		const merged = mergeText("package-lock.json", lock.join("\n"), [...lock.slice(0, at), ...entry("left-pad", "1.3.0"), ...lock.slice(at)].join("\n"), [...lock.slice(0, at), ...entry("mime", "4.0.4"), ...lock.slice(at)].join("\n"));
		expect(merged.text).toBe([...lock.slice(0, at), ...entry("left-pad", "1.3.0"), ...entry("mime", "4.0.4"), ...lock.slice(at)].join("\n"));
	});

	it("calls one side's insert plus more at the same point a conflict, never two copies", () => {
		const base = 'const app = new Hono();\napp.get("/health", health);\n\nexport default app;\n';
		const routes = 'app.get("/users", listUsers);\napp.post("/users", createUser);\n';
		const merged = mergeText("src/app.ts", base, base.replace("\nexport", `${routes}\nexport`), base.replace("\nexport", `${routes}app.delete("/users/:id", deleteUser);\n\nexport`));
		expect(merged.clean).toBe(false);
	});

	it("calls a note both added a few lines below a rewrite a conflict", () => {
		const header = Array.from({ length: 20 }, (_, i) => `intro line ${i}`);
		const oldBlock = Array.from({ length: 40 }, (_, i) => (i === 30 ? "kept line" : `old line ${i}`));
		const newBlock = Array.from({ length: 10 }, (_, i) => [`## Section ${i}`, `- item ${i}`, "- done", ""]).flat();
		newBlock.splice(20, 0, "kept line");
		const tail = Array.from({ length: 900 }, (_, i) => `tail line ${i}`);
		const gap = Array.from({ length: 6 }, () => "- done");
		const base = [...header, ...oldBlock, "- done", ...gap, "", "## End", ...tail];
		const ours = [...header, ...newBlock, "- done", ...gap, "- note", "", "## End", ...tail];
		const theirs = [...header, ...oldBlock, "- done", ...gap, "- note", "", "## End", ...tail];
		expect(mergeText("NOTES.md", base.join("\n"), ours.join("\n"), theirs.join("\n")).clean).toBe(false);
	});

	it("stays fast when every change sits next to the other side's", () => {
		// Blocks [k, p, K, q]: trunk changes every p, the flight every q, each change a line from the next.
		const base: string[] = [];
		const ours: string[] = [];
		const theirs: string[] = [];
		for (let i = 0; i < 40_000; i++) {
			base.push(`k${i}`, `p${i}`, `K${i}`, `q${i}`);
			ours.push(`k${i}`, `Z${i}`, `K${i}`, `q${i}`);
			theirs.push(`k${i}`, `p${i}`, `K${i}`, `Z${i + 1}`);
		}
		const t0 = Date.now();
		const merged = mergeText("x.txt", base.join("\n"), ours.join("\n"), theirs.join("\n"));
		expect(Date.now() - t0).toBeLessThan(5000);
		expect(merged.clean).toBe(true);
	});
});
