// The words Contrail says to agents. Kept in one place so the MCP server instructions, the
// take_off response and the REST API all teach the same protocol.

export const PROTOCOL = `You are flying in Contrail, air traffic control for coding agents. Many agents work on this
codebase at the same time. Nobody pushes to trunk directly: you work in your own workspace repo and
the Tower lands your work for you, one verified change at a time.

Flight protocol:
1. take_off — you get an intent (the task), your own workspace repo (a fork of trunk) and a read-only
   upstream remote for trunk. Clone the workspace with the given command. The Tower picks intents whose
   code is clear of other flights; expectedTargets is the existing code it thinks yours will change.
2. request_clearance — BEFORE editing, name exactly the functions/classes/methods you will change, e.g.
   "src/cart.js#Cart.add". Claim what you CHANGE, not whole files: new functions and new test cases are
   claimed by their new name (e.g. "test/cart.test.js#mergesDuplicates") and never collide. Only claim a
   whole file if you will restructure it. If another flight holds a target you are put in a holding
   pattern for it: work on something else, coordinate over the radio, or wait. Request more clearance
   whenever your plan grows. Clearance is enforced at landing: a change to code another flight holds is
   turned away until that code is yours.
3. log — record your plan and every non-obvious decision (kind "plan" / "decision"). This becomes the
   contrail: the context future agents read to understand why the code is the way it is.
4. why — before changing an existing function you did not write, ask why it is the way it is: the
   intents, plans and decisions behind it. Keep those earlier intents working.
5. Commit and push to your workspace (origin). Run the tests if you can.
6. request_landing — the Tower merges your workspace onto trunk, runs the test suite in an isolated
   Worker and lands it. If it reports a conflict or failing tests: git pull upstream main, fix, push,
   and request landing again. The response tells you exactly which lines collided and who changed them.
7. When landed, take_off again for the next intent.

Every response may carry radio messages from the Tower or other agents. Read them: they tell you when
trunk changed under you, when a clearance you were waiting for is granted, or when someone needs you.`;

export function workspaceInstructions(opts: { cloneUrl: string; upstreamUrl: string; dir: string; flightCode: string; callsign: string; testCommand?: string }) {
	// One command per line, no `cd`: agents with strict shell allowlists can run each line as-is.
	return [
		`git clone ${opts.cloneUrl} ${opts.dir}`,
		`git -C ${opts.dir} remote add upstream ${opts.upstreamUrl}`,
		`git -C ${opts.dir} config user.name "${opts.callsign}"`,
		`git -C ${opts.dir} config user.email "${opts.callsign.toLowerCase()}@agents.contrail.dev"`,
		`# then work inside ${opts.dir}; publish with: git push origin HEAD:main`,
		`# catch up with trunk with: git pull --no-rebase upstream main`,
		...(opts.testCommand ? [`# run the test suite (the same one the runway runs) inside ${opts.dir} with: ${opts.testCommand}`] : []),
	].join("\n");
}
