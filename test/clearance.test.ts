import { describe, expect, it } from "vitest";
import { airspaceViolations, findCollisions, normalizeTarget, parseTarget, targetsOverlap } from "../src/tower/clearance";

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
