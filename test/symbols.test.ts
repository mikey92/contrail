import { describe, expect, it } from "vitest";
import { extractSymbols, symbolAt, TOP } from "../src/git/symbols";

const CART = `import { money } from "./money.js";

export const TAX_RATE = 0.08;

export function subtotal(items) {
  // sum line items { not a brace }
  return items.reduce((s, i) => s + i.price * i.qty, 0);
}

export class Cart {
  constructor() {
    this.items = [];
  }

  addItem(item) {
    if (item.qty <= 0) {
      throw new Error("qty must be positive");
    }
    this.items.push(item);
  }

  static empty() { return new Cart(); }
}

export const applyDiscount = (total, pct) => {
  return total * (1 - pct / 100);
};
`;

describe("extractSymbols (js)", () => {
	const syms = extractSymbols("src/cart.js", CART);
	const byName = Object.fromEntries(syms.map((s) => [s.name, s]));

	it("finds functions, classes, methods and consts", () => {
		expect(Object.keys(byName)).toEqual(
			expect.arrayContaining(["TAX_RATE", "subtotal", "Cart", "Cart.constructor", "Cart.addItem", "Cart.empty", "applyDiscount"]),
		);
	});

	it("computes extents by brace matching, ignoring braces in comments", () => {
		expect(byName.subtotal).toMatchObject({ start: 5, end: 8 });
		expect(byName["Cart.addItem"]).toMatchObject({ start: 15, end: 20 });
		expect(byName.Cart).toMatchObject({ start: 10, end: 23 });
		expect(byName.applyDiscount).toMatchObject({ start: 25, end: 27 });
		expect(byName.TAX_RATE).toMatchObject({ start: 3, end: 3 });
	});

	it("maps lines to innermost symbols", () => {
		expect(symbolAt(syms, 17)).toBe("Cart.addItem");
		expect(symbolAt(syms, 1)).toBe(TOP);
		expect(symbolAt(syms, 26)).toBe("applyDiscount");
	});
});

describe("extractSymbols (py)", () => {
	it("uses indentation", () => {
		const py = "import os\n\ndef a():\n    return 1\n\nclass B:\n    def m(self):\n        pass\n\n    def n(self):\n        return 2\n";
		const syms = extractSymbols("x.py", py);
		expect(syms.map((s) => [s.name, s.start, s.end])).toEqual([
			["a", 3, 4],
			["B", 6, 11],
			["B.m", 7, 8],
			["B.n", 10, 11],
		]);
	});
});

describe("functions stay whole around text that looks like code", () => {
	it("Python: a docstring or comment at column 0 inside a function doesn't end it", () => {
		const src = 'def render(cart):\n    """Renders a cart.\n\nTotals at the bottom.\ndef fake():\n"""\n# a note at column 0\n    return "cart"\n\n\ndef other():\n    pass\n';
		const syms = extractSymbols("r.py", src);
		expect(syms.map((s) => s.name)).toEqual(["render", "other"]);
		expect(symbolAt(syms, 8)).toBe("render");
		expect(symbolAt(syms, 11)).toBe("other");
	});

	it("JavaScript: a template literal with blank lines and code-like lines stays in its const", () => {
		const src = "export const HARNESS = `\nfunction runSuite() {\n\n  register();\n}\nexport function register() {}\n`;\n\nexport function after() {\n  return 1;\n}\n";
		const syms = extractSymbols("h.js", src);
		expect(syms.map((s) => s.name)).toEqual(["HARNESS", "after"]);
		expect(syms[0]).toMatchObject({ start: 1, end: 7 });
		expect(symbolAt(syms, 4)).toBe("HARNESS");
	});
});
