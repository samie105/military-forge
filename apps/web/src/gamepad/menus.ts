/**
 * The menus with a controller (the DOM side of spatial.ts): which part of the page has the pad
 * (the topmost modal, a full-screen route, a menu screen), what in it can take focus, moving focus,
 * pressing, sliders, tab strips (L1 / R1) and scrolling with the right stick.
 *
 * Nothing here knows a screen: any page built from buttons, links, inputs and the kit's sliders,
 * switches and tabs works (the app's shell, the Locker, the Armory page). A screen can say more with
 * a few attributes (UX audit 2, N-03/N-04/N-05/N-11):
 * - `data-pad-first`: where the pad lands first (the safe main button: Play now, Ready, Play again);
 * - `data-pad-skip`: not for the pad (Home's current tab, a Cancel that B already does);
 * - `data-pad-back`: what Circle / B presses here (Not now, Stay, Cancel), before the app's Escape;
 * - `data-pad-start`: what Options / Menu presses here (Home: Settings);
 * - `data-pad-tabs`: a strip of buttons L1 / R1 step through like a tab strip (Home's top nav);
 * - `data-pad-cycle`: a letter box: up and down step its letter (keys ArrowUp / ArrowDown), ✕ / A is Enter;
 * - `data-pad-y="Join"`: what Triangle / Y presses in a toast (an invite's Join, a request's Accept), and its word in the hint bar;
 * - `data-pad-leave`: a way out (Leave room): the pad only lands on it when moved there, never on its own;
 * - `data-pad-modal`: a card over play that takes the pad when it shows (the first-run controls card).
 * A native <select> steps with left and right (L1 / R1: ten at a time), as a pad can't open its list;
 * a spin button (the 18+ card's year) gets the same as keys.
 */
import { logicalRect } from '../ui/landscape';
import type { NavDir } from './mapping';
import { nextTab, pickFirst, pickNext, type Rect } from './spatial';

const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [role="slider"], [role="switch"], [role="tab"], [role="radio"], [role="button"], [role="spinbutton"]';

/**
 * The app's menus, topmost first: a modal (Pause, Settings, Join…, and the 18+ step: audit 2 N-01,
 * the pad couldn't reach its year), a route (the Locker), a menu screen.
 */
export function appMenuScope(doc: Document = document): Element | null {
  const last = (sel: string) => {
    const all = doc.querySelectorAll(sel);
    return all.length ? all[all.length - 1]! : null;
  };
  return last('.mf-fit--modal, #shell .age-gate') ?? doc.querySelector('.mf-route') ?? last('#shell .screen--menu')?.closest('.mf-fit') ?? last('#shell .screen--menu');
}

/** A friend's invite or request toast with buttons (social/): a tap of View / Share reaches it in the menus too (audit 2, N-06). */
export function appToastScope(doc: Document = document): Element | null {
  const toasts = doc.querySelectorAll('.mf-social-toast .screen--game');
  for (let i = toasts.length - 1; i >= 0; i--) {
    const s = toasts[i]!;
    if (focusables(s).length) return s.closest('.mf-fit') ?? s;
  }
  return null;
}

/** A card over play that waits for an answer (`data-pad-modal`: the first-run controls card): the pad goes straight to it (audit 2, N-13). */
export function appBlockingScope(doc: Document = document): Element | null {
  const cards = doc.querySelectorAll('#shell [data-pad-modal]');
  for (let i = cards.length - 1; i >= 0; i--) {
    const c = cards[i]!;
    if (focusables(c).length) return c.closest('.mf-fit') ?? c;
  }
  return null;
}

/**
 * Game screens over play that carry buttons (the warm-up's Ready, the folded lobby, the controls
 * card, the countdown's Start now): the pad reaches them with a tap of Share / View.
 */
export function appOverlayScope(doc: Document = document): Element | null {
  const screens = doc.querySelectorAll('#shell .screen--game');
  for (let i = screens.length - 1; i >= 0; i--) {
    const s = screens[i]!;
    if (s.getAttribute('data-screen') === 'hud') continue;
    if (focusables(s).length) return s.closest('.mf-fit') ?? s;
  }
  return null;
}

function visible(el: Element): boolean {
  if (el.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.05;
}

/** What the pad can focus in `scope`, in document order (`data-pad-skip` left out). */
export function focusables(scope: Element): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => visible(el) && !el.closest('[data-pad-skip]'));
}

/** The visible control in `scope` marked `attr` (`data-pad-back`…), if any. */
export function marked(scope: Element, attr: string): HTMLElement | null {
  return Array.from(scope.querySelectorAll<HTMLElement>(`[${attr}]`)).find(visible) ?? null;
}

/** Presses the control in `scope` marked `attr`; false when there is none. */
export function pressMarked(scope: Element, attr: string): boolean {
  const el = marked(scope, attr);
  if (!el) return false;
  el.click();
  return true;
}

const rectOf = (el: Element): Rect => logicalRect(el);
/** Far below everything: the last choice for a first focus. */
const FAR: Rect = { left: 0, top: 1e9, right: 0, bottom: 1e9 };

/** The focused element when it's inside `scope`. */
export function focusedIn(scope: Element): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  return a && a !== document.body && scope.contains(a) && visible(a) ? a : null;
}

export function focusEl(el: HTMLElement): void {
  // focusVisible: the kit's ring shows for a pad as it does for the keyboard (where the browser takes the option)
  document.querySelector('.mf-pad-focused')?.classList.remove('mf-pad-focused');
  el.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
  el.classList.add('mf-pad-focused');
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

/** Enough to find the same choice if a selection replaces its DOM node. */
export interface FocusAnchor {
  scope: Element;
  screen: string;
  id: string;
  tab: string;
  label: string;
  x: number;
  y: number;
}

export function rememberFocus(scope: Element, el: HTMLElement | null = focusedIn(scope)): FocusAnchor | null {
  if (!el) return null;
  const rect = logicalRect(el);
  return {
    scope,
    screen: scope.getAttribute('data-screen') ?? scope.querySelector('[data-screen]')?.getAttribute('data-screen') ?? '',
    id: el.id,
    tab: el.getAttribute('data-tab') ?? '',
    label: el.getAttribute('aria-label') ?? '',
    x: (rect.left + rect.right) / 2,
    y: (rect.top + rect.bottom) / 2,
  };
}

/** Restore the selected control, not the first button, after React refreshes a menu. */
export function restoreFocus(scope: Element, anchor: FocusAnchor | null): HTMLElement | null {
  if (!anchor) return null;
  const screen = scope.getAttribute('data-screen') ?? scope.querySelector('[data-screen]')?.getAttribute('data-screen') ?? '';
  if (anchor.scope !== scope && (anchor.scope.isConnected || !screen || screen !== anchor.screen)) return null;
  const list = focusables(scope);
  if (!list.length) return null;
  const named = list.find((el) => (anchor.id && el.id === anchor.id) || (anchor.tab && el.getAttribute('data-tab') === anchor.tab) || (anchor.label && el.getAttribute('aria-label') === anchor.label));
  // the pressed button went (Play again became "You voted"): the nearest one, but never a way out
  const safe = list.filter((el) => !el.hasAttribute('data-pad-leave'));
  const closest = (safe.length ? safe : list).reduce((best, el) => {
    const r = logicalRect(el);
    const distance = Math.hypot((r.left + r.right) / 2 - anchor.x, (r.top + r.bottom) / 2 - anchor.y);
    return distance < best.distance ? { el, distance } : best;
  }, { el: (safe.length ? safe : list)[0]!, distance: Infinity }).el;
  const chosen = named ?? closest;
  focusEl(chosen);
  return chosen;
}

/**
 * The first control a pad lands on: one that asks to be (data-pad-first, then autofocus), the selected
 * tab (Settings, the Locker: L1 / R1 and down go on from there), the screen's main button, or the top-left one.
 */
export function focusFirst(scope: Element): HTMLElement | null {
  const list = focusables(scope);
  if (!list.length) return null;
  const main = preferredIndex(list);
  // the top-left one, but not a way out (the lobby's Leave sat top left: audit 2, N-04)
  const rects = list.map((el) => (el.hasAttribute('data-pad-leave') && list.length > 1 ? FAR : rectOf(el)));
  const i = pickFirst(rects, main);
  const el = list[i]!;
  focusEl(el);
  return el;
}

/** The control a screen names as its first (data-pad-first, autofocus, the selected tab, the main button): its index in `list`, or −1. */
function preferredIndex(list: readonly HTMLElement[]): number {
  for (const sel of ['[data-pad-first]', '[autofocus]', '[role="tab"][aria-selected="true"]', '.btn--volt']) {
    const i = list.findIndex((el) => el.matches(sel));
    if (i >= 0) return i;
  }
  return -1;
}

/** The control `scope` names as its first, if any (a screen drawn after the pad landed: the creator's body cards, the Locker's tab). */
export function preferredControl(scope: Element): HTMLElement | null {
  const list = focusables(scope);
  return list[preferredIndex(list)] ?? null;
}

const isSlider = (el: Element) => el.getAttribute('role') === 'slider' || el.getAttribute('role') === 'spinbutton' || (el instanceof HTMLInputElement && el.type === 'range');
/** A native range input (stepUp works); a text field with role="spinbutton" (the 18+ card's year) takes the arrow keys instead. */
const isRange = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && el.type === 'range';
const isSelect = (el: Element): el is HTMLSelectElement => typeof HTMLSelectElement !== 'undefined' && el instanceof HTMLSelectElement;
/** Controls left and right change (a slider, a spin button, a select) rather than leave. */
export const stepsSideways = (el: Element | null): boolean => !!el && (isSlider(el) || isSelect(el));
/** A letter box (`data-pad-cycle`): up and down change its letter. */
export const stepsUpDown = (el: Element | null): boolean => !!el?.closest('[data-pad-cycle]');
const KEYS: Record<NavDir, [key: string, code: string]> = { up: ['ArrowUp', 'ArrowUp'], down: ['ArrowDown', 'ArrowDown'], left: ['ArrowLeft', 'ArrowLeft'], right: ['ArrowRight', 'ArrowRight'] };

/** A synthetic key on an element (sliders, tab strips): React and plain listeners see it as a key press. False when a listener took it (preventDefault). */
export function sendKey(target: EventTarget, key: string, code = key): boolean {
  let taken = false;
  for (const type of ['keydown', 'keyup'] as const) {
    const ok = target.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
    if (type === 'keydown') taken = !ok;
  }
  return !taken;
}

/**
 * A select a pad steps (it can't open the list): its own keys first (the year you were born takes
 * ArrowLeft / ArrowRight / PageUp / PageDown: shell/age.ts stepYear), else the next or previous option.
 */
function stepSelect(el: HTMLSelectElement, key: string, by: number): void {
  if (!sendKey(el, key)) return;
  const i = Math.max(0, Math.min(el.options.length - 1, el.selectedIndex + by));
  if (i === el.selectedIndex) return;
  el.selectedIndex = i;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** L1 / R1 on a select or slider: ten steps at a time (PageDown / PageUp); false when the focus isn't one. */
export function stepFocusedFar(scope: Element, dir: 1 | -1): boolean {
  const el = focusedIn(scope);
  if (!el || !stepsSideways(el)) return false;
  const key = dir > 0 ? 'PageUp' : 'PageDown';
  if (isSelect(el)) stepSelect(el, key, dir * 10);
  else if (isRange(el)) for (let i = 0; i < 10; i++) stepRange(el, dir);
  else sendKey(el, key);
  return true;
}

/** Nudges a native range input one step (a synthetic key doesn't move it). */
function stepRange(el: HTMLInputElement, dir: 1 | -1): void {
  const before = el.value;
  if (dir > 0) el.stepUp();
  else el.stepDown();
  if (el.value !== before) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/** The nearest box round `el` (inside `scope`) whose content scrolls, if any. */
function scrollerOf(el: Element, scope: Element): Element | null {
  for (let p = el.parentElement; p && p !== scope.parentElement; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll|hidden)/.test(s.overflowY + s.overflowX) && (p.scrollHeight > p.clientHeight + 1 || p.scrollWidth > p.clientWidth + 1)) return p;
  }
  return null;
}

/** `el`'s middle shows: inside its scrolling box's clip, with nothing drawn over it (a fixed footer). */
function inView(el: Element, scroller: Element | null): boolean {
  const r = el.getBoundingClientRect();
  const x = (r.left + r.right) / 2;
  const y = (r.top + r.bottom) / 2;
  if (scroller) {
    const c = scroller.getBoundingClientRect();
    if (x < c.left || x > c.right || y < c.top || y > c.bottom) return false;
  }
  const hit = typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : el;
  return !!hit && (hit === el || el.contains(hit));
}

/**
 * Where a move can go from `from`: anywhere in its own scrolling box first (focus scrolls it there:
 * a long Settings panel walks down to its last row before the footer's Done), then into another box
 * only where that one shows it (audit 2, N-12: from the lobby's Start now, "down" picked a map card
 * scrolled under the footer, and the next "down" came back).
 */
function candidates(scope: Element, from: HTMLElement): { own: HTMLElement[]; other: HTMLElement[] } {
  const box = scrollerOf(from, scope);
  const own: HTMLElement[] = [];
  const other: HTMLElement[] = [];
  for (const el of focusables(scope)) {
    if (el === from || from.contains(el)) continue;
    const elBox = scrollerOf(el, scope);
    if (box && elBox === box) own.push(el);
    else if (elBox === box || inView(el, elBox)) other.push(el);
  }
  return { own, other };
}

/**
 * The focus a pad can act from: a control of `scope`, or null. A dialog that focuses its own frame
 * (Settings, Friends, the 18+ card: tabindex -1) is not one: the first press lands on its first
 * control (audit 2, N-02: the D-pad did nothing there and A pressed the frame).
 */
function padFocus(scope: Element): HTMLElement | null {
  const from = focusedIn(scope);
  return from && from.matches(FOCUSABLE) && !from.closest('[data-pad-skip]') ? from : null;
}

/** The focus is a frame or nothing (pollMenu moves it to a control). */
export const needsFocus = (scope: Element): boolean => padFocus(scope) === null;

/** D-pad / stick: focus moves to the nearest control that way; left and right on a slider (or a select) change it, up and down a letter box's letter. */
export function moveFocus(scope: Element, dir: NavDir): void {
  const from = padFocus(scope);
  if (!from) {
    focusFirst(scope);
    return;
  }
  const sideways = dir === 'left' || dir === 'right';
  if (sideways && stepsSideways(from)) {
    if (isSelect(from)) stepSelect(from, KEYS[dir][0], dir === 'right' ? 1 : -1);
    else if (isRange(from)) stepRange(from, dir === 'right' ? 1 : -1);
    else sendKey(from, ...KEYS[dir]);
    return;
  }
  if (!sideways && stepsUpDown(from)) {
    sendKey(from, ...KEYS[dir]);
    return;
  }
  const { own, other } = candidates(scope, from);
  const to = rectOf(from);
  for (const list of [own, other]) {
    const i = pickNext(to, list.map(rectOf), dir);
    if (i >= 0) return focusEl(list[i]!);
  }
}

/** Cross / A: press the focused control (a text field takes focus for typing; a letter box takes it as Enter). */
export function activate(scope: Element): void {
  const el = padFocus(scope);
  if (!el) {
    focusFirst(scope);
    return;
  }
  if (stepsUpDown(el)) sendKey(el, 'Enter');
  else if (el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range'].includes(el.type)) el.focus();
  else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.focus();
  else el.click();
}

/**
 * L1 / R1: the previous or next tab of the tab strip in `scope` (Settings' sections, the Locker's),
 * or of a strip of buttons marked `data-pad-tabs` (Home's top nav: audit 2, N-11).
 */
export function switchTab(scope: Element, step: 1 | -1, onSelect?: (tab: HTMLElement) => void): boolean {
  // a tab strip that shows first (the creator's Look tabs), else a marked strip (its Body / Look steps, Home's nav)
  const shown = (sel: string) => Array.from(scope.querySelectorAll(sel)).find(visible) ?? null;
  const strip = shown('[role="tablist"]') ?? shown('[data-pad-tabs]');
  if (!strip) return false;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>(strip.matches('[role="tablist"]') ? '[role="tab"]' : 'button, a[href]')).filter(visible);
  const selected = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true' || t.getAttribute('aria-current') === 'page' || t.getAttribute('aria-current') === 'step' || t.classList.contains('is-on') || t.classList.contains('is-active'));
  const i = nextTab(tabs.length, selected, step);
  if (i < 0) return false;
  // The old panel may be replaced on click. Remember and focus the new tab before it happens.
  focusEl(tabs[i]!);
  onSelect?.(tabs[i]!);
  tabs[i]!.click();
  return true;
}

/** Whether `scope` has a tab strip (the hint bar names L1 / R1 then). */
export const hasTabs = (scope: Element): boolean => scope.querySelector('[role="tablist"] [role="tab"], [data-pad-tabs] button') !== null;

/** The screen in `scope` draws its own key hints (frame.tsx Hints, in the pad's glyphs while one plays): the floating bar stays away (audit 2, N-15). */
export const hasOwnHints = (scope: Element): boolean => Array.from(scope.querySelectorAll('[data-pad-hints]')).some(visible);

const scrolls = (el: Element) => {
  const s = getComputedStyle(el);
  return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
};

/**
 * The box the right stick scrolls (long Settings panels, the Locker's lists): the nearest scrolling
 * box round the focus, else the first one in `scope`. The caller keeps it while the stick is held.
 */
export function findScroller(scope: Element): Element | null {
  for (let el: Element | null = focusedIn(scope) ?? scope; el && el !== scope.parentElement; el = el.parentElement) if (scrolls(el)) return el;
  for (const box of scope.querySelectorAll('*')) if (scrolls(box)) return box;
  return null;
}
