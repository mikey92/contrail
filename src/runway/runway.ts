// Runway: the only writer of a project's trunk.
//
// One Runway Durable Object per project keeps a warm in-memory clone of the trunk Artifacts repo.
// Landings arrive in batches ("trains") from the Tower. For each landing the Runway fetches the
// flight's workspace fork, three-way merges it onto the current trunk tip and commits it as one
// squashed, attributed commit with the flight's contrail attached as a git note. The train's
// merged tree is tested in a Dynamic Worker (a failing train is replayed landing by landing), and
// the whole train is pushed to trunk in a single push.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { extractSymbols } from "../git/symbols";
import { targetsOverlap } from "../tower/clearance";
import type { ConflictReport, FileChange, TestReport, TrunkFile } from "../shared/types";
import { errorMessage } from "../util";
import {
	addNote,
	cloneMain,
	commit,
	commitTreeOid,
	fetchFork,
	type FlatTree,
	fetchMain,
	fetchNotes,
	listTree,
	log,
	mergeBase,
	newRepo,
	type Person,
	pushMain,
	pushNotes,
	readNote,
	readText,
	type Repo,
	seed,
	setMain,
	writeFlatTree,
} from "./gitops";
import { describeChanges, mergeTrees } from "./treemerge";
import { verifyTree } from "./verify";

export interface LandingJob {
	landingId: string;
	flightId: string;
	/** Artifacts repo name of the flight's workspace fork. */
	repo: string;
	message: string;
	author: Person;
	note: Record<string, unknown>;
	/** Targets the project's policy reserves for a human; touching one parks the landing for review. */
	review?: string[];
	/** A human approved this landing. */
	approved?: boolean;
}

export interface LandingOutcome {
	landingId: string;
	status: "landed" | "conflict" | "failed" | "review";
	/** For "review": the protected targets the change touches. */
	reviewRequired?: string[];
	forkHead: string | null;
	base: string | null;
	trunkBefore: string;
	trunkAfter: string | null;
	changes: FileChange[];
	conflicts: ConflictReport[];
	tests: TestReport | null;
	unioned: number;
	error: string | null;
	ms: number;
}

export interface BatchResult {
	outcomes: LandingOutcome[];
	head: string;
	trunk: TrunkFile[] | null;
}

interface TrainOptions {
	retry: number;
	/** Replaying a train whose combined test run failed: test every landing on its own. */
	oneByOne: boolean;
	/** Fork heads already fetched in this train, by landing id. */
	heads: Map<string, string>;
}

/** The protected targets (from the project's review policy) that a change touches. */
function reviewRequired(policy: string[], changes: FileChange[]): string[] {
	if (!policy.length) return [];
	const touched = changes.flatMap((c) => (c.symbols.length ? c.symbols.map((sym) => `${c.path}#${sym}`) : [c.path]));
	return policy.filter((p) => touched.some((t) => targetsOverlap(p, t)));
}

function failTests(outcome: LandingOutcome, tests: TestReport) {
	outcome.status = "failed";
	outcome.tests = tests;
	outcome.error = tests.error ? `test suite failed to load: ${tests.error}` : `${tests.failed} test(s) failed`;
}

const MAX_SUMMARY_FILE_BYTES = 256 * 1024;
const MAX_REPO_BYTES = 64 * 1024 * 1024;

export class Runway extends DurableObject<Env> {
	private repo: Repo | null = null;
	private trunkName: string | null = null;
	private remote: string | null = null;
	private token: { value: string; expires: number } | null = null;
	private queue: Promise<unknown> = Promise.resolve();
	private symbolCache = new Map<string, TrunkFile["symbols"]>();
	private lineCache = new Map<string, number>();

	/** Serializes all git work on the in-memory clone. */
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => {});
		return run;
	}

	private async trunkToken(trunk: string): Promise<string> {
		if (this.token && this.token.expires - Date.now() > 5 * 60_000 && this.trunkName === trunk) return this.token.value;
		const repo = await this.env.ARTIFACTS.get(trunk);
		try {
			if (!this.remote || this.trunkName !== trunk) this.remote = (await repo.info()).remote;
			const t = await repo.createToken("write", 3600);
			this.token = { value: t.plaintext, expires: Date.parse(t.expiresAt) };
			return t.plaintext;
		} finally {
			repo[Symbol.dispose]?.();
		}
	}

	private async forkReadToken(name: string): Promise<{ token: string; remote: string }> {
		const repo = await this.env.ARTIFACTS.get(name);
		try {
			const [info, t] = await Promise.all([repo.info(), repo.createToken("read", 600)]);
			return { token: t.plaintext, remote: info.remote };
		} finally {
			repo[Symbol.dispose]?.();
		}
	}

	/** Ensures a warm clone of `trunk` and returns its current tip. */
	private async sync(trunk: string): Promise<string> {
		const token = await this.trunkToken(trunk);
		if (this.repo && this.trunkName === trunk && this.repo.fs.byteSize < MAX_REPO_BYTES) {
			const head = await fetchMain(this.repo, token);
			await setMain(this.repo, head);
			return head;
		}
		this.repo = newRepo();
		this.trunkName = trunk;
		const head = await cloneMain(this.repo, this.remote!, token);
		await fetchNotes(this.repo, token);
		return head;
	}

	async seedTrunk(trunk: string, files: Record<string, string>, message: string): Promise<string> {
		return this.exclusive(async () => {
			const repo = await this.env.ARTIFACTS.get(trunk);
			try {
				const [info, t] = await Promise.all([repo.info(), repo.createToken("write", 600)]);
				return await seed(info.remote, t.plaintext, files, message, { name: "Contrail", email: "tower@contrail.dev" });
			} finally {
				repo[Symbol.dispose]?.();
			}
		});
	}

	async land(trunk: string, jobs: LandingJob[]): Promise<BatchResult> {
		return this.exclusive(() => this.landTrain(trunk, jobs, { retry: 0, oneByOne: false, heads: new Map() }));
	}

	/**
	 * Each landing in a train is merged onto the tip left by the one before it, and the train's final
	 * tree is tested once, like a merge queue. If that run fails, the train is replayed one landing at a
	 * time so only the culprit is turned away. Landings that need a human review are tested on their own.
	 */
	private async landTrain(trunk: string, jobs: LandingJob[], opts: TrainOptions): Promise<BatchResult> {
		const before = this.repo;
		const start = await this.sync(trunk);
		const r = this.repo!;
		// Fetched fork heads are reused by a replay, unless the clone was replaced.
		if (r !== before) opts.heads.clear();
		let tip = start;
		let tipFiles: FlatTree | null = null;
		const outcomes: LandingOutcome[] = [];
		const boarded: { job: LandingJob; outcome: LandingOutcome; head: string }[] = [];
		// Exactly-once: a train interrupted after its push (deploy, eviction) is replayed by the Tower.
		// Landings already on trunk are recognised by their Contrail-Landing trailer, not merged again.
		const onTrunk = new Map<string, { oid: string; parent: string }>();
		for (const c of await log(r, start, 300)) {
			const id = c.commit.message.match(/^Contrail-Landing: (\S+)$/m)?.[1];
			if (id) onTrunk.set(id, { oid: c.oid, parent: c.commit.parent[0] });
		}

		for (const job of jobs) {
			const t0 = Date.now();
			const already = onTrunk.get(job.landingId);
			if (already) {
				outcomes.push({
					landingId: job.landingId,
					status: "landed",
					forkHead: null,
					base: already.parent,
					trunkBefore: already.parent,
					trunkAfter: already.oid,
					changes: await describeChanges(r, await listTree(r, already.parent), await listTree(r, already.oid)),
					conflicts: [],
					tests: null,
					unioned: 0,
					error: null,
					ms: Date.now() - t0,
				});
				continue;
			}
			const outcome: LandingOutcome = {
				landingId: job.landingId,
				status: "failed",
				forkHead: null,
				base: null,
				trunkBefore: tip,
				trunkAfter: null,
				changes: [],
				conflicts: [],
				tests: null,
				unioned: 0,
				error: null,
				ms: 0,
			};
			try {
				let head = opts.heads.get(job.landingId);
				if (!head) {
					const fork = await this.forkReadToken(job.repo);
					head = await fetchFork(r, job.repo, fork.remote, fork.token);
					opts.heads.set(job.landingId, head);
				}
				outcome.forkHead = head;
				const base = await mergeBase(r, tip, head);
				outcome.base = base;
				if (!base) throw new Error("workspace shares no history with trunk");
				if (base === head) throw new Error("nothing to land: the workspace has no commits beyond trunk");

				const merged = await mergeTrees(r, base, tip, head);
				outcome.changes = merged.changes;
				outcome.unioned = merged.unioned;
				if (merged.changes.length === 0) throw new Error("nothing to land: the workspace makes no changes");
				if (merged.conflicts.length > 0) {
					outcome.status = "conflict";
					outcome.conflicts = merged.conflicts;
					continue;
				}

				const tree = await writeFlatTree(r, merged.files);
				if (tree === (await commitTreeOid(r, tip))) throw new Error("nothing to land: trunk already contains these changes");

				const required = job.approved ? [] : reviewRequired(job.review ?? [], merged.changes);
				if (required.length || opts.oneByOne) {
					outcome.tests = await this.test(r, tree, merged.files);
					if (outcome.tests.failed > 0) {
						failTests(outcome, outcome.tests);
						continue;
					}
				}
				if (required.length) {
					outcome.status = "review";
					outcome.reviewRequired = required;
					continue;
				}

				const landed = await commit(r, { tree, parents: [tip], message: job.message, author: job.author });
				outcome.status = "landed";
				outcome.trunkAfter = landed;
				tip = landed;
				tipFiles = merged.files;
				boarded.push({ job, outcome, head });
			} catch (err) {
				outcome.status = "failed";
				outcome.error = errorMessage(err);
			} finally {
				outcome.ms = Date.now() - t0;
				outcomes.push(outcome);
			}
		}

		if (!opts.oneByOne && boarded.length > 0) {
			const report = await this.test(r, await commitTreeOid(r, tip), tipFiles!).catch(
				(err): TestReport => ({ passed: 0, failed: 1, results: [], error: errorMessage(err), ms: 0 }),
			);
			if (report.failed > 0) {
				if (boarded.length > 1) return this.landTrain(trunk, jobs, { ...opts, oneByOne: true });
				// A train of one: that landing is the culprit.
				failTests(boarded[0].outcome, report);
				boarded[0].outcome.trunkAfter = null;
				boarded.length = 0;
				tip = start;
			} else {
				for (const b of boarded) b.outcome.tests = boarded.length > 1 ? { ...report, train: boarded.length } : report;
			}
		}

		for (const { job, outcome, head } of boarded) {
			const tests = outcome.tests && { passed: outcome.tests.passed, failed: outcome.tests.failed, train: outcome.tests.train };
			await addNote(r, outcome.trunkAfter!, JSON.stringify({ ...job.note, forkHead: head, changes: outcome.changes, tests }, null, 2));
		}

		if (tip !== start) {
			const token = await this.trunkToken(trunk);
			await setMain(r, tip);
			try {
				await pushMain(r, token);
			} catch (err) {
				// Someone else moved trunk underneath us: drop the clone and replay the train once.
				this.repo = null;
				if (opts.retry < 1) return this.landTrain(trunk, jobs, { ...opts, retry: opts.retry + 1, heads: new Map() });
				throw err;
			}
			await pushNotes(r, token).catch(() => {});
		}
		return { outcomes, head: tip, trunk: tip !== start || opts.retry > 0 ? await this.summarize(tip) : null };
	}

	/** Runs the test suite of `tree` in a Dynamic Worker. */
	private async test(r: Repo, tree: string, files: FlatTree): Promise<TestReport> {
		const texts = new Map<string, string>();
		for (const [path, item] of files) {
			if (!/\.(m?js|cjs|json)$/.test(path)) continue;
			const text = await readText(r, item.oid);
			if (text !== null) texts.set(path, text);
		}
		return verifyTree(this.env.LOADER, tree, texts);
	}

	/** File list with line counts and symbols for the Radar's codebase map. */
	async trunkFiles(trunk: string): Promise<{ head: string; files: TrunkFile[] }> {
		return this.exclusive(async () => {
			const head = await this.sync(trunk);
			return { head, files: await this.summarize(head) };
		});
	}

	private async summarize(commitOid: string): Promise<TrunkFile[]> {
		const r = this.repo!;
		const files: TrunkFile[] = [];
		for (const [path, item] of await listTree(r, commitOid)) {
			let lines = this.lineCache.get(item.oid);
			let symbols = this.symbolCache.get(item.oid);
			if (lines === undefined || symbols === undefined) {
				const text = await readText(r, item.oid);
				if (text === null || text.length > MAX_SUMMARY_FILE_BYTES) {
					lines = 0;
					symbols = [];
				} else {
					lines = text.split("\n").length;
					symbols = extractSymbols(path, text).map((s) => ({ name: s.name, kind: s.kind, start: s.start, end: s.end }));
				}
				this.lineCache.set(item.oid, lines);
				this.symbolCache.set(item.oid, symbols);
			}
			files.push({ path, lines, symbols });
		}
		return files.sort((a, b) => a.path.localeCompare(b.path));
	}

	async reset() {
		this.repo = null;
		this.trunkName = null;
		this.remote = null;
		this.token = null;
		await this.ctx.storage.deleteAll();
	}

	/** Contrail note attached to a trunk commit, if any. */
	async note(trunk: string, oid: string): Promise<string | null> {
		return this.exclusive(async () => {
			await this.sync(trunk);
			return readNote(this.repo!, oid);
		});
	}
}
