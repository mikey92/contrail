import { describe, expect, it } from "vitest";
import type { TrunkFile } from "../src/shared/types";
import { codeNames, firstCollision, predictTargets, symbolIndex } from "../src/tower/planner";

const sym = (name: string, kind: string) => ({ name, kind, start: 1, end: 2 });
const files: TrunkFile[] = [
	{ path: "src/pricing.js", lines: 40, symbols: [sym("subtotal", "function"), sym("total", "function")] },
	{ path: "src/cart.js", lines: 30, symbols: [sym("Cart", "class"), sym("Cart.add", "method"), sym("Cart.count", "method")] },
	{ path: "src/tax.js", lines: 10, symbols: [sym("tax", "function")] },
	{ path: "src/counters.js", lines: 72, symbols: [sym("c03", "function"), sym("c04", "function")] },
	{ path: "source/clamp.js", lines: 33, symbols: [sym("clamp", "const")] },
	{ path: "source/prop.js", lines: 30, symbols: [sym("prop", "const")] },
	{ path: "source/index.js", lines: 273, symbols: [sym("clamp", "export"), sym("prop", "export")] },
	{ path: "test/clamp.js", lines: 30, symbols: [sym("eq", "const"), sym("R", "const"), sym("clamp", "suite")] },
];
const index = symbolIndex(files);
const predict = (title: string, body = "") => predictTargets({ title, body }, index);

describe("codeNames", () => {
	it("keeps names written like code and drops prose", () => {
		expect(codeNames("R.clamp: reject NaN bounds").names).toEqual(["R.clamp", "NaN"]);
		expect(codeNames("In subtotal(), a line with qty >= 3 gets 10% off").names).toEqual(["subtotal"]);
		expect(codeNames("formatMoney should render EUR as '€12.34'").names).toEqual(["formatMoney"]);
		expect(codeNames("Replace the CA rate in tax() with a TAX_RATES table").names).toEqual(["tax", "TAX_RATES"]);
		expect(codeNames("Rename `total` everywhere").names).toEqual(["total"]);
		expect(codeNames("Free shipping on orders over $50").names).toEqual([]);
	});

	it("reads explicit path#symbol targets", () => {
		expect(codeNames("Change src/cart.js#Cart.add and ./src/tax.js#tax").targets).toEqual(["src/cart.js#Cart.add", "src/tax.js#tax"]);
	});
});

describe("predictTargets", () => {
	it("finds the function a prose title changes through its body", () => {
		expect(predict("Bulk discount: 10% off 3+ copies of the same book", "In subtotal(), a line with qty >= 3 gets 10% off.")).toEqual(["src/pricing.js#subtotal"]);
	});

	it("resolves methods, namespaced names and plain counters", () => {
		expect(predict("Merge duplicate ISBNs in Cart.add")).toEqual(["src/cart.js#Cart.add"]);
		expect(predict("R.clamp: reject NaN bounds")).toEqual(["source/clamp.js#clamp", "test/clamp.js#clamp"]);
		expect(predict("Increment c03")).toEqual(["src/counters.js#c03"]);
	});

	it("predicts nothing for new code, even when the body calls existing functions", () => {
		expect(predict("Add R.sumBy", "sumBy(fn, list): the sum of fn(x), e.g. sumBy(prop('price'), items).")).toEqual([]);
		expect(predict("Add Cart.setQuantity and Cart.isEmpty")).toEqual([]);
	});

	it("keeps explicit targets that exist", () => {
		expect(predict("Add gift wrap", "Touches src/pricing.js#total and src/nope.js#x")).toEqual(["src/pricing.js#total"]);
	});
});

describe("firstCollision", () => {
	it("matches symbols, files and directories in the air", () => {
		const target = ["src/pricing.js#subtotal"];
		expect(firstCollision(target, [{ target: "src/pricing.js#total", flightId: "a" }])).toBeNull();
		expect(firstCollision(target, [{ target: "src/pricing.js", flightId: "b" }])?.with.flightId).toBe("b");
		expect(firstCollision(target, [{ target: "src/", flightId: "c" }])?.with.flightId).toBe("c");
		expect(firstCollision(target, [{ target: "src/pricing.js#subtotal", flightId: "d" }])?.target).toBe("src/pricing.js#subtotal");
	});
});
