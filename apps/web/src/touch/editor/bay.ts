/**
 * The layout bay: the HUD editor (board "VOICE + HUD EDITOR · landscape-first", E1–E5). The owner, 24
 * Oct: "to set the HUD is confusing, and we keep forgetting it's a mobile device and on landscape".
 *
 * Edit on a stage of its own, above every screen (it used to open under Home, unseen): the game dims
 * under it (or a plain field outside a game), the controls float on it as they really are, and Cancel,
 * Undo, Redo, the base, Reset and Save never move. Nothing to read:
 * - drag a control (it snaps to its neighbours and the middle: the controller's drag code);
 * - pinch it, or tap it for its card: size and fade sliders, and "off the HUD" for the extras;
 * - the tray at the bottom holds the extras off the HUD; tap one to put it on;
 * - the base (Classic, Claw, One-thumb) as three big cards drawn as the real layouts, plus Mirror;
 * - controls that overlap turn red together; the reach arcs show where each thumb lands.
 * The controller keeps the drag, snap and pinch (controller.ts); this module is the rest, behind BayHost.
 */
import { CONTROLS, PRESET_IDS, type ControlId, type Placement } from '../layout';
import { LIMITS, PRESET_NAMES, type Handed, type PresetId } from '../settings';
import { BASE_HANDS, BayHistory, baseDrawing, cardAt, overlaps, trayAt, type BaySnapshot, type Disc } from './model';
import './editor.css';

/** What the bay needs from the controller. */
export interface BayHost {
  /** the touch root (the bay's layers go in it) and the safe box the controls sit in */
  readonly root: HTMLElement;
  readonly safe: HTMLElement;
  snapshot(): BaySnapshot;
  /** puts a snapshot back (places, base and its settings, hand) and saves it */
  restore(s: BaySnapshot): void;
  pickPreset(p: PresetId): void;
  setHanded(h: Handed): void;
  selected(): ControlId | null;
  select(id: ControlId | null): void;
  placement(id: ControlId): Placement;
  /** a control's size on its base, before any edit (the size slider runs around it) */
  baseSize(id: ControlId): number;
  /** a control's new placement (screen coordinates, the current hand), saved */
  setPlacement(id: ControlId, p: Placement): void;
  /** the base's places again (the pins stay) */
  reset(): void;
  setPinned(id: ControlId, on: boolean): void;
  /** the extras off this base's HUD that can be put on it (not pinned yet) */
  tray(): ControlId[];
  /** pinned extras (they can go back to the tray) */
  pinned(): readonly ControlId[];
  /** the controls on screen now (px, in the safe box) */
  discs(): Disc[];
  /** leaves the bay (the layout as it stands is saved) */
  leave(): void;
  /** a game runs under the bay (else: a plain field), and its clock is running */
  inGame(): boolean;
  matchLive(): boolean;
}

const svg = (body: string, cls = '') => `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const use = (name: string) => `<svg class="ic" aria-hidden="true"><use href="#icon-${name}"/></svg>`;
const ICONS = {
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  mirror: svg('<path d="M12 3v18"/><path d="M8 7L3 12l5 5V7zM16 7l5 5-5 5V7z"/>'),
  off: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5.5 0 9 5.5 9 7a12 12 0 0 1-2.6 3.4M6.6 6.6C4.4 8 3 10.4 3 12c0 1.5 3.5 7 9 7a9.6 9.6 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>'),
  small: svg('<circle cx="12" cy="12" r="3.5"/>'),
  big: svg('<circle cx="12" cy="12" r="9"/>'),
  ghost: svg('<circle cx="12" cy="12" r="8" stroke-dasharray="3 3"/>'),
  solid: svg('<circle cx="12" cy="12" r="8" fill="currentColor"/>'),
  hand: svg('<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15a6.5 6.5 0 0 1-6.5 6.5h-1A6.5 6.5 0 0 1 7 18.4L4.6 14.6a1.5 1.5 0 0 1 2.5-1.7L8 14"/>'),
};
/** The extras' glyphs (the kit sprite). */
const TRAY_ICON: Partial<Record<ControlId, string>> = { dash: 'dash', cycleGrenade: 'g-frag', melee: 'melee', reload: 'reload', shield: 'shield', zoom: 'zoom' };
/** A base's name on its card (short: a card is about 200 px wide on a phone). */
const BASE_NAME: Readonly<Record<PresetId, string>> = { classic: PRESET_NAMES.classic, claw: PRESET_NAMES.claw, oneThumb: 'One-thumb' };
const labelOf = (id: ControlId): string => CONTROLS.find((c) => c.id === id)?.label ?? id;

/** The size slider runs from 60 % to 180 % of the control's size on its base (within the layout's limits). */
const sizeRange = (base: number): [number, number] => [Math.max(LIMITS.sizeMin, base * 0.6), Math.min(LIMITS.sizeMax, base * 1.8)];
const sizeToSlider = (size: number, base: number) => {
  const [lo, hi] = sizeRange(base);
  return Math.round(Math.min(1, Math.max(0, (size - lo) / Math.max(1e-6, hi - lo))) * 100);
};
const sliderToSize = (v: number, base: number) => {
  const [lo, hi] = sizeRange(base);
  return lo + (v / 100) * (hi - lo);
};

export class LayoutBay {
  private readonly backdrop: HTMLDivElement;
  private readonly ui: HTMLDivElement;
  private readonly card: HTMLDivElement;
  private readonly tray: HTMLDivElement;
  private readonly shelf: HTMLDivElement;
  private history = new BayHistory();
  /** the layout as the bay opened (Cancel puts it back) */
  private start: BaySnapshot | null = null;
  /** a change in progress (a drag, a pinch, a slider held): its state before */
  private pending: BaySnapshot | null = null;
  private open = false;
  private readonly offKey: () => void;

  constructor(private readonly host: BayHost) {
    const el = (cls: string, parent: HTMLElement, html = '') => {
      const d = document.createElement('div');
      d.className = cls;
      d.innerHTML = html;
      parent.append(d);
      return d;
    };
    // under the controls: the dimmed game (or a plain field) and the thumbs' reach
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'mf-bay-back';
    this.backdrop.hidden = true;
    this.backdrop.innerHTML = '<i class="mf-bay-reach mf-bay-reach--l"></i><i class="mf-bay-reach mf-bay-reach--r"></i>';
    host.root.prepend(this.backdrop);
    // over them: the bar, the card, the tray and the base shelf
    this.ui = el('mf-bay-ui mf-bay', host.root);
    this.ui.hidden = true;
    this.ui.setAttribute('role', 'dialog');
    this.ui.setAttribute('aria-label', 'Edit the HUD');
    el(
      'mf-bay__bar mf-bay__bar--l',
      this.ui,
      `<button type="button" class="mf-bay__btn" data-bay="cancel" aria-label="Cancel: leave without changes">${use('close')}</button>
       <button type="button" class="mf-bay__btn" data-bay="undo" aria-label="Undo">${ICONS.undo}</button>
       <button type="button" class="mf-bay__btn" data-bay="redo" aria-label="Redo">${ICONS.redo}</button>`,
    );
    el(
      'mf-bay__bar mf-bay__bar--r',
      this.ui,
      `<button type="button" class="mf-bay__btn mf-bay__base" data-bay="base" aria-haspopup="dialog" aria-expanded="false">${svg('<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8" cy="14" r="2.5"/><circle cx="16" cy="14" r="2.5"/><circle cx="16.5" cy="8.5" r="1"/>')}<b data-bay="base-name"></b>${use('chev-down')}</button>
       <button type="button" class="mf-bay__btn" data-bay="reset" aria-label="Reset to the base's places">${use('refresh')}</button>
       <button type="button" class="mf-bay__btn mf-bay__save" data-bay="save">${use('check')}<b>Save</b></button>`,
    );
    el('mf-bay__live', this.ui, 'The match keeps running');
    this.card = el(
      'mf-bay__card',
      this.ui,
      `<div class="mf-bay__card-h"><b data-bay="name"></b><button type="button" class="mf-bay__btn mf-bay__btn--s" data-bay="unpin" aria-label="Off the HUD">${ICONS.off}</button></div>
       <label class="mf-bay__row"><span class="mf-bay__glyph">${ICONS.small}</span><input type="range" min="0" max="100" step="1" data-bay="size" aria-label="Size" /><span class="mf-bay__glyph">${ICONS.big}</span></label>
       <label class="mf-bay__row"><span class="mf-bay__glyph">${ICONS.ghost}</span><input type="range" min="15" max="100" step="5" data-bay="fade" aria-label="Fade" /><span class="mf-bay__glyph">${ICONS.solid}</span></label>`,
    );
    this.card.hidden = true;
    this.tray = el('mf-bay__tray', this.ui);
    this.shelf = el(
      'mf-bay__shelf',
      this.ui,
      `<div class="mf-bay__cards" role="radiogroup" aria-label="Base layout">${PRESET_IDS.map((id) => `<button type="button" class="mf-bay__base-card" role="radio" data-preset="${id}" aria-label="${PRESET_NAMES[id]}"></button>`).join('')}</div>
       <button type="button" class="mf-bay__mirror" role="switch" data-bay="mirror">${ICONS.mirror}<b>Mirror</b><i class="mf-bay__switch"></i></button>`,
    );
    this.shelf.hidden = true;
    this.wire();
    const onKey = (e: KeyboardEvent) => {
      if (!this.open || e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      if (!this.shelf.hidden) this.showShelf(false);
      else this.cancel();
    };
    window.addEventListener('keydown', onKey, true);
    this.offKey = () => window.removeEventListener('keydown', onKey, true);
  }

  private q<T extends HTMLElement>(name: string): T {
    return this.ui.querySelector<T>(`[data-bay="${name}"]`)!;
  }

  private wire(): void {
    this.q('cancel').addEventListener('click', () => this.cancel());
    this.q('save').addEventListener('click', () => this.host.leave());
    this.q('undo').addEventListener('click', () => this.step(-1));
    this.q('redo').addEventListener('click', () => this.step(1));
    this.q('reset').addEventListener('click', () => this.change(() => this.host.reset()));
    this.q('base').addEventListener('click', () => this.showShelf(this.shelf.hidden !== false));
    this.q('mirror').addEventListener('click', () => this.change(() => this.host.setHanded(this.host.snapshot().handed === 'left' ? 'right' : 'left')));
    this.shelf.addEventListener('click', (e) => {
      const card = (e.target as Element).closest<HTMLElement>('[data-preset]');
      if (card) {
        const id = card.dataset.preset as PresetId;
        this.change(() => this.host.pickPreset(id));
        this.showShelf(false);
      } else if (e.target === this.shelf) this.showShelf(false);
    });
    this.q('unpin').addEventListener('click', () => {
      const id = this.host.selected();
      if (!id) return;
      this.change(() => {
        this.host.setPinned(id, false);
        this.host.select(null);
      });
    });
    // a slider held: one undo step for the whole slide. The thumb drives it here (the page stops touch
    // moves while editing, which a native range would need); the keyboard still steps it natively
    for (const name of ['size', 'fade'] as const) {
      const input = this.q<HTMLInputElement>(name);
      const apply = () => {
        const id = this.host.selected();
        if (!id) return;
        this.pending ??= this.host.snapshot();
        const p = this.host.placement(id);
        const v = Number(input.value);
        this.host.setPlacement(id, name === 'size' ? { ...p, size: sliderToSize(v, this.host.baseSize(id)) } : { ...p, opacity: v / 100 });
      };
      const fromPointer = (e: PointerEvent) => {
        const r = input.getBoundingClientRect();
        const min = Number(input.min);
        const max = Number(input.max);
        const step = Number(input.step) || 1;
        const t = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
        input.value = String(Math.round((min + t * (max - min)) / step) * step);
        apply();
      };
      input.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        input.setPointerCapture?.(e.pointerId);
        this.willChange();
        fromPointer(e);
      });
      input.addEventListener('pointermove', (e) => {
        if (input.hasPointerCapture?.(e.pointerId)) fromPointer(e);
      });
      const end = () => this.changed();
      input.addEventListener('pointerup', end);
      input.addEventListener('pointercancel', end);
      input.addEventListener('input', apply);
      input.addEventListener('change', end);
    }
    this.tray.addEventListener('click', (e) => {
      if ((e.target as Element).closest('[data-bay="tray-open"]')) {
        if (this.tray.classList.contains('is-tight')) this.tray.classList.toggle('is-open');
        this.sync();
        return;
      }
      const b = (e.target as Element).closest<HTMLElement>('[data-pin]');
      if (!b) return;
      this.tray.classList.remove('is-open');
      const id = b.dataset.pin as ControlId;
      this.change(() => {
        this.host.setPinned(id, true);
        this.host.select(id);
      });
    });
  }

  /** The bay opens: what's there now is what Cancel goes back to. */
  show(): void {
    this.open = true;
    this.start = this.host.snapshot();
    this.history = new BayHistory();
    this.pending = null;
    this.backdrop.hidden = false;
    this.ui.hidden = false;
    this.backdrop.classList.toggle('is-field', this.host.inGame() !== true);
    this.showShelf(false);
    this.sync();
    this.q<HTMLButtonElement>('save').focus({ preventScroll: true });
  }

  /** The bay closes (Save, Cancel, or the controls went away). */
  hide(): void {
    this.open = false;
    this.start = null;
    this.pending = null;
    this.backdrop.hidden = true;
    this.ui.hidden = true;
    this.showShelf(false);
    for (const el of this.host.safe.querySelectorAll('.mf-overlap')) el.classList.remove('mf-overlap');
  }

  get isOpen(): boolean {
    return this.open;
  }

  private cancel(): void {
    if (this.start) this.host.restore(this.start);
    this.host.leave();
  }

  /** A change starts (a drag, a pinch, a slider held): remember the state before it. */
  willChange(): void {
    if (this.open) this.pending = this.host.snapshot();
  }

  /** The change is done: one undo step (none if nothing moved). */
  changed(): void {
    if (!this.open || !this.pending) return;
    this.history.record(this.pending, this.host.snapshot());
    this.pending = null;
    this.sync();
  }

  private change(fn: () => void): void {
    const before = this.host.snapshot();
    fn();
    this.history.record(before, this.host.snapshot());
    this.sync();
  }

  private step(dir: -1 | 1): void {
    const now = this.host.snapshot();
    const to = dir < 0 ? this.history.undo(now) : this.history.redo(now);
    if (!to) return;
    this.host.restore(to);
    this.host.select(null);
    this.sync();
  }

  /** While a control is dragged, the bar and the card step back (they never move). */
  dragging(on: boolean): void {
    this.ui.classList.toggle('is-dragging', on);
  }

  private showShelf(on: boolean): void {
    this.shelf.hidden = !on;
    this.q('base').setAttribute('aria-expanded', String(on));
    this.ui.classList.toggle('is-shelf', on);
    if (on) this.drawShelf();
  }

  private drawShelf(): void {
    const now = this.host.snapshot();
    for (const card of this.shelf.querySelectorAll<HTMLElement>('[data-preset]')) {
      const id = card.dataset.preset as PresetId;
      const on = id === now.preset;
      card.setAttribute('aria-checked', String(on));
      const W = 200;
      const H = 95;
      const dots = baseDrawing(id, now.handed)
        .map((d) => `<circle cx="${(d.x * W).toFixed(1)}" cy="${(d.y * H).toFixed(1)}" r="${Math.max(3, d.r * H).toFixed(1)}"${d.slot ? ' class="is-slot"' : ''}/>`)
        .join('');
      card.innerHTML = `<svg class="mf-bay__mini" viewBox="0 0 ${W} ${H}" aria-hidden="true">${dots}</svg><span class="mf-bay__base-name"><b>${BASE_NAME[id]}</b><span class="mf-bay__hands" aria-hidden="true">${ICONS.hand.repeat(BASE_HANDS[id])}</span></span>`;
    }
    const mirror = this.q('mirror');
    mirror.setAttribute('aria-checked', String(now.handed === 'left'));
  }

  /** Redraws the bay for the layout as it stands (the controller calls it after placing the controls). */
  sync(): void {
    if (!this.open) return;
    const now = this.host.snapshot();
    this.q('base-name').textContent = BASE_NAME[now.preset];
    this.q('base').setAttribute('aria-label', `Base layout: ${BASE_NAME[now.preset]}`);
    this.q<HTMLButtonElement>('undo').disabled = !this.history.canUndo;
    this.q<HTMLButtonElement>('redo').disabled = !this.history.canRedo;
    this.ui.classList.toggle('is-live', this.host.inGame() && this.host.matchLive());
    this.ui.dataset.preset = now.preset;
    const discs = this.host.discs();
    // too close: both red
    const bad = overlaps(discs);
    for (const el of this.host.safe.querySelectorAll<HTMLElement>('[data-mf-control], [data-mf-stick]')) {
      const id = (el.dataset.mfControl ?? el.dataset.mfStick) as ControlId;
      el.classList.toggle('mf-overlap', bad.has(id));
    }
    this.drawCard(discs);
    this.drawTray(discs);
    if (!this.shelf.hidden) this.drawShelf();
  }

  private drawCard(discs: readonly Disc[]): void {
    const id = this.host.selected();
    const d = id ? discs.find((x) => x.id === id) : undefined;
    this.card.hidden = !id || !d;
    if (!id || !d) return;
    const p = this.host.placement(id);
    this.q('name').textContent = labelOf(id);
    this.q('unpin').hidden = !this.host.pinned().includes(id);
    const size = this.q<HTMLInputElement>('size');
    const fade = this.q<HTMLInputElement>('fade');
    if (document.activeElement !== size) size.value = String(sizeToSlider(p.size, this.host.baseSize(id)));
    if (document.activeElement !== fade) fade.value = String(Math.round(p.opacity * 100));
    const safe = this.host.safe.getBoundingClientRect();
    const box = { w: safe.width, h: safe.height };
    const w = this.card.offsetWidth || 220;
    const h = this.card.offsetHeight || 140;
    const at = cardAt(d, { w, h }, box, 56);
    // the card lives in the bay's layer, which spans the root: from the safe box's to the root's coordinates
    const root = this.host.root.getBoundingClientRect();
    this.card.style.left = `${(at.x + safe.left - root.left).toFixed(1)}px`;
    this.card.style.top = `${(at.y + safe.top - root.top).toFixed(1)}px`;
  }

  private drawTray(discs: readonly Disc[]): void {
    const ids = this.host.tray();
    const key = ids.join(',');
    if (this.tray.dataset.ids !== key) {
      this.tray.dataset.ids = key;
      this.tray.innerHTML = ids.length
        ? `<button type="button" class="mf-bay__btn mf-bay__btn--s mf-bay__plus" data-bay="tray-open" aria-label="More controls" aria-expanded="false">+</button>${ids.map((id) => `<button type="button" class="mf-bay__btn mf-bay__btn--s" data-pin="${id}" aria-label="Put ${labelOf(id)} on the HUD">${use(TRAY_ICON[id] ?? 'plus')}</button>`).join('')}`
        : '';
    }
    this.tray.hidden = ids.length === 0 || !this.card.hidden;
    if (this.tray.hidden) return;
    const safe = this.host.safe.getBoundingClientRect();
    const box = { w: safe.width, h: safe.height };
    const need = 58 + ids.length * 50;
    // no stretch wide enough (Claw's slot, a short phone): the tray folds to its +, and opens over the HUD
    const full = trayAt(discs, box, need);
    const spot = full ?? trayAt(discs, box, 58);
    const tight = !full;
    this.tray.classList.toggle('is-tight', tight);
    if (!tight) this.tray.classList.remove('is-open');
    this.tray.querySelector('[data-bay="tray-open"]')?.setAttribute('aria-expanded', String(this.tray.classList.contains('is-open')));
    const width = tight && !this.tray.classList.contains('is-open') ? 58 : need;
    const root = this.host.root.getBoundingClientRect();
    const x = spot ? spot.x + (spot.width - 58) / 2 : (box.w - 58) / 2;
    const left = Math.min(Math.max(4, tight ? x - (width - 58) / 2 : (full?.x ?? x)), box.w - width - 4);
    this.tray.style.left = `${(left + safe.left - root.left).toFixed(1)}px`;
  }

  destroy(): void {
    this.offKey();
    this.backdrop.remove();
    this.ui.remove();
  }
}
