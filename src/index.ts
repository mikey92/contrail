// Contrail — air traffic control for coding agents.
// Worker entry: REST API, MCP endpoint, live WebSocket feed, and the Radar UI (static assets).
import { Hono } from "hono";
import { boundArgs, CENTER_TOOL_BY_NAME, CENTER_TOOLS, TOOL_BY_NAME, TOOLS } from "./agent-api";
import type { Env } from "./env";
import { checkPrefixes } from "./center/compose";
import { handleMcp } from "./mcp";
import { CROSSING_PROTOCOL, PROTOCOL } from "./tower/briefing";
import type { ProjectSource } from "./tower/tower";
import { byteRange, errorMessage, expiredKeyMessage, randomToken, readJson, safeEqual, TooLarge } from "./util";

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
	return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function isAdmin(c: { req: { raw: Request }; env: Env }): boolean {
	const key = bearer(c.req.raw) ?? c.req.raw.headers.get("X-Contrail-Admin");
	return !!key && !!c.env.CONTRAIL_ADMIN_KEY && safeEqual(key, c.env.CONTRAIL_ADMIN_KEY);
}

/** An agent's request body over 1 MB: a tool call never needs that much, so it is turned away unread. */
const tooLarge = (req: Request) => Number(req.headers.get("content-length") ?? 0) > 1 << 20;
/** The most a request anyone may send without a key (joining, launching edge agents) is read: a few fields. */
const PUBLIC_BODY_MAX = 64 << 10;

/** What an agent is told when its key no longer works: expired (with where to get a new one) or revoked. */
function keyRefused(found: { expiredAt: number } | { revokedAt: number }, renew: string): string {
	if ("expiredAt" in found) return expiredKeyMessage(found.expiredAt, renew);
	return `This agent key was revoked by the operator on ${new Date(found.revokedAt).toISOString().slice(0, 16).replace("T", " ")} UTC.`;
}

// Where an agent with an expired key gets a new one.
const renewProject = (c: { req: { url: string }; env: Env }, slug: string) =>
	`Get a new one with Connect an Agent… on ${c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin}/p/${slug} (or POST /api/p/${slug}/join with the join code)`;
const renewCenter = (slug: string) => `Ask the operator for a new one (POST /api/c/${slug}/join with the admin key)`;

app.onError((err, c) => {
	if (err instanceof TooLarge) return c.json({ error: "request too large" }, 413);
	const message = errorMessage(err);
	// A Durable Object restarting or a platform hiccup is worth a retry, unlike a request the tower turned down.
	const transient = /internal error|network connection|connection (?:reset|lost)|Durable Object reset|overloaded|exceeded|try again|HTTP Error: 5\d\d/i.test(message);
	return c.json({ error: message }, transient ? 503 : 400);
});

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

// Workspace forks nothing still needs: those of deleted projects and centers, and of playground rounds that
// ended before forks were retired. Towers and Centers retire their own forks an hour after each flight or
// crossing; this sweeps the rest, at most `limit` per call (run it again until `remaining` is 0).
app.post("/api/admin/sweep-forks", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const limit = Math.max(1, Math.min(Number(c.req.query("limit") ?? 300) || 300, 1000));
	const [projects, centers] = await Promise.all([registry(c.env).list(), registry(c.env).listCenters()]);
	const live = new Set(
		(
			await Promise.all([
				...projects.map((p) => tower(c.env, p.slug).liveForks().catch(() => [] as string[])),
				...centers.map((x) => center(c.env, x.slug).liveForks().catch(() => [] as string[])),
			])
		).flat(),
	);
	const cutoff = Date.now() - 60 * 60_000;
	const orphans: string[] = [];
	let total = 0;
	let cursor: string | undefined;
	do {
		const page = await c.env.ARTIFACTS.list({ limit: 200, cursor });
		total = page.total;
		for (const repo of page.repos)
			if (/--(fl|cx)-\d+-[a-z0-9]{4}$/.test(repo.name) && !live.has(repo.name) && Date.parse(repo.updatedAt) < cutoff) orphans.push(repo.name);
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
	// A private airspace's feed opens with the admin key in a header, or with a ticket bought with it: a browser's
	// WebSocket can't send headers, and a key in a URL ends up in logs.
	const ticket = new URL(c.req.url).searchParams.get("ticket");
	const entry = await registry(c.env).get(slug);
	const allowed = !!entry && (entry.info.public || isAdmin(c) || (!!ticket && (await tower(c.env, slug).redeemLiveTicket(ticket))));
	if (!allowed) return c.json({ error: "not found" }, 404);
	return tower(c.env, slug).fetch(c.req.raw);
});

app.post("/api/p/:slug/live-ticket", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const slug = c.req.param("slug");
	if (!(await registry(c.env).get(slug))) return c.json({ error: "not found" }, 404);
	return c.json(await tower(c.env, slug).liveTicket());
});

app.post("/api/p/:slug/agents/:agent/revoke", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const slug = c.req.param("slug");
	if (!(await registry(c.env).get(slug))) return c.json({ error: "not found" }, 404);
	return c.json(await tower(c.env, slug).revokeKey(c.req.param("agent")));
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
	// An unknown slug must not wake (and create) a Tower, and a private one looks unknown to visitors.
	const entry = await registry(c.env).get(c.req.param("slug"));
	if (!entry || (!entry.info.public && !isAdmin(c))) return c.json({ error: "not found" }, 404);
	if (!isAdmin(c)) {
		const body = await readJson<{ count?: number }>(c.req.raw, PUBLIC_BODY_MAX, {});
		const res = await tower(c.env, c.req.param("slug")).launchEdgePublic({ count: Number(body.count ?? 3) });
		if (!("error" in res)) return c.json(res);
		return c.json(res, /admin key/.test(res.error) ? 403 : 429);
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

// A playground's operator starts a new round: trunk back to its starting code and every intent open again.
app.post("/api/p/:slug/new-round", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	if (!(await registry(c.env).get(c.req.param("slug")))) return c.json({ error: "not found" }, 404);
	const res = await tower(c.env, c.req.param("slug")).newRound();
	return "error" in res ? c.json(res, 409) : c.json(res);
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
	// A body too big, null or not JSON carries no join code (so a private airspace still looks unknown).
	const body = ((await readJson<{ joinCode?: string; callsign?: string; kind?: any; model?: string } | null>(c.req.raw, PUBLIC_BODY_MAX, {}).catch(() => null)) ?? {}) as {
		joinCode?: string;
		callsign?: string;
		kind?: any;
		model?: string;
	};
	const admin = isAdmin(c);
	// Without its code, a private airspace looks unknown.
	if (!admin && !(typeof body.joinCode === "string" && safeEqual(body.joinCode, entry.joinCode)))
		return entry.info.public ? c.json({ error: "join code required" }, 401) : c.json({ error: "not found" }, 404);
	const input = { callsign: body.callsign, kind: body.kind, model: body.model };
	const joined = admin ? await tower(c.env, slug).join(input) : await tower(c.env, slug).joinWithCode(input);
	if ("error" in joined) return c.json(joined, 429);
	const { agent, key, expiresAt } = joined;
	const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
	const mcpUrl = `${origin}/mcp/${slug}`;
	return c.json({
		agent,
		key,
		expiresAt,
		mcp: {
			url: mcpUrl,
			claudeCode: `claude mcp add --transport http contrail ${mcpUrl} --header "Authorization: Bearer ${key}"`,
			codex: `export CONTRAIL_KEY=${key} && codex mcp add contrail --url ${mcpUrl} --bearer-token-env-var CONTRAIL_KEY`,
		},
	});
});

// ── agent REST API (same operations as the MCP tools) ─────

app.use("/api/p/:slug/agent/*", async (c, next) => {
	if (tooLarge(c.req.raw)) return c.json({ error: "request too large" }, 413);
	const slug = c.req.param("slug");
	// Look the project up first: an unknown slug must not wake (and create) a Tower.
	const entry = await registry(c.env).get(slug);
	if (!entry) return c.json({ error: "not found" }, 404);
	const key = bearer(c.req.raw);
	const found = key ? await tower(c.env, slug).authenticate(key) : null;
	if (found && !("agent" in found)) return c.json({ error: keyRefused(found, renewProject(c, slug)) }, 401);
	// Without a key of its own, a private airspace looks unknown.
	if (!found) return entry.info.public || isAdmin(c) ? c.json({ error: "agent key required (Authorization: Bearer ct_…)" }, 401) : c.json({ error: "not found" }, 404);
	c.set("agentId", found.agent.id);
	await next();
});

app.get("/api/p/:slug/agent/tools", (c) => c.json({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));

app.post("/api/p/:slug/agent/:tool", async (c) => {
	const tool = TOOL_BY_NAME.get(c.req.param("tool"));
	if (!tool) return c.json({ error: "unknown tool" }, 404);
	const args = await readJson<Record<string, unknown>>(c.req.raw, 1 << 20, {});
	return c.json(await tool.run(tower(c.env, c.req.param("slug")), c.get("agentId")!, boundArgs(args)));
});

// ── MCP ───────────────────────────────────────────────────

app.all("/mcp/:slug", async (c) => {
	if (tooLarge(c.req.raw)) return c.json({ error: "request too large" }, 413);
	const slug = c.req.param("slug");
	const entry = await registry(c.env).get(slug);
	if (!entry) return c.json({ error: "not found" }, 404);
	const t = tower(c.env, slug);
	const key = bearer(c.req.raw);
	const found = key ? await t.authenticate(key) : null;
	// A private airspace answers only its own agents (an expired or revoked key hears why) and the operator: not even
	// its name to anyone else.
	if (!entry.info.public && !found && !isAdmin(c)) return c.json({ error: "not found" }, 404);
	return handleMcp(c.req.raw, {
		tools: TOOLS,
		target: t,
		agentId: found && "agent" in found ? found.agent.id : null,
		refused: found && !("agent" in found) ? keyRefused(found, renewProject(c, slug)) : undefined,
		projectName: entry.info.name,
		instructions: PROTOCOL,
	});
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

app.get("/api/c/:slug/crossings/:code", async (c) => {
	if (!(await canViewCenter(c, c.req.param("slug")))) return c.json({ error: "not found" }, 404);
	const crossing = await center(c.env, c.req.param("slug")).crossing(c.req.param("code"));
	return crossing ? c.json({ crossing }) : c.json({ error: "no such crossing" }, 404);
});

// ── crossings: changes across sectors, flown through the Center ──

app.post("/api/c/:slug/intents", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	if (!(await registry(c.env).getCenter(c.req.param("slug")))) return c.json({ error: "not found" }, 404);
	const body = await c.req.json<{ intents: { title: string; body?: string }[] }>();
	return c.json({ intents: await center(c.env, c.req.param("slug")).addIntents(body.intents ?? []) });
});

// Crossing agents join with the admin key and receive a personal agent key for this Center.
app.post("/api/c/:slug/join", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const slug = c.req.param("slug");
	if (!(await registry(c.env).getCenter(slug))) return c.json({ error: "not found" }, 404);
	const body = await c.req.json<{ callsign?: string; kind?: any; model?: string }>().catch(() => ({}) as any);
	const { agent, key, expiresAt } = await center(c.env, slug).join({ callsign: body.callsign, kind: body.kind, model: body.model });
	const origin = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
	const mcpUrl = `${origin}/mcp/c/${slug}`;
	return c.json({
		agent,
		key,
		expiresAt,
		mcp: {
			url: mcpUrl,
			claudeCode: `claude mcp add --transport http contrail-${slug} ${mcpUrl} --header "Authorization: Bearer ${key}"`,
			codex: `export CONTRAIL_KEY=${key} && codex mcp add contrail-${slug} --url ${mcpUrl} --bearer-token-env-var CONTRAIL_KEY`,
		},
	});
});

app.use("/api/c/:slug/agent/*", async (c, next) => {
	if (tooLarge(c.req.raw)) return c.json({ error: "request too large" }, 413);
	const slug = c.req.param("slug");
	if (!(await registry(c.env).getCenter(slug))) return c.json({ error: "not found" }, 404);
	const key = bearer(c.req.raw);
	const found = key ? await center(c.env, slug).authenticate(key) : null;
	if (found && !("agent" in found)) return c.json({ error: keyRefused(found, renewCenter(slug)) }, 401);
	if (!found) return c.json({ error: "agent key required (Authorization: Bearer ct_…)" }, 401);
	c.set("agentId", found.agent.id);
	await next();
});

app.get("/api/c/:slug/agent/tools", (c) => c.json({ tools: CENTER_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));

app.post("/api/c/:slug/agent/:tool", async (c) => {
	const tool = CENTER_TOOL_BY_NAME.get(c.req.param("tool"));
	if (!tool) return c.json({ error: "unknown tool" }, 404);
	const args = await readJson<Record<string, unknown>>(c.req.raw, 1 << 20, {});
	return c.json(await tool.run(center(c.env, c.req.param("slug")), c.get("agentId")!, boundArgs(args)));
});

app.post("/api/c/:slug/agents/:agent/revoke", async (c) => {
	if (!isAdmin(c)) return c.json({ error: "admin key required" }, 401);
	const slug = c.req.param("slug");
	if (!(await registry(c.env).getCenter(slug))) return c.json({ error: "not found" }, 404);
	return c.json(await center(c.env, slug).revokeKey(c.req.param("agent")));
});

app.all("/mcp/c/:slug", async (c) => {
	if (tooLarge(c.req.raw)) return c.json({ error: "request too large" }, 413);
	const slug = c.req.param("slug");
	const info = await registry(c.env).getCenter(slug);
	if (!info) return c.json({ error: "not found" }, 404);
	const target = center(c.env, slug);
	const key = bearer(c.req.raw);
	const found = key ? await target.authenticate(key) : null;
	if (!info.public && !(found && "agent" in found) && !isAdmin(c)) return c.json({ error: "not found" }, 404);
	return handleMcp(c.req.raw, {
		tools: CENTER_TOOLS,
		target,
		agentId: found && "agent" in found ? found.agent.id : null,
		refused: found && !("agent" in found) ? keyRefused(found, renewCenter(slug)) : undefined,
		projectName: info.name,
		instructions: CROSSING_PROTOCOL,
	});
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// ── Radar UI (static assets with SPA fallback) ────────────

// The demo video, with byte ranges: Safari on iPhone plays only from a server that answers them.
app.on(["GET", "HEAD"], "/demo.mp4", async (c) => {
	const asset = await c.env.ASSETS.fetch(new URL("/demo.mp4", c.req.url));
	return byteRange(asset, c.req.header("range") ?? null, c.req.method === "HEAD");
});

app.get("*", async (c) => {
	const res = await c.env.ASSETS.fetch(c.req.raw);
	if (res.status !== 404) return res;
	return c.env.ASSETS.fetch(new Request(new URL("/index.html", c.req.url), c.req.raw));
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
