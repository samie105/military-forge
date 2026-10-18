/**
 * The touch controls' motion (docs/design/ui-motion-spec.md §4.2), on the shared tokens (--m-*,
 * --ease-*: ui/kit.css) through the Web Animations API. Each helper takes over from whatever ran on
 * the element before (nothing queues, nothing waits), and under Reduce motion becomes an opacity change
 * of 120 ms at most, or nothing. None of them runs on a value written every frame. The shared helpers
 * (reduced, tokenMs) are ui/motion.ts's; these are the phone's own moves.
 */
import { reduced, tokenMs } from '../ui/motion';

/** Reduce motion (ui/motion.ts: the Settings switch or the system's preference). */
export const reducedMotion = reduced;

const cache = new Map<string, string>();

/** A motion token's value as text (read once per page: the tokens never change at run time). */
function token(name: string, fallback: string): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = typeof getComputedStyle === 'function' && globalThis.document ? getComputedStyle(document.documentElement).getPropertyValue(name).trim() : '';
    cache.set(name, v);
  }
  return v || fallback;
}

/** A duration token in ms (ui/motion.ts tokenMs). */
const ms = (name: string, fallback: number) => tokenMs(name, fallback);

/** The ≤ 1.5 % overshoot settle; older engines without CSS linear() easing get a plain ease-out. */
function easing(name: string, fallback: string): string {
  const v = token(name, fallback);
  if (!v.startsWith('linear(')) return v;
  return typeof CSS !== 'undefined' && CSS.supports?.('transition-timing-function', v) ? v : 'cubic-bezier(0.2, 0.9, 0.3, 1)';
}

export const arrive = () => easing('--ease-arrive', 'cubic-bezier(0.16, 1, 0.3, 1)');
export const leave = () => easing('--ease-leave', 'cubic-bezier(0.7, 0, 0.84, 0)');
export const settle = () => easing('--ease-settle', 'cubic-bezier(0.2, 0.9, 0.3, 1)');

function stop(el: Element): void {
  for (const a of el.getAnimations?.() ?? []) a.cancel();
}

/** P7 stamp: scale 1.18 → 1 on --ease-settle over --m-fast (READY ticks, the dash coming back). */
export function stamp(el: HTMLElement | SVGElement, from = 1.18): Animation | null {
  if (typeof el.animate !== 'function') return null;
  stop(el);
  if (reducedMotion()) return el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 120 });
  return el.animate(
    [
      { transform: `scale(${from})`, opacity: 0 },
      { opacity: 1, offset: 0.4 },
      { transform: 'none', opacity: 1 },
    ],
    { duration: ms('--m-fast', 160), easing: settle() },
  );
}

/** A control coming into play (the take button near a crate): grows from 0.6 at its place (P7). */
export function growIn(el: HTMLElement): void {
  if (typeof el.animate !== 'function') return;
  stop(el);
  if (reducedMotion()) {
    el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
    return;
  }
  el.animate(
    [
      { scale: '0.6', opacity: 0 },
      { opacity: 1, offset: 0.4 },
      { scale: '1', opacity: 1 },
    ],
    { duration: ms('--m-base', 240), easing: settle() },
  );
}

/** …and going out of play: shrinks away, accelerating (--ease-leave), then `done`. */
export function shrinkOut(el: HTMLElement, done: () => void): void {
  if (typeof el.animate !== 'function') {
    done();
    return;
  }
  stop(el);
  const a = reducedMotion()
    ? el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120 })
    : el.animate([{ scale: '1', opacity: 1 }, { scale: '0.6', opacity: 0 }], { duration: ms('--m-fast', 160), easing: leave() });
  a.onfinish = done;
}

/** A floating stick going home after the thumb lifts: from (dx, dy) px away back to its place, settling. */
export function glideHome(el: HTMLElement, dx: number, dy: number): void {
  if (typeof el.animate !== 'function' || (dx === 0 && dy === 0)) return;
  stop(el);
  if (reducedMotion()) return;
  el.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }], { duration: ms('--m-base', 240), easing: settle() });
}

/** The dials' arcs drawing in from 0 (P10 over --m-slow) at the start of a match: --dial-in 0 → 1. */
export function drawIn(el: HTMLElement): void {
  if (typeof el.animate !== 'function') return;
  if (reducedMotion()) return;
  try {
    el.animate([{ '--dial-in': '0' }, { '--dial-in': '1' }], { duration: ms('--m-slow', 360), easing: arrive() });
  } catch {
    /* an engine that can't animate a registered custom property: the arcs are simply there */
  }
}

/** Cancels whatever the helpers started on `el` (a thumb came back down mid-glide). */
export function settleNow(el: Element): void {
  stop(el);
}

/**
 * The swap pill's two guns cross (like the desktop's slot cards): the gun now in hand travels from
 * where the slung one was, the slung one from where the held one was, over the gun's real equip time
 * on --ease-travel. `held`/`back` are the icons after the swap; `heldWas`/`backWas` their boxes before.
 */
export function cross(held: Element, back: Element, heldWas: DOMRect, backWas: DOMRect, duration: number): void {
  const travel = easing('--ease-travel', 'cubic-bezier(0.7, 0, 0.16, 1)');
  const move = (el: Element, from: DOMRect) => {
    if (typeof (el as HTMLElement).animate !== 'function') return;
    stop(el);
    const to = el.getBoundingClientRect();
    if (!to.width || !from.width) return;
    if (reducedMotion()) {
      (el as HTMLElement).animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
      return;
    }
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const k = from.width / to.width;
    (el as HTMLElement).animate([{ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${k.toFixed(3)})` }, { transform: 'none' }], { duration, easing: travel });
  };
  move(held, backWas);
  move(back, heldWas);
}
