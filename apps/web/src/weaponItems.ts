/**
 * Weapon crates on the map, as the HUD and the views see them (the sim's rules: packages/sim
 * pickups.ts). Walking over a gun you hold tops its reserve up; any other gun waits for `E`
 * (Btn.Interact), which swaps it into the slot in hand.
 */
import { POWER_WEAPONS, pickups, weapons, type PickupDef, type WeaponDef } from '@military-forge/content';
import type { PickupView, PlayerView } from './view';

/** the sim's touch rule: feet at most this far above the item */
const TOUCH_ABOVE = 0.5;
/** a standing body's height, for "touching" (crouched or not, the item sits at the feet) */
const BODY = 1.5;


/** Colour of a weapon crate: gold for power weapons, steel blue otherwise. */
export function crateColor(w: WeaponDef): string {
  return POWER_WEAPONS.has(w.id) ? '#e3b341' : '#79c0ff';
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

/**
 * What standing on a gun you don't hold says: `[E] take Widow (swaps your Hammer .44)`, in the
 * player's own key (`key`), or on a phone (null) the touch wording: `Tap Take: Widow (…)`.
 */
export function takePrompt(under: WeaponUnderfoot, p: Pick<PlayerView, 'weapons' | 'active'>, key: string | null = 'E'): string {
  const inHand = weapons[p.weapons[p.active]?.def ?? -1];
  const swaps = inHand ? ` (swaps your ${inHand.name})` : '';
  return key === null ? `Tap Take: ${under.weapon.name}${swaps}` : `[${key}] take ${under.weapon.name}${swaps}`;
}

/** A gun lying close by: the take key (`key`; null: a phone's Take button) takes it, unless you hold one already (walking over it is ammo). */
export function nearbyWeaponPrompt(def: PickupDef, p: Pick<PlayerView, 'weapons'>, key: string | null = 'E'): string {
  const held = def.weapon !== undefined && (p.weapons ?? []).some((w) => w.def === def.weapon);
  if (held) return `${def.name}: walk over for ammo`;
  return key === null ? `${def.name}: stand on it, then tap Take` : `${def.name}: stand on it, ${key} to take`;
}
