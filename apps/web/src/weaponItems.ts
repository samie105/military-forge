/**
 * Weapon crates on the map, as the HUD and the views see them (the sim's rules: packages/sim
 * pickups.ts). Walking over a gun you hold tops its reserve up; any other gun waits for `E`
 * (Btn.Interact), which swaps it into the slot in hand.
 */
import { pickups, weapons, type PickupDef, type WeaponDef } from '@military-forge/content';
import type { PickupView, PlayerView } from './view';

/** the sim's touch rule: feet at most this far above the item */
const TOUCH_ABOVE = 0.5;
/** a standing body's height, for "touching" (crouched or not, the item sits at the feet) */
const BODY = 1.5;

/** Weapon classes the crates tint by: the power weapons gold, the rest by role. */
const POWER = new Set(['breacher', 'widow', 'longbow', 'shredder', 'arc', 'machete']);

/** Colour of a weapon crate: gold for power weapons, steel blue otherwise. */
export function crateColor(w: WeaponDef): string {
  return POWER.has(w.id) ? '#e3b341' : '#79c0ff';
}

export interface WeaponUnderfoot {
  item: PickupView;
  def: PickupDef;
  weapon: WeaponDef;
  /** the player already holds this gun (walking over it tops its reserve up) */
  held: boolean;
}

/** The weapon crate `p` stands on, if any (the nearest when several are in reach). */
export function weaponUnderfoot(items: readonly PickupView[] | undefined, p: Pick<PlayerView, 'x' | 'y' | 'weapons'>): WeaponUnderfoot | null {
  let best: WeaponUnderfoot | null = null;
  let bestDx = Infinity;
  for (const item of items ?? []) {
    const def = pickups[item.def];
    if (def?.kind !== 'weapon' || def.weapon === undefined) continue;
    const dx = Math.abs(p.x - item.x);
    if (dx > def.reach || p.y > item.y + TOUCH_ABOVE || p.y + BODY < item.y || dx >= bestDx) continue;
    const weapon = weapons[def.weapon];
    if (!weapon) continue;
    best = { item, def, weapon, held: (p.weapons ?? []).some((w) => w.def === def.weapon) };
    bestDx = dx;
  }
  return best;
}

/** What standing on a gun you don't hold says: `[E] take Widow (swaps your Hammer .44)`. */
export function takePrompt(under: WeaponUnderfoot, p: Pick<PlayerView, 'weapons' | 'active'>): string {
  const inHand = weapons[p.weapons[p.active]?.def ?? -1];
  return `[E] take ${under.weapon.name}${inHand ? ` (swaps your ${inHand.name})` : ''}`;
}

/** A gun lying close by: E takes it, unless you hold one already (walking over it is ammo). */
export function nearbyWeaponPrompt(def: PickupDef, p: Pick<PlayerView, 'weapons'>): string {
  const held = def.weapon !== undefined && (p.weapons ?? []).some((w) => w.def === def.weapon);
  return held ? `${def.name}: walk over for ammo` : `${def.name}: stand on it, E to take`;
}
