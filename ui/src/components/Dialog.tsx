import { useEffect, useId, useRef } from "preact/hooks";
import { focusables } from "../a11y";
import { Icon } from "./Icons";

/**
 * A modal dialog (a sheet, in HIG terms): it takes focus when it opens and gives it back when it closes,
 * keeps Tab inside, closes on Escape, on its Close button and on a click outside it.
 */
export function Dialog({
	title,
	kicker,
	titleMono = false,
	wide = false,
	onClose,
	children,
}: {
	title: preact.ComponentChildren;
	kicker?: string;
	titleMono?: boolean;
	wide?: boolean;
	onClose: () => void;
	children?: preact.ComponentChildren;
}) {
	const panel = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const close = useRef(onClose);
	close.current = onClose;
	// A click outside closes it only if it began outside: selecting a command and letting go past the edge does not.
	const pressedOutside = useRef(false);

	useEffect(() => {
		const before = document.activeElement as HTMLElement | null;
		const el = panel.current!;
		el.focus({ preventScroll: true });
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				close.current();
				return;
			}
			if (e.key !== "Tab") return;
			const items = focusables(el);
			if (!items.length) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		};
		el.addEventListener("keydown", onKey);
		// The page behind is out of reach while the dialog is open.
		const scroller = document.scrollingElement as HTMLElement | null;
		const overflow = scroller?.style.overflow ?? "";
		if (scroller) scroller.style.overflow = "hidden";
		return () => {
			el.removeEventListener("keydown", onKey);
			if (scroller) scroller.style.overflow = overflow;
			before?.focus?.({ preventScroll: true });
		};
	}, []);

	return (
		<div
			class="why-backdrop"
			onPointerDown={(e) => (pressedOutside.current = e.target === e.currentTarget)}
			onClick={(e) => {
				if (e.target === e.currentTarget && pressedOutside.current) close.current();
			}}
		>
			<div ref={panel} class={`why${wide ? " wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
				<button class="close" onClick={() => close.current()} aria-label="Close">
					<Icon name="abort" size={16} />
				</button>
				{kicker && <div class="why-kicker">{kicker}</div>}
				<h2 id={titleId} class={`dialog-title${titleMono ? " mono" : ""}`}>
					{title}
				</h2>
				{children}
			</div>
		</div>
	);
}
