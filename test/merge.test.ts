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

	it("still keeps two different methods added at the same point", () => {
		const base = "export class Cart {\n  add(x) {\n    this.items.push(x);\n  }\n}\n";
		const at = base.lastIndexOf("}\n");
		const merged = mergeText("src/cart.js", base, `${base.slice(0, at)}  size() {\n    return this.items.length;\n  }\n${base.slice(at)}`, `${base.slice(0, at)}  clear() {\n    this.items = [];\n  }\n${base.slice(at)}`);
		expect(merged.clean).toBe(true);
		expect(merged.text).toContain("size()");
		expect(merged.text).toContain("clear()");
	});
});
