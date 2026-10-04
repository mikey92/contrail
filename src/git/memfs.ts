// In-memory filesystem for isomorphic-git inside Workers and Durable Objects.
// Errors carry Node-style `code`s because isomorphic-git branches on them.

type Entry =
	| { kind: "dir"; children: Set<string>; mtimeMs: number }
	| { kind: "file"; data: Uint8Array; mtimeMs: number; mode: number }
	| { kind: "symlink"; target: string; mtimeMs: number };

function fsError(code: string, op: string, path: string): Error {
	const err = new Error(`${code}: ${op} '${path}'`) as Error & { code: string };
	err.code = code;
	return err;
}

let inoCounter = 1;

class Stats {
	readonly ino = inoCounter++;
	readonly dev = 1;
	readonly uid = 1;
	readonly gid = 1;
	constructor(private entry: Entry) {}
	get size() {
		return this.entry.kind === "file" ? this.entry.data.byteLength : 0;
	}
	get mode() {
		if (this.entry.kind === "file") return this.entry.mode;
		if (this.entry.kind === "symlink") return 0o120000;
		return 0o040000;
	}
	get mtimeMs() {
		return this.entry.mtimeMs;
	}
	get ctimeMs() {
		return this.entry.mtimeMs;
	}
	get mtime() {
		return new Date(this.entry.mtimeMs);
	}
	get ctime() {
		return new Date(this.entry.mtimeMs);
	}
	isFile() {
		return this.entry.kind === "file";
	}
	isDirectory() {
		return this.entry.kind === "dir";
	}
	isSymbolicLink() {
		return this.entry.kind === "symlink";
	}
}

export class MemoryFS {
	private entries = new Map<string, Entry>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);
	private encoder = new TextEncoder();
	private decoder = new TextDecoder();

	readonly promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.lstat.bind(this),
		readlink: this.readlink.bind(this),
		symlink: this.symlink.bind(this),
		chmod: this.chmod.bind(this),
	};

	/** Approximate bytes held, used to decide when to drop a warm clone. */
	get byteSize(): number {
		let total = 0;
		for (const e of this.entries.values()) if (e.kind === "file") total += e.data.byteLength;
		return total;
	}

	private normalize(input: string): string {
		const segments: string[] = [];
		for (const part of input.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") segments.pop();
			else segments.push(part);
		}
		return `/${segments.join("/")}`;
	}

	private parent(path: string): string {
		const parts = this.normalize(path).split("/").filter(Boolean);
		parts.pop();
		return parts.length ? `/${parts.join("/")}` : "/";
	}

	private basename(path: string): string {
		return this.normalize(path).split("/").filter(Boolean).pop() ?? "";
	}

	private get(path: string, op: string): Entry {
		const entry = this.entries.get(this.normalize(path));
		if (!entry) throw fsError("ENOENT", op, path);
		return entry;
	}

	private dir(path: string, op: string) {
		const entry = this.get(path, op);
		if (entry.kind !== "dir") throw fsError("ENOTDIR", op, path);
		return entry;
	}

	async mkdir(path: string, options?: { recursive?: boolean } | number): Promise<void> {
		const target = this.normalize(path);
		if (target === "/") return;
		const recursive = typeof options === "object" && options !== null && !!options.recursive;
		if (this.entries.has(target)) {
			if (recursive) return;
			throw fsError("EEXIST", "mkdir", path);
		}
		const parent = this.parent(target);
		if (!this.entries.has(parent)) {
			if (!recursive) throw fsError("ENOENT", "mkdir", path);
			await this.mkdir(parent, { recursive: true });
		}
		this.dir(parent, "mkdir").children.add(this.basename(target));
		this.entries.set(target, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
	}

	async writeFile(path: string, data: string | Uint8Array | ArrayBuffer, options?: { mode?: number } | string) {
		const target = this.normalize(path);
		const parent = this.parent(target);
		if (!this.entries.has(parent)) throw fsError("ENOENT", "open", path);
		const existing = this.entries.get(target);
		if (existing?.kind === "dir") throw fsError("EISDIR", "open", path);
		const bytes =
			typeof data === "string" ? this.encoder.encode(data) : data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
		const mode = (typeof options === "object" && options?.mode) || 0o100644;
		this.entries.set(target, { kind: "file", data: bytes, mtimeMs: Date.now(), mode });
		this.dir(parent, "open").children.add(this.basename(target));
	}

	async readFile(path: string, options?: string | { encoding?: string }): Promise<Uint8Array | string> {
		const entry = this.get(path, "open");
		if (entry.kind === "dir") throw fsError("EISDIR", "read", path);
		if (entry.kind === "symlink") return this.readFile(entry.target, options);
		const encoding = typeof options === "string" ? options : options?.encoding;
		return encoding ? this.decoder.decode(entry.data) : entry.data;
	}

	async readdir(path: string): Promise<string[]> {
		return [...this.dir(path, "scandir").children].sort();
	}

	async unlink(path: string): Promise<void> {
		const target = this.normalize(path);
		const entry = this.get(target, "unlink");
		if (entry.kind === "dir") throw fsError("EISDIR", "unlink", path);
		this.entries.delete(target);
		this.dir(this.parent(target), "unlink").children.delete(this.basename(target));
	}

	async rmdir(path: string): Promise<void> {
		const target = this.normalize(path);
		const entry = this.dir(target, "rmdir");
		if (entry.children.size > 0) throw fsError("ENOTEMPTY", "rmdir", path);
		this.entries.delete(target);
		this.dir(this.parent(target), "rmdir").children.delete(this.basename(target));
	}

	async stat(path: string): Promise<Stats> {
		const entry = this.get(path, "stat");
		if (entry.kind === "symlink") return this.stat(entry.target);
		return new Stats(entry);
	}

	async lstat(path: string): Promise<Stats> {
		return new Stats(this.get(path, "lstat"));
	}

	async readlink(path: string): Promise<string> {
		const entry = this.get(path, "readlink");
		if (entry.kind !== "symlink") throw fsError("EINVAL", "readlink", path);
		return entry.target;
	}

	async symlink(target: string, path: string): Promise<void> {
		const p = this.normalize(path);
		this.dir(this.parent(p), "symlink").children.add(this.basename(p));
		this.entries.set(p, { kind: "symlink", target, mtimeMs: Date.now() });
	}

	async chmod(path: string, mode: number): Promise<void> {
		const entry = this.get(path, "chmod");
		if (entry.kind === "file") entry.mode = mode;
	}
}
