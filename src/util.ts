export const now = () => Date.now();

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export function randomId(len = 12): string {
	const bytes = crypto.getRandomValues(new Uint8Array(len));
	let out = "";
	for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
	return out;
}

export function randomToken(prefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	return `${prefix}_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison for secrets. */
export function safeEqual(a: string, b: string): boolean {
	const ea = new TextEncoder().encode(a);
	const eb = new TextEncoder().encode(b);
	if (ea.length !== eb.length) return false;
	let diff = 0;
	for (let i = 0; i < ea.length; i++) diff |= ea[i] ^ eb[i];
	return diff === 0;
}

/** An agent key works for 30 days after it is issued; then the agent joins again for a new one. */
export const AGENT_KEY_TTL_MS = 30 * 24 * 3600_000;

/** A key's agent while the key works; after that, only when it expired. */
export function keyCheck<A extends { joinedAt: number }>(agent: A, at = now()): { agent: A } | { expiredAt: number } {
	const expiresAt = agent.joinedAt + AGENT_KEY_TTL_MS;
	return at < expiresAt ? { agent } : { expiredAt: expiresAt };
}

/** What an agent with an expired key is told, with where to get a new one. */
export function expiredKeyMessage(expiredAt: number, renew: string): string {
	const on = new Date(expiredAt).toISOString().slice(0, 16).replace("T", " ");
	return `This agent key expired on ${on} UTC; keys work for ${AGENT_KEY_TTL_MS / 86_400_000} days. ${renew} and use it in place of the old one.`;
}

export function json<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

const PALETTE = ["#4fd1c5", "#f6ad55", "#9f7aea", "#68d391", "#fc8181", "#63b3ed", "#f687b3", "#faf089", "#81e6d9", "#d6bcfa", "#fbd38d", "#90cdf4"];

export function colorFor(index: number): string {
	return PALETTE[index % PALETTE.length];
}

const KIND_PREFIX: Record<string, string> = { "claude-code": "CLAUDE", codex: "CODEX", edge: "EDGE", human: "HUMAN", other: "AGENT" };

export function callsignFor(kind: string, n: number): string {
	return `${KIND_PREFIX[kind] ?? "AGENT"}-${n}`;
}

/** Artifacts repo names: letters, digits, '.', '_' and '-', starting with a letter or digit. */
export function repoSafe(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 60);
}

/** A git URL with an Artifacts repo token in it, for an agent's remotes. */
export function cloneUrl(remote: string, token: string): string {
	const secret = token.split("?expires=")[0];
	return `https://x:${secret}@${remote.replace(/^https:\/\//, "")}`;
}

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

/** Runs `fn` again after errors that look transient (HTTP 5xx, dropped connections), backing off 0.3 s, then 0.9 s. */
export async function retryTransient<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (err) {
			if (i >= attempts || !/HTTP Error: 5\d\d|internal error|network connection|connection (reset|lost)/i.test(errorMessage(err))) throw err;
			await sleep(300 * 3 ** (i - 1));
		}
	}
}

/**
 * The landing id in a trunk commit's trailer block. The Tower writes that block last, so only the last
 * Contrail-Landing line counts: look-alikes in an agent's summary above it cannot stand in for it.
 */
export function landingTrailer(message: string): string | null {
	return [...message.matchAll(/^Contrail-Landing: (\S+)$/gm)].at(-1)?.[1] ?? null;
}

/**
 * A static asset answered for one byte range (206), as Safari on iPhone needs to play a video: the asset
 * server always sends the whole file. One range only; anything else gets the whole file, as HTTP allows.
 */
export async function byteRange(asset: Response, range: string | null, head = false): Promise<Response> {
	const headers = new Headers(asset.headers);
	headers.set("accept-ranges", "bytes");
	const m = /^bytes=(\d*)-(\d*)$/.exec(range?.trim() ?? "");
	if (asset.status !== 200 || !m || (m[1] === "" && m[2] === "")) return new Response(head ? null : asset.body, { status: asset.status, headers });
	let body = asset.body;
	let size = Number(asset.headers.get("content-length") ?? Number.NaN);
	if (!Number.isFinite(size) || !body) {
		const all = new Uint8Array(await asset.arrayBuffer());
		size = all.length;
		body = new Blob([all]).stream();
	}
	// "bytes=-500" is the last 500 bytes; "bytes=100-" runs to the end.
	const start = m[1] === "" ? Math.max(0, size - Number(m[2])) : Number(m[1]);
	const end = m[1] === "" || m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
	if (start >= size || start > end) {
		await body?.cancel();
		return new Response(null, { status: 416, headers: { "accept-ranges": "bytes", "content-range": `bytes */${size}` } });
	}
	headers.set("content-range", `bytes ${start}-${end}/${size}`);
	headers.set("content-length", String(end - start + 1));
	if (head) {
		await body?.cancel();
		return new Response(null, { status: 206, headers });
	}
	let pos = 0;
	const slice = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, out) {
			const from = Math.max(0, start - pos);
			const to = Math.min(chunk.length, end + 1 - pos);
			if (from < to) out.enqueue(chunk.subarray(from, to));
			pos += chunk.length;
			if (pos > end) out.terminate();
		},
	});
	const sliced = body.pipeThrough(slice);
	// On Workers a streamed body loses its Content-Length unless it runs through a FixedLengthStream.
	const fixed = typeof FixedLengthStream === "function" ? sliced.pipeThrough(new FixedLengthStream(end - start + 1)) : sliced;
	return new Response(fixed, { status: 206, headers });
}
