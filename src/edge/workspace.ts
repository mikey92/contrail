// A checked-out working tree of a flight's workspace fork, held in memory by an edge agent.
import { Buffer } from "node:buffer";
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "../git/memfs";
import { type FlatTree, GITLINK, listTree, mergeBase, type Repo, writeFlatTree } from "../runway/gitops";
import { mergeTrees } from "../runway/treemerge";

const DIR = "/w";

function authFromUrl(cloneUrl: string): { url: string; headers: Record<string, string> } {
	const u = new URL(cloneUrl);
	const secret = decodeURIComponent(u.password);
	u.username = "";
	u.password = "";
	return { url: u.toString(), headers: { Authorization: `Basic ${btoa(`x:${secret}`)}` } };
}

export interface SyncResult {
	upstream: string;
	fastForward: boolean;
	changed: string[];
	conflicts: string[];
	/** Conflicts that are a file on one side and a directory on the other: trunk's side is at `<path>~trunk`. */
	clashes: string[];
}

/** Where sync() puts trunk's side of a file/directory clash: beside the workspace's, as git does. */
const TRUNK_SIDE = "~trunk";

export class Workspace {
	readonly repo: Repo = { fs: new MemoryFS(), dir: DIR, cache: {} };
	private origin!: { url: string; headers: Record<string, string> };
	private upstream!: { url: string; headers: Record<string, string> };
	/** Second parent recorded by sync() while conflicts are being resolved. */
	private pendingMerge: string | null = null;
	/** The commit the workspace fork's main has, as far as this checkout knows. */
	private pushed: string | null = null;

	static async open(cloneUrl: string, upstreamUrl: string, author: { name: string; email: string }): Promise<Workspace> {
		const ws = new Workspace();
		ws.origin = authFromUrl(cloneUrl);
		ws.upstream = authFromUrl(upstreamUrl);
		const { fs, dir, cache } = ws.repo;
		await git.clone({ fs, http, dir, url: ws.origin.url, ref: "main", singleBranch: true, headers: ws.origin.headers, cache });
		await git.setConfig({ fs, dir, path: "user.name", value: author.name });
		await git.setConfig({ fs, dir, path: "user.email", value: author.email });
		ws.pushed = await git.resolveRef({ fs, dir, ref: "HEAD" });
		return ws;
	}

	private path(p: string) {
		const clean = p.replace(/^\.?\/+/, "");
		if (!clean || clean.split("/").some((s) => s === ".." || s === ".git")) throw new Error(`bad path ${p}`);
		return { clean, full: `${DIR}/${clean}` };
	}

	async listFiles(): Promise<{ path: string; lines: number }[]> {
		const out: { path: string; lines: number }[] = [];
		const walk = async (d: string, prefix: string) => {
			for (const name of await this.repo.fs.promises.readdir(d)) {
				if (name === ".git") continue;
				const full = `${d}/${name}`;
				const st = await this.repo.fs.promises.stat(full);
				if (st.isDirectory()) await walk(full, `${prefix}${name}/`);
				else {
					const text = (await this.repo.fs.promises.readFile(full, "utf8")) as string;
					out.push({ path: `${prefix}${name}`, lines: text.split("\n").length });
				}
			}
		};
		await walk(DIR, "");
		return out.sort((a, b) => a.path.localeCompare(b.path));
	}

	async read(p: string): Promise<string> {
		const { full } = this.path(p);
		return (await this.repo.fs.promises.readFile(full, "utf8")) as string;
	}

	async write(p: string, content: string) {
		const { full } = this.path(p);
		await this.repo.fs.promises.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
		await this.repo.fs.promises.writeFile(full, content);
	}

	async edit(p: string, oldText: string, newText: string): Promise<void> {
		const current = await this.read(p);
		const count = current.split(oldText).length - 1;
		if (count === 0) throw new Error(`old_text not found in ${p}`);
		if (count > 1) throw new Error(`old_text appears ${count} times in ${p}; include more surrounding lines`);
		// A function replacer: in a replacement string, "$$", "$&" and "$'" would be patterns, not text.
		await this.write(p, current.replace(oldText, () => newText));
	}

	async remove(p: string) {
		const { full } = this.path(p);
		await this.repo.fs.promises.unlink(full);
		// Git keeps no empty directories: one left empty goes too, so a file can take its name.
		for (let d = full.slice(0, full.lastIndexOf("/")); d !== DIR && (await this.repo.fs.promises.readdir(d)).length === 0; d = d.slice(0, d.lastIndexOf("/"))) await this.repo.fs.promises.rmdir(d);
	}

	/** A file as it is on trunk, as of the last sync(). */
	async readTrunk(p: string): Promise<string> {
		const { clean } = this.path(p);
		const { fs, dir, cache } = this.repo;
		const oid = await git.resolveRef({ fs, dir, ref: "refs/remotes/upstream/main" });
		const { blob } = await git.readBlob({ fs, dir, oid, filepath: clean, cache });
		return new TextDecoder().decode(blob);
	}

	/** Text files of the working tree, for running tests. */
	async snapshot(): Promise<Map<string, string>> {
		const files = new Map<string, string>();
		for (const f of await this.listFiles()) files.set(f.path, await this.read(f.path));
		return files;
	}

	async hasConflictMarkers(): Promise<string[]> {
		const hits: string[] = [];
		for (const [path, text] of await this.snapshot()) if (/^<{7} |^>{7} /m.test(text)) hits.push(path);
		return hits;
	}

	/**
	 * Stages everything, commits (as a merge if a sync is pending) and pushes to the workspace fork. A commit
	 * sync() made of earlier edits is pushed too, even when nothing has changed since.
	 */
	async commitAndPush(message: string): Promise<string | null> {
		const { fs, dir, cache } = this.repo;
		const oid = (await this.commitLocal(message)) ?? (await git.resolveRef({ fs, dir, ref: "HEAD" }));
		if (oid === this.pushed) return null;
		const res = await git.push({ fs, http, dir, remote: "origin", ref: "main", headers: this.origin.headers, cache });
		if (!res.ok) throw new Error(`push failed: ${JSON.stringify(res.refs)}`);
		this.pushed = oid;
		return oid;
	}

	/**
	 * Merges trunk into the workspace (like `git pull upstream main`). Clean merges are applied to the
	 * working tree; conflicting files get conflict markers that the agent must resolve before landing.
	 */
	async sync(): Promise<SyncResult> {
		const { fs, dir, cache } = this.repo;
		await git.addRemote({ fs, dir, remote: "upstream", url: this.upstream.url, force: true });
		await git.fetch({ fs, http, dir, remote: "upstream", ref: "main", singleBranch: true, headers: this.upstream.headers, cache });
		const upstream = await git.resolveRef({ fs, dir, ref: "refs/remotes/upstream/main" });
		// Commit local edits first so the merge sees them.
		const head = (await this.commitLocal("WIP before syncing with trunk")) ?? (await git.resolveRef({ fs, dir, ref: "HEAD" }));
		const base = await mergeBase(this.repo, head, upstream);
		if (base === upstream) return { upstream, fastForward: false, changed: [], conflicts: [], clashes: [] };
		if (base === head) {
			// What trunk deleted goes first, so a file it turned into a directory (or back) leaves room for it.
			const target = await this.flat(upstream);
			for (const path of (await this.flat(head)).keys()) {
				if (target.has(path)) continue;
				await this.remove(path).catch(() => {});
				await git.remove({ fs, dir, filepath: path, cache });
			}
			await git.writeRef({ fs, dir, ref: "refs/heads/main", value: upstream, force: true });
			await git.checkout({ fs, dir, ref: "main", force: true, cache });
			return { upstream, fastForward: true, changed: [], conflicts: [], clashes: [] };
		}
		const merged = await mergeTrees(this.repo, base!, head, upstream);
		const beforeTree = await this.flat(head);
		// A path that is a file on one side and a directory on the other can't be both in a working tree: what
		// trunk has there goes beside it, at <path>~trunk, for the agent to keep one of them.
		// Read from the merged files: a modify/delete conflict on the same path hides treemerge's file/directory one.
		const clashes = [...new Set([...merged.files.keys()].flatMap((p) => {
			const dirs: string[] = [];
			for (let i = p.indexOf("/"); i !== -1; i = p.indexOf("/", i + 1)) if (merged.files.has(p.slice(0, i))) dirs.push(p.slice(0, i));
			return dirs;
		}))];
		const placed = (path: string) => {
			const clash = clashes.find((c) => path === c || path.startsWith(`${c}/`));
			return clash ? `${clash}${TRUNK_SIDE}${path.slice(clash.length)}` : path;
		};
		// Deletions first: a file trunk turned into a directory (or back) must go before what replaces it is written.
		for (const path of beforeTree.keys()) if (!merged.files.has(path)) await this.remove(path).catch(() => {});
		const changed: string[] = [];
		for (const [path, item] of merged.files) {
			if (beforeTree.get(path)?.oid === item.oid || item.mode === GITLINK) continue;
			const { blob } = await git.readBlob({ fs, dir, oid: item.oid, cache });
			await this.write(placed(path), new TextDecoder().decode(blob));
			changed.push(placed(path));
		}
		for (const [path, text] of merged.conflictTexts) await this.write(path, text);
		this.pendingMerge = upstream;
		if (merged.conflicts.length === 0) await this.commitAndPushMerge(merged.files, head, upstream);
		return { upstream, fastForward: false, changed, conflicts: merged.conflicts.map((c) => c.path), clashes };
	}

	/** Trunk's sides of file/directory clashes (`<path>~trunk`) still in the working tree: not settled yet. */
	async unsettledClashes(): Promise<string[]> {
		const roots = (await this.listFiles()).flatMap((f) => {
			const at = f.path.split("/").findIndex((part) => part.endsWith(TRUNK_SIDE));
			return at === -1 ? [] : [f.path.split("/").slice(0, at + 1).join("/")];
		});
		return [...new Set(roots)];
	}

	private async flat(commit: string): Promise<FlatTree> {
		return listTree(this.repo, commit);
	}

	/** Stages every change and commits it (as a merge commit while a sync is pending). */
	private async commitLocal(message: string): Promise<string | null> {
		const { fs, dir, cache } = this.repo;
		const matrix = await git.statusMatrix({ fs, dir, cache });
		let changed = false;
		for (const [filepath, head, work, stage] of matrix) {
			if (head === 1 && work === 1 && stage === 1) continue;
			changed = true;
			if (work === 0) await git.remove({ fs, dir, filepath, cache });
			else await git.add({ fs, dir, filepath, cache });
		}
		if (!changed && !this.pendingMerge) return null;
		const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
		const parents = this.pendingMerge ? [head, this.pendingMerge] : [head];
		this.pendingMerge = null;
		return git.commit({ fs, dir, message, parent: parents, cache });
	}

	private async commitAndPushMerge(files: FlatTree, head: string, upstream: string) {
		const { fs, dir, cache } = this.repo;
		const tree = await writeFlatTree(this.repo, files);
		const name = (await git.getConfig({ fs, dir, path: "user.name" })) as string;
		const email = (await git.getConfig({ fs, dir, path: "user.email" })) as string;
		const ts = Math.floor(Date.now() / 1000);
		const oid = await git.writeCommit({
			fs,
			dir,
			commit: {
				message: "Merge trunk into workspace\n",
				tree,
				parent: [head, upstream],
				author: { name, email, timestamp: ts, timezoneOffset: 0 },
				committer: { name, email, timestamp: ts, timezoneOffset: 0 },
			},
		});
		await git.writeRef({ fs, dir, ref: "refs/heads/main", value: oid, force: true });
		await git.checkout({ fs, dir, ref: "main", force: true, cache });
		this.pendingMerge = null;
		const res = await git.push({ fs, http, dir, remote: "origin", ref: "main", headers: this.origin.headers, cache });
		if (!res.ok) throw new Error(`push failed: ${JSON.stringify(res.refs)}`);
		this.pushed = oid;
	}
}
