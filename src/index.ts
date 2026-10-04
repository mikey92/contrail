// Contrail — air traffic control for coding agents.
// Worker entry: REST API, MCP endpoint, live WebSocket feed, and the Radar UI (static assets).
import { Hono } from "hono";
import { TOOL_BY_NAME, TOOLS } from "./agent-api";
import type { Env } from "./env";
import { handleMcp } from "./mcp";
import type { ProjectSource } from "./tower/tower";
import { errorMessage, randomToken, safeEqual } from "./util";

export { EdgeAgent } from "./edge/agent";
export { Registry } from "./registry";
export { Runway } from "./runway/runway";
export { Tower } from "./tower/tower";

type App = { Bindings: Env; Variables: { agentId: string | null } };

const app = new Hono<App>();

const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName("global"));
const tower = (env: Env, slug: string) => env.TOWER.get(env.TOWER.idFromName(slug));

function bearer(req: Request): string | null {
	const h = req.headers.get("Authorization");
	if (h?.startsWith("Bearer ")) return h.slice(7).trim();
	return new URL(req.url).searchParams.get("key");
}

function isAdmin(c: { req: { raw: Request }; env: Env }): boolean {
	const key = bearer(c.req.raw) ?? c.req.raw.headers.get("X-Contrail-Admin");
	return !!key && !!c.env.CONTRAIL_ADMIN_KEY && safeEqual(key, c.env.CONTRAIL_ADMIN_KEY);
}

app.onError((err, c) => c.json({ error: errorMessage(err) }, 400));

app.get("/api/health", (c) => c.json({ ok: true, service: "contrail" }));

// ── projects ──────────────────────────────────────────────

app.get("/api/projects", async (c) => {
	const all = await registry(c.env).list();
	return c.json({ projects: isAdmin(c) ? all : all.filter((p) => p.public) });
});

app.post("/api/projects", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const body = await c.req.json<{ slug: string; name: string; description?: string; public?: boolean; source?: ProjectSource; joinCode?: string }>();
	const slug = String(body.slug ?? "").toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) return c.json({ error: "slug: 2-31 chars, a-z 0-9 -" }, 400);
	const joinCode = body.joinCode ?? randomToken("join");
	const info = { slug, name: body.name || slug, description: body.description ?? "", trunkRepo: "", createdAt: Date.now(), public: body.public ?? true };
	if (!(await registry(c.env).register(info, joinCode))) return c.json({ error: "project exists" }, 409);
	try {
		const created = await tower(c.env, slug).setup({ slug, name: info.name, description: info.description, public: info.public, source: body.source ?? { kind: "files" } });
		await registry(c.env).update(created);
		await tower(c.env, slug).ensureAlarm();
		return c.json({ project: created, joinCode });
	} catch (err) {
		await registry(c.env).remove(slug);
		throw err;
	}
});

async function canView(c: { req: { raw: Request }; env: Env }, slug: string) {
	const entry = await registry(c.env).get(slug);
	if (!entry) return null;
	if (!entry.info.public && !isAdmin(c)) return null;
	return entry;
}

app.get("/api/p/:slug/snapshot", async (c) => {
	const slug = c.req.param("slug");
	if (!(await canView(c, slug))) return c.json({ error: "not found" }, 404);
	return c.json(await tower(c.env, slug).snapshot());
});

app.get("/api/p/:slug/live", async (c) => {
	const slug = c.req.param("slug");
	if (!(await canView(c, slug))) return c.json({ error: "not found" }, 404);
	return tower(c.env, slug).fetch(c.req.raw);
});

app.get("/api/p/:slug/flights/:ref", async (c) => {
	const slug = c.req.param("slug");
	if (!(await canView(c, slug))) return c.json({ error: "not found" }, 404);
	return c.json(await tower(c.env, slug).flightDetail(c.req.param("ref")));
});

app.get("/api/p/:slug/why", async (c) => {
	const slug = c.req.param("slug");
	if (!(await canView(c, slug))) return c.json({ error: "not found" }, 404);
	const line = c.req.query("line");
	return c.json(await tower(c.env, slug).why({ path: c.req.query("path") ?? "", line: line ? Number(line) : undefined, symbol: c.req.query("symbol") }));
});

app.get("/api/p/:slug/file", async (c) => {
	const slug = c.req.param("slug");
	const entry = await canView(c, slug);
	if (!entry) return c.json({ error: "not found" }, 404);
	const repo = await c.env.ARTIFACTS.get(entry.info.trunkRepo);
	try {
		const blob = await repo.readFile({ ref: c.req.query("ref") || "main", path: c.req.query("path") ?? "" });
		if (!blob) return c.json({ error: "no such file" }, 404);
		return new Response(blob, { headers: { "content-type": "text/plain; charset=utf-8" } });
	} finally {
		repo[Symbol.dispose]?.();
	}
});

app.get("/api/p/:slug/commits", async (c) => {
	const slug = c.req.param("slug");
	const entry = await canView(c, slug);
	if (!entry) return c.json({ error: "not found" }, 404);
	const repo = await c.env.ARTIFACTS.get(entry.info.trunkRepo);
	try {
		return c.json({ commits: await repo.log({ ref: "main", limit: Number(c.req.query("limit") ?? 50) }) });
	} finally {
		repo[Symbol.dispose]?.();
	}
});

app.post("/api/p/:slug/intents", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const body = await c.req.json<{ intents: { title: string; body?: string; priority?: number; labels?: string[]; dependsOn?: number[] }[] }>();
	return c.json({ intents: await tower(c.env, c.req.param("slug")).addIntents(body.intents ?? [], "operator") });
});

app.post("/api/p/:slug/resync", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	return c.json(await tower(c.env, c.req.param("slug")).resync());
});

// ── edge agents (run on Workers AI inside Durable Objects) ──

app.post("/api/p/:slug/edge/launch", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const body = await c.req.json<{ count?: number; model?: string; maxFlights?: number; mode?: "llm" | "scripted" }>().catch(() => ({}) as any);
	return c.json(
		await tower(c.env, c.req.param("slug")).launchEdge({ count: Number(body.count ?? 4), model: body.model, maxFlights: body.maxFlights, mode: body.mode, limit: 500 }),
	);
});

app.post("/api/p/:slug/edge/stop", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	return c.json(await tower(c.env, c.req.param("slug")).stopEdge());
});

app.get("/api/p/:slug/edge", async (c) => {
	const slug = c.req.param("slug");
	if (!(await canView(c, slug))) return c.json({ error: "not found" }, 404);
	return c.json({ fleet: await tower(c.env, slug).edgeStatus() });
});

// Agents join with the project's join code (or the admin key) and receive a personal agent key.
app.post("/api/p/:slug/join", async (c) => {
	const slug = c.req.param("slug");
	const entry = await registry(c.env).get(slug);
	if (!entry) return c.json({ error: "not found" }, 404);
	const body = await c.req.json<{ joinCode?: string; callsign?: string; kind?: any; model?: string }>().catch(() => ({}) as any);
	if (!isAdmin(c) && !(body.joinCode && safeEqual(body.joinCode, entry.joinCode))) return c.json({ error: "join code required" }, 401);
	const { agent, key } = await tower(c.env, slug).join({ callsign: body.callsign, kind: body.kind, model: body.model });
	const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
	const mcpUrl = `${origin}/mcp/${slug}`;
	return c.json({
		agent,
		key,
		mcp: {
			url: mcpUrl,
			claudeCode: `claude mcp add --transport http contrail ${mcpUrl} --header "Authorization: Bearer ${key}"`,
			codex: `codex mcp add contrail --url ${mcpUrl} --bearer-token-env-var CONTRAIL_KEY  # with CONTRAIL_KEY=${key}`,
		},
	});
});

// ── agent REST API (same operations as the MCP tools) ─────

app.use("/api/p/:slug/agent/*", async (c, next) => {
	const key = bearer(c.req.raw);
	const agent = key ? await tower(c.env, c.req.param("slug")).authenticate(key) : null;
	if (!agent) return c.json({ error: "agent key required (Authorization: Bearer ct_…)" }, 401);
	c.set("agentId", agent.id);
	await next();
});

app.get("/api/p/:slug/agent/tools", (c) => c.json({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));

app.post("/api/p/:slug/agent/:tool", async (c) => {
	const tool = TOOL_BY_NAME.get(c.req.param("tool"));
	if (!tool) return c.json({ error: "unknown tool" }, 404);
	const args = await c.req.json<Record<string, unknown>>().catch(() => ({}));
	return c.json(await tool.run(tower(c.env, c.req.param("slug")), c.get("agentId")!, args));
});

// ── MCP ───────────────────────────────────────────────────

app.all("/mcp/:slug", async (c) => {
	const slug = c.req.param("slug");
	const entry = await registry(c.env).get(slug);
	if (!entry) return c.json({ error: "not found" }, 404);
	const t = tower(c.env, slug);
	const key = bearer(c.req.raw);
	const agent = key ? await t.authenticate(key) : null;
	return handleMcp(c.req.raw, { tower: t, agentId: agent?.id ?? null, projectName: entry.info.name });
});

// ── Radar UI (static assets with SPA fallback) ────────────

app.get("*", async (c) => {
	const res = await c.env.ASSETS.fetch(c.req.raw);
	if (res.status !== 404) return res;
	return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url), c.req.raw));
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
