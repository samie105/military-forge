/**
 * What the v3 gestures and the teaching draw over the controls (touch-controls-v3.md), in the kit's
 * parts and the shared motion: the grenade belt's fan, the gun pill's radial, a first-time hint chip
 * and the "Learn the controls" plate. Positions are the safe box's (the controls' centres, from the
 * controller); nothing here reads a pointer.
 */
import { grenades } from '@military-forge/content';
import { iconHref } from '../ui/icons';
import type { RadialChoice, Vec } from './gestures';
import { drillHow, type Drill, type DrillContext, type Hint } from './teach';
import { FIRE_MODE_TEXT, fireArt } from './fireArt';
import { FIRE_MODES, type FireMode } from './settings';

const svg = (href: string, cls = 'ic ic--sm') => `<svg class="${cls}" aria-hidden="true"><use href="${href}"/></svg>`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export interface RadialItem extends RadialChoice {
  label: string;
  /** an icon href (#icon-…) */
  icon: string;
  /** a gun icon (wide) or a glyph */
  wide?: boolean;
}

export class TouchOverlays {
  readonly layer: HTMLDivElement;
  private readonly fan: HTMLDivElement;
  private readonly radial: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly cue: HTMLDivElement;
  readonly plate: HTMLDivElement;
  private readonly chooser: HTMLDivElement;
  private onChoose: ((m: FireMode) => void) | null = null;
  private fanTimer = 0;
  private hintTimer = 0;
  private radialItems: RadialItem[] = [];

  constructor(parent: HTMLElement, onSkip: () => void, onClose: () => void) {
    this.layer = el('mf-touch-fx', parent);
    this.fan = el('mf-fan plate', this.layer);
    this.fan.hidden = true;
    this.radial = el('mf-radial', this.layer);
    this.radial.hidden = true;
    this.hint = el('mf-hintchip', this.layer);
    this.hint.hidden = true;
    this.hint.setAttribute('role', 'status');
    this.cue = el('mf-cue', this.layer);
    this.cue.hidden = true;
    this.cue.setAttribute('role', 'status');
    this.plate = el('mf-drill plate', this.layer);
    this.plate.hidden = true;
    this.plate.setAttribute('role', 'region');
    this.plate.setAttribute('aria-label', 'Learn the controls');
    this.chooser = el('mf-choose plate', this.layer);
    this.chooser.hidden = true;
    this.chooser.setAttribute('role', 'dialog');
    this.chooser.setAttribute('aria-label', 'How do you want to shoot?');
    this.chooser.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-fire]');
      if (b && this.onChoose) this.onChoose(b.dataset.fire as FireMode);
    });
    this.plate.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLElement>('[data-drill]');
      if (b?.dataset.drill === 'skip') onSkip();
      else if (b?.dataset.drill === 'close') onClose();
    });
  }

  // ---- the grenade belt ----

  /**
   * The belt fanned beside the grenade button: every type carried, the one in hand marked, the one a
   * scrub lands on lined up with the button. `side`: which side of the button it opens on.
   */
  showFan(at: Vec, radius: number, types: readonly number[], counts: readonly number[], current: number, landing: number, side: 'left' | 'right'): void {
    window.clearTimeout(this.fanTimer);
    const row = 34;
    const rows = types
      .map((t, i) => {
        const g = grenades[t];
        const cls = ['mf-fan__row', t === current ? 'is-held' : '', t === landing ? 'is-landing' : ''].filter(Boolean).join(' ');
        return `<li class="${cls}" style="--i:${i}">${svg(iconHref(`g-${g?.id ?? 'frag'}`), 'ic ic--fill ic--sm')}<span>${esc(g?.name ?? '')}</span><b class="num">${counts[t] ?? 0}</b></li>`;
      })
      .join('');
    const idx = Math.max(0, types.indexOf(landing));
    this.fan.innerHTML = `<ul style="translate: 0 ${(-idx * row).toFixed(0)}px">${rows}</ul>${types.length < 2 ? '<p>Pick up another type to switch</p>' : ''}`;
    this.fan.dataset.side = side;
    this.fan.style.left = `${(side === 'left' ? at.x - radius - 10 : at.x + radius + 10).toFixed(0)}px`;
    this.fan.style.top = `${(at.y - row / 2).toFixed(0)}px`;
    if (this.fan.hidden) {
      this.fan.hidden = false;
      this.fan.classList.remove('is-leaving');
    }
  }

  hideFan(afterMs = 0): void {
    window.clearTimeout(this.fanTimer);
    this.fanTimer = window.setTimeout(() => {
      this.fan.classList.add('is-leaving');
      this.fanTimer = window.setTimeout(() => (this.fan.hidden = true), 180);
    }, afterMs);
  }

  // ---- the gun pill's radial ----

  /** The radial round the pill at `at`; `spots`: each choice's place (gestures.ts radialSpots). */
  showRadial(at: Vec, items: RadialItem[], spots: readonly Vec[], pick: number): void {
    this.radialItems = items;
    this.radial.innerHTML =
      items
        .map((it, i) => {
          const x = spots[i]!.x - at.x;
          const y = spots[i]!.y - at.y;
          return `<span class="mf-radial__it${it.wide ? ' is-wide' : ''}" data-i="${i}" style="left:${x.toFixed(0)}px;top:${y.toFixed(0)}px">${it.icon ? svg(it.icon, it.wide ? 'ic--kf' : 'ic') : ''}<b>${esc(it.label)}</b></span>`;
        })
        .join('');
    this.radial.style.left = `${at.x.toFixed(0)}px`;
    this.radial.style.top = `${at.y.toFixed(0)}px`;
    this.radial.hidden = false;
    this.pickRadial(pick);
  }

  pickRadial(pick: number): void {
    for (const it of this.radial.querySelectorAll<HTMLElement>('.mf-radial__it')) it.classList.toggle('is-picked', Number(it.dataset.i) === pick);
  }

  hideRadial(): void {
    this.radial.hidden = true;
    this.radialItems = [];
  }

  get radialOpen(): boolean {
    return !this.radial.hidden && this.radialItems.length > 0;
  }

  // ---- a first-time hint ----

  showHint(h: Hint, at: Vec, radius: number, ms = 6000): void {
    window.clearTimeout(this.hintTimer);
    this.hint.textContent = h.text;
    this.hint.dataset.side = h.side;
    const gap = radius + 10;
    const x = h.side === 'left' ? at.x - gap : h.side === 'right' ? at.x + gap : at.x;
    const y = h.side === 'above' ? at.y - gap : h.side === 'below' ? at.y + gap : at.y;
    this.hint.style.left = `${x.toFixed(0)}px`;
    this.hint.style.top = `${y.toFixed(0)}px`;
    this.hint.hidden = false;
    this.hintTimer = window.setTimeout(() => this.hideHint(), ms);
  }

  hideHint(): void {
    window.clearTimeout(this.hintTimer);
    this.hint.hidden = true;
  }

  get hintShown(): boolean {
    return !this.hint.hidden;
  }

  // ---- a moment's cue by a control ("Shield broken") ----

  private cueTimer = 0;

  showCue(text: string, icon: string, at: Vec, radius: number, ms = 2200): void {
    window.clearTimeout(this.cueTimer);
    this.cue.innerHTML = `${svg(icon)}<b>${esc(text)}</b>`;
    this.cue.style.left = `${(at.x - radius - 10).toFixed(0)}px`;
    this.cue.style.top = `${at.y.toFixed(0)}px`;
    this.cue.hidden = false;
    this.cue.classList.remove('m-p7');
    void this.cue.offsetWidth;
    this.cue.classList.add('m-p7');
    this.cueTimer = window.setTimeout(() => (this.cue.hidden = true), ms);
  }

  // ---- the first-run fire chooser (§4.10.1) ----

  /** "How do you want to shoot?": the four modes with their pictures; a tap picks one (and closes it). */
  showChooser(current: FireMode, onPick: (m: FireMode) => void): void {
    this.onChoose = (m) => {
      this.onChoose = null;
      this.chooser.hidden = true;
      onPick(m);
    };
    const cards = FIRE_MODES.map((m) => {
      const t = FIRE_MODE_TEXT[m];
      const tag = m === 'auto' ? '<span class="mf-choose__tag">Recommended</span>' : '';
      return `<button type="button" class="mf-choose__opt${m === current ? ' is-on' : ''}" data-fire="${m}" aria-pressed="${m === current}">${fireArt(m)}<b>${esc(t.name)}</b>${tag}<span>${esc(t.line)}</span></button>`;
    }).join('');
    this.chooser.innerHTML = `<b class="mf-choose__t">How do you want to shoot?</b><div class="mf-choose__opts">${cards}</div><p class="mf-choose__note">Change it any time in Settings → Touch.</p>`;
    this.chooser.hidden = false;
  }

  get choosing(): boolean {
    return !this.chooser.hidden;
  }

  /** The choice was made elsewhere (Settings): the card goes without picking. */
  hideChooser(): void {
    this.onChoose = null;
    this.chooser.hidden = true;
  }

  // ---- the drill's plate ----

  /** the plate's last content: it's rebuilt only when that changes */
  private plateHtml = '';

  /**
   * The plate, rebuilt only when what it says changes, and then only its words: the plate takes
   * touches (a stick can start on it), and an element taken out from under a thumb can lose that
   * thumb's pointerup in WebKit, leaving the stick pushed (QA, 23 Oct: qa-bullets-lag-touch.md §3 M).
   * Its frame and its buttons stay put.
   */
  showDrill(d: Drill, how: DrillContext = { fire: 'pull', stickJet: true, preset: 'classic' }): void {
    const s = d.step;
    const n = d.steps.length;
    const parts = s
      ? {
          eyebrow: `Drill · ${d.index + 1}/${n}`,
          close: 'Close the drill',
          goal: esc(s.goal),
          how: esc(drillHow(s, how)),
          dots: d.steps.map((st, i) => (d.ticked.has(st.id) ? 'is-done' : d.skipped.has(st.id) ? 'is-skipped' : i === d.index ? 'is-now' : '')),
          done: !!d.justTicked,
          skip: true,
        }
      : { eyebrow: 'Learn the controls', close: 'Close', goal: `${svg('#icon-check')} All done`, how: 'Replay it any time: Settings → Touch → Learn the controls.', dots: [], done: false, skip: false };
    const key = JSON.stringify(parts);
    this.plate.hidden = false;
    if (key === this.plateHtml) return;
    this.plateHtml = key;
    if (!this.plate.firstChild) {
      this.plate.innerHTML = `<div class="mf-drill__top"><span class="eyebrow"></span><button type="button" class="btn btn--ghost btn--icon btn--sm" data-drill="close">${svg('#icon-close')}</button></div>
<b class="mf-drill__goal"></b><p class="mf-drill__how"></p>
<div class="mf-drill__foot"><span class="mf-drill__dots" aria-hidden="true"></span><span class="mf-drill__done"></span><button type="button" class="btn btn--ghost btn--sm" data-drill="skip">Skip</button></div>`;
    }
    const q = <T extends Element>(sel: string) => this.plate.querySelector<T>(sel)!;
    q('.mf-drill__top .eyebrow').textContent = parts.eyebrow;
    q('[data-drill="close"]').setAttribute('aria-label', parts.close);
    q('.mf-drill__goal').innerHTML = parts.goal;
    q('.mf-drill__how').innerHTML = parts.how;
    // the dots: the same <i>s while the count holds, only their classes change
    const dots = q<HTMLElement>('.mf-drill__dots');
    if (dots.children.length !== parts.dots.length) dots.innerHTML = parts.dots.map(() => '<i></i>').join('');
    parts.dots.forEach((cls, i) => (dots.children[i]!.className = cls));
    const done = q<HTMLElement>('.mf-drill__done');
    const had = done.childElementCount > 0;
    if (parts.done !== had) done.innerHTML = parts.done ? `<span class="mf-drill__tick m-p7">${svg('#icon-check')}Done</span>` : '';
    q<HTMLElement>('[data-drill="skip"]').hidden = !parts.skip;
  }

  hideDrill(): void {
    this.plate.hidden = true;
  }

  clear(): void {
    this.hideHint();
    this.hideRadial();
    this.fan.hidden = true;
  }
}

function el(className: string, parent: HTMLElement): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  parent.append(d);
  return d;
}
