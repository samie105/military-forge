/**
 * The weapon quick-select (owner, 23 Oct: "the ui for the swapping guns … needs to be premium"): the
 * swap key (Q) or the pad's swap button (Y / △), tapped, swaps guns on its release, as before; held
 * past HOLD_MS it opens a wheel near the crosshair with the gun in hand, the slung gun and every
 * grenade type you carry. Point at one (the mouse, or the pad's aim stick), or step with the mouse
 * wheel, and let go (or click) to take it.
 *
 * Nothing new reaches the sim or the wire: a gun is picked with Input.weaponSelect (slot 1 or 2, the
 * digit keys' field), a grenade type with CycleGrenade presses (one every other tick, as touch's
 * belt swipe sends them), and a tap with a one-tick Btn.Swap. input.ts and the pad route the swap
 * button here instead of holding Btn.Swap; the HUD draws the wheel from `view` and tells it the
 * player's loadout (`observe`).
 */
import { NO_WEAPON, grenades, weapons } from '@military-forge/content';
import { Btn, type Input } from '@military-forge/sim';

/** Held this long (ms), the swap button opens the wheel instead of swapping on release. */
export const HOLD_MS = 200;
/** The pointer must move this far (CSS px) from where the wheel opened before it points at anything. */
export const POINT_DEADZONE = 26;

export type QuickItem = { kind: 'gun'; slot: number; def: number } | { kind: 'grenade'; type: number; count: number };

/** What the quick-select knows of the local player (the HUD hands it every frame). */
export interface QuickPlayer {
  alive: boolean;
  active: number;
  dual: boolean;
  weapons: readonly { def: number }[];
  grenadeType?: number;
  grenadeCounts?: readonly number[];
}

/** The wheel's items: the gun in hand, the slung gun, then each grenade type carried (the belt's order). */
export function quickItems(p: QuickPlayer | null): QuickItem[] {
  if (!p) return [];
  const items: QuickItem[] = [];
  const guns = p.weapons.map((w, slot) => ({ slot, def: w.def })).filter((g) => g.def !== NO_WEAPON && weapons[g.def]);
  const held = guns.find((g) => g.slot === p.active);
  if (held) items.push({ kind: 'gun', ...held });
  for (const g of guns) if (g !== held) items.push({ kind: 'gun', ...g });
  (p.grenadeCounts ?? []).forEach((count, type) => {
    if (count > 0 && grenades[type]) items.push({ kind: 'grenade', type, count });
  });
  return items;
}

/**
 * Which item a pointer at `angle` picks (radians, screen: 0 = right, y down): the items sit round the
 * wheel clockwise from the top, each owning an equal slice.
 */
export function itemAt(angle: number, count: number): number {
  if (count <= 0) return -1;
  const fromTop = (angle + Math.PI / 2 + 2 * Math.PI) % (2 * Math.PI); // 0 at the top, clockwise
  const slice = (2 * Math.PI) / count;
  return Math.floor(((fromTop + slice / 2) % (2 * Math.PI)) / slice) % count;
}

/**
 * The item a direction picks, by where the items are drawn: the one whose direction from the wheel's
 * centre is nearest `angle` (radians, screen). The wheel is an ellipse, so a drawn item's direction
 * isn't its slot's angle; picking by the drawn directions keeps what you point at and what lights up
 * the same.
 */
export function pickByAngle(angle: number, angles: readonly number[]): number {
  let best = -1;
  let bestD = Infinity;
  angles.forEach((a, i) => {
    const d = Math.abs(Math.atan2(Math.sin(angle - a), Math.cos(angle - a)));
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/** The wheel's drawn radii in the HUD's design px (hud.ts places each item at itemAngle on this ellipse). */
export const WHEEL_RX = 250;
export const WHEEL_RY = 180;

/** Where the wheel draws item `i` of `count`, from its centre, in design px (× the HUD's fit for page px). */
export function itemSpot(i: number, count: number): { x: number; y: number } {
  const a = itemAngle(i, count);
  return { x: Math.cos(a) * WHEEL_RX, y: Math.sin(a) * WHEEL_RY };
}

/** Where item `i` of `count` sits round the wheel (radians, screen), the middle of its slice. */
export function itemAngle(i: number, count: number): number {
  return -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, count);
}

/** CycleGrenade presses from the selected type to `target`: the sim cycles to the next type carried. */
export function cyclesTo(target: number, selected: number, counts: readonly number[]): number {
  const n = counts.length;
  if (n === 0 || target === selected || !(counts[target]! > 0)) return 0;
  let type = selected;
  for (let presses = 1; presses <= n; presses++) {
    // grenades.ts nextHeldGrenade
    let next = type;
    for (let k = 1; k < n; k++) {
      const t = (type + k) % n;
      if (counts[t]! > 0) {
        next = t;
        break;
      }
    }
    if (next === type) return 0;
    type = next;
    if (type === target) return presses;
  }
  return 0;
}

export interface QuickView {
  open: boolean;
  items: readonly QuickItem[];
  highlight: number;
  /** where it opened (CSS px, the page's): the reticle's place then */
  at: { x: number; y: number };
  /** 'key' (mouse and keyboard) or 'pad' */
  by: 'key' | 'pad';
}

export class QuickSelect {
  private downAt = -1;
  private by: 'key' | 'pad' = 'key';
  private openNow = false;
  private items: QuickItem[] = [];
  private highlight = 0;
  private at = { x: 0, y: 0 };
  /** where the wheel is drawn (its centre, page px, after the HUD keeps it on screen) and its items' directions from there */
  private drawn: { x: number; y: number; angles: number[] } | null = null;
  private player: QuickPlayer | null = null;
  /** the next samples' pulses: one Btn.Swap, a weapon slot, CycleGrenade presses (on, off, on…) */
  private swapPulse = false;
  private slotPick = 0;
  private cycles = 0;
  private cycleOn = false;
  /** a click picked: the fire button stays out until it is let go */
  swallowFire = false;

  /** The HUD, every frame: the player's loadout (what the wheel lists and how to reach a grenade). */
  observe(p: QuickPlayer | null): void {
    this.player = p;
    if (this.openNow && (!p || !p.alive)) this.cancel();
  }

  /** The swap button went down (`at`: the reticle's place, CSS px). */
  press(by: 'key' | 'pad', now: number, at: { x: number; y: number }): void {
    if (this.downAt >= 0) return;
    this.downAt = now;
    this.by = by;
    this.at = { ...at };
    this.drawn = null;
  }

  /** Called every sample while it's down: past HOLD_MS the wheel opens. */
  tick(now: number): void {
    if (this.downAt < 0 || this.openNow || now - this.downAt < HOLD_MS) return;
    const p = this.player;
    if (!p || !p.alive || p.dual) return;
    this.items = quickItems(p);
    if (this.items.length < 2) return;
    this.openNow = true;
    // the slung gun first: holding and letting go without pointing still swaps
    this.highlight = this.items.length > 1 && this.items[1]!.kind === 'gun' ? 1 : 0;
  }

  /** The swap button came up: a tap swaps, an open wheel takes what is highlighted. */
  release(now: number): void {
    if (this.downAt < 0) return;
    // not opened (a tap, or a hold with nothing to choose from): the plain swap, on the release
    if (this.openNow) this.pick(this.highlight);
    else this.swapPulse = now >= this.downAt;
    this.downAt = -1;
    this.openNow = false;
  }

  /** A click while open: take the highlighted item now. */
  click(): boolean {
    if (!this.openNow) return false;
    this.pick(this.highlight);
    this.openNow = false;
    this.downAt = -1;
    this.swallowFire = true;
    return true;
  }

  /** The pointer at (x, y), CSS px: past the dead zone it highlights the item that way. */
  point(x: number, y: number): void {
    if (!this.openNow) return;
    const c = this.drawn ?? this.at;
    const dx = x - c.x;
    const dy = y - c.y;
    if (Math.hypot(dx, dy) < POINT_DEADZONE) return;
    this.highlight = this.pickAt(Math.atan2(dy, dx));
  }

  /**
   * The HUD, each frame the wheel shows: where it drew it (its centre, page px: the reticle's place
   * kept on screen) and its items (page px). Pointing is measured from there, toward them.
   */
  layout(centre: { x: number; y: number }, spots: readonly { x: number; y: number }[]): void {
    if (!this.openNow || spots.length !== this.items.length) return;
    this.drawn = { x: centre.x, y: centre.y, angles: spots.map((p) => Math.atan2(p.y - centre.y, p.x - centre.x)) };
  }

  private pickAt(angle: number): number {
    return this.drawn ? pickByAngle(angle, this.drawn.angles) : itemAt(angle, this.items.length);
  }

  /** The pad's stick (a unit-ish vector, screen axes): past half-way it highlights that way. */
  stick(x: number, y: number): void {
    if (!this.openNow || Math.hypot(x, y) < 0.5) return;
    this.highlight = this.pickAt(Math.atan2(y, x));
  }

  /** Mouse-wheel steps while open: the next or previous item. Returns whether it took them. */
  step(n: number): boolean {
    if (!this.openNow) return false;
    if (n !== 0) this.highlight = (((this.highlight + Math.sign(n)) % this.items.length) + this.items.length) % this.items.length;
    return true;
  }

  cancel(): void {
    this.downAt = -1;
    this.openNow = false;
  }

  get open(): boolean {
    return this.openNow;
  }

  get view(): QuickView {
    return { open: this.openNow, items: this.items, highlight: this.highlight, at: this.at, by: this.by };
  }

  /** This sample's part: the swap button never reaches the sim held; its tap, its pick and the fire it swallowed. */
  take(out: Input): void {
    out.buttons &= ~Btn.Swap;
    if (this.openNow) out.buttons &= ~(Btn.Fire | Btn.Fire2);
    if (this.swallowFire) {
      if (out.buttons & Btn.Fire) out.buttons &= ~Btn.Fire;
      else this.swallowFire = false;
    }
    if (this.swapPulse) {
      out.buttons |= Btn.Swap;
      this.swapPulse = false;
    }
    if (this.slotPick) {
      out.weaponSelect = this.slotPick;
      this.slotPick = 0;
    }
    if (this.cycles > 0) {
      this.cycleOn = !this.cycleOn;
      if (this.cycleOn) {
        out.buttons |= Btn.CycleGrenade;
        this.cycles--;
      }
    } else this.cycleOn = false;
  }

  private pick(i: number): void {
    const item = this.items[i];
    const p = this.player;
    if (!item || !p) return;
    if (item.kind === 'gun') {
      if (item.slot !== p.active) this.slotPick = item.slot + 1;
      return;
    }
    this.cycles = cyclesTo(item.type, p.grenadeType ?? 0, p.grenadeCounts ?? []);
    this.cycleOn = false;
  }
}

/** The one the page uses: input.ts, the pad and the HUD share it. */
export const quickSelect = new QuickSelect();
