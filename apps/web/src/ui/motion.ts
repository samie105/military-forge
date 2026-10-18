/**
 * The motion system's script half (docs/design/ui-motion-spec.md §5), shared by the desktop and the
 * phone UI. CSS does what it can (kit.css: .m-p1 … .m-p10 and the --m-* tokens); this does what needs
 * measuring or per-character work, with the Web Animations API and no library:
 *
 *   reduced()                  Reduce motion is on (the setting's html.reduce-motion, or the OS)
 *   stagger(el, i)             P3: sets --i (capped at 10) for .m-p3's delay
 *   sharedElement(from, to)    P2: FLIP: `to` starts where `from` was and travels to its own place
 *   rollText(el, next)         P4: a number's changed digits roll (old up and out, new up from below)
 *   moveIndicator(el, x, w)    P5: an underline or knob whose leading edge leads and trailing edge settles
 *   flood(from, options)       P6: a circle grows from the trigger past the far corner, then clears
 *
 * Every helper takes over from whatever ran before (no queues, nothing waits on an animation), and
 * under Reduce motion becomes an opacity change of 120 ms at most, or nothing. Never use these on a
 * value written every frame.
 */

const STAGGER_CAP = 10;

/** Reduce motion: the Settings switch (html.reduce-motion) or the system's preference. */
export function reduced(doc: Document | undefined = globalThis.document): boolean {
  if (doc?.documentElement?.classList.contains('reduce-motion')) return true;
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** A token's value in milliseconds ('240ms' → 240), with a fallback when it isn't set. */
export function tokenMs(name: string, fallback: number, el: Element | undefined = globalThis.document?.documentElement): number {
  if (!el || typeof getComputedStyle !== 'function') return fallback;
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return v.endsWith('s') && !v.endsWith('ms') ? n * 1000 : n;
}

/** A token's value as text (an easing), with a fallback. */
export function token(name: string, fallback: string, el: Element | undefined = globalThis.document?.documentElement): string {
  if (!el || typeof getComputedStyle !== 'function') return fallback;
  return getComputedStyle(el).getPropertyValue(name).trim() || fallback;
}

// ---------------------------------------------------------------- P3 stagger

/** The stagger step a row gets: its index, capped so the last lands within 300 ms of the first. */
export function staggerIndex(i: number): number {
  return Math.max(0, Math.min(STAGGER_CAP, Math.floor(i)));
}

/** P3: the row's place in its group (.m-p3 reads --i for its delay). */
export function stagger(el: { style: { setProperty(name: string, value: string): void } }, i: number): void {
  el.style.setProperty('--i', String(staggerIndex(i)));
}

// ---------------------------------------------------------------- P2 shared element

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The transform that puts a box drawn at `to` where `from` is (FLIP's "invert"), origin top left. */
export function flipTransform(from: Box, to: Box): string {
  const sx = to.width > 0 ? from.width / to.width : 1;
  const sy = to.height > 0 ? from.height / to.height : 1;
  const dx = from.left - to.left;
  const dy = from.top - to.top;
  return `translate(${round(dx)}px, ${round(dy)}px) scale(${round(sx, 4)}, ${round(sy, 4)})`;
}

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * P2: `to` (already in its final place) starts over `from` (an element, or its box measured before it
 * went) and travels to its own place over --m-scene on --ease-travel; its content fades in when the
 * shell is about 90 % there. Returns the animation (null when there's nothing to animate).
 */
export function sharedElement(from: Element | Box, to: HTMLElement, options: { content?: readonly Element[] } = {}): Animation | null {
  const a = 'getBoundingClientRect' in from ? from.getBoundingClientRect() : from;
  const b = to.getBoundingClientRect();
  for (const old of to.getAnimations?.() ?? []) old.cancel();
  if (reduced()) return to.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: 'linear' });
  if (b.width === 0 || b.height === 0) return null;
  const duration = tokenMs('--m-scene', 520);
  const shell = to.animate([{ transformOrigin: '0 0', transform: flipTransform(a, b) }, { transformOrigin: '0 0', transform: 'none' }], { duration, easing: token('--ease-travel', 'cubic-bezier(0.7, 0, 0.16, 1)') });
  for (const c of options.content ?? []) c.animate([{ opacity: 0 }, { opacity: 0, offset: 0.9 }, { opacity: 1 }], { duration: duration + 120, easing: 'linear' });
  return shell;
}

// ---------------------------------------------------------------- P4 roll counter

/** Which characters of `prev` → `next` change (by place from the right, so 9 → 10 rolls the new digit in). */
export function rollPlan(prev: string, next: string): { char: string; changed: boolean }[] {
  const out: { char: string; changed: boolean }[] = [];
  for (let i = 0; i < next.length; i++) {
    const fromRight = next.length - 1 - i;
    const before = prev[prev.length - 1 - fromRight];
    out.push({ char: next[i]!, changed: before !== next[i] });
  }
  return out;
}

/**
 * P4: shows `next` in `el`, rolling the characters that changed: the old one leaves upward and the new
 * one arrives from below (60–120 ms, a 2 px vertical blur), per character, in tabular figures. A
 * change mid-roll finishes the running one first. Under Reduce motion the text just changes.
 */
export function rollText(el: HTMLElement, next: string): void {
  const prev = el.dataset.roll ?? el.textContent ?? '';
  if (prev === next && el.dataset.roll !== undefined) return;
  el.dataset.roll = next;
  if (reduced() || typeof el.animate !== 'function') {
    el.textContent = next;
    return;
  }
  el.classList.add('m-roll');
  const cells = [...el.children] as HTMLElement[];
  for (const c of cells) for (const a of c.getAnimations?.({ subtree: true }) ?? []) a.finish();
  const plan = rollPlan(prev, next);
  if (cells.length !== plan.length || !cells.every((c) => c.classList.contains('m-roll__c'))) {
    // a new length (or plain text): rebuild, rolling in only what changed
    el.textContent = '';
    for (const p of plan) {
      const cell = document.createElement('span');
      cell.className = 'm-roll__c';
      const glyph = document.createElement('span');
      glyph.textContent = p.char;
      cell.append(glyph);
      el.append(cell);
      if (p.changed && prev !== '') rollIn(glyph);
    }
    return;
  }
  plan.forEach((p, i) => {
    if (!p.changed) return;
    const cell = cells[i]!;
    const old = cell.firstElementChild as HTMLElement | null;
    const glyph = document.createElement('span');
    glyph.textContent = p.char;
    cell.append(glyph);
    rollIn(glyph);
    if (old) {
      const out = old.animate([{ transform: 'none', filter: 'blur(0)' }, { transform: 'translateY(-100%)', filter: `blur(${token('--m-roll-blur', '2px')})`, opacity: 0 }], { duration: 100, easing: token('--ease-leave', 'ease-in') });
      out.onfinish = () => old.remove();
      out.oncancel = () => old.remove();
    }
  });
}

function rollIn(glyph: HTMLElement): void {
  glyph.animate([{ transform: 'translateY(100%)', filter: `blur(${token('--m-roll-blur', '2px')})`, opacity: 0 }, { transform: 'none', filter: 'blur(0)', opacity: 1 }], { duration: 110, easing: token('--ease-arrive', 'ease-out') });
}

// ---------------------------------------------------------------- P5 two-spring indicator

/**
 * P5: moves an .m-p5 indicator to span x … x + width (px in its parent). The edge on the side it's
 * going leads on --ease-arrive; the other follows on --ease-settle 40 ms later, so it stretches and
 * catches up.
 */
export function moveIndicator(el: HTMLElement, x: number, width: number): void {
  const prevLeft = Number.parseFloat(el.style.getPropertyValue('--m5-l')) || 0;
  const forward = x >= prevLeft;
  const lead = 'var(--m-base) var(--ease-arrive)';
  const trail = 'var(--m-base) var(--ease-settle) 40ms';
  el.style.transition = forward ? `--m5-r ${lead}, --m5-l ${trail}` : `--m5-l ${lead}, --m5-r ${trail}`;
  el.style.setProperty('--m5-l', String(round(x)));
  el.style.setProperty('--m5-r', String(round(x + width)));
}

// ---------------------------------------------------------------- P6 flood

/** The radius a circle from (x, y) needs to cover a w × h viewport past its farthest corner. */
export function floodRadius(x: number, y: number, w: number, h: number): number {
  return Math.ceil(Math.max(Math.hypot(x, y), Math.hypot(w - x, y), Math.hypot(x, h - y), Math.hypot(w - x, h - y)));
}

/**
 * P6: a circle grows from the trigger (an element, or a point) past the farthest corner in ~320 ms,
 * then clears; at most one on screen (a new one replaces it). `color` defaults to --c-volt. Big
 * moments only: GO, a match won. Reduce flashes keeps it faint (kit.css); Reduce motion skips it.
 */
export function flood(from: Element | { x: number; y: number }, options: { color?: string } = {}): Promise<void> {
  const doc = globalThis.document;
  if (!doc || reduced()) return Promise.resolve();
  doc.querySelector('.m-p6')?.remove();
  const point = 'getBoundingClientRect' in from ? centre(from.getBoundingClientRect()) : from;
  const r = floodRadius(point.x, point.y, innerWidth, innerHeight);
  const circle = doc.createElement('div');
  circle.className = 'm-p6';
  circle.setAttribute('aria-hidden', 'true');
  Object.assign(circle.style, { left: `${point.x - r}px`, top: `${point.y - r}px`, width: `${r * 2}px`, height: `${r * 2}px` });
  if (options.color) circle.style.setProperty('--m-flood', options.color);
  doc.body.append(circle);
  const grow = circle.animate([{ transform: 'scale(0)' }, { transform: 'scale(1)' }], { duration: 320, easing: token('--ease-travel', 'ease-in-out'), fill: 'forwards' });
  return grow.finished
    .then(() => circle.animate([{ opacity: 1 }, { opacity: 0 }], { duration: tokenMs('--m-base', 240), easing: token('--ease-leave', 'ease-in'), fill: 'forwards' }).finished)
    .then(
      () => circle.remove(),
      () => circle.remove(),
    );
}

const centre = (b: Box) => ({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
