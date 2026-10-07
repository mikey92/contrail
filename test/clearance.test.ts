import { describe, expect, it } from "vitest";
import { airspaceViolations, findCollisions, holdQueue, normalizeTarget, parseTarget, policyTargetsTouched, targetsOverlap } from "../src/tower/clearance";

describe("targetsOverlap", () => {
	it.each([
		["src/a.js", "src/a.js#f", true],
		["src/a.js#f", "src/a.js#g", false],
		["src/a.js#Cart", "src/a.js#Cart.addItem", true],
		["src/a.js#Cart.add", "src/a.js#Cart.remove", false],
		["src/", "src/a.js#f", true],
		["lib/", "src/a.js", false],
		["src/a.js#f", "src/b.js#f", false],
	])("%s vs %s → %s", (a, b, expected) => {
		expect(targetsOverlap(a, b)).toBe(expected);
		expect(targetsOverlap(b, a)).toBe(expected);
	});

	it("normalizes", () => {
		expect(normalizeTarget(" ./src/a.js # f ")).toBe("src/a.js#f");
	});

	it("ignores the requesting flight's own holds", () => {
		const held = [
			{ target: "src/a.js#f", flightId: "f1" },
			{ target: "src/a.js#g", flightId: "f2" },
		];
		expect(findCollisions(["src/a.js"], held, "f1")).toEqual([{ target: "src/a.js", with: held[1] }]);
	});
});

describe("airspaceViolations", () => {
	const held = [
		{ target: "src/pricing.js#subtotal", flight: "FL-005", callsign: "CLAUDE-5" },
		{ target: "src/cart.js", flight: "FL-002", callsign: "CODEX-2" },
	];

	it("turns away a change to a function another flight is cleared for", () => {
		expect(airspaceViolations(held, [{ path: "src/pricing.js", symbols: ["subtotal"] }])).toEqual([held[0]]);
	});

	it("lets parallel work in the same file through", () => {
		expect(airspaceViolations(held, [{ path: "src/pricing.js", symbols: ["tax", "bulkDiscount"] }])).toEqual([]);
		expect(airspaceViolations(held, [{ path: "src/pricing.js", symbols: [] }])).toEqual([]);
	});

	it("treats a claim on a whole file as covering everything in it", () => {
		expect(airspaceViolations(held, [{ path: "src/cart.js", symbols: [] }])).toEqual([held[1]]);
		expect(airspaceViolations(held, [{ path: "src/cart.js", symbols: ["Cart.add"] }])).toEqual([held[1]]);
	});

	it("knows that a target without a file means the whole repository", () => {
		expect(parseTarget("#subtotal").path).toBe("");
		expect(targetsOverlap("#subtotal", "src/anything.js#x")).toBe(true);
	});
});

describe("policyTargetsTouched", () => {
	const policy = ["src/money.js#formatMoney", "src/payments/"];

	it("finds the protected functions and directories a change touches", () => {
		expect(policyTargetsTouched(policy, [{ path: "src/money.js", symbols: ["formatMoney"] }])).toEqual(["src/money.js#formatMoney"]);
		expect(policyTargetsTouched(policy, [{ path: "src/payments/card.js", symbols: ["charge"] }])).toEqual(["src/payments/"]);
	});

	it("lets changes to other functions of the same file through", () => {
		expect(policyTargetsTouched(policy, [{ path: "src/money.js", symbols: ["parseMoney"] }])).toEqual([]);
		expect(policyTargetsTouched([], [{ path: "src/money.js", symbols: ["formatMoney"] }])).toEqual([]);
	});

	it("counts code outside any function as touching the whole file", () => {
		// e.g. `formatMoney = () => "free";` at the top level overrides the protected function
		expect(policyTargetsTouched(policy, [{ path: "src/money.js", symbols: ["(top)"] }])).toEqual(["src/money.js#formatMoney"]);
		expect(policyTargetsTouched(policy, [{ path: "src/money.js", symbols: ["parseMoney", "(top)"] }])).toEqual(["src/money.js#formatMoney"]);
		expect(policyTargetsTouched(policy, [{ path: "src/money.js", symbols: [] }])).toEqual(["src/money.js#formatMoney"]);
	});
});

describe("holdQueue", () => {
	const g = (id: string, flightId: string, target: string, createdAt = 0) => ({ id, flightId, target, status: "granted" as const, createdAt });
	const h = (id: string, flightId: string, target: string, createdAt: number) => ({ id, flightId, target, status: "holding" as const, createdAt });

	it("waits for the flight cleared for overlapping code", () => {
		expect(holdQueue([g("c1", "F1", "src/a.js#x"), h("h2", "F2", "src/a.js#x", 1)]).get("h2")).toEqual(["F1"]);
	});

	it("lets a hold on a whole file go first: a later claim on a function in it queues behind", () => {
		const claims = [g("c1", "F1", "src/a.js#x"), h("h2", "F2", "src/a.js", 1), h("h3", "F3", "src/a.js#y", 2)];
		const q = holdQueue(claims);
		expect(q.get("h2")).toEqual(["F1"]);
		expect(q.get("h3")).toEqual(["F2"]);
	});

	it("never queues a flight behind one that waits for it", () => {
		// F2 waits for F1's src/a.js#x; F1 asking for another function of a.js would wait for F2: neither could move.
		const claims = [g("c1", "F1", "src/a.js#x"), h("h2", "F2", "src/a.js", 1), h("h3", "F1", "src/a.js#y", 2)];
		expect(holdQueue(claims).get("h3")).toEqual([]);
	});

	it("follows waits through other flights", () => {
		// F3 waits for F1 (a grant), F2 queues behind F3, so F1 must not queue behind F2.
		const claims = [g("c1", "F1", "src/c.js#k"), h("h3", "F3", "src/c.js", 1), h("h2", "F2", "src/c.js#m", 2), h("h4", "F1", "src/c.js#m", 3)];
		const q = holdQueue(claims);
		expect(q.get("h3")).toEqual(["F1"]);
		expect(q.get("h2")).toEqual(["F3"]);
		expect(q.get("h4")).toEqual([]);
	});

	it("leaves unrelated holds alone", () => {
		const claims = [g("c1", "F1", "src/a.js#x"), h("h2", "F2", "src/a.js#x", 1), h("h3", "F3", "src/b.js#y", 2)];
		expect(holdQueue(claims).get("h3")).toEqual([]);
	});
});
