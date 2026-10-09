import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/agent-api";
import { handleMcp, type McpContext } from "../src/mcp";

const ctx: McpContext = { tools: TOOLS, target: {}, agentId: null, projectName: "Test", instructions: "" };
const post = (body: unknown) => handleMcp(new Request("https://x/mcp/test", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ctx);
const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping" });

describe("MCP batches", () => {
	it("answers a short batch message by message", async () => {
		const res = await post([ping(1), { jsonrpc: "2.0", method: "notifications/initialized" }, ping(2)]);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([
			{ jsonrpc: "2.0", id: 1, result: {} },
			{ jsonrpc: "2.0", id: 2, result: {} },
		]);
	});

	it("turns away an empty batch and a long one, whose answers would dwarf the request", async () => {
		for (const body of [[], Array.from({ length: 11 }, (_, i) => ping(i))]) {
			const res = await post(body);
			expect(res.status).toBe(400);
			expect(((await res.json()) as any).error.code).toBe(-32600);
		}
	});

	it("answers an element that isn't a message with Invalid Request, not a crash", async () => {
		const res = await post([null, 7, ping(3)]);
		expect(res.status).toBe(200);
		const out = (await res.json()) as any[];
		expect(out.map((r) => r.error?.code ?? "ok")).toEqual([-32600, -32600, "ok"]);
	});

	it("still takes a single message and a lone notification", async () => {
		expect(await (await post(ping(9))).json()).toEqual({ jsonrpc: "2.0", id: 9, result: {} });
		expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
	});
});
