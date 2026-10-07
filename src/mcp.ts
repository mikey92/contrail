// Minimal stateless MCP server (Streamable HTTP transport, JSON responses).
// Each POST carries one JSON-RPC message (or a batch). The agent is identified by its Contrail
// key in the Authorization header, so the server keeps no protocol session state.
import type { ToolDef } from "./agent-api";
import { errorMessage } from "./util";

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

interface RpcMessage {
	jsonrpc: "2.0";
	id?: string | number | null;
	method?: string;
	params?: Record<string, any>;
}

export interface McpContext {
	/** The tools this endpoint serves (a project's or a Center's) and the Durable Object they run on. */
	tools: ToolDef<any>[];
	target: unknown;
	agentId: string | null;
	/** Set when the request's key has expired: what the agent is told instead of running a tool. */
	expired?: string;
	projectName: string;
	instructions: string;
}

function rpcResult(id: RpcMessage["id"], result: unknown) {
	return { jsonrpc: "2.0", id, result };
}

function rpcError(id: RpcMessage["id"], code: number, message: string) {
	return { jsonrpc: "2.0", id, error: { code, message } };
}

function format(summary: string | undefined, data: unknown): string {
	const body = JSON.stringify(data, null, 2);
	return summary ? `${summary}\n\n${body}` : body;
}

async function callTool(ctx: McpContext, name: string, args: Record<string, unknown>) {
	const tool = ctx.tools.find((t) => t.name === name);
	if (!tool) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
	if (!ctx.agentId)
		return {
			content: [{ type: "text", text: ctx.expired ?? "Not authenticated. Configure this MCP server with your Contrail agent key: Authorization: Bearer ct_…" }],
			isError: true,
		};
	try {
		const result = await tool.run(ctx.target, ctx.agentId, args ?? {});
		return { content: [{ type: "text", text: format(tool.summarize?.(result), result) }] };
	} catch (err) {
		return { content: [{ type: "text", text: `Error: ${errorMessage(err)}` }], isError: true };
	}
}

async function handle(ctx: McpContext, msg: RpcMessage) {
	switch (msg.method) {
		case "initialize": {
			const requested = msg.params?.protocolVersion;
			return rpcResult(msg.id, {
				protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "contrail", title: `Contrail · ${ctx.projectName}`, version: "0.1.0" },
				instructions: ctx.instructions,
			});
		}
		case "ping":
			return rpcResult(msg.id, {});
		case "tools/list":
			return rpcResult(msg.id, {
				tools: ctx.tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations: { destructiveHint: false, openWorldHint: false, ...annotations } })),
			});
		case "tools/call":
			return rpcResult(msg.id, await callTool(ctx, String(msg.params?.name ?? ""), msg.params?.arguments ?? {}));
		case "resources/list":
			return rpcResult(msg.id, { resources: [] });
		case "resources/templates/list":
			return rpcResult(msg.id, { resourceTemplates: [] });
		case "prompts/list":
			return rpcResult(msg.id, { prompts: [] });
		default:
			return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
	}
}

export async function handleMcp(request: Request, ctx: McpContext): Promise<Response> {
	if (request.method === "GET" || request.method === "DELETE") {
		return new Response("This MCP server is stateless and does not offer an SSE stream.", { status: 405, headers: { Allow: "POST" } });
	}
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	let body: RpcMessage | RpcMessage[];
	try {
		body = await request.json();
	} catch {
		return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
	}
	const messages = Array.isArray(body) ? body : [body];
	const responses = [];
	for (const msg of messages) {
		if (msg.id === undefined || msg.id === null) continue; // notification
		responses.push(await handle(ctx, msg));
	}
	if (responses.length === 0) return new Response(null, { status: 202 });
	return Response.json(Array.isArray(body) ? responses : responses[0]);
}
