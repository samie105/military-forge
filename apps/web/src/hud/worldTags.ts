/**
 * World-space labels (round two's weapons-in-the-world screen, data-screen="weapons-world"): a tag
 * over every item lying on the map, in the HUD's DOM at the item's point on screen.
 *
 *   - a lone crate (the map's spawners) or item: the kit's crate label, its gun's glyph, name and
 *     family, on a stem over the crate (.crate__float);
 *   - the test armory's rack (crates 0.8 m apart, too close for a tag each): the kit's paper name
 *     tags, only for the guns within a few metres of you (they read as you walk along it), on two
 *     rows so neighbours don't overlap, and the rack's sign over the rack while you're near it.
 *
 * They stand LIFT m over the floor (above a soldier's head, so they never cover one), skip the crate
 * you stand on (the swap card says it) and hide where a HUD plate is (the swap card, the corners).
 * Positions come from the game's camera (HudInput.toScreen, window pixels) in the HUD's design
 * pixels (÷ --hud-fit), by transform, so moving them costs no layout.
 */
import { grenades, pickups as pickupDefs, weapons, type PickupDef } from '@military-forge/content';
import { iconHref, weaponIcon } from '../ui/icons';
import { drawButtonCap } from '../gamepad/caps';
import { currentPadFamily } from '../gamepad/device';
import { logicalRect, viewport, type Box } from '../ui/landscape';
import type { PickupView } from '../view';
import { weaponFamily } from './model';

/** Crates closer than this (m) along the floor are a rack (the armory's are 0.8 m apart). */
export const RACK_GAP = 1.2;
/** The rack's tags show for the guns this close to you (m). */
export const RACK_NEAR = 1.7;
/** The rack's sign shows while you're this close to the rack (m). */
export const SIGN_NEAR = 7;
/** A crate this close to you (m, along the floor) is the one you stand on: no tag (the swap card says it). */
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
}

/**
 * Which items get which tag: rack crates (a weapon crate with another within RACK_GAP at the same
 * height) only near `me`, everything else always; and where the rack's sign goes (over the middle of
 * the rack's crates you're near), null when you're not near one.
 */
export function planTags(items: readonly PickupView[], me: { x: number; y: number } | null): { tags: TagPlan[]; sign: { x: number; y: number } | null } {
  const tags: TagPlan[] = [];
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
    // the crate you stand on: the swap card says it
    if (me && Math.abs(k.x - me.x) < UNDERFOOT && Math.abs(k.y - me.y) < 1) continue;
    if (!rack.has(k.id)) {
      tags.push({ id: k.id, kind: 'crate', row: 0, def, x: k.x, y: k.y });
      continue;
    }
    if (!me) continue;
    const dx = Math.abs(k.x - me.x);
    const dy = Math.abs(k.y - me.y);
    if (dx < SIGN_NEAR && dy < 3) {
      signL = Math.min(signL, k.x);
      signR = Math.max(signR, k.x);
      signY = Math.max(signY, k.y);
    }
    if (dx <= RACK_NEAR && dy < 2.5) tags.push({ id: k.id, kind: 'rack', row: Math.round(k.x / 0.8) % 2 === 0 ? 0 : 1, def, x: k.x, y: k.y });
  }
  return { tags, sign: signL <= signR ? { x: (signL + signR) / 2, y: signY } : null };
}

/** The tag's words: the gun's name and family, or the item's name (a shield, a grenade pair). */
export function tagWords(def: PickupDef): { name: string; family: string; icon: string } {
  if (def.kind === 'weapon' && def.weapon !== undefined) {
    const w = weapons[def.weapon];
    return { name: w?.name ?? def.name, family: weaponFamily(w), icon: iconHref(weaponIcon(w?.id) ?? 'armory') };
  }
  if (def.kind === 'grenades' && def.grenade !== undefined) return { name: def.name, family: 'Grenades', icon: iconHref(`g-${grenades[def.grenade]?.id ?? 'frag'}`) };
  return { name: def.name, family: 'Item', icon: iconHref('shield') };
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

interface Shown {
  el: HTMLElement;
  key: string;
  at: string;
  /** its size in the HUD's design pixels (measured once) */
  w: number;
  h: number;
}

export class WorldTags {
  private readonly shown = new Map<number, Shown>();
  private readonly sign: HTMLElement;
  private signAt = '';
  private signKey = '';
  private signSize: { w: number; h: number } | null = null;
  /** the rack's first row's height (design px), for the second row */
  private rowH = 0;
  private plates: Box[] = [];
  private platesAt = -Infinity;

  constructor(private readonly layer: HTMLElement) {
    this.sign = document.createElement('div');
    this.sign.className = 'mf-rack-sign';
    this.sign.hidden = true;
    layer.appendChild(this.sign);
  }

  /**
   * This frame's tags. `toScreen` is the game camera's (window pixels; it may hand back a shared
   * object), `fit` the HUD's zoom, `interactKey` the Take key's cap for the rack's sign; `hidden`
   * clears them (no match on screen, spectating, a menu over the game).
   */
  update(items: readonly PickupView[] | undefined, me: { x: number; y: number; alive: boolean } | null, toScreen: (x: number, y: number) => { x: number; y: number }, fit: number, interactKey: string, hidden: boolean, interactCode?: string): void {
    const plan = hidden || !items?.length ? { tags: [], sign: null } : planTags(items, me?.alive ? me : null);
    const { w, h } = viewport(); // the page's own size (an upright phone plays turned: ui/landscape.ts)
    const plates = this.plateRects();
    const seen = new Set<number>();
    for (const t of plan.tags) {
      const s = toScreen(t.x, t.y + LIFT);
      const sx = s.x;
      const sy = s.y;
      if (sx < -200 || sx > w + 200 || sy < -200 || sy > h + 200) continue;
      seen.add(t.id);
      const key = `${t.kind}:${t.row}:${t.def.id}`;
      let shown = this.shown.get(t.id);
      if (!shown || shown.key !== key) {
        shown?.el.remove();
        shown = { el: this.build(t), key, at: '', w: 0, h: 0 };
        this.shown.set(t.id, shown);
        this.layer.appendChild(shown.el);
      }
      if (!shown.h) {
        shown.w = shown.el.offsetWidth;
        shown.h = shown.el.offsetHeight;
        if (t.kind === 'rack' && t.row === 0) this.rowH = Math.max(this.rowH, shown.h);
      }
      // the rack's second row stands on the first (its height measured: Text size grows it)
      const x = sx / fit;
      const y = sy / fit - (t.row === 1 ? this.rowH + 6 : 0);
      const box = { l: (x - shown.w / 2) * fit, r: (x + shown.w / 2) * fit, t: (y - shown.h) * fit, b: y * fit };
      const clear = !plates.some((p) => box.l < p.right && box.r > p.left && box.t < p.bottom && box.b > p.top);
      const at = clear ? `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` : 'hidden';
      if (at !== shown.at) {
        shown.at = at;
        if (clear) shown.el.style.transform = at;
        shown.el.style.visibility = clear ? '' : 'hidden';
      }
    }
    for (const [id, s] of this.shown) {
      if (seen.has(id)) continue;
      s.el.remove();
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
      b.textContent = 'Test armory';
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

  /** The HUD's plates on screen now (the swap card, the corners, the clock): the tags keep off them. Read every 200 ms. */
  private plateRects(): Box[] {
    const now = performance.now();
    if (now - this.platesAt < 200) return this.plates;
    this.platesAt = now;
    const screen = this.layer.closest('.screen');
    if (!screen) return (this.plates = []);
    this.plates = [...screen.querySelectorAll<HTMLElement>('.pickup, .hud-bl, .hud-br .plate, .hud-match .plate, .hud-tl .plate')]
      .map((el) => logicalRect(el))
      .filter((r) => r.width > 0 && r.height > 0);
    return this.plates;
  }

  dispose(): void {
    for (const s of this.shown.values()) s.el.remove();
    this.shown.clear();
    this.sign.remove();
  }

  private build(t: TagPlan): HTMLElement {
    const words = tagWords(t.def);
    const wrap = document.createElement('div');
    if (t.kind === 'rack') {
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
    wrap.className = 'mf-wtag mf-wtag--crate crate__float';
    const label = document.createElement('span');
    label.className = 'crate__label';
    label.appendChild(icon(words.icon, t.def.kind === 'weapon' ? 'ic--kf' : 'ic ic--sm'));
    const b = document.createElement('b');
    b.textContent = words.name;
    const fam = document.createElement('span');
    fam.textContent = words.family;
    label.append(b, fam);
    wrap.append(label, document.createElement('i'));
    return wrap;
  }
}
