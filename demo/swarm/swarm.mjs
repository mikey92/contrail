#!/usr/bin/env node
// Launches a swarm of real coding agents (Claude Code and/or Codex, headless) into a Contrail project.
//
//   CONTRAIL_URL=https://… CONTRAIL_ADMIN_KEY=… node demo/swarm/swarm.mjs <slug> [--claude N] [--codex N]
//       [--model sonnet] [--codex-model gpt-5-codex] [--stagger 4] [--dir ~/contrail-swarm]
//
// Each agent joins with its own callsign and key, gets a private working directory and an MCP config
// pointing at the project's Contrail tower, and is told to keep taking off and landing intents until
// none are left. Logs: <dir>/<run>/<CALLSIGN>.jsonl (raw) and <CALLSIGN>.log (readable).
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const slug = args[0];
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const base = process.env.CONTRAIL_URL;
const admin = process.env.CONTRAIL_ADMIN_KEY;
const joinCode = process.env.CONTRAIL_JOIN_CODE;
if (!slug || !base || !(admin || joinCode)) {
  console.error("usage: CONTRAIL_URL=… CONTRAIL_ADMIN_KEY=… node demo/swarm/swarm.mjs <slug> [--claude N] [--codex N]");
  process.exit(2);
}
const nClaude = Number(opt("claude", 3));
const nCodex = Number(opt("codex", 0));
const claudeModels = String(opt("model", "sonnet")).split(",");
const codexModel = opt("codex-model", null);
const stagger = Number(opt("stagger", 4)) * 1000;
const root = opt("dir", join(homedir(), "contrail-swarm"));
const run = join(root, `${slug}-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`);
mkdirSync(run, { recursive: true });
const prompt = readFileSync(join(here, "prompt.md"), "utf8");
// Agents get a private global git config: tool state directories never end up in commits.
writeFileSync(join(run, "gitignore"), [".omc/", ".claude/", ".codex/", ".DS_Store", "node_modules/", ".mcp.json"].join("\n") + "\n");
writeFileSync(join(run, "gitconfig"), `[core]\n\texcludesFile = ${join(run, "gitignore")}\n[pull]\n\trebase = false\n[init]\n\tdefaultBranch = main\n`);

async function join_(kind, model) {
  const res = await fetch(`${base}/api/p/${slug}/join`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${admin}` } : {}) },
    body: JSON.stringify({ kind, model, joinCode }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`join failed: ${JSON.stringify(body)}`);
  return body;
}

const redact = (s) => s.replace(/x:[^@\s"]+@/g, "x:***@").replace(/art_v\d+_[A-Za-z0-9_]+/g, "art_***");

/** Turns stream-json / codex json lines into a short readable log (with credentials redacted). */
function readable(kind, line) {
  return redact(readableRaw(kind, line));
}

function readableRaw(kind, line) {
  try {
    const m = JSON.parse(line);
    if (kind === "claude-code") {
      if (m.type === "assistant") {
        return (m.message?.content ?? [])
          .map((c) => (c.type === "text" ? `💬 ${c.text}` : c.type === "tool_use" ? `🔧 ${c.name} ${JSON.stringify(c.input).slice(0, 300)}` : ""))
          .filter(Boolean)
          .join("\n");
      }
      if (m.type === "result") return `🏁 ${m.subtype} · ${m.num_turns} turns · $${m.total_cost_usd?.toFixed?.(2) ?? "?"} · ${m.result?.slice?.(0, 300) ?? ""}`;
      return "";
    }
    if (m.type === "item.started") return ""; // codex reports each item twice; log completions only
    const item = m.item ?? m.msg ?? m;
    if (item?.type === "agent_message" || item?.type === "assistant_message") return `💬 ${item.text ?? item.message ?? ""}`;
    if (item?.type === "mcp_tool_call") return `🔧 ${item.server}.${item.tool} ${JSON.stringify(item.arguments ?? {}).slice(0, 300)}`;
    if (item?.type === "command_execution") return `$ ${item.command}`;
    return "";
  } catch {
    return line.slice(0, 300);
  }
}

function launch({ kind, model, callsign, key }) {
  const dir = join(run, callsign);
  mkdirSync(dir, { recursive: true });
  const mcpUrl = `${base}/mcp/${slug}`;
  const text = prompt.replaceAll("{{CALLSIGN}}", callsign);
  let cmd;
  let cmdArgs;
  const env = { ...process.env, CONTRAIL_KEY: key, GIT_CONFIG_GLOBAL: join(run, "gitconfig") };
  if (kind === "claude-code") {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { contrail: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${key}` } } } }, null, 2));
    cmd = "claude";
    cmdArgs = [
      "-p",
      text,
      "--mcp-config",
      join(dir, ".mcp.json"),
      "--strict-mcp-config",
      "--setting-sources",
      "project,local",
      "--model",
      model,
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "mcp__contrail",
      "Bash(git:*)",
      "Bash(node:*)",
      "Bash(npm test:*)",
      "Bash(npm run test:*)",
      "Bash(ls:*)",
      "Bash(cat:*)",
      "Bash(cd:*)",
      "Bash(pwd)",
      "Bash(sleep:*)",
      "Bash(mkdir:*)",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "--disallowedTools",
      "WebFetch",
      "WebSearch",
      "--output-format",
      "stream-json",
      "--verbose",
      "--max-turns",
      "400",
    ];
  } else {
    cmd = "codex";
    cmdArgs = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "--ignore-user-config",
      "-C",
      dir,
      "-s",
      "workspace-write",
      "-c",
      "sandbox_workspace_write.network_access=true",
      "-c",
      'approval_policy="never"',
      "-c",
      `mcp_servers.contrail.url="${mcpUrl}"`,
      "-c",
      'mcp_servers.contrail.bearer_token_env_var="CONTRAIL_KEY"',
      "-c",
      'mcp_servers.contrail.default_tools_approval_mode="approve"',
      ...(model ? ["-m", model] : []),
      text,
    ];
  }
  const raw = createWriteStream(join(dir, "..", `${callsign}.jsonl`));
  const log = createWriteStream(join(dir, "..", `${callsign}.log`));
  const child = spawn(cmd, cmdArgs, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "";
  child.stdout.on("data", (chunk) => {
    raw.write(chunk);
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const r = readable(kind, line);
      if (r) log.write(`${new Date().toISOString().slice(11, 19)} ${r}\n`);
    }
  });
  child.stderr.on("data", (chunk) => log.write(`stderr: ${redact(chunk.toString())}`));
  return new Promise((resolve) => child.on("close", (code) => (raw.end(), log.end(), resolve({ callsign, code }))));
}

const roster = [
  ...Array.from({ length: nClaude }, (_, i) => ({ kind: "claude-code", model: claudeModels[i % claudeModels.length] })),
  ...Array.from({ length: nCodex }, () => ({ kind: "codex", model: codexModel })),
];
console.log(`launching ${roster.length} agents into ${base}/p/${slug} — logs in ${run}`);
const runs = [];
for (const r of roster) {
  const joined = await join_(r.kind, r.kind === "claude-code" ? `claude-${r.model}` : (r.model ?? "codex"));
  console.log(`  ${joined.agent.callsign} (${r.kind}${r.model ? ` ${r.model}` : ""})`);
  runs.push(launch({ ...r, callsign: joined.agent.callsign, key: joined.key }));
  await new Promise((res) => setTimeout(res, stagger));
}
const results = await Promise.all(runs);
for (const r of results) console.log(`  ${r.callsign} exited ${r.code}`);
