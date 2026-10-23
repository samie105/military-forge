/**
 * Taps while another finger is down (QA, 23 Oct 2026, qa-bullets-lag-touch.md §3 H: "the mobile UI
 * becomes unresponsive"). A browser makes a click only from a one-finger tap: with a thumb resting on
 * the move dial, a tap on Resume, Got it, Settings or a results button sends pointerdown and pointerup
 * but no click, so every onClick in the menus, the HUD and the touch overlays ignores it until both
 * thumbs lift.
 *
 * One delegated fix at the root rather than a new prop on every button: a press on something
 * clickable (a button, a link, a role=button, a checkbox or radio, a label) that started or turned
 * multi-touch, and ends on the same element within the slop and time a tap allows, gets its click
 * here (`el.click()`: the same event a tap makes, so React's onClick and the HUD's delegated listeners
 * run as usual). The browser's own click for that press, if it sends one after all, is swallowed:
 * one press, one action. A mouse, a single-finger tap and the keyboard's Enter and Space are left
 * alone. The touch controls (data-mf-control) act on pointerdown themselves and are skipped.
 */

/** How far a finger may wander and still tap (CSS px; a button's own tap allows about this much). */
export const TAP_SLOP_PX = 16;
/** Longer than this is a hold, not a tap (no click, as the browser's). */
export const TAP_MAX_MS = 800;
/** The browser's own click arrives within this of the pointerup it follows. */
export const ECHO_MS = 400;

/** What a tap clicks. */
export const CLICKABLE = 'button, a[href], [role="button"], [role="link"], [role="radio"], [role="tab"], [role="switch"], [role="checkbox"], [role="menuitem"], [role="option"], summary, label, input[type="checkbox"], input[type="radio"]';
/** What acts on its own pointer events: the touch controls and their edit button (touch/controller.ts). */
export const OWN_POINTER = '[data-mf-control], [data-mf-edit], [data-own-tap]';

/** The DOM this needs (an element, as far as it's used here): the tests give stand-ins. */
export interface TapElement {
  closest(selector: string): TapElement | null;
  contains(other: unknown): boolean;
  click(): void;
  hasAttribute(name: string): boolean;
  readonly disabled?: boolean;
}

interface TapPointer {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly target: unknown;
}
interface TapClick {
  readonly target: unknown;
  preventDefault(): void;
  stopImmediatePropagation(): void;
}

export interface TapEnv {
  /** where the listeners go (window) */
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  /** the element under a screen point (document.elementFromPoint) */
  elementAt(x: number, y: number): unknown;
  now(): number;
}

interface Press {
  el: TapElement;
  x: number;
  y: number;
  at: number;
  /** another finger was down when it started, or came down during it: the browser makes no click */
  multi: boolean;
}

function clickable(target: unknown): TapElement | null {
  const t = target as Partial<TapElement> | null;
  if (!t || typeof t.closest !== 'function') return null;
  if (t.closest(OWN_POINTER)) return null;
  const el = t.closest(CLICKABLE);
  if (!el || el.disabled || el.hasAttribute('disabled') || el.closest('[aria-disabled="true"], [inert]')) return null;
  return el;
}

/** Starts the fix; returns what stops it. */
export function startMultiTouchTaps(env: TapEnv = browserEnv()): () => void {
  /** fingers and pens on the screen now */
  const down = new Set<number>();
  const presses = new Map<number, Press>();
  /** the click we just made: let it through, and swallow the browser's own for the same press */
  let ours: TapElement | null = null;
  let echo: { el: TapElement; until: number } | null = null;

  const onDown = (e: TapPointer) => {
    if (e.pointerType === 'mouse') return;
    for (const p of presses.values()) p.multi = true;
    const others = down.size > 0;
    down.add(e.pointerId);
    const el = clickable(e.target);
    if (el) presses.set(e.pointerId, { el, x: e.clientX, y: e.clientY, at: env.now(), multi: others });
  };

  const onUp = (e: TapPointer) => {
    if (e.pointerType === 'mouse') return;
    down.delete(e.pointerId);
    const p = presses.get(e.pointerId);
    presses.delete(e.pointerId);
    if (!p?.multi) return; // a one-finger tap: the browser clicks
    const now = env.now();
    if (now - p.at > TAP_MAX_MS || Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP_PX) return;
    // still on it (a touch's events stay with the element it started on, wherever the finger goes)
    if (!p.el.contains(env.elementAt(e.clientX, e.clientY)) || clickable(p.el) !== p.el) return;
    echo = { el: p.el, until: now + ECHO_MS };
    ours = p.el;
    try {
      p.el.click();
    } finally {
      ours = null;
    }
  };

  const onCancel = (e: TapPointer) => {
    down.delete(e.pointerId);
    presses.delete(e.pointerId);
  };

  const onClick = (e: TapClick) => {
    if (!echo || ours) return;
    if (env.now() > echo.until) {
      echo = null;
      return;
    }
    if (echo.el.contains(e.target)) {
      // the browser's click for the press we already clicked
      echo = null;
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  // the page went away mid-press (a call, the app switcher): no finger is down any more
  const reset = () => {
    down.clear();
    presses.clear();
  };

  const opts = { capture: true, passive: true } as const;
  const listeners: [string, (e: never) => void, AddEventListenerOptions][] = [
    ['pointerdown', onDown, opts],
    ['pointerup', onUp, opts],
    ['pointercancel', onCancel, opts],
    ['click', onClick, { capture: true }],
    // the window's own blur only: an element's blur (a button let go of focus) passes window in the
    // capture phase too, and must not forget a thumb that's still down
    ['blur', reset, { passive: true }],
  ];
  for (const [type, fn, o] of listeners) env.target.addEventListener(type, fn as EventListener, o);
  return () => {
    for (const [type, fn, o] of listeners) env.target.removeEventListener(type, fn as EventListener, o);
  };
}

function browserEnv(): TapEnv {
  return { target: window, elementAt: (x, y) => document.elementFromPoint(x, y), now: () => performance.now() };
}
