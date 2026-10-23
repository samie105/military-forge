/**
 * The spotlight (docs/design/onboarding-research.md §4; the owner, 23 Oct: "those button clip-paths
 * that circle things and tell you what to use"): one component for every "circle the thing" moment
 * of the tour, the hints and the Home stops, from React, the plain-DOM HUD and the touch overlays.
 *
 * - A full-screen dim with an even-odd `clip-path: path()` hole per target. Per the CSS Masking spec the
 *   clipped-out hole isn't hit-tested, so in `block: 'outside'` (menus) the dim blocks every click but
 *   the hole passes it to the target, with no hit-testing code. In `block: 'none'` (play) the dim takes
 *   no pointer at all and the game keeps every key, pad button and touch.
 * - A volt "range-finder" ring per hole, moved by transform (composited), with brass corner ticks.
 * - A Frost callout: eyebrow, a 1–3 word title, one body line, the player's own keys, Skip and an
 *   optional primary; placed beside the target (desktop) or top-centre (phone), flipped and shifted
 *   inside the safe box. A polite live region announces each step.
 *
 * Every hole is the same rounded-rect command list (a circle is a square with r = w/2), so the path
 * interpolates in the desktop menus' clip-path transition. The path is rewritten only when a hole moved
 * more than 2 px; nothing runs per frame while the targets are still (no rAF loop at all: DOM targets
 * re-measure on resize, scroll and their ResizeObserver; world targets on update() from the game loop).
 */
import { logicalRect, viewport, type Box } from './landscape';
import { reduced } from './motion';
import './spotlight.css';

/** What to circle: a DOM element (or a lookup), a selector, a rect, or a point in the world. */
export type SpotTarget =
  | { kind: 'element'; el: Element | (() => Element | null) }
  | { kind: 'selector'; selector: string }
  /** a box the caller measures (a touch control's: touch/index.ts touchControlRect); `shape` overrides the step's */
  | { kind: 'rect'; rect: () => Box | null; shape?: SpotShape }
  /** logical px of the page, null = off screen; `size` is the ring's diameter (default 56) */
  | { kind: 'world'; point: () => { x: number; y: number } | null; size?: number };

export type SpotShape = 'auto' | 'circle' | 'rect' | 'pill';
export type SpotPlace = 'auto' | 'above' | 'below' | 'left' | 'right' | 'top-centre';

export interface SpotStep {
  id: string;
  target: SpotTarget | readonly SpotTarget[];
  shape?: SpotShape;
  /** px around the target (default 6) */
  padding?: number;
  /** "ORDERS · 2/5" */
  eyebrow?: string;
  /** 1–3 words */
  title: string;
  /** ≤ 12 words */
  body?: string;
  /** key caps (already the player's own: Kbd text or a pad glyph's label), shown after the body */
  keys?: readonly string[];
  place?: SpotPlace;
  /** 'outside': menus (the dim blocks, the hole passes); 'none' (default): play, nothing is blocked */
  block?: 'outside' | 'none';
  /**
   * What the callout keeps clear of: 'all' (default) its targets; 'none' only `place` (in play, where a
   * world marker moves every frame, the callout holds still)
   */
  anchor?: 'all' | 'none';
  /** 0..1: default 0.28 ('none') or 0.6 ('outside') */
  dim?: number;
  primary?: { label: string };
  /** default true */
  skippable?: boolean;
  /** the skip link's words (default "Skip", or "Skip this" with a time-out): e.g. "Later" */
  skipLabel?: string;
  /** "Skip training" beside Skip (the whole tour, not just this step) */
  skipAll?: boolean;
  /** after this long without the step being done, the callout offers Skip (never auto-advances) */
  timeoutMs?: number;
  /** the second line the time-out adds ("Push the left dial up and hold") */
  help?: string;
  /** the progress pips: [done, of] */
  progress?: readonly [number, number];
  /** what the live region says (default: eyebrow, title and body) */
  announce?: string;
}

export interface SpotlightOptions {
  /** where the overlay mounts (default document.body: on a turned phone page that's the turned box) */
  root?: HTMLElement;
  reducedMotion?: () => boolean;
  /** the box the callout keeps inside (logical px); default the viewport inset by 12 px */
  safeBox?: () => Box;
  /** a phone layout: the callout goes top-centre (never over a thumb dial) */
  phone?: () => boolean;
}

// ---------------------------------------------------------------- geometry (pure; tests drive it)

export function box(left: number, top: number, width: number, height: number): Box {
  return { left, top, width, height, right: left + width, bottom: top + height };
}

export function inflate(b: Box, by: number): Box {
  return box(b.left - by, b.top - by, b.width + by * 2, b.height + by * 2);
}

/** A hole: a rounded rect; `r` is the corner radius (a circle: a square with r = width / 2). */
export interface Hole extends Box {
  r: number;
}

/** A target's box → its hole, by shape (`auto`: a near-square with a big radius is a circle). */
export function holeFor(b: Box, shape: SpotShape, radius = 0): Hole {
  const s = shape === 'auto' ? (Math.abs(b.width - b.height) <= 4 && radius >= Math.min(b.width, b.height) / 2 - 1 ? 'circle' : 'rect') : shape;
  if (s === 'circle') {
    const d = Math.max(b.width, b.height);
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    return { ...box(cx - d / 2, cy - d / 2, d, d), r: d / 2 };
  }
  if (s === 'pill') return { ...b, r: Math.min(b.width, b.height) / 2 };
  return { ...b, r: Math.max(0, Math.min(radius, b.width / 2, b.height / 2)) };
}

const n = (v: number) => Math.round(v * 10) / 10;

/** One hole's sub-path: always M H A V A H A V A Z, so paths interpolate (the same command list). */
export function holeCommands(h: Hole): string {
  const { left: x, top: y, width: w, height: ht, r } = h;
  return `M${n(x + r)} ${n(y)}H${n(x + w - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}V${n(y + ht - r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + ht)}H${n(x + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + ht - r)}V${n(y + r)}A${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)}Z`;
}

/** The dim's clip path: the whole view, minus each hole (even-odd). */
export function dimPath(w: number, h: number, holes: readonly Hole[]): string {
  return `path(evenodd, "M0 0H${n(w)}V${n(h)}H0Z${holes.map(holeCommands).join('')}")`;
}

/** Whether any hole moved or resized by more than `px` (the path is rewritten only then). */
export function holesMoved(a: readonly Hole[], b: readonly Hole[], px = 2): boolean {
  if (a.length !== b.length) return true;
  return a.some((h, i) => {
    const o = b[i]!;
    return Math.abs(h.left - o.left) > px || Math.abs(h.top - o.top) > px || Math.abs(h.width - o.width) > px || Math.abs(h.height - o.height) > px;
  });
}

/** The union of the holes (what the callout sits beside). */
export function unionBox(holes: readonly Box[]): Box | null {
  if (!holes.length) return null;
  const l = Math.min(...holes.map((h) => h.left));
  const t = Math.min(...holes.map((h) => h.top));
  const r = Math.max(...holes.map((h) => h.right));
  const b = Math.max(...holes.map((h) => h.bottom));
  return box(l, t, r - l, b - t);
}

/** How much two boxes overlap (area; 0 = clear). */
function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where the callout goes, clear of the target: the preferred side, then the opposite, then the others
 * (phones prefer top-centre, never over a thumb dial). Each candidate is shifted along its side to stay
 * inside `safe`; the first that doesn't cover the target wins, else the one covering it least.
 */
export function placeCallout(target: Box | null, size: { width: number; height: number }, safe: Box, place: SpotPlace, gap = 16): { left: number; top: number; side: Exclude<SpotPlace, 'auto'> } {
  const clampX = (x: number) => Math.max(safe.left, Math.min(safe.right - size.width, x));
  const clampY = (y: number) => Math.max(safe.top, Math.min(safe.bottom - size.height, y));
  const topCentre = { left: clampX(safe.left + (safe.width - size.width) / 2), top: safe.top, side: 'top-centre' as const };
  if (!target) return topCentre;
  const cx = target.left + target.width / 2 - size.width / 2;
  const cy = target.top + target.height / 2 - size.height / 2;
  const at = {
    'top-centre': topCentre,
    below: { left: clampX(cx), top: clampY(target.bottom + gap), side: 'below' as const },
    above: { left: clampX(cx), top: clampY(target.top - gap - size.height), side: 'above' as const },
    right: { left: clampX(target.right + gap), top: clampY(cy), side: 'right' as const },
    left: { left: clampX(target.left - gap - size.width), top: clampY(cy), side: 'left' as const },
  };
  const opposite = { below: 'above', above: 'below', left: 'right', right: 'left' } as const;
  const sides = ['below', 'above', 'right', 'left'] as const;
  const order: (keyof typeof at)[] =
    place === 'top-centre' ? ['top-centre', 'below', 'above', 'right', 'left'] : place === 'auto' ? [...sides] : [place, opposite[place], ...sides];
  const hole = inflate(target, gap / 2);
  let best = at[order[0]!];
  let least = Infinity;
  for (const side of order) {
    const p = at[side];
    const cover = overlapArea(box(p.left, p.top, size.width, size.height), hole);
    if (cover === 0) return p;
    if (cover < least) {
      least = cover;
      best = p;
    }
  }
  return best;
}

// ---------------------------------------------------------------- the component

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The target itself when it takes focus, else the first thing inside it that does. */
function focusableIn(el: Element): HTMLElement | null {
  if (el instanceof HTMLElement && el.matches(FOCUSABLE)) return el;
  return el.querySelector<HTMLElement>(FOCUSABLE);
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c]!);

export class Spotlight {
  /** Skip (this step) or Skip training (`all`); Escape in a blocking pass skips the pass (`all`) */
  onSkip: ((id: string, all: boolean) => void) | null = null;
  onPrimary: ((id: string) => void) | null = null;
  private readonly el: HTMLDivElement;
  private readonly dim: HTMLDivElement;
  private readonly rings: HTMLDivElement;
  private readonly callout: HTMLElement;
  private readonly live: HTMLParagraphElement;
  private step: SpotStep | null = null;
  private holes: Hole[] = [];
  private observer: ResizeObserver | null = null;
  private timer = 0;
  private hideTimer = 0;
  private measureFrame = 0;
  private readonly reducedMotion: () => boolean;
  private readonly safeBox: () => Box;
  private readonly phone: () => boolean;

  constructor(opts: SpotlightOptions = {}) {
    this.reducedMotion = opts.reducedMotion ?? (() => reduced());
    this.phone = opts.phone ?? (() => false);
    this.safeBox = opts.safeBox ?? (() => {
      const v = viewport();
      return box(12, 12, v.w - 24, v.h - 24);
    });
    this.el = document.createElement('div');
    this.el.className = 'mf-spot kit-v2';
    this.el.hidden = true;
    this.el.innerHTML = `<div class="mf-spot__dim"></div><div class="mf-spot__rings" aria-hidden="true"></div>
      <section class="mf-spot__callout" tabindex="-1"></section><p class="mf-spot__live" aria-live="polite"></p>`;
    this.dim = this.el.querySelector('.mf-spot__dim')!;
    this.rings = this.el.querySelector('.mf-spot__rings')!;
    this.callout = this.el.querySelector('.mf-spot__callout')!;
    this.live = this.el.querySelector('.mf-spot__live')!;
    this.callout.addEventListener('click', this.onCalloutClick);
    (opts.root ?? document.body).append(this.el);
  }

  get current(): SpotStep | null {
    return this.step;
  }

  /**
   * Shows a step, or moves to it from the one shown (the same overlay: the ring travels, the path morphs).
   * The same step again (its id) updates it in place: no travel, and its time-out keeps running.
   */
  show(step: SpotStep): void {
    window.clearTimeout(this.hideTimer);
    const same = !!this.step && this.step.id === step.id && !this.el.hidden;
    if (!same) window.clearTimeout(this.timer);
    const first = !this.step || this.el.hidden;
    this.step = step;
    const blocking = step.block === 'outside';
    this.el.hidden = false;
    this.el.classList.toggle('is-blocking', blocking);
    this.el.classList.toggle('is-phone', this.phone());
    this.el.classList.toggle('is-reduced', this.reducedMotion());
    this.el.classList.remove('is-leaving');
    if (!same) this.el.classList.remove('is-timeout');
    this.el.style.setProperty('--spot-dim', String(step.dim ?? (blocking ? 0.6 : 0.28)));
    this.renderCallout(step);
    this.live.textContent = step.announce ?? [step.eyebrow, step.title, step.body].filter(Boolean).join('. ');
    this.watch(step);
    // between steps in play (and on phones): fade the dim, move, fade back; menus on desktop morph the path
    const moving = !first && !blocking && !same;
    if (moving) this.el.classList.add('is-moving');
    this.holes = [];
    this.measure(true);
    if (moving) requestAnimationFrame(() => this.el.classList.remove('is-moving'));
    if (step.timeoutMs && !same) this.timer = window.setTimeout(() => this.el.classList.add('is-timeout'), step.timeoutMs);
    if (blocking) {
      document.addEventListener('keydown', this.onKey, true);
      if (!same) this.focusTarget();
    } else document.removeEventListener('keydown', this.onKey, true);
  }

  /** A P7 stamp on the callout ("Confirmed"), until the next step is shown. The caller announces it. */
  stamp(text: string): void {
    const row = this.step ? this.callout.querySelector('.mf-spot__actions') : null;
    if (!row) return;
    row.querySelector('.mf-spot__stamp')?.remove();
    const s = document.createElement('span');
    s.className = 'stamp stamp--volt m-p7 mf-spot__stamp';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = text;
    row.prepend(s);
    this.measure(true); // the callout may have grown: place it again
  }

  /** The game loop calls this when a world target may have moved (cheap when nothing did). */
  update(): void {
    if (this.step) this.measure(false);
  }

  /** Leaves (P9's exit; opacity only under Reduce motion). */
  hide(): Promise<void> {
    if (!this.step) return Promise.resolve();
    this.step = null;
    window.clearTimeout(this.timer);
    this.unwatch();
    document.removeEventListener('keydown', this.onKey, true);
    this.el.classList.add('is-leaving');
    return new Promise((done) => {
      this.hideTimer = window.setTimeout(
        () => {
          this.el.hidden = true;
          this.el.classList.remove('is-leaving');
          this.holes = [];
          done();
        },
        this.reducedMotion() ? 120 : 220,
      );
    });
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.hideTimer);
    cancelAnimationFrame(this.measureFrame);
    this.unwatch();
    document.removeEventListener('keydown', this.onKey, true);
    this.el.remove();
    this.step = null;
  }

  // ---- internals

  private targets(step: SpotStep): SpotTarget[] {
    return Array.isArray(step.target) ? [...step.target] : [step.target as SpotTarget];
  }

  private resolve(t: SpotTarget): Element | null {
    if (t.kind === 'element') return typeof t.el === 'function' ? t.el() : t.el;
    if (t.kind === 'selector') return document.querySelector(t.selector);
    return null;
  }

  /** The holes now, in logical px (the turned phone page's own axes). */
  private currentHoles(step: SpotStep): Hole[] {
    const pad = step.padding ?? 6;
    const out: Hole[] = [];
    for (const t of this.targets(step)) {
      if (t.kind === 'world') {
        const p = t.point();
        if (!p) continue;
        const d = t.size ?? 56;
        out.push(holeFor(box(p.x - d / 2, p.y - d / 2, d, d), 'circle'));
        continue;
      }
      let b: Box | null = null;
      let radius = 0;
      if (t.kind === 'rect') b = t.rect();
      else {
        const el = this.resolve(t);
        if (el) {
          b = logicalRect(el);
          if (b.width === 0 && b.height === 0) b = null;
          radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
        }
      }
      if (!b) continue;
      out.push(holeFor(inflate(b, pad), (t.kind === 'rect' ? t.shape : undefined) ?? step.shape ?? 'auto', radius + pad));
    }
    return out;
  }

  private measure(force: boolean): void {
    const step = this.step;
    if (!step) return;
    const holes = this.currentHoles(step);
    if (!force && !holesMoved(holes, this.holes)) return;
    this.holes = holes;
    const v = viewport();
    this.dim.style.clipPath = dimPath(v.w, v.h, holes);
    this.el.classList.toggle('is-lost', holes.length === 0);
    this.drawRings(holes);
    this.placeCallout(step, holes);
  }

  /** One ring per hole, positioned by transform; resized only when the hole's size changed. */
  private drawRings(holes: readonly Hole[]): void {
    while (this.rings.children.length > holes.length) this.rings.lastElementChild!.remove();
    while (this.rings.children.length < holes.length) {
      const r = document.createElement('div');
      r.className = 'mf-spot__ring';
      r.innerHTML = '<i></i><i></i><i></i><i></i>';
      this.rings.append(r);
    }
    holes.forEach((h, i) => {
      const r = this.rings.children[i] as HTMLElement;
      const size = `${n(h.width)}x${n(h.height)}x${n(h.r)}`;
      if (r.dataset.size !== size) {
        r.dataset.size = size;
        r.style.width = `${n(h.width)}px`;
        r.style.height = `${n(h.height)}px`;
        r.style.borderRadius = `${n(h.r)}px`;
      }
      r.style.transform = `translate3d(${n(h.left)}px, ${n(h.top)}px, 0)`;
    });
  }

  private placeCallout(step: SpotStep, holes: readonly Hole[]): void {
    const c = this.callout;
    const size = { width: c.offsetWidth, height: c.offsetHeight };
    const place = this.phone() ? 'top-centre' : (step.place ?? 'auto');
    const at = placeCallout(step.anchor === 'none' ? null : unionBox(holes), size, this.safeBox(), place);
    c.style.transform = `translate3d(${n(at.left)}px, ${n(at.top)}px, 0)`;
    c.dataset.side = at.side;
  }

  private renderCallout(step: SpotStep): void {
    const skippable = step.skippable !== false;
    const keys = (step.keys ?? []).map((k) => `<kbd class="kbd">${esc(k)}</kbd>`).join('');
    const pips = step.progress ? `<span class="mf-spot__pips" aria-hidden="true">${Array.from({ length: step.progress[1] }, (_, i) => `<i class="${i < step.progress![0] ? 'is-done' : i === step.progress![0] ? 'is-now' : ''}"></i>`).join('')}</span>` : '';
    const blocking = step.block === 'outside';
    this.callout.setAttribute('role', blocking ? 'dialog' : 'group');
    if (blocking) this.callout.setAttribute('aria-modal', 'false');
    else this.callout.removeAttribute('aria-modal');
    this.callout.setAttribute('aria-labelledby', 'mf-spot-title');
    this.callout.setAttribute('aria-describedby', 'mf-spot-body');
    this.callout.innerHTML = `${step.eyebrow || pips ? `<span class="mf-spot__eyebrow">${esc(step.eyebrow ?? '')}${pips}</span>` : ''}
      <b class="mf-spot__title display" id="mf-spot-title">${esc(step.title)}</b>
      <span class="mf-spot__body" id="mf-spot-body">${step.body ? esc(step.body) : ''}${keys ? ` <span class="mf-spot__keys">${keys}</span>` : ''}</span>
      ${step.help ? `<span class="mf-spot__help">${esc(step.help)}</span>` : ''}
      <span class="mf-spot__actions">
        ${skippable ? `<button type="button" class="mf-spot__skip" data-spot="skip">${esc(step.skipLabel ?? (step.timeoutMs ? 'Skip this' : 'Skip'))}</button>` : ''}
        ${step.skipAll ? '<button type="button" class="mf-spot__skip" data-spot="skip-all">Skip training</button>' : ''}
        ${step.primary ? `<button type="button" class="btn btn--volt btn--sm mf-spot__primary" data-spot="primary">${esc(step.primary.label)}</button>` : ''}
      </span>`;
  }

  private readonly onCalloutClick = (e: MouseEvent): void => {
    const b = (e.target as Element).closest<HTMLElement>('[data-spot]');
    const id = this.step?.id;
    if (!b || !id) return;
    if (b.dataset.spot === 'primary') this.onPrimary?.(id);
    else this.onSkip?.(id, b.dataset.spot === 'skip-all');
  };

  /** Blocking: Escape skips the pass; Tab cycles the target and the callout's buttons. */
  private readonly onKey = (e: KeyboardEvent): void => {
    const step = this.step;
    if (!step || step.block !== 'outside') return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.onSkip?.(step.id, true);
      return;
    }
    if (e.key !== 'Tab') return;
    const targets = this.targets(step)
      .map((t) => this.resolve(t))
      .filter((x): x is Element => !!x);
    const stops = [...targets.map(focusableIn).filter((x): x is HTMLElement => !!x), ...this.callout.querySelectorAll<HTMLElement>('button')];
    if (!stops.length) return;
    e.preventDefault();
    const active = document.activeElement;
    // focus anywhere inside a target counts as that target's stop
    const at = stops.findIndex((s, i) => s === active || (i < targets.length && !!active && targets[i]!.contains(active)));
    const next = stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]!;
    next.focus();
  };

  private focusTarget(): void {
    const step = this.step;
    if (!step) return;
    const el = this.targets(step)
      .map((t) => this.resolve(t))
      .map((x) => (x ? focusableIn(x) : null))
      .find((x): x is HTMLElement => !!x);
    (el ?? this.callout).focus({ preventScroll: true });
  }

  /** DOM targets re-measure on their own resize, the window's resize and any scroll (no loop). */
  private watch(step: SpotStep): void {
    this.unwatch();
    const schedule = () => {
      cancelAnimationFrame(this.measureFrame);
      this.measureFrame = requestAnimationFrame(() => this.measure(false));
    };
    // a transition or animation that ended on a target or one of its ancestors may have moved it
    const moved = (e: Event) => {
      const node = e.target instanceof Node ? e.target : null;
      if (!node || this.el.contains(node)) return;
      if (this.targets(step).some((t) => {
        const el = this.resolve(t);
        return !!el && node.contains(el);
      })) schedule();
    };
    this.moved = moved;
    if (typeof ResizeObserver === 'function') {
      this.observer = new ResizeObserver(schedule);
      for (const t of this.targets(step)) {
        const el = this.resolve(t);
        if (el) this.observer.observe(el);
      }
    }
    this.schedule = schedule;
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    // a target that animates in (P1 entrances, a plate sliding): measure where it settled
    document.addEventListener('transitionend', moved, true);
    document.addEventListener('animationend', moved, true);
  }

  private schedule: (() => void) | null = null;
  private moved: ((e: Event) => void) | null = null;

  private unwatch(): void {
    this.observer?.disconnect();
    this.observer = null;
    const s = this.schedule;
    if (!s) return;
    window.removeEventListener('resize', s);
    window.removeEventListener('orientationchange', s);
    window.removeEventListener('scroll', s, { capture: true });
    if (this.moved) {
      document.removeEventListener('transitionend', this.moved, true);
      document.removeEventListener('animationend', this.moved, true);
    }
    this.schedule = null;
    this.moved = null;
  }
}
