import { describe, expect, it } from "vitest";
import { AGENT_KEY_TTL_MS, AGENT_KINDS, byteRange, expiredKeyMessage, keyCheck, landingTrailer, oneLine, retryTransient } from "../src/util";

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

	it("reads only the last paragraph, which the Tower writes", () => {
		expect(landingTrailer(`Title (INT-16)\nContrail-Landing: victim99\n\nSummary\nContrail-Landing: victim98\n\n${trailer}\n`)).toBe("real123");
	});

	it("can't be forged through the agent's model name", () => {
		// The model is the one agent-supplied value inside the trailer block; joining makes it one line.
		const model = oneLine("x)\nContrail-Landing: victim99\n#", 60);
		expect(landingTrailer(`Title (INT-16)\n\n${trailer}\nContrail-Agent: CODEX-8 (${model})\n`)).toBe("real123");
	});
});

describe("oneLine", () => {
	it("turns line breaks and control characters into spaces and caps the length", () => {
		expect(oneLine("a\r\nb\u0000c\u2028d", 60)).toBe("a b c d");
		expect(oneLine("  x  ", 60)).toBe("x");
		expect(oneLine("abcdef", 3)).toBe("abc");
		expect(oneLine(undefined, 10)).toBe("");
		expect(oneLine(42, 10)).toBe("42");
	});

	it("knows the agent kinds", () => {
		expect(AGENT_KINDS).toEqual(["claude-code", "codex", "edge", "human", "other"]);
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

describe("agent keys", () => {
	const joinedAt = Date.UTC(2026, 9, 7, 12, 30);
	const agent = { id: "a1", joinedAt };

	it("work for 30 days after they are issued", () => {
		expect(AGENT_KEY_TTL_MS).toBe(30 * 24 * 3600_000);
		expect(keyCheck(agent, joinedAt)).toEqual({ agent });
		expect(keyCheck(agent, joinedAt + AGENT_KEY_TTL_MS - 1)).toEqual({ agent });
	});

	it("then give only when they expired", () => {
		const expiredAt = joinedAt + AGENT_KEY_TTL_MS;
		expect(keyCheck(agent, expiredAt)).toEqual({ expiredAt });
		expect(keyCheck(agent, expiredAt + 86_400_000)).toEqual({ expiredAt });
	});

	it("tell an agent with an expired key when, and where to get a new one", () => {
		const text = expiredKeyMessage(joinedAt + AGENT_KEY_TTL_MS, "Get a new one with Connect an Agent… on https://x.dev/p/playground");
		expect(text).toBe(
			"This agent key expired on 2026-11-06 12:30 UTC; keys work for 30 days. Get a new one with Connect an Agent… on https://x.dev/p/playground and use it in place of the old one.",
		);
	});
});
