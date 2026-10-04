// Center: one per sectored monorepo (a single Durable Object per center slug).
//
// A big codebase can be split into sectors, each a full airspace (Tower, Runway and its own trunk repo
// in Artifacts) that owns one directory prefix. Sectors land independently and in parallel. The Center
// keeps the monorepo's own trunk: whenever sectors move, it fetches their latest trunks and commits one
// composed tree. Prefixes are disjoint, so composing never conflicts and never needs tests of its own.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { cloneMain, commit, commitTreeOid, type FlatTree, fetchMain, fetchUnrelated, listTree, newRepo, type Repo, pushMain, seed, setMain, writeFlatTree } from "../runway/gitops";
import type { CenterInfo, CenterSnapshot, SectorInfo } from "../shared/types";
import { errorMessage, repoSafe } from "../util";
import { checkPrefixes, composeTree } from "./compose";

/** How long the Center waits after a sector moves, so a burst of landings becomes one composition. */
const COALESCE_MS = 1000;
const MAX_REPO_BYTES = 64 * 1024 * 1024;
const TOKEN_SECONDS = 600;
const AUTHOR = { name: "Contrail Center", email: "center@contrail.dev" };

export class Center extends DurableObject<Env> {
	private repo: Repo | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	/** Remote URLs and tokens per repo and scope, reused for most of each token's life. */
	private access = new Map<string, { remote: string; token: string; until: number }>();

	/** Serializes all git work on the in-memory clone. */
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	private async info(): Promise<CenterInfo> {
		const info = await this.ctx.storage.get<CenterInfo>("center");
		if (!info) throw new Error("center is not set up");
		return info;
	}

	/** Creates the monorepo trunk from the full file set; the sectors were created from their slices of it. */
	async setup(input: { slug: string; name: string; description: string; public: boolean; sectors: SectorInfo[]; files: Record<string, string> }): Promise<CenterInfo> {
		const existing = await this.ctx.storage.get<CenterInfo>("center");
		if (existing) return existing;
		const problem = checkPrefixes(input.sectors.map((s) => s.prefix));
		if (problem) throw new Error(problem);
		const trunkRepo = repoSafe(`${input.slug}--monorepo`);
		const A = this.env.ARTIFACTS;
		const exists = await A.get(trunkRepo)
			.then((r) => (r[Symbol.dispose]?.(), true))
			.catch(() => false);
		if (!exists) await A.create(trunkRepo, { setDefaultBranch: "main", description: `${input.name} monorepo (composed from ${input.sectors.length} sectors)` });
		const repo = await A.get(trunkRepo);
		try {
			const log = await repo.log({ ref: "main", limit: 1 });
			if (log.length === 0) {
				const [info, t] = await Promise.all([repo.info(), repo.createToken("write", 600)]);
				await seed(info.remote, t.plaintext, input.files, `Create ${input.name}`, AUTHOR);
			}
		} finally {
			repo[Symbol.dispose]?.();
		}
		const info: CenterInfo = { slug: input.slug, name: input.name, description: input.description, trunkRepo, sectors: input.sectors, createdAt: Date.now(), public: input.public };
		await this.ctx.storage.put("center", info);
		return info;
	}

	/** A sector's trunk moved. Compositions are coalesced: a burst of landings becomes one commit. */
	async sectorMoved(slug: string): Promise<void> {
		const dirty = new Set((await this.ctx.storage.get<string[]>("dirty")) ?? []);
		dirty.add(slug);
		await this.ctx.storage.put("dirty", [...dirty]);
		if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + COALESCE_MS);
	}

	async alarm() {
		// A center that was deleted (or never set up) has nothing to compose.
		if (!(await this.ctx.storage.get<CenterInfo>("center"))) {
			await this.ctx.storage.deleteAll();
			return;
		}
		try {
			await this.compose();
		} catch (err) {
			await this.ctx.storage.put("lastError", errorMessage(err));
			await this.ctx.storage.setAlarm(Date.now() + 5000);
			return;
		}
		// Sectors that moved while we were composing get the next commit.
		if (((await this.ctx.storage.get<string[]>("dirty")) ?? []).length) await this.ctx.storage.setAlarm(Date.now() + COALESCE_MS);
	}

	/** Brings the monorepo trunk up to date with every sector that moved. */
	async compose(): Promise<string | null> {
		return this.exclusive(async () => {
			const info = await this.info();
			const dirty = (await this.ctx.storage.get<string[]>("dirty")) ?? [];
			if (!dirty.length) return null;
			await this.ctx.storage.put("dirty", []);
			const heads = (await this.ctx.storage.get<Record<string, string>>("heads")) ?? {};
			try {
				const { head, token } = await this.sync(info.trunkRepo);
				const r = this.repo!;
				const due = info.sectors.filter((s) => dirty.includes(s.slug));
				const sources = await Promise.all(due.map(async (s) => ({ name: `sector-${s.slug}`, ...(await this.repoAccess(s.trunkRepo, "read")) })));
				const sectorHeads = await fetchUnrelated(r, sources.map((s) => ({ name: s.name, url: s.remote, token: s.token })));
				const moved: { prefix: string; tree: FlatTree }[] = [];
				for (const [i, sector] of due.entries()) {
					if (heads[sector.slug] === sectorHeads[i]) continue;
					moved.push({ prefix: sector.prefix, tree: await listTree(r, sectorHeads[i]) });
					heads[sector.slug] = sectorHeads[i];
				}
				if (!moved.length) return head;
				const tree = await writeFlatTree(r, composeTree(await listTree(r, head), moved));
				if (tree === (await commitTreeOid(r, head))) return head;
				const names = info.sectors.filter((s) => moved.some((m) => m.prefix === s.prefix));
				const message = [
					`Compose ${names.map((s) => s.name).join(", ")}`,
					"",
					...names.map((s) => `Contrail-Sector: ${s.name} ${heads[s.slug].slice(0, 12)}`),
				].join("\n");
				const composed = await commit(r, { tree, parents: [head], message, author: AUTHOR });
				await setMain(r, composed);
				try {
					await pushMain(r, token);
				} catch (err) {
					this.repo = null; // someone else moved the monorepo trunk: start from a fresh clone next time
					throw err;
				}
				await this.ctx.storage.put({ heads, head: composed, composedAt: Date.now(), compositions: ((await this.ctx.storage.get<number>("compositions")) ?? 0) + 1, lastError: null });
				return composed;
			} catch (err) {
				this.access.clear(); // a token may have been revoked
				// Put the sectors back so the next attempt picks them up.
				const now = new Set([...((await this.ctx.storage.get<string[]>("dirty")) ?? []), ...dirty]);
				await this.ctx.storage.put("dirty", [...now]);
				throw err;
			}
		});
	}

	private async repoAccess(name: string, scope: "read" | "write"): Promise<{ remote: string; token: string }> {
		const key = `${scope} ${name}`;
		const known = this.access.get(key);
		if (known && known.until > Date.now()) return known;
		const repo = await this.env.ARTIFACTS.get(name);
		try {
			const [info, t] = await Promise.all([repo.info(), repo.createToken(scope, TOKEN_SECONDS)]);
			const access = { remote: info.remote, token: t.plaintext, until: Date.now() + (TOKEN_SECONDS - 60) * 1000 };
			this.access.set(key, access);
			return access;
		} finally {
			repo[Symbol.dispose]?.();
		}
	}

	/** A warm clone of the monorepo trunk and a write token for it. */
	private async sync(trunkRepo: string): Promise<{ head: string; token: string }> {
		const { remote, token } = await this.repoAccess(trunkRepo, "write");
		if (this.repo && this.repo.fs.byteSize < MAX_REPO_BYTES) {
			const head = await fetchMain(this.repo, token);
			await setMain(this.repo, head);
			return { head, token };
		}
		this.repo = newRepo();
		return { head: await cloneMain(this.repo, remote, token), token };
	}

	/** The Center page: the composed trunk and every sector's live counts. */
	async snapshot(): Promise<CenterSnapshot> {
		const info = await this.info();
		const [head, composedAt, compositions, dirty] = await Promise.all([
			this.ctx.storage.get<string>("head"),
			this.ctx.storage.get<number>("composedAt"),
			this.ctx.storage.get<number>("compositions"),
			this.ctx.storage.get<string[]>("dirty"),
		]);
		const sectors = await Promise.all(
			info.sectors.map(async (s) => ({ ...s, summary: await this.env.TOWER.get(this.env.TOWER.idFromName(s.slug)).summary().catch(() => null) })),
		);
		return { center: info, head: head ?? null, composedAt: composedAt ?? null, behind: (dirty ?? []).length, compositions: compositions ?? 0, sectors };
	}

	/** Deletes the monorepo trunk (the sectors are projects of their own and are deleted separately). */
	async destroy(): Promise<{ deleted: string | null }> {
		const info = await this.ctx.storage.get<CenterInfo>("center");
		if (info) await this.env.ARTIFACTS.delete(info.trunkRepo).catch(() => false);
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.repo = null;
		this.access.clear();
		return { deleted: info?.trunkRepo ?? null };
	}
}
