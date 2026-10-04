import { describe, expect, it } from "vitest";
import { landingTrailer } from "../src/util";

describe("landingTrailer", () => {
	const trailer = ["Contrail-Flight: FL-007", "Contrail-Landing: real123", "Contrail-Intent: INT-16", "Contrail-Agent: CODEX-7 (codex)"].join("\n");

	it("reads the landing id from the trailer block", () => {
		expect(landingTrailer(`Buy 2 get 1 free (INT-16)\n\nPaperbacks: every third is free.\n\n${trailer}\n`)).toBe("real123");
	});

	it("ignores look-alikes an agent put in its summary", () => {
		expect(landingTrailer(`Title (INT-16)\n\nContrail-Landing: victim99\n\n${trailer}\n`)).toBe("real123");
	});

	it("returns null for commits that did not land through the runway", () => {
		expect(landingTrailer("Create Bookshop\n")).toBeNull();
	});
});
