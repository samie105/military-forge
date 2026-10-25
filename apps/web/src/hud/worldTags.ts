/**
 * World-space labels (round two's weapons-in-the-world screen, data-screen="weapons-world", made
 * game-grade for the owner's 23 Oct ask: "the guns on the ground … so users have more views"): a tag
 * over every item lying on the map, in the HUD's DOM at the item's point on screen.
 *
 *   - a lone crate (the map's spawners), a dropped gun or an item: a tag on a fading stem: the gun's glyph, its short name, its class chip, its mag and how far it is ("30 rd ·
 *     14 m"); a power weapon's tag in brass. It shrinks and fades with distance (model.ts tagFade:
 *     full size to 6 m, 0.72× and 45 % at 30 m, gone past 48 m), so the near ones read first;
 *   - the test armory's rack (crates 0.8 m apart, too close for a tag each): the kit's paper name
 *     tags, only for the guns within a few metres of you (they read as you walk along it), on two
 *     rows so neighbours don't overlap, and the rack's sign over the rack while you're near it.
 *
 * They stand LIFT m over the floor (above a soldier's head, so they never cover one), skip the crate
 * you stand on (the compare card says it) and hide where a HUD plate is (the cards, the corners).
 * Positions come from the game's camera (HudInput.toScreen, window pixels) in the HUD's design
 * pixels (÷ the screen's fit), by transform; a tag's element is written only when its step of
 * position, size or strength changes, and the elements are pooled (reused, never rebuilt per item).
 * The phone (PHONE_TAGS) shows the nearest few only, and keeps them off the touch controls too.
 */
import { GRENADE_PICKUP_COUNT, POWER_WEAPONS, grenades, pickups as pickupDefs, weapons, type PickupDef } from '@military-forge/content';
import { iconHref, weaponIcon } from '../ui/icons';
import { drawButtonCap } from '../gamepad/caps';
import { currentPadFamily } from '../gamepad/device';
import { logicalRect, viewport, type Box } from '../ui/landscape';
import type { PickupView } from '../view';
import { tagDistance, tagFade, weaponFamily } from './model';

/** Crates closer than this (m) along the floor are a rack (the armory's are 0.8 m apart). */
export const RACK_GAP = 1.2;
/** The rack's tags show for the guns this close to you (m). */
export const RACK_NEAR = 1.7;
/** The rack's sign shows while you're this close to the rack (m). */
export const SIGN_NEAR = 7;
/** A crate this close to you (m, along the floor) is the one you stand on: no tag (the compare card says it). */
export const UNDERFOOT = 0.4;
/** Tags sit this high over the floor (m): above a soldier's head, so they never cover one. */
export const LIFT = 2.1;
/** The rack's sign sits this much higher (m). */
export const SIGN_LIFT = 3.3;

export interface TagPlan {
  id: number;
  kind: 'crate' | 'rack';
  /** the rack's tags alternate between two heights */
  row: 0 | 1;
  def: PickupDef;
  x: number;
  y: number;
  /** from you, m (Infinity when there's no you) */
  distance: number;
}

export interface TagOptions {
  /** at most this many crate tags, the nearest first (Infinity: every one) */
  max: number;
  /** the screen's plates the tags keep off (selectors inside the tags' screen) */
  plates: string;
  /** and these anywhere on the page (the phone's touch controls) */
  pagePlates?: string;
  /** the rack's paper tags and sign (the desktop) */
  rack: boolean;
  /** how often the plates are measured (ms): the phone less often (its controls move only in the editor) */
  platesEvery: number;
}

/** The desktop: every tag, the rack's paper tags and sign. */
export const DESKTOP_TAGS: TagOptions = { max: Infinity, plates: '.pickup, .hud-bl, .hud-br .plate, .hud-match .plate, .hud-tl .plate, .mf-ev > :not([hidden]), .mf-kc', rack: true, platesEvery: 200 };
/** The phone: the nearest four, clear of the HUD's plates and the touch controls; the rack's tags as crate tags near you. */
export const PHONE_TAGS: TagOptions = { max: 4, plates: '.pt-clock, .pt-feed, .pt-cue, .respawn, .pt-cmp, .pt-draw, .pt-pickup, .mf-ev > :not([hidden])', pagePlates: '.mf-touch .mf-ctl', rack: false, platesEvery: 600 };

/**
 * Which items get which tag: rack crates (a weapon crate with another within RACK_GAP at the same
 * height) only near `me`, everything else always; and where the rack's sign goes (over the middle of
 * the rack's crates you're near), null when you're not near one. Without the rack (the phone), a rack
 * crate near you is a crate tag like any other. `max` keeps the nearest crate tags.
 */
export function planTags(items: readonly PickupView[], me: { x: number; y: number } | null, options: Pick<TagOptions, 'max' | 'rack'> = DESKTOP_TAGS): { tags: TagPlan[]; sign: { x: number; y: number } | null } {
  const crateTags: TagPlan[] = [];
  const rackTags: TagPlan[] = [];
  const crates = items.filter((k) => pickupDefs[k.def]?.kind === 'weapon').sort((a, b) => a.x - b.x);
  const rack = new Set<number>();
  for (let i = 0; i < crates.length; i++) {
    const a = crates[i]!;
    for (const b of [crates[i - 1], crates[i + 1]]) if (b && Math.abs(b.x - a.x) < RACK_GAP && Math.abs(b.y - a.y) < 0.5) rack.add(a.id);
  }
  let signL = Infinity;
  let signR = -Infinity;
  let signY = -Infinity;
  for (const k of items) {
    const def = pickupDefs[k.def];
    if (!def) continue;
    // the crate you stand on: the compare card says it
    if (me && Math.abs(k.x - me.x) < UNDERFOOT && Math.abs(k.y - me.y) < 1) continue;
    const distance = me ? Math.hypot(k.x - me.x, k.y - me.y) : Infinity;
    if (!rack.has(k.id)) {
      crateTags.push({ id: k.id, kind: 'crate', row: 0, def, x: k.x, y: k.y, distance });
      continue;
    }
    if (!me) continue;
    const dx = Math.abs(k.x - me.x);
    const dy = Math.abs(k.y - me.y);
    if (!options.rack) {
      if (dx <= RACK_NEAR && dy < 2.5) crateTags.push({ id: k.id, kind: 'crate', row: 0, def, x: k.x, y: k.y, distance });
      continue;
    }
    if (dx < SIGN_NEAR && dy < 3) {
      signL = Math.min(signL, k.x);
      signR = Math.max(signR, k.x);
      signY = Math.max(signY, k.y);
    }
    if (dx <= RACK_NEAR && dy < 2.5) rackTags.push({ id: k.id, kind: 'rack', row: Math.round(k.x / 0.8) % 2 === 0 ? 0 : 1, def, x: k.x, y: k.y, distance });
  }
  const near = Number.isFinite(options.max) ? [...crateTags].sort((a, b) => a.distance - b.distance).slice(0, options.max) : crateTags;
  return { tags: [...near, ...rackTags], sign: options.rack && signL <= signR ? { x: (signL + signR) / 2, y: signY } : null };
}

/** The tag's words: the gun's name (its family and mag ("30 rd") for the cards; the tag shows the name only), a grenade pair's count ("×2", by its type's icon), "Shield". */
export function tagWords(def: PickupDef): { name: string; family: string; icon: string; ammo: string; power: boolean; kind: 'gun' | 'grenades' | 'shield' } {
  if (def.kind === 'weapon' && def.weapon !== undefined) {
    const w = weapons[def.weapon];
    const melee = w?.fireMode === 'melee';
    return { name: w?.name ?? def.name, family: weaponFamily(w), icon: iconHref(weaponIcon(w?.id) ?? 'armory'), ammo: w && !melee ? `${w.mag} rd` : '', power: !!w && POWER_WEAPONS.has(w.id), kind: 'gun' };
  }
  if (def.kind === 'grenades' && def.grenade !== undefined) return { name: `×${GRENADE_PICKUP_COUNT}`, family: 'Grenades', icon: iconHref(`g-${grenades[def.grenade]?.id ?? 'frag'}`), ammo: '', power: false, kind: 'grenades' };
  return { name: 'Shield', family: 'Item', icon: iconHref('shield'), ammo: '', power: false, kind: 'shield' };
}

const SVG = 'http://www.w3.org/2000/svg';

function icon(ref: string, className: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', ref);
  svg.appendChild(use);
  return svg;
}

/** One pooled crate tag's parts, filled in place when it's reused for another item. */
interface CrateEl {
  el: HTMLElement;
  use: SVGUseElement;
  svg: SVGSVGElement;
  name: HTMLElement;
  cls: HTMLElement;
  meta: HTMLElement;
}

interface Shown {
  el: HTMLElement;
  crate: CrateEl | null;
  key: string;
  at: string;
  meta: string;
  opacity: string;
  /** its size in the HUD's design pixels at scale 1 (measured once per fill) */
  w: number;
  h: number;
}

export class WorldTags {
  private readonly shown = new Map<number, Shown>();
  /** crate tags not in use, kept in the layer (hidden) for the next item */
  private readonly pool: CrateEl[] = [];
  private readonly sign: HTMLElement;
  private signAt = '';
  private signKey = '';
  private signSize: { w: number; h: number } | null = null;
  /** the rack's first row's height (design px), for the second row */
  private rowH = 0;
  private plates: Box[] = [];
  private platesAt = -Infinity;

  constructor(
    private readonly layer: HTMLElement,
    private readonly options: TagOptions = DESKTOP_TAGS,
  ) {
    this.sign = document.createElement('div');
    this.sign.className = 'mf-rack-sign';
    this.sign.hidden = true;
    layer.appendChild(this.sign);
  }

  /**
   * This frame's tags. `toScreen` is the game camera's (window pixels; it may hand back a shared
   * object), `fit` the HUD's zoom, `interactKey` the Take key's cap for the rack's sign; `hidden`
   * clears them (no match on screen, spectating, a menu over the game, the other screen showing).
   */
  update(items: readonly PickupView[] | undefined, me: { x: number; y: number; alive: boolean } | null, toScreen: (x: number, y: number) => { x: number; y: number }, fit: number, interactKey: string, hidden: boolean, interactCode?: string): void {
    if ((hidden || !items?.length) && this.shown.size === 0 && this.sign.hidden) return;
    const plan = hidden || !items?.length ? { tags: [], sign: null } : planTags(items, me?.alive ? me : null, this.options);
    const { w, h } = viewport(); // the page's own size (an upright phone plays turned: ui/landscape.ts)
    const plates = plan.tags.length || plan.sign ? this.plateRects() : [];
    const seen = new Set<number>();
    // nearest first: a tag that would sit on a nearer one's hides (no two tags in a pile)
    const order = [...plan.tags].sort((a, b) => a.distance - b.distance);
    const placed: Box[] = [];
    for (const t of order) {
      const fade = t.kind === 'crate' ? tagFade(t.distance) : { scale: 1, opacity: 1 };
      if (!fade) continue;
      const s = toScreen(t.x, t.y + LIFT);
      const sx = s.x;
      const sy = s.y;
      if (sx < -200 || sx > w + 200 || sy < -200 || sy > h + 200) continue;
      seen.add(t.id);
      const key = `${t.kind}:${t.row}:${t.def.id}`;
      let shown = this.shown.get(t.id);
      if (!shown || shown.key !== key) {
        if (shown) this.release(shown);
        shown = this.take(t, key);
        this.shown.set(t.id, shown);
      }
      // the distance (and the mag) in words, rewritten only when its step changes
      if (shown.crate) {
        const words = tagWords(t.def);
        const meta = [words.ammo, Number.isFinite(t.distance) ? tagDistance(t.distance) : ''].filter(Boolean).join(' · ');
        if (meta !== shown.meta) {
          shown.meta = meta;
          shown.crate.meta.textContent = meta;
          shown.crate.meta.hidden = meta === '';
        }
      }
      if (!shown.h) {
        shown.w = shown.el.offsetWidth;
        shown.h = shown.el.offsetHeight;
        if (t.kind === 'rack' && t.row === 0) this.rowH = Math.max(this.rowH, shown.h);
      }
      // the rack's second row stands on the first (its height measured: Text size grows it)
      const x = sx / fit;
      const y = sy / fit - (t.row === 1 ? this.rowH + 6 : 0);
      const tw = shown.w * fade.scale;
      const th = shown.h * fade.scale;
      const box = { l: (x - tw / 2) * fit, r: (x + tw / 2) * fit, t: (y - th) * fit, b: y * fit };
      const hits = (p: Box) => box.l < p.right && box.r > p.left && box.t < p.bottom && box.b > p.top;
      const clear = !plates.some(hits) && (t.kind === 'rack' || !placed.some(hits));
      if (clear && t.kind === 'crate') placed.push({ left: box.l, right: box.r, top: box.t, bottom: box.b, width: box.r - box.l, height: box.b - box.t });
      const at = clear ? `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)${fade.scale !== 1 ? ` scale(${fade.scale})` : ''}` : 'hidden';
      if (at !== shown.at) {
        shown.at = at;
        if (clear) shown.el.style.transform = at;
        shown.el.style.visibility = clear ? '' : 'hidden';
      }
      const opacity = fade.opacity === 1 ? '' : String(fade.opacity);
      if (opacity !== shown.opacity) {
        shown.opacity = opacity;
        shown.el.style.opacity = opacity;
      }
    }
    for (const [id, s] of this.shown) {
      if (seen.has(id)) continue;
      this.release(s);
      this.shown.delete(id);
    }
    // the rack's sign: over the rack's crates you're near, unless a HUD plate is there
    if (!plan.sign) {
      this.sign.hidden = true;
      return;
    }
    const signKey = `${interactKey}:${interactCode ?? ''}:${currentPadFamily()}`;
    if (this.signKey !== signKey) {
      this.signKey = signKey;
      this.signSize = null;
      this.sign.innerHTML = '';
      const b = document.createElement('b');
      b.className = 'display';
      b.textContent = 'Weapon rack';
      const line = document.createElement('span');
      line.append('Walk up to any gun · ');
      const kbd = document.createElement('kbd');
      kbd.className = 'kbd';
      drawButtonCap(kbd, interactCode, interactKey || 'E');
      line.append(kbd, ' to take it');
      this.sign.append(b, line);
    }
    this.sign.hidden = false;
    const s = toScreen(plan.sign.x, plan.sign.y + SIGN_LIFT);
    const x = s.x / fit;
    const y = s.y / fit - (this.rowH ? this.rowH + 6 : 0);
    if (!this.signSize) this.signSize = { w: this.sign.offsetWidth, h: this.sign.offsetHeight };
    const box = { l: (x - this.signSize.w / 2) * fit, r: (x + this.signSize.w / 2) * fit, t: (y - this.signSize.h) * fit, b: y * fit };
    const clear = !plates.some((p) => box.l < p.right && box.r > p.left && box.t < p.bottom && box.b > p.top);
    this.sign.style.visibility = clear ? '' : 'hidden';
    const at = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    if (at !== this.signAt) {
      this.signAt = at;
      this.sign.style.transform = at;
    }
  }

  /** The HUD's plates on screen now (the cards, the corners, the clock; the phone's controls): the tags keep off them. Read every `platesEvery` ms. */
  private plateRects(): Box[] {
    const now = performance.now();
    if (now - this.platesAt < this.options.platesEvery) return this.plates;
    this.platesAt = now;
    const screen = this.layer.closest('.screen');
    const els = [...(screen?.querySelectorAll<HTMLElement>(this.options.plates) ?? []), ...(this.options.pagePlates ? document.querySelectorAll<HTMLElement>(this.options.pagePlates) : [])];
    this.plates = els.map((el) => logicalRect(el)).filter((r) => r.width > 0 && r.height > 0);
    return this.plates;
  }

  dispose(): void {
    for (const s of this.shown.values()) s.el.remove();
    this.shown.clear();
    for (const c of this.pool.splice(0)) c.el.remove();
    this.sign.remove();
  }

  /** A tag for `t`: a crate tag from the pool (filled for this item) or a new one; a rack's paper tag. */
  private take(t: TagPlan, key: string): Shown {
    const shown: Shown = { el: null!, crate: null, key, at: '', meta: '', opacity: '', w: 0, h: 0 };
    if (t.kind === 'rack') {
      shown.el = this.rackTag(t);
      this.layer.appendChild(shown.el);
      return shown;
    }
    const c = this.pool.pop() ?? this.crateTag();
    const words = tagWords(t.def);
    c.el.className = `mf-wtag mf-wtag--crate mf-wtag--${words.kind}${words.power ? ' mf-wtag--power' : ''}`;
    c.svg.setAttribute('class', words.kind === 'gun' ? 'ic--kf' : 'ic ic--sm ic--fill');
    c.use.setAttribute('href', words.icon);
    c.name.textContent = words.name;
    c.cls.textContent = words.family;
    c.meta.textContent = '';
    c.meta.hidden = true;
    c.el.style.visibility = 'hidden';
    c.el.style.opacity = '';
    c.el.hidden = false;
    shown.el = c.el;
    shown.crate = c;
    return shown;
  }

  /** Back to the pool (a crate tag) or gone (a rack's tag). */
  private release(s: Shown): void {
    if (!s.crate) {
      s.el.remove();
      return;
    }
    s.el.hidden = true;
    this.pool.push(s.crate);
  }

  private crateTag(): CrateEl {
    const el = document.createElement('div');
    const plate = document.createElement('span');
    plate.className = 'mf-wtag__plate';
    const svg = icon('', 'ic--kf');
    const use = svg.firstElementChild as SVGUseElement;
    const name = document.createElement('b');
    name.className = 'mf-wtag__name';
    const cls = document.createElement('span');
    cls.className = 'mf-wtag__cls';
    const meta = document.createElement('span');
    meta.className = 'mf-wtag__meta num';
    plate.append(svg, name, cls, meta);
    const stem = document.createElement('i');
    stem.className = 'mf-wtag__stem';
    el.append(plate, stem);
    this.layer.appendChild(el);
    return { el, use, svg, name, cls, meta };
  }

  private rackTag(t: TagPlan): HTMLElement {
    const words = tagWords(t.def);
    const wrap = document.createElement('div');
    wrap.className = `mf-wtag mf-wtag--rack mf-wtag--row${t.row}`;
    const tag = document.createElement('span');
    tag.className = 'rack__tag';
    const b = document.createElement('b');
    b.textContent = words.name;
    const fam = document.createElement('span');
    fam.textContent = words.family;
    tag.append(b, fam);
    wrap.appendChild(tag);
    return wrap;
  }
}
