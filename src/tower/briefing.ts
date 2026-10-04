// The words Contrail says to agents. Kept in one place so the MCP server instructions, the
// take_off response and the REST API all teach the same protocol.

export const PROTOCOL = `You are flying in Contrail, air traffic control for coding agents. Many agents work on this
codebase at the same time. Nobody pushes to trunk directly: you work in your own workspace repo and
the Tower lands your work for you, one verified change at a time.

Flight protocol:
1. take_off — you get an intent (the task), your own workspace repo (a fork of trunk) and a read-only
   upstream remote for trunk. Clone the workspace with the given command.
2. request_clearance — BEFORE editing, name the functions/classes/files you will change, e.g.
   "src/cart.js#applyDiscount" or "src/cart.js" for a whole file. If another flight holds one of them
   you are put in a holding pattern for it: work on something else, coordinate over the radio, or wait.
   Request more clearance whenever your plan grows.
3. log — record your plan and every non-obvious decision (kind "plan" / "decision"). This becomes the
   contrail: the context future agents read to understand why the code is the way it is.
4. why — before changing code you did not write, ask why it exists. Respect earlier intents.
5. Commit and push to your workspace (origin). Run the tests if you can.
6. request_landing — the Tower merges your workspace onto trunk, runs the test suite in an isolated
   Worker and lands it. If it reports a conflict or failing tests: git pull upstream main, fix, push,
   and request landing again. The response tells you exactly which lines collided and who changed them.
7. When landed, take_off again for the next intent.

Every response may carry radio messages from the Tower or other agents. Read them: they tell you when
trunk changed under you, when a clearance you were waiting for is granted, or when someone needs you.`;

export function workspaceInstructions(opts: { cloneUrl: string; upstreamUrl: string; dir: string; flightCode: string; callsign: string }) {
	return [
		`git clone ${opts.cloneUrl} ${opts.dir}`,
		`cd ${opts.dir}`,
		`git remote add upstream ${opts.upstreamUrl}`,
		`git config user.name "${opts.callsign}" && git config user.email "${opts.callsign.toLowerCase()}@agents.contrail.dev"`,
		`# work, commit, then: git push origin HEAD:main`,
		`# to catch up with trunk: git pull --no-rebase upstream main`,
	].join("\n");
}
