import { describe, expect, it } from "vitest";
import { landingTrailer, retryTransient } from "../src/util";

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

describe("retryTransient", () => {
	it("retries server errors and gives up on others", async () => {
		let calls = 0;
		const flaky = async () => {
			if (++calls < 2) throw new Error("HTTP Error: 500 Internal Server Error");
			return "ok";
		};
		expect(await retryTransient(flaky)).toBe("ok");
		expect(calls).toBe(2);

		calls = 0;
		const missing = async () => {
			calls++;
			throw new Error("HTTP Error: 404 Not Found");
		};
		await expect(retryTransient(missing)).rejects.toThrow(/404/);
		expect(calls).toBe(1);
	});
});
