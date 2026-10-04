import { useEffect, useState } from "preact/hooks";
import { Command } from "./Detail";

const MODELS = [
	["@cf/zai-org/glm-5.3-flash", "GLM-5.3 Flash (fast, cheap)"],
	["@cf/moonshotai/kimi-k2.7-code", "Kimi K2.7 Code"],
	["@cf/openai/gpt-oss-120b", "gpt-oss-120b"],
	["@cf/deepseek-ai/deepseek-v4-flash-0731", "DeepSeek V4 Flash"],
];

function storedKey(): string {
	try {
		return localStorage.getItem("contrail-admin") ?? "";
	} catch {
		return "";
	}
}

export function OperatorPanel({ slug, onClose }: { slug: string; onClose: () => void }) {
	const [key, setKey] = useState(storedKey());
	const [count, setCount] = useState(4);
	const [model, setModel] = useState(MODELS[0][0]);
	const [load, setLoad] = useState(40);
	const [intentTitle, setIntentTitle] = useState("");
	const [intentBody, setIntentBody] = useState("");
	const [msg, setMsg] = useState<string | null>(null);

	const call = async (path: string, body: unknown) => {
		try {
			localStorage.setItem("contrail-admin", key);
		} catch {
			// private mode
		}
		setMsg("…");
		const res = await fetch(`/api/p/${slug}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
		const json = await res.json().catch(() => ({}));
		setMsg(res.ok ? "Done." : `Error: ${json.error ?? res.status}`);
		return json;
	};

	return (
		<div class="why-backdrop" onClick={onClose}>
			<div class="why operator" onClick={(e) => e.stopPropagation()}>
				<button class="close" onClick={onClose}>
					×
				</button>
				<div class="why-kicker">Operator</div>
				<h3>Control tower</h3>
				<label class="field">
					<span>Admin key</span>
					<input type="password" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} placeholder="contrail admin key" />
				</label>
				<section class="op">
					<h4>Edge agents on Workers AI</h4>
					<p class="muted">Coding agents that live in Durable Objects: Artifacts workspace, tests in Dynamic Workers, reasoning on Workers AI.</p>
					<div class="row">
						<input type="number" min={1} max={20} value={count} onInput={(e) => setCount(Number((e.target as HTMLInputElement).value))} />
						<select value={model} onChange={(e) => setModel((e.target as HTMLSelectElement).value)}>
							{MODELS.map(([v, l]) => (
								<option key={v} value={v}>
									{l}
								</option>
							))}
						</select>
						<button class="btn" onClick={() => call("/edge/launch", { count, model, maxFlights: 4 })}>
							Launch
						</button>
					</div>
				</section>
				<section class="op">
					<h4>Load test</h4>
					<p class="muted">Scripted agents (no LLM) for intents that carry a machine-readable script.</p>
					<div class="row">
						<input type="number" min={1} max={300} value={load} onInput={(e) => setLoad(Number((e.target as HTMLInputElement).value))} />
						<button class="btn" onClick={() => call("/edge/launch", { count: load, mode: "scripted", maxFlights: 10 })}>
							Launch scripted agents
						</button>
						<button class="btn ghost" onClick={() => call("/edge/stop", {})}>
							Stop all edge agents
						</button>
					</div>
				</section>
				<section class="op">
					<h4>File an intent</h4>
					<input class="wide" value={intentTitle} onInput={(e) => setIntentTitle((e.target as HTMLInputElement).value)} placeholder="Imperative title" />
					<textarea value={intentBody} onInput={(e) => setIntentBody((e.target as HTMLTextAreaElement).value)} placeholder="Details and acceptance criteria" />
					<button class="btn" disabled={!intentTitle} onClick={() => call("/intents", { intents: [{ title: intentTitle, body: intentBody, priority: 5 }] }).then(() => setIntentTitle(""))}>
						File intent
					</button>
				</section>
				{msg && <div class="op-msg mono">{msg}</div>}
			</div>
		</div>
	);
}

export function ClonePanel({ slug, onClose }: { slug: string; onClose: () => void }) {
	const [cmds, setCmds] = useState<string[] | null>(null);
	const [err, setErr] = useState<string | null>(null);
	// Once per opening: the radar re-renders with every update, and a render must not ask again.
	useEffect(() => {
		fetch(`/api/p/${slug}/clone`)
			.then((r) => r.json())
			.then((d) => (d.commands ? setCmds(d.commands) : setErr(d.error ?? "unavailable")))
			.catch((e) => setErr(String(e)));
	}, [slug]);
	return (
		<div class="why-backdrop" onClick={onClose}>
			<div class="why connect" onClick={(e) => e.stopPropagation()}>
				<button class="close" onClick={onClose}>
					×
				</button>
				<div class="why-kicker">Trunk</div>
				<h3>Clone trunk with its contrail</h3>
				<p>Trunk is an Artifacts repo. Every landed commit carries its flight's intent, plan, decisions and evidence as a git note in refs/notes/contrail. This read-only URL is valid for an hour.</p>
				{err && <div class="muted">{err}</div>}
				{cmds && <Command text={cmds.join("\n")} />}
			</div>
		</div>
	);
}
