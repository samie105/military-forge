/**
 * Dialogs that cover the screen (Settings, Join, the in-match menu, the name overlay, the local-room
 * panels; Screen and PhoneScreen with `dialog`) keep the keyboard inside them, as WCAG 2.4.3 asks:
 * focus moves in when one opens (unless the screen already put it somewhere inside), Tab and
 * Shift+Tab wrap around its controls, and when it closes focus goes back where it was.
 */
import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** The element Tab should go to from `current` among `list` (wrapping), or null to let the browser do it. */
export function wrapFocus<T>(list: readonly T[], current: T | null, back: boolean): T | null {
  if (list.length === 0) return null;
  const i = current === null ? -1 : list.indexOf(current);
  if (i === -1) return back ? list[list.length - 1]! : list[0]!;
  if (back && i === 0) return list[list.length - 1]!;
  if (!back && i === list.length - 1) return list[0]!;
  return null;
}

/** The dialog's controls a person can reach now (shown, not inert). */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'));
}

/** Traps focus in `ref`'s element while `active`. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return undefined;
    const before = document.activeElement as HTMLElement | null;
    // after the screen's own effects (one may focus its first field): move in only if it didn't
    const t = window.setTimeout(() => {
      if (!root.contains(document.activeElement)) root.focus({ preventScroll: true });
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const active = document.activeElement as HTMLElement | null;
      const next = wrapFocus(focusables(root), active && root.contains(active) && active !== root ? active : null, e.shiftKey);
      if (!next) return;
      e.preventDefault();
      next.focus();
    };
    root.addEventListener('keydown', onKey);
    // Tab pressed while focus sits outside (the page body after a click on the backdrop)
    const onDocKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab' && !root.contains(document.activeElement)) onKey(e);
    };
    document.addEventListener('keydown', onDocKey);
    return () => {
      window.clearTimeout(t);
      root.removeEventListener('keydown', onKey);
      document.removeEventListener('keydown', onDocKey);
      if (before && before.isConnected && typeof before.focus === 'function' && !before.closest('[inert]')) before.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
