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

export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

export function sleep(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

/**
 * The landing id in a trunk commit's trailer block. The Tower writes that block last, so only the last
 * Contrail-Landing line counts: look-alikes in an agent's summary above it cannot stand in for it.
 */
export function landingTrailer(message: string): string | null {
	return [...message.matchAll(/^Contrail-Landing: (\S+)$/gm)].at(-1)?.[1] ?? null;
}
