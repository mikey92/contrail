// Runway: the only writer of a project's trunk.
//
// One Runway Durable Object per project keeps a warm in-memory clone of the trunk Artifacts repo.
// Landings arrive in batches ("trains") from the Tower. For each landing the Runway fetches the
// flight's workspace fork, three-way merges it onto the current trunk tip and commits it as one
// squashed, attributed commit with the flight's contrail attached as a git note. The train's
// merged tree is tested in a Dynamic Worker (a failing train is replayed landing by landing), and
// the whole train is pushed to trunk in a single push. When the project's policy asks for it, a model from
// another family than the agent's reviews each landing's change against its intent while the train merges.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import { extractSymbols } from "../git/symbols";
import { airspaceViolations, type HeldByOther, policyTargetsTouched } from "../tower/clearance";
import type { AiReview, ConflictReport, FileChange, TestReport, TrunkFile } from "../shared/types";
import { errorMessage, flightTrailer, landingTrailer, retryTransient } from "../util";
import {
	addNote,
	cloneMain,
	commit,
	commitTreeOid,
	fetchFork,
	fetchMain,
	fetchNotes,
	type FlatTree,
	listTree,
	log,
	mergeBase,
	newRepo,
	type Person,
	pushMain,
	pushNotes,
	readItemText,
	readText,
	type Repo,
	seed,
	setMain,
	writeFlatTree,
} from "./gitops";
import { type ReviewInput, reviewChange } from "./review";
import { describeChanges, mergeTrees } from "./treemerge";
import { CONFIG_FILE, type TestConfig, testConfig, testFiles, verifyTree } from "./verify";

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
	/** The Workers AI model that reviews the change against its intent; a flag parks the landing for a person. */
	reviewer?: string;
	/** Code other flights are cleared to change right now. Landing a change to it is an airspace violation. */
	heldByOthers?: HeldByOther[];
	/** The workspace commit a human approved. Commits pushed after it need their own review. */
	approvedHead?: string;
	/** A sector's directory: a change outside it would never reach the monorepo, so it doesn't land. */
	prefix?: string;
	/** The flight's code and when it took off: a change of its already on trunk under an earlier landing id is its landing. */
	flight?: { code: string; since: number };
}

export interface LandingOutcome {
	landingId: string;
	status: "landed" | "conflict" | "failed" | "review";
	/** For "review": the protected targets the change touches. */
	reviewRequired?: string[];
	/** The AI reviewer's verdict, when the job asked for one. */
	aiReview?: AiReview;
	/** For "failed": code this landing changed that other flights are cleared to change. */
	violations?: HeldByOther[];
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
	/** AI reviews under way or done, by landing id and fork head: a replayed train doesn't ask twice. */
	reviews: Map<string, Promise<AiReview>>;
	/**
	 * A crossing's phase one: called with the outcomes once the train is merged and green, before
	 * anything is pushed. Resolves true to push (phase two), false to leave trunk as it was.
	 */
	hold?: (outcomes: LandingOutcome[]) => Promise<boolean>;
}

/** The protected targets (from the project's review policy) that a change touches. */
function reviewRequired(policy: string[], changes: FileChange[]): string[] {
	// The test gate's own configuration is always a human's call: it decides what every later landing must pass.
	const gate = changes.some((c) => c.path === CONFIG_FILE) ? [CONFIG_FILE] : [];
	return [...gate, ...policyTargetsTouched(policy, changes)];
}

function failTests(outcome: LandingOutcome, tests: TestReport) {
	outcome.status = "failed";
	outcome.tests = tests;
	outcome.error = tests.error ? `test suite failed to load: ${tests.error}` : `${tests.failed} test${tests.failed === 1 ? "" : "s"} failed`;
}

interface Gate {
	config: TestConfig;
	tests: number;
	/** The trunk commit it was read from. */
	commit: string;
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
	/** A crossing's landing that is merged and green and waits for decide(); the runway is held meanwhile. */
	private held: { landingId: string; decide: (commit: boolean) => void; result: Promise<BatchResult> } | null = null;

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
			try {
				const head = await fetchMain(this.repo, token);
				await setMain(this.repo, head);
				return head;
			} catch (err) {
				this.repo = null; // start over from a clean clone next time
				throw err;
			}
		}
		// The clone is kept only once it is whole: a half-made one would pass for a warm clone next time.
		this.repo = null;
		const repo = newRepo();
		const head = await cloneMain(repo, this.remote!, token);
		await retryTransient(() => fetchNotes(repo, token));
		this.repo = repo;
		this.trunkName = trunk;
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
		return this.exclusive(() => this.landTrain(trunk, jobs, { retry: 0, oneByOne: false, heads: new Map(), reviews: new Map() }));
	}

	/**
	 * Phase one of a crossing (a change that lands in several sectors or in none): merges, checks and tests
	 * `job` like any landing, then stops short of the push and holds this runway, so trunk cannot move
	 * under it, until decide() or `holdMs`. Answers with the outcome: "landed" here means ready to land.
	 */
	async prepare(trunk: string, job: LandingJob, holdMs: number): Promise<LandingOutcome> {
		return new Promise<LandingOutcome>((answer, fail) => {
			let answered = false;
			let decision: Promise<boolean> | null = null;
			const result: Promise<BatchResult> = this.exclusive(() =>
				this.landTrain(trunk, [job], {
					retry: 0,
					oneByOne: false,
					heads: new Map(),
					reviews: new Map(),
					hold: (outcomes) => {
						// A train replayed after a failed push asks again: the decision stands.
						if (decision) return decision;
						answered = true;
						answer(outcomes[0]);
						decision = new Promise<boolean>((decide) => {
							const timer = setTimeout(() => {
								if (this.held?.landingId === job.landingId) this.held = null;
								decide(false);
							}, holdMs);
							this.held = {
								landingId: job.landingId,
								decide: (commit) => {
									clearTimeout(timer);
									decide(commit);
								},
								result,
							};
						});
						return decision;
					},
				}),
			);
			result.then(
				(r) => !answered && answer(r.outcomes[0]),
				(err) => !answered && fail(err),
			);
		});
	}

	/** Phase two of a crossing: pushes the prepared landing (or drops it) and returns the train's result. */
	async decide(landingId: string, commit: boolean): Promise<BatchResult | null> {
		const held = this.held;
		if (!held || held.landingId !== landingId) {
			if (!commit) return null;
			throw new Error("the prepared landing is gone (it waited too long, or the runway restarted)");
		}
		this.held = null;
		held.decide(commit);
		const result = await held.result;
		return commit ? result : null;
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
		const gate = await this.gate(r, start);
		let tip = start;
		let tipFiles: FlatTree | null = null;
		const outcomes: LandingOutcome[] = [];
		const boarded: { job: LandingJob; outcome: LandingOutcome; head: string }[] = [];
		// Exactly-once: a train interrupted after its push (deploy, eviction) is replayed by the Tower.
		// Landings already on trunk are recognised by their Contrail-Landing trailer, not merged again.
		const onTrunk = new Map<string, { oid: string; parent: string }>();
		// The latest landing of each flight, for a retry whose earlier landing was pushed but never reported.
		const byFlight = new Map<string, { oid: string; parent: string; at: number }>();
		for (const c of await log(r, start, 300)) {
			const id = landingTrailer(c.commit.message);
			if (id) onTrunk.set(id, { oid: c.oid, parent: c.commit.parent[0] });
			const flight = flightTrailer(c.commit.message);
			if (flight && !byFlight.has(flight)) byFlight.set(flight, { oid: c.oid, parent: c.commit.parent[0], at: c.commit.committer.timestamp * 1000 });
		}
		// Every review starts before the first merge, so a train waits for about one model call, not one per landing.
		for (const job of jobs) if (job.reviewer && !onTrunk.has(job.landingId)) await this.startReview(r, start, job, opts);

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
					// An Artifacts hiccup should not turn a landing away.
					head = await retryTransient(async () => {
						const fork = await this.forkReadToken(job.repo);
						return fetchFork(r, job.repo, fork.remote, fork.token);
					});
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
				const outside = job.prefix ? merged.changes.filter((c) => !c.path.startsWith(job.prefix!)) : [];
				if (outside.length)
					throw new Error(
						`this sector owns ${job.prefix} only, and ${outside.slice(0, 3).map((c) => c.path).join(", ")}${outside.length > 3 ? ` and ${outside.length - 3} more` : ""} ${outside.length > 1 ? "are" : "is"} outside it: change other sectors through the monorepo's Center (a crossing)`,
					);
				const violations = airspaceViolations(job.heldByOthers ?? [], merged.changes);
				if (violations.length) {
					outcome.violations = violations;
					throw new Error(
						`airspace violation: ${violations.map((v) => `${v.target} is cleared to ${v.flight} (${v.callsign})`).join("; ")}. Request clearance for it and land once it is yours`,
					);
				}
				if (merged.conflicts.length > 0) {
					outcome.status = "conflict";
					outcome.conflicts = merged.conflicts;
					continue;
				}

				const tree = await writeFlatTree(r, merged.files);
				if (tree === (await commitTreeOid(r, tip))) {
					// This flight landed it already, under a landing id the Tower never heard back about (a restart):
					// that commit is the answer. (Codes start over in a playground's next round, hence the time check.)
					const mine = job.flight ? byFlight.get(job.flight.code) : undefined;
					if (!mine || mine.at < job.flight!.since - 60_000) throw new Error("nothing to land: trunk already contains these changes");
					outcome.status = "landed";
					outcome.trunkBefore = mine.parent;
					outcome.trunkAfter = mine.oid;
					outcome.changes = await describeChanges(r, await listTree(r, mine.parent), await listTree(r, mine.oid));
					continue;
				}

				const required = job.approvedHead === head ? [] : reviewRequired(job.review ?? [], merged.changes);
				// A person's approval of this commit covers it; otherwise the AI reviewer's flag parks it for one.
				const review = job.approvedHead === head ? undefined : opts.reviews.get(`${job.landingId}@${head}`);
				if (review) outcome.aiReview = await review;
				const flagged = outcome.aiReview?.verdict === "flag";
				if (required.length || flagged || opts.oneByOne) {
					outcome.tests = await this.test(r, tree, merged.files, gate);
					if (outcome.tests.failed > 0 && required.length && !opts.oneByOne && tip !== start) {
						// Red on top of this train's other landings, which no test has passed yet: judge it on trunk as it was.
						const alone = await mergeTrees(r, (await mergeBase(r, start, head)) ?? base, start, head);
						if (alone.conflicts.length === 0) {
							const retest = await this.test(r, await writeFlatTree(r, alone.files), alone.files, gate);
							if (retest.failed === 0) outcome.tests = retest;
						}
					}
					if (outcome.tests.failed > 0) {
						failTests(outcome, outcome.tests);
						continue;
					}
				}
				if (required.length || flagged) {
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
			const report = await this.test(r, await commitTreeOid(r, tip), tipFiles!, gate).catch(
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

		// A crossing waits here, merged and green, until every sector it touches is ready too.
		if (tip !== start && opts.hold && !(await opts.hold(outcomes))) {
			for (const b of boarded) {
				b.outcome.status = "failed";
				b.outcome.trunkAfter = null;
				b.outcome.error = "held back: the crossing did not land in every sector";
			}
			return { outcomes, head: start, trunk: null };
		}

		for (const { job, outcome, head } of boarded) {
			const tests = outcome.tests && { passed: outcome.tests.passed, failed: outcome.tests.failed, train: outcome.tests.train };
			const aiReview = outcome.aiReview && { model: outcome.aiReview.model, verdict: outcome.aiReview.verdict, reason: outcome.aiReview.reason, concerns: outcome.aiReview.concerns };
			await addNote(r, outcome.trunkAfter!, JSON.stringify({ ...job.note, forkHead: head, changes: outcome.changes, tests, ...(aiReview ? { aiReview } : {}) }, null, 2));
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
			// Notes that trunk turned down (they don't build on its own) mean this clone's notes are stale: clone again next time.
			const notes = await pushNotes(r, token).catch(() => null);
			if (!notes?.ok) this.repo = null;
		}
		// A replayed train whose landings were all on trunk already still reports trunk: the Tower may not have heard.
		const moved = tip !== start || opts.retry > 0 || outcomes.some((o) => o.status === "landed");
		// From this clone `r`: a clone dropped above is still whole for reading what it pushed.
		return { outcomes, head: tip, trunk: moved ? await this.summarize(tip, r) : null };
	}

	/**
	 * Starts the AI review of `job`: its fork's own change since it left trunk, judged against its intent, plan and
	 * summary. Only the model call runs in the background; the git reads stay in line with the train's.
	 */
	private async startReview(r: Repo, start: string, job: LandingJob, opts: TrainOptions): Promise<void> {
		try {
			let head = opts.heads.get(job.landingId);
			if (!head) {
				head = await retryTransient(async () => {
					const fork = await this.forkReadToken(job.repo);
					return fetchFork(r, job.repo, fork.remote, fork.token);
				});
				opts.heads.set(job.landingId, head);
			}
			const key = `${job.landingId}@${head}`;
			if (job.approvedHead === head || opts.reviews.has(key)) return;
			const base = await mergeBase(r, start, head);
			if (!base || base === head) return;
			const changes = await describeChanges(r, await listTree(r, base), await listTree(r, head), 2);
			if (changes.length === 0) return;
			const note = job.note as { intent?: ReviewInput["intent"]; summary?: string; plan?: string | null; decisions?: string[] };
			const input: ReviewInput = {
				intent: note.intent ?? { seq: 0, title: job.message.split("\n")[0], body: "" },
				summary: note.summary ?? "",
				plan: note.plan ?? null,
				decisions: note.decisions ?? [],
				changes,
			};
			opts.reviews.set(key, reviewChange(this.env.AI, job.reviewer!, input));
		} catch {
			// The landing itself fetches again and reports what went wrong.
		}
	}

	/** Runs the test suite of `tree` in a Dynamic Worker. */
	private async test(r: Repo, tree: string, files: FlatTree, gate: Gate): Promise<TestReport> {
		const report = await verifyTree(this.env.LOADER, tree, await this.texts(r, files), gate.config, gate.tests > 0);
		// "No tests ran" holds a change to trunk's own standard: a trunk whose suite runs nothing either can't drop tests.
		if (report.error?.startsWith("no tests ran") && !(await this.trunkRunsTests(r, gate))) return { passed: 0, failed: 0, results: [], ms: report.ms };
		return report;
	}

	/** The JavaScript and JSON files of a tree as text, for the test runner. */
	private async texts(r: Repo, files: FlatTree): Promise<Map<string, string>> {
		const texts = new Map<string, string>();
		for (const [path, item] of files) {
			if (!/\.(m?js|cjs|json)$/.test(path)) continue;
			const text = await readItemText(r, item);
			if (text !== null) texts.set(path, text);
		}
		return texts;
	}

	/** Whether trunk's own suite (at the gate's commit) runs at least one test. */
	private async trunkRunsTests(r: Repo, gate: Gate): Promise<boolean> {
		const tree = await commitTreeOid(r, gate.commit);
		const report = await verifyTree(this.env.LOADER, tree, await this.texts(r, await listTree(r, gate.commit)), gate.config, false);
		return report.passed + report.failed > 0;
	}

	/** The test gate as trunk defines it: its contrail.json and how many test files it runs. */
	private async gate(r: Repo, commitOid: string): Promise<Gate> {
		const tree = await listTree(r, commitOid);
		const item = tree.get(CONFIG_FILE);
		const text = item ? await readText(r, item.oid) : null;
		const config = testConfig(new Map(text === null ? [] : [[CONFIG_FILE, text]]));
		return { config, tests: testFiles(config, tree.keys()).length, commit: commitOid };
	}

	/**
	 * Puts trunk's first tree back as a new commit on top of its history, so a playground can start over
	 * without rewriting anything. Returns the new head (or the current one if trunk is already there).
	 */
	async restoreFirstTree(trunk: string, message: string, author: Person, from: string | null = null): Promise<string> {
		return this.exclusive(async () => {
			const start = await this.sync(trunk);
			const r = this.repo!;
			// The commit the project started from (an import's head); trunk's first commit for projects older than that.
			let tree: string;
			if (from) tree = await commitTreeOid(r, from);
			else {
				const history = await log(r, start, 10_000);
				const first = history[history.length - 1];
				if (!first || first.commit.parent.length > 0) throw new Error("trunk's first commit is out of reach");
				tree = first.commit.tree;
			}
			if (tree === (await commitTreeOid(r, start))) return start;
			const head = await commit(r, { tree, parents: [start], message, author });
			await setMain(r, head);
			try {
				await pushMain(r, await this.trunkToken(trunk));
			} catch (err) {
				this.repo = null;
				throw err;
			}
			return head;
		});
	}

	/** File list with line counts and symbols for the Radar's codebase map. */
	async trunkFiles(trunk: string): Promise<{ head: string; files: TrunkFile[] }> {
		return this.exclusive(async () => {
			const head = await this.sync(trunk);
			return { head, files: await this.summarize(head) };
		});
	}

	private async summarize(commitOid: string, r: Repo = this.repo!): Promise<TrunkFile[]> {
		const files: TrunkFile[] = [];
		for (const [path, item] of await listTree(r, commitOid)) {
			let lines = this.lineCache.get(item.oid);
			let symbols = this.symbolCache.get(item.oid);
			if (lines === undefined || symbols === undefined) {
				const text = await readItemText(r, item);
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

}
