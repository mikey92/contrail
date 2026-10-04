import { describe, expect, it } from "vitest";
import { findCollisions, normalizeTarget, targetsOverlap } from "../src/tower/clearance";

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
