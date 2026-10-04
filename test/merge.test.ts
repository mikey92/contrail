import { describe, expect, it } from "vitest";
import { mergeText, touchedSymbols } from "../src/git/merge";

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
});
