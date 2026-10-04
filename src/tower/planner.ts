// Flight planning. Before a flight takes off, the Tower predicts which code its intent will touch,
// from names in the intent's text that are written like code (R.clamp, Cart.add, subtotal(),
// formatMoney, TAX_RATES, `name`, src/a.js#fn), matched against trunk's symbol index. It then
// dispatches the open intents that stay clear of code already in the air. A prediction only orders
// the queue; clearances still decide who may edit what.
import type { TrunkFile } from "../shared/types";
import { targetsOverlap } from "./clearance";

const PLANNED_KINDS = new Set(["function", "class", "method", "const", "suite"]);
/** A name that matches more targets than this is too generic to predict anything. */
const MAX_MATCHES = 4;
const MAX_BODY_TARGETS = 8;
const EXPLICIT = /([\w./-]+\.\w+)#([A-Za-z_$][\w$.]*)/g;
const NAME = /`([^`]+)`|((?:[A-Za-z_]|\$(?=[A-Za-z_]))[\w$]*(?:\.[A-Za-z_$][\w$]*)*)(\s*\()?/g;

export interface SymbolIndex {
	paths: Set<string>;
	byName: Map<string, string[]>;
	/** Methods by their own name: "add" → src/cart.js#Cart.add. */
	byMember: Map<string, string[]>;
	classes: Set<string>;
}

export function symbolIndex(files: TrunkFile[]): SymbolIndex {
	const index: SymbolIndex = { paths: new Set(), byName: new Map(), byMember: new Map(), classes: new Set() };
	const add = (map: Map<string, string[]>, name: string, target: string) => {
		const list = map.get(name) ?? [];
		if (!list.includes(target)) list.push(target);
		map.set(name, list);
	};
	for (const f of files) {
		index.paths.add(f.path);
		for (const s of f.symbols) {
			if (!PLANNED_KINDS.has(s.kind)) continue;
			const target = `${f.path}#${s.name}`;
			add(index.byName, s.name, target);
			if (s.kind === "class") index.classes.add(s.name);
			if (s.kind === "method") add(index.byMember, s.name.slice(s.name.lastIndexOf(".") + 1), target);
		}
	}
	return index;
}

/** Explicit `path#symbol` targets and code-like names in a piece of text. */
export function codeNames(text: string): { targets: string[]; names: string[] } {
	const targets = [...text.matchAll(EXPLICIT)].map((m) => `${m[1].replace(/^\.\//, "")}#${m[2]}`);
	const names = new Set<string>();
	for (const m of text.replace(EXPLICIT, " ").matchAll(NAME)) {
		if (m[1] !== undefined) {
			const inner = m[1].match(/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/);
			if (inner) names.add(inner[0]);
			continue;
		}
		const name = m[2];
		// Plain words are prose; calls, dotted names, snake_case, digits and camelCase are code.
		if (m[3] || name.includes(".") || /[_$\d]/.test(name) || /[a-z][A-Z]/.test(name)) names.add(name);
	}
	return { targets, names: [...names] };
}

function resolve(name: string, index: SymbolIndex): string[] {
	const exact = index.byName.get(name);
	if (exact) return exact.length <= MAX_MATCHES ? exact : [];
	const dot = name.lastIndexOf(".");
	if (dot === -1) {
		const members = index.byMember.get(name) ?? [];
		return members.length <= MAX_MATCHES ? members : [];
	}
	// A new member of a known class (Cart.setQuantity) is new code. Otherwise the prefix is a namespace
	// or a variable: R.clamp names clamp, cart.add names add.
	if (index.classes.has(name.slice(0, dot))) return [];
	return resolve(name.slice(dot + 1), index);
}

/**
 * The existing code an intent will probably change. Names in the title are trusted on their own: a
 * title that names only new code (Add R.sumBy) predicts nothing, even when its body mentions
 * functions it will call. Without code in the title, the body's code-like names are used.
 */
export function predictTargets(intent: { title: string; body: string }, index: SymbolIndex): string[] {
	const title = codeNames(intent.title);
	const body = codeNames(intent.body);
	const explicit = [...title.targets, ...body.targets].filter((t) => index.paths.has(t.slice(0, t.indexOf("#"))));
	const named = title.names.length ? title.names.flatMap((n) => resolve(n, index)) : body.names.flatMap((n) => resolve(n, index)).slice(0, MAX_BODY_TARGETS);
	return [...new Set([...explicit, ...named])];
}

export interface AirTarget {
	target: string;
	flightId: string;
}

/** The first predicted target that overlaps code in the air, with what it overlaps. */
export function firstCollision(predicted: string[], air: AirTarget[]): { target: string; with: AirTarget } | null {
	for (const target of predicted) {
		const hit = air.find((a) => targetsOverlap(target, a.target));
		if (hit) return { target, with: hit };
	}
	return null;
}
