// Small accessibility helpers shared by the components (Apple HIG: everything that responds to a click
// responds to the keyboard and to VoiceOver too, and says what it is).
import { useEffect } from "preact/hooks";

/**
 * Props that make an element that is not a <button> act as one: it takes focus, Enter and Space press it,
 * and assistive technologies announce it as a button. For rows and cards that hold block content.
 */
export function pressable(onPress: () => void, label?: string) {
	return {
		role: "button" as const,
		tabIndex: 0,
		...(label ? { "aria-label": label } : {}),
		onClick: onPress,
		onKeyDown: (e: KeyboardEvent) => {
			if (e.key !== "Enter" && e.key !== " ") return;
			e.preventDefault();
			onPress();
		},
	};
}

/** The window's title while a page is shown: "<what> · Contrail". */
export function useTitle(title: string | null | undefined) {
	useEffect(() => {
		if (!title) return;
		const before = document.title;
		document.title = `${title} · Contrail`;
		return () => {
			document.title = before;
		};
	}, [title]);
}

/** Whether the primary pointer is a finger: "tap" instead of "click" in the words the UI uses. */
export const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** The controls inside `root` that Tab can reach, in order. */
export function focusables(root: HTMLElement): HTMLElement[] {
	return [
		...root.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex='-1'])"),
	].filter((el) => el.offsetParent !== null || el === document.activeElement);
}
