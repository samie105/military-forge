/**
 * Keyboard focus at the hand-off from the menus to play. The game reads its keys from the whole
 * window, but while one of the shell's controls has focus, Space and the arrows are that control's
 * (input.ts menusHaveKeys: Space presses a focused button on its release). So when play starts the
 * shell lets go of the keyboard: nothing in #shell keeps focus over a running match.
 */

/** Blurs the focused element when it is one of the shell's (#shell); true when it did. */
export function releaseShellFocus(doc: Pick<Document, 'activeElement'> | undefined = globalThis.document): boolean {
  const el = doc?.activeElement as (Element & { blur?(): void }) | null | undefined;
  if (!el || typeof el.closest !== 'function' || el.closest('#shell') === null || typeof el.blur !== 'function') return false;
  el.blur();
  return true;
}

// ---- routes: what Escape does in the open one, and where focus goes back when it closes (audit N-14)

let routeBack: (() => void) | null = null;

/** The open route's own Back (RouteView sets it from the route's mount): Escape, B and the browser's Back use it. */
export function setActiveRouteBack(fn: (() => void) | null): void {
  routeBack = fn;
}

export function activeRouteBack(): (() => void) | null {
  return routeBack;
}

/** What opened the route, told apart by what a person sees on it (the screen under it re-renders while the route is up). */
interface Opener {
  label: string;
  tag: string;
}

let opener: Opener | null = null;

function labelOf(el: Element): string {
  return (el.getAttribute('aria-label') ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** A route opens: remember the control that opened it (the focused one, when it's a button or a link in #shell). */
export function rememberOpener(doc: Document | undefined = globalThis.document): void {
  const el = doc?.activeElement;
  opener = el && el !== doc.body && el.closest?.('#shell') && /^(BUTTON|A)$/.test(el.tagName) ? { label: labelOf(el), tag: el.tagName } : null;
}

/**
 * The route closed: focus goes back to the control that opened it (Home's Locker tab, not the first
 * control on the page), once the screen under it is back. Nothing remembered: nothing moves.
 */
export function returnFocus(doc: Document | undefined = globalThis.document, later: (fn: () => void) => void = (fn) => requestAnimationFrame(() => fn())): void {
  const want = opener;
  opener = null;
  if (!want || !doc) return;
  later(() => {
    if (doc.activeElement?.closest?.('[aria-modal="true"]')) return; // a dialog opened meanwhile has it
    for (const el of doc.querySelectorAll<HTMLElement>(`#shell ${want.tag.toLowerCase()}`)) {
      if (labelOf(el) === want.label && el.getClientRects().length > 0) {
        el.focus({ preventScroll: true });
        return;
      }
    }
  });
}
