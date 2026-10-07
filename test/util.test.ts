import { describe, expect, it } from "vitest";
import { byteRange, landingTrailer, retryTransient } from "../src/util";

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

describe("byteRange", () => {
	const file = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251));
	const asset = (len = true) => new Response(file, { status: 200, headers: { "content-type": "video/mp4", ...(len ? { "content-length": "1000" } : {}) } });
	const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

	it("answers one range with 206 and exactly those bytes", async () => {
		const r = await byteRange(asset(), "bytes=0-1");
		expect(r.status).toBe(206);
		expect(r.headers.get("content-range")).toBe("bytes 0-1/1000");
		expect(r.headers.get("content-length")).toBe("2");
		expect(r.headers.get("accept-ranges")).toBe("bytes");
		expect([...(await bytes(r))]).toEqual([0, 1]);
	});

	it("handles open ranges, suffix ranges and a range past the end", async () => {
		expect([...(await bytes(await byteRange(asset(), "bytes=998-")))]).toEqual([file[998], file[999]]);
		expect([...(await bytes(await byteRange(asset(), "bytes=-3")))]).toEqual([file[997], file[998], file[999]]);
		const r = await byteRange(asset(), "bytes=990-5000");
		expect(r.headers.get("content-range")).toBe("bytes 990-999/1000");
		expect((await bytes(r)).length).toBe(10);
	});

	it("slices across chunk boundaries", async () => {
		const chunks = [file.subarray(0, 300), file.subarray(300, 700), file.subarray(700)];
		const stream = new ReadableStream<Uint8Array>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
		const r = await byteRange(new Response(stream, { headers: { "content-length": "1000" } }), "bytes=250-750");
		expect([...(await bytes(r))]).toEqual([...file.subarray(250, 751)]);
	});

	it("finds the size when the asset has no content-length", async () => {
		const r = await byteRange(asset(false), "bytes=10-19");
		expect(r.headers.get("content-range")).toBe("bytes 10-19/1000");
		expect([...(await bytes(r))]).toEqual([...file.subarray(10, 20)]);
	});

	it("sends the whole file without a usable range, and 416 past the end", async () => {
		const whole = await byteRange(asset(), null);
		expect(whole.status).toBe(200);
		expect(whole.headers.get("accept-ranges")).toBe("bytes");
		expect((await bytes(whole)).length).toBe(1000);
		expect((await byteRange(asset(), "bytes=0-1,5-6")).status).toBe(200);
		const past = await byteRange(asset(), "bytes=1000-");
		expect(past.status).toBe(416);
		expect(past.headers.get("content-range")).toBe("bytes */1000");
	});

	it("answers HEAD with headers only", async () => {
		const r = await byteRange(asset(), "bytes=0-99", true);
		expect(r.status).toBe(206);
		expect(r.headers.get("content-length")).toBe("100");
		expect(r.body).toBeNull();
	});
});
