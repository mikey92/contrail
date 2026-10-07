// Thin helpers over isomorphic-git for an in-memory repository living inside a Durable Object.
import { Buffer } from "node:buffer";
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "../git/memfs";

export interface Repo {
	fs: MemoryFS;
	dir: string;
	cache: object;
}

export interface TreeItem {
	oid: string;
	mode: string;
}

export type FlatTree = Map<string, TreeItem>;

export interface Person {
	name: string;
	email: string;
}

export const newRepo = (): Repo => ({ fs: new MemoryFS(), dir: "/repo", cache: {} });

const headers = (token: string) => ({ Authorization: `Bearer ${token}` });

export async function cloneMain(repo: Repo, url: string, token: string): Promise<string> {
	await git.clone({ fs: repo.fs, http, dir: repo.dir, url, ref: "main", singleBranch: true, noCheckout: true, headers: headers(token), cache: repo.cache });
	return git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: "refs/remotes/origin/main" });
}

export async function fetchMain(repo: Repo, token: string): Promise<string> {
	await git.fetch({ fs: repo.fs, http, dir: repo.dir, remote: "origin", ref: "main", singleBranch: true, headers: headers(token), cache: repo.cache });
	return git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: "refs/remotes/origin/main" });
}

/** Fetches `main` of another Artifacts repo (an agent's workspace fork) into refs/remotes/<name>/main. */
export async function fetchFork(repo: Repo, name: string, url: string, token: string): Promise<string> {
	await git.addRemote({ fs: repo.fs, dir: repo.dir, remote: name, url, force: true });
	try {
		await git.fetch({ fs: repo.fs, http, dir: repo.dir, remote: name, ref: "main", singleBranch: true, headers: headers(token), cache: repo.cache });
		return await git.resolveRef({ fs: repo.fs, dir: repo.dir, ref: `refs/remotes/${name}/main` });
	} finally {
		await git.deleteRemote({ fs: repo.fs, dir: repo.dir, remote: name }).catch(() => {});
	}
}

/**
 * Fetches `main` of several unrelated Artifacts repos (sector trunks) at once, each into refs/remotes/<name>/main.
 * Their histories share nothing with this repo's, so each fetch offers the head it fetched last time;
 * offering this repo's own main instead would make the server send the whole history again every time.
 */
export async function fetchUnrelated(repo: Repo, sources: { name: string; url: string; token: string }[]): Promise<string[]> {
	// The remotes stay configured (fetches write refs through their refspecs), and config writes happen one at a time.
	for (const s of sources) {
		if ((await git.getConfig({ fs: repo.fs, dir: repo.dir, path: `remote.${s.name}.url` })) !== s.url) {
			await git.addRemote({ fs: repo.fs, dir: repo.dir, remote: s.name, url: s.url, force: true });
		}
	}
	return Promise.all(
		sources.map(async (s) => {
			const ref = `refs/remotes/${s.name}/main`;
			const res = await git.fetch({ fs: repo.fs, http, dir: repo.dir, remote: s.name, ref, remoteRef: "refs/heads/main", singleBranch: true, headers: headers(s.token), cache: repo.cache });
			if (!res.fetchHead) throw new Error(`${s.name} has no main branch`);
			return res.fetchHead;
		}),
	);
}

/** Pushes `oid` as `main` of another repo (a crossing's leg fork), replacing whatever its main was. */
export async function pushTo(repo: Repo, url: string, token: string, oid: string) {
	const ref = `refs/heads/push-${oid}`;
	await git.writeRef({ fs: repo.fs, dir: repo.dir, ref, value: oid, force: true });
	try {
		const res = await git.push({ fs: repo.fs, http, dir: repo.dir, url, ref, remoteRef: "refs/heads/main", force: true, headers: headers(token), cache: repo.cache });
		if (!res.ok) throw new Error(`push rejected: ${JSON.stringify(res.refs)}`);
	} finally {
		await git.deleteRef({ fs: repo.fs, dir: repo.dir, ref }).catch(() => {});
	}
}

export async function setMain(repo: Repo, oid: string) {
	await git.writeRef({ fs: repo.fs, dir: repo.dir, ref: "refs/heads/main", value: oid, force: true });
}

export async function pushMain(repo: Repo, token: string) {
	const res = await git.push({ fs: repo.fs, http, dir: repo.dir, remote: "origin", ref: "main", headers: headers(token), cache: repo.cache });
	if (!res.ok) throw new Error(`push rejected: ${JSON.stringify(res.refs)}`);
	return res;
}

/** Pushes the landing notes. A fast-forward only: notes added on top of trunk's notes never replace them. */
export async function pushNotes(repo: Repo, token: string) {
	return git.push({
		fs: repo.fs,
		http,
		dir: repo.dir,
		remote: "origin",
		ref: "refs/notes/contrail",
		remoteRef: "refs/notes/contrail",
		headers: headers(token),
		cache: repo.cache,
	});
}

/** Fetches trunk's landing notes into the local notes ref, so new notes are added to them. */
export async function fetchNotes(repo: Repo, token: string) {
	let head: string | null = null;
	try {
		const res = await git.fetch({ fs: repo.fs, http, dir: repo.dir, remote: "origin", ref: "refs/notes/contrail", remoteRef: "refs/notes/contrail", singleBranch: true, tags: false, headers: headers(token), cache: repo.cache });
		head = res.fetchHead;
	} catch (err) {
		// A trunk without notes yet has nothing to fetch; anything else is an error.
		if (!/could not find|not found|no ref/i.test(String((err as Error)?.message ?? err))) throw err;
	}
	if (head) await git.writeRef({ fs: repo.fs, dir: repo.dir, ref: "refs/notes/contrail", value: head, force: true });
}

export async function mergeBase(repo: Repo, a: string, b: string): Promise<string | null> {
	const bases = await git.findMergeBase({ fs: repo.fs, dir: repo.dir, oids: [a, b], cache: repo.cache });
	return bases[0] ?? null;
}

export async function commitTreeOid(repo: Repo, commit: string): Promise<string> {
	const { commit: c } = await git.readCommit({ fs: repo.fs, dir: repo.dir, oid: commit, cache: repo.cache });
	return c.tree;
}

/** The tree oid of directory `dir` ("services/payments/") in a commit, or null when it has none. */
export async function subtreeOid(repo: Repo, commitOid: string, dir: string): Promise<string | null> {
	try {
		const { oid } = await git.readTree({ fs: repo.fs, dir: repo.dir, oid: commitOid, filepath: dir.replace(/\/$/, ""), cache: repo.cache });
		return oid;
	} catch {
		return null;
	}
}

/**
 * The newest commit at or behind `head` (following first parents) whose directory `dir` is the tree `want`:
 * where a sector's own history stood when the monorepo had that tree. Null if not within `limit` commits.
 */
export async function findSubtree(repo: Repo, head: string, dir: string, want: string | null, limit = 5000): Promise<string | null> {
	let oid: string | undefined = head;
	for (let i = 0; oid && i < limit; i++) {
		if ((await subtreeOid(repo, oid, dir)) === want) return oid;
		const { commit: c } = await git.readCommit({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache });
		oid = c.parent[0];
	}
	return null;
}

/** All blobs of a commit's tree, keyed by path. */
export async function listTree(repo: Repo, commitOrTree: string): Promise<FlatTree> {
	const out: FlatTree = new Map();
	const walkTree = async (treeOid: string, prefix: string) => {
		const { tree } = await git.readTree({ fs: repo.fs, dir: repo.dir, oid: treeOid, cache: repo.cache });
		for (const entry of tree) {
			const path = prefix ? `${prefix}/${entry.path}` : entry.path;
			if (entry.type === "tree") await walkTree(entry.oid, path);
			else if (entry.type === "blob") out.set(path, { oid: entry.oid, mode: entry.mode });
		}
	};
	const { type } = await git.readObject({ fs: repo.fs, dir: repo.dir, oid: commitOrTree, format: "parsed", cache: repo.cache });
	await walkTree(type === "commit" ? await commitTreeOid(repo, commitOrTree) : commitOrTree, "");
	return out;
}

export async function readBlob(repo: Repo, oid: string): Promise<Uint8Array> {
	const { blob } = await git.readBlob({ fs: repo.fs, dir: repo.dir, oid, cache: repo.cache });
	return blob;
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Blob as UTF-8 text, or null when it looks binary. */
export async function readText(repo: Repo, oid: string): Promise<string | null> {
	const bytes = await readBlob(repo, oid);
	if (bytes.includes(0)) return null;
	try {
		return decoder.decode(bytes);
	} catch {
		return null;
	}
}

export async function writeText(repo: Repo, text: string): Promise<string> {
	return git.writeBlob({ fs: repo.fs, dir: repo.dir, blob: new TextEncoder().encode(text) });
}

/** Writes nested tree objects for a flat path → blob map and returns the root tree oid. */
export async function writeFlatTree(repo: Repo, files: FlatTree): Promise<string> {
	interface Dir {
		blobs: Map<string, TreeItem>;
		dirs: Map<string, Dir>;
	}
	const root: Dir = { blobs: new Map(), dirs: new Map() };
	for (const [path, item] of files) {
		const parts = path.split("/");
		let d = root;
		for (const p of parts.slice(0, -1)) {
			let next = d.dirs.get(p);
			if (!next) {
				next = { blobs: new Map(), dirs: new Map() };
				d.dirs.set(p, next);
			}
			d = next;
		}
		d.blobs.set(parts[parts.length - 1], item);
	}
	const write = async (d: Dir): Promise<string> => {
		const entries: { mode: string; path: string; oid: string; type: "blob" | "tree" }[] = [];
		for (const [name, sub] of d.dirs) entries.push({ mode: "040000", path: name, oid: await write(sub), type: "tree" });
		for (const [name, item] of d.blobs) entries.push({ mode: item.mode, path: name, oid: item.oid, type: "blob" });
		return git.writeTree({ fs: repo.fs, dir: repo.dir, tree: entries });
	};
	return write(root);
}

export async function commit(repo: Repo, opts: { tree: string; parents: string[]; message: string; author: Person; committer?: Person }): Promise<string> {
	const timestamp = Math.floor(Date.now() / 1000);
	const committer = opts.committer ?? { name: "Contrail Runway", email: "runway@contrail.dev" };
	return git.writeCommit({
		fs: repo.fs,
		dir: repo.dir,
		commit: {
			message: opts.message.endsWith("\n") ? opts.message : `${opts.message}\n`,
			tree: opts.tree,
			parent: opts.parents,
			author: { ...opts.author, timestamp, timezoneOffset: 0 },
			committer: { ...committer, timestamp, timezoneOffset: 0 },
		},
	});
}

export async function addNote(repo: Repo, oid: string, note: string) {
	await git.addNote({
		fs: repo.fs,
		dir: repo.dir,
		ref: "refs/notes/contrail",
		oid,
		note,
		force: true,
		author: { name: "Contrail Runway", email: "runway@contrail.dev" },
		cache: repo.cache,
	});
}

export async function readNote(repo: Repo, oid: string): Promise<string | null> {
	try {
		const bytes = await git.readNote({ fs: repo.fs, dir: repo.dir, ref: "refs/notes/contrail", oid, cache: repo.cache });
		return new TextDecoder().decode(bytes);
	} catch {
		return null;
	}
}

export async function log(repo: Repo, ref: string, depth = 50) {
	return git.log({ fs: repo.fs, dir: repo.dir, ref, depth, cache: repo.cache });
}

/** Creates a brand-new repository with the given files and pushes it as `main`. */
export async function seed(url: string, token: string, files: Record<string, string>, message: string, author: Person) {
	const repo = newRepo();
	await git.init({ fs: repo.fs, dir: repo.dir, defaultBranch: "main" });
	const flat: FlatTree = new Map();
	for (const [path, content] of Object.entries(files)) flat.set(path, { oid: await writeText(repo, content), mode: "100644" });
	const tree = await writeFlatTree(repo, flat);
	const oid = await commit(repo, { tree, parents: [], message, author });
	await setMain(repo, oid);
	await git.push({ fs: repo.fs, http, dir: repo.dir, url, ref: "main", headers: headers(token), cache: repo.cache });
	return oid;
}
