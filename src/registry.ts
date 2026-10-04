// Registry: the list of projects hosted by this Contrail deployment (a single global Durable Object).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import type { ProjectInfo } from "./shared/types";
import { json } from "./util";

export class Registry extends DurableObject<Env> {
	private sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS projects (slug TEXT PRIMARY KEY, info TEXT NOT NULL, join_code TEXT NOT NULL, created_at INTEGER NOT NULL)`);
	}

	async register(info: ProjectInfo, joinCode: string): Promise<boolean> {
		const exists = this.sql.exec("SELECT slug FROM projects WHERE slug = ?", info.slug).toArray().length > 0;
		if (exists) return false;
		this.sql.exec("INSERT INTO projects (slug, info, join_code, created_at) VALUES (?, ?, ?, ?)", info.slug, JSON.stringify(info), joinCode, Date.now());
		return true;
	}

	async update(info: ProjectInfo) {
		this.sql.exec("UPDATE projects SET info = ? WHERE slug = ?", JSON.stringify(info), info.slug);
	}

	async get(slug: string): Promise<{ info: ProjectInfo; joinCode: string } | null> {
		const row = this.sql.exec("SELECT info, join_code FROM projects WHERE slug = ?", slug).toArray()[0] as { info: string; join_code: string } | undefined;
		return row ? { info: json<ProjectInfo>(row.info, null as unknown as ProjectInfo), joinCode: row.join_code } : null;
	}

	async list(): Promise<ProjectInfo[]> {
		return this.sql
			.exec("SELECT info FROM projects ORDER BY created_at DESC")
			.toArray()
			.map((r) => json<ProjectInfo>((r as { info: string }).info, null as unknown as ProjectInfo));
	}

	async remove(slug: string) {
		this.sql.exec("DELETE FROM projects WHERE slug = ?", slug);
	}
}
