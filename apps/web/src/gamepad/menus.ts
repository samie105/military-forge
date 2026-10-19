/**
 * The menus with a controller (the DOM side of spatial.ts): which part of the page has the pad
 * (the topmost modal, a full-screen route, a menu screen), what in it can take focus, moving focus,
 * pressing, sliders, tab strips (L1 / R1) and scrolling with the right stick.
 *
 * Nothing here knows a screen: any page built from buttons, links, inputs and the kit's sliders,
 * switches and tabs works (the app's shell, the Locker, the Armory page).
 */
import { logicalRect } from '../ui/landscape';
import type { NavDir } from './mapping';
import { nextTab, pickFirst, pickNext, type Rect } from './spatial';

const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"]), [role="slider"], [role="switch"], [role="tab"], [role="radio"], [role="button"]';

/** The app's menus, topmost first: a modal (Pause, Settings, Join…), a route (the Locker), a menu screen. */
export function appMenuScope(doc: Document = document): Element | null {
  const last = (sel: string) => {
    const all = doc.querySelectorAll(sel);
    return all.length ? all[all.length - 1]! : null;
  };
  return last('.mf-fit--modal') ?? doc.querySelector('.mf-route') ?? last('#shell .screen--menu')?.closest('.mf-fit') ?? last('#shell .screen--menu');
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

/** What the pad can focus in `scope`, in document order. */
export function focusables(scope: Element): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);
}

const rectOf = (el: Element): Rect => logicalRect(el);

/** The focused element when it's inside `scope`. */
export function focusedIn(scope: Element): HTMLElement | null {
  const a = document.activeElement as HTMLElement | null;
  return a && a !== document.body && scope.contains(a) && visible(a) ? a : null;
}

export function focusEl(el: HTMLElement): void {
  // focusVisible: the kit's ring shows for a pad as it does for the keyboard (where the browser takes the option)
  el.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

/** The first control a pad lands on: one that asks to be (data-pad-first, autofocus), the screen's main button, or the top-left one. */
export function focusFirst(scope: Element): HTMLElement | null {
  const list = focusables(scope);
  if (!list.length) return null;
  const preferred = list.findIndex((el) => el.matches('[data-pad-first], [autofocus]'));
  const main = preferred >= 0 ? preferred : list.findIndex((el) => el.matches('.btn--volt'));
  const i = pickFirst(list.map(rectOf), main);
  const el = list[i]!;
  focusEl(el);
  return el;
}

const isSlider = (el: Element) => el.getAttribute('role') === 'slider' || (el instanceof HTMLInputElement && el.type === 'range');
const KEYS: Record<NavDir, [key: string, code: string]> = { up: ['ArrowUp', 'ArrowUp'], down: ['ArrowDown', 'ArrowDown'], left: ['ArrowLeft', 'ArrowLeft'], right: ['ArrowRight', 'ArrowRight'] };

/** A synthetic key on an element (sliders, tab strips): React and plain listeners see it as a key press. */
export function sendKey(target: EventTarget, key: string, code = key): void {
  for (const type of ['keydown', 'keyup'] as const) target.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }));
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

/** D-pad / stick: focus moves to the nearest control that way; left and right on a slider move the slider. */
export function moveFocus(scope: Element, dir: NavDir): void {
  const from = focusedIn(scope);
  if (!from) {
    focusFirst(scope);
    return;
  }
  if (isSlider(from) && (dir === 'left' || dir === 'right')) {
    if (from instanceof HTMLInputElement) stepRange(from, dir === 'right' ? 1 : -1);
    else sendKey(from, ...KEYS[dir]);
    return;
  }
  const list = focusables(scope).filter((el) => el !== from && !from.contains(el));
  const i = pickNext(rectOf(from), list.map(rectOf), dir);
  if (i >= 0) focusEl(list[i]!);
}

/** Cross / A: press the focused control (a text field takes focus for typing). */
export function activate(scope: Element): void {
  const el = focusedIn(scope);
  if (!el) {
    focusFirst(scope);
    return;
  }
  if (el instanceof HTMLInputElement && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range'].includes(el.type)) el.focus();
  else if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.focus();
  else el.click();
}

/** L1 / R1: the previous or next tab of the tab strip in `scope` (Settings' sections, the Locker's). */
export function switchTab(scope: Element, step: 1 | -1): boolean {
  const strip = scope.querySelector('[role="tablist"]');
  if (!strip) return false;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>('[role="tab"]')).filter(visible);
  const selected = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true' || t.classList.contains('is-on') || t.classList.contains('is-active'));
  const i = nextTab(tabs.length, selected, step);
  if (i < 0) return false;
  tabs[i]!.click();
  // keep the pad's focus on the strip, so the next L1 / R1 and the D-pad start from the new tab
  if (focusedIn(scope) && strip.contains(document.activeElement)) focusEl(tabs[i]!);
  return true;
}

/** Whether `scope` has a tab strip (the hint bar names L1 / R1 then). */
export const hasTabs = (scope: Element): boolean => scope.querySelector('[role="tablist"] [role="tab"]') !== null;

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
