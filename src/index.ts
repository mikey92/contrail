// Contrail — air traffic control for coding agents.
// Worker entry: REST API, MCP endpoint, live WebSocket feed, and the Radar UI (static assets).
import { Hono } from "hono";
import { TOOL_BY_NAME, TOOLS } from "./agent-api";
import type { Env } from "./env";
import { checkPrefixes } from "./center/compose";
import { handleMcp } from "./mcp";
import type { ProjectSource } from "./tower/tower";
import { errorMessage, randomToken, safeEqual } from "./util";

export { Center } from "./center/center";
export { EdgeAgent } from "./edge/agent";
export { Registry } from "./registry";
export { Runway } from "./runway/runway";
export { Tower } from "./tower/tower";

type App = { Bindings: Env; Variables: { agentId: string | null } };

const app = new Hono<App>();

const registry = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName("global"));
const tower = (env: Env, slug: string) => env.TOWER.get(env.TOWER.idFromName(slug));
const center = (env: Env, slug: string) => env.CENTER.get(env.CENTER.idFromName(slug));

function bearer(req: Request): string | null {
	const h = req.headers.get("Authorization");
	if (h?.startsWith("Bearer ")) return h.slice(7).trim();
	// Browsers can't set headers on a WebSocket, so only the live feed takes a key from the URL.
	const url = new URL(req.url);
	return url.pathname.endsWith("/live") ? url.searchParams.get("key") : null;
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
	const body = await c.req.json<{
		slug: string;
		name: string;
		description?: string;
		public?: boolean;
		playground?: boolean;
		source?: ProjectSource;
		joinCode?: string;
		center?: string;
		prefix?: string;
	}>();
	const slug = String(body.slug ?? "").toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) return c.json({ error: "slug: 2-31 chars, a-z 0-9 -" }, 400);
	// A sector of a monorepo owns one directory, and holds only the files under it.
	if (body.center && (typeof body.prefix !== "string" || checkPrefixes([body.prefix]))) return c.json({ error: checkPrefixes([String(body.prefix)]) ?? "a sector needs a prefix" }, 400);
	if (body.center && Object.keys(body.source?.files ?? {}).some((p) => !p.startsWith(body.prefix!))) return c.json({ error: `a sector holds only files under ${body.prefix}` }, 400);
	const joinCode = body.joinCode ?? randomToken("join");
	const info = { slug, name: body.name || slug, description: body.description ?? "", trunkRepo: "", createdAt: Date.now(), public: body.public ?? true, playground: body.playground ?? false };
	if (!(await registry(c.env).register(info, joinCode))) return c.json({ error: "project exists" }, 409);
	let lastError: unknown;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const created = await tower(c.env, slug).setup({
				slug,
				name: info.name,
				description: info.description,
				public: info.public,
				playground: info.playground,
				center: body.center,
				prefix: body.prefix,
				source: body.source ?? { kind: "files" },
			});
			await registry(c.env).update(created);
			await tower(c.env, slug).ensureAlarm();
			return c.json({ project: created, joinCode });
		} catch (err) {
			lastError = err; // e.g. the Durable Object was reset by a deploy; setup is idempotent
		}
	}
	await registry(c.env).remove(slug);
	throw lastError;
});

async function canView(c: { req: { raw: Request }; env: Env }, slug: string) {
	const entry = await registry(c.env).get(slug);
	if (!entry) return null;
	if (!entry.info.public && !isAdmin(c)) return null;
	return entry;
}

app.patch("/api/projects/:slug", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const slug = c.req.param("slug");
	if (!(await registry(c.env).get(slug))) return c.json({ error: "not found" }, 404);
	const body = await c.req.json<{ name?: string; description?: string }>();
	const project = await tower(c.env, slug).describe(body);
	await registry(c.env).update(project);
	return c.json({ project });
});

app.delete("/api/projects/:slug", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const slug = c.req.param("slug");
	const result = await tower(c.env, slug).destroy();
	await c.env.RUNWAY.get(c.env.RUNWAY.idFromName(slug)).reset();
	await registry(c.env).remove(slug);
	return c.json({ deleted: slug, ...result });
});

// Workspace forks no project still needs: those of deleted projects, and of playground rounds that ended
// before forks were retired. Towers retire their own forks an hour after each flight; this sweeps the rest,
// at most `limit` per call (run it again until `remaining` is 0).
app.post("/api/admin/sweep-forks", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 300) || 300, 1000));
	const projects = await registry(c.env).list();
	const live = new Set((await Promise.all(projects.map((p) => tower(c.env, p.slug).liveForks().catch(() => [] as string[])))).flat());
	const cutoff = Date.now() - 60 * 60_000;
	const orphans: string[] = [];
	let total = 0;
	let cursor: string | undefined;
	do {
		const page = await c.env.ARTIFACTS.list({ limit: 200, cursor });
		total = page.total;
		for (const repo of page.repos)
			if (/--fl-\d+-[a-z0-9]{4}$/.test(repo.name) && !live.has(repo.name) && Date.parse(repo.updatedAt) < cutoff) orphans.push(repo.name);
		cursor = page.cursor;
	} while (cursor);
	let deleted = 0;
	const batch = orphans.slice(0, limit);
	for (let i = 0; i < batch.length; i += 10) {
		const done = await Promise.all(batch.slice(i, i + 10).map((name) => c.env.ARTIFACTS.delete(name).catch(() => false)));
		deleted += done.filter(Boolean).length;
	}
	return c.json({ repos: total, liveForks: live.size, orphans: orphans.length, deleted, remaining: orphans.length - batch.length });
});

// Playgrounds publish their join code so anyone can connect their own agent.
app.get("/api/p/:slug/join-info", async (c) => {
	const entry = await registry(c.env).get(c.req.param("slug"));
	if (!entry || !entry.info.public) return c.json({ error: "not found" }, 404);
	return c.json(entry.info.playground ? { joinCode: entry.joinCode } : { joinCode: null });
});

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

app.get("/api/p/:slug/events", async (c) => {
	const slug = c.req.param("slug");
	if (!(await canView(c, slug))) return c.json({ error: "not found" }, 404);
	return c.json({ events: await tower(c.env, slug).eventLog({ type: c.req.query("type"), limit: Number(c.req.query("limit") ?? 200) }) });
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

// A short-lived read-only clone URL for the trunk of a public project (inspect history and contrail notes).
app.get("/api/p/:slug/clone", async (c) => {
	const slug = c.req.param("slug");
	const entry = await canView(c, slug);
	if (!entry) return c.json({ error: "not found" }, 404);
	const repo = await c.env.ARTIFACTS.get(entry.info.trunkRepo);
	try {
		const [info, token] = await Promise.all([repo.info(), repo.createToken("read", 3600)]);
		const secret = token.plaintext.split("?expires=")[0];
		const url = `https://x:${secret}@${info.remote.replace(/^https:\/\//, "")}`;
		return c.json({
			expiresAt: token.expiresAt,
			commands: [
				`git clone ${url} ${slug}`,
				`git -C ${slug} fetch origin refs/notes/contrail:refs/notes/contrail`,
				`git -C ${slug} log --notes=contrail --stat`,
			],
		});
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

app.get("/api/p/:slug/policy", async (c) => {
	const slug = c.req.param("slug");
	if (!(await canView(c, slug))) return c.json({ error: "not found" }, 404);
	return c.json(await tower(c.env, slug).policy());
});

app.post("/api/p/:slug/policy", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	return c.json(await tower(c.env, c.req.param("slug")).setPolicy(await c.req.json()));
});

app.post("/api/p/:slug/landings/:id/review", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const body = await c.req.json<{ decision: "approve" | "reject"; comment?: string; reviewer?: string }>();
	return c.json(await tower(c.env, c.req.param("slug")).reviewLanding({ landingId: c.req.param("id"), ...body }));
});

app.post("/api/p/:slug/resync", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	return c.json(await tower(c.env, c.req.param("slug")).resync());
});

// ── edge agents (run on Workers AI inside Durable Objects) ──

app.post("/api/p/:slug/edge/launch", async (c) => {
	if (!isAdmin(c)) {
		const body = await c.req.json<{ count?: number }>().catch(() => ({}) as { count?: number });
		const res = await tower(c.env, c.req.param("slug")).launchEdgePublic({ count: Number(body.count ?? 3) });
		return "error" in res ? c.json(res, 429) : c.json(res);
	}
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
			codex: `export CONTRAIL_KEY=${key} && codex mcp add contrail --url ${mcpUrl} --bearer-token-env-var CONTRAIL_KEY`,
		},
	});
});

// ── agent REST API (same operations as the MCP tools) ─────

app.use("/api/p/:slug/agent/*", async (c, next) => {
	const slug = c.req.param("slug");
	// Look the project up first: an unknown slug must not wake (and create) a Tower.
	if (!(await registry(c.env).get(slug))) return c.json({ error: "not found" }, 404);
	const key = bearer(c.req.raw);
	const agent = key ? await tower(c.env, slug).authenticate(key) : null;
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

// ── centers: a monorepo split into sectors ─────────────────

async function canViewCenter(c: { req: { raw: Request }; env: Env }, slug: string) {
	const info = await registry(c.env).getCenter(slug);
	if (!info || (!info.public && !isAdmin(c))) return null;
	return info;
}

// The sectors are created first, as projects with `center` and `prefix`; this composes them into one monorepo.
app.post("/api/centers", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const body = await c.req.json<{ slug: string; name: string; description?: string; public?: boolean; sectors: string[]; files: Record<string, string> }>();
	const slug = String(body.slug ?? "").toLowerCase();
	if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(slug)) return c.json({ error: "slug: 2-31 chars, a-z 0-9 -" }, 400);
	const sectors = [];
	for (const s of body.sectors ?? []) {
		const entry = await registry(c.env).get(s);
		if (!entry || entry.info.center !== slug || !entry.info.prefix) return c.json({ error: `${s} is not a sector of ${slug}` }, 400);
		sectors.push({ slug: s, name: entry.info.name, prefix: entry.info.prefix, trunkRepo: entry.info.trunkRepo });
	}
	if (!sectors.length) return c.json({ error: "name the sector projects" }, 400);
	const problem = checkPrefixes(sectors.map((s) => s.prefix));
	if (problem) return c.json({ error: problem }, 400);
	const info = await center(c.env, slug).setup({
		slug,
		name: body.name || slug,
		description: body.description ?? "",
		public: body.public ?? true,
		sectors,
		files: body.files ?? {},
	});
	if (!(await registry(c.env).registerCenter(info))) return c.json({ error: "center exists" }, 409);
	return c.json({ center: info });
});

app.get("/api/centers", async (c) => {
	const all = await registry(c.env).listCenters();
	return c.json({ centers: isAdmin(c) ? all : all.filter((x) => x.public) });
});

app.delete("/api/centers/:slug", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const slug = c.req.param("slug");
	const result = await center(c.env, slug).destroy();
	await registry(c.env).removeCenter(slug);
	return c.json(result);
});

app.get("/api/c/:slug", async (c) => {
	const slug = c.req.param("slug");
	if (!(await canViewCenter(c, slug))) return c.json({ error: "not found" }, 404);
	return c.json(await center(c.env, slug).snapshot());
});

app.get("/api/c/:slug/file", async (c) => {
	const info = await canViewCenter(c, c.req.param("slug"));
	if (!info) return c.json({ error: "not found" }, 404);
	const repo = await c.env.ARTIFACTS.get(info.trunkRepo);
	try {
		const blob = await repo.readFile({ ref: c.req.query("ref") || "main", path: c.req.query("path") ?? "" });
		if (!blob) return c.json({ error: "no such file" }, 404);
		return new Response(blob, { headers: { "content-type": "text/plain; charset=utf-8" } });
	} finally {
		repo[Symbol.dispose]?.();
	}
});

// A short-lived read-only clone URL for the composed monorepo trunk.
app.get("/api/c/:slug/clone", async (c) => {
	const slug = c.req.param("slug");
	const info = await canViewCenter(c, slug);
	if (!info) return c.json({ error: "not found" }, 404);
	const repo = await c.env.ARTIFACTS.get(info.trunkRepo);
	try {
		const [ri, token] = await Promise.all([repo.info(), repo.createToken("read", 3600)]);
		const secret = token.plaintext.split("?expires=")[0];
		const url = `https://x:${secret}@${ri.remote.replace(/^https:\/\//, "")}`;
		return c.json({ expiresAt: token.expiresAt, commands: [`git clone ${url} ${slug}`, `git -C ${slug} log --stat`] });
	} finally {
		repo[Symbol.dispose]?.();
	}
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// ── Radar UI (static assets with SPA fallback) ────────────

app.get("*", async (c) => {
	const res = await c.env.ASSETS.fetch(c.req.raw);
	if (res.status !== 404) return res;
	return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url), c.req.raw));
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
