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
	// On a phone the sheet rises from the bottom, and a downward swipe on its top puts it away.
	const drag = useRef<{ y: number; dy: number } | null>(null);
	const onDown = (e: PointerEvent) => {
		if (e.pointerType === "mouse" || !matchMedia("(max-width: 700px)").matches) return;
		if (!(e.target as Element).closest(".grabber, .why-kicker, .dialog-title")) return;
		drag.current = { y: e.clientY, dy: 0 };
		try {
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		} catch {
			// a pointer the browser no longer tracks
		}
	};
	const onMove = (e: PointerEvent) => {
		const d = drag.current;
		if (!d) return;
		d.dy = Math.max(0, e.clientY - d.y);
		panel.current!.style.transform = d.dy ? `translateY(${d.dy}px)` : "";
	};
	const onUp = () => {
		const d = drag.current;
		drag.current = null;
		if (!d) return;
		const el = panel.current!;
		if (d.dy > 90) return close.current();
		el.style.transition = "transform 0.2s ease-out";
		el.style.transform = "";
		setTimeout(() => (el.style.transition = ""), 200);
	};

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
			<div
				ref={panel}
				class={`why${wide ? " wide" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				onPointerDown={onDown}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onPointerCancel={onUp}
			>
				<div class="grabber" aria-hidden="true" />
				<button class="close" onClick={() => close.current()} aria-label="Close" title="Close">
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
