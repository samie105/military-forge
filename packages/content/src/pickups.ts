/**
 * Map pickups (docs/03 §12): items that appear at map spawners (MapDef.spawners) or that players
 * drop when they die, taken by touching them. The riot shield came first, then grenade pairs, then
 * weapons (a crate with a gun in it: `E` swaps it into the slot in hand); health packs, ammo boxes
 * and Power Boost follow the same path: a PickupDef here, a pool that lists it, and what touching it
 * does in packages/sim/src/pickups.ts.
 */
import { EMP, FLASHBANG, FRAG, GAS, GRENADE_PICKUP_COUNT, MINE, SMOKE, type GrenadeDef } from './grenades';
import { weapons, type WeaponDef } from './weapons';

export type PickupKind = 'shield' | 'grenades' | 'weapon';

export interface PickupDef {
  /** wire id (u4), append-only: never reorder */
  index: number;
  id: string;
  name: string;
  kind: PickupKind;
  /** a player whose centre line comes this close horizontally (m) touches it */
  reach: number;
  /** kind 'grenades': the grenade type (GrenadeDef.index); a pair of it (GRENADE_PICKUP_COUNT) */
  grenade?: number;
  /** kind 'weapon': the gun in the crate (WeaponDef.index) */
  weapon?: number;
}

export const RIOT_SHIELD_PICKUP: PickupDef = {
  index: 0,
  id: 'riot_shield',
  name: 'Riot Shield',
  kind: 'shield',
  reach: 0.6,
};

/** A pair of one grenade type (docs/03 §12 "Grenade pair"): addGrenades(player, type, 2), up to the type's carry limit. */
function grenadePair(index: number, g: GrenadeDef, name: string): PickupDef {
  return { index, id: `${g.id}_pair`, name: `${name} ×${GRENADE_PICKUP_COUNT}`, kind: 'grenades', reach: 0.6, grenade: g.index };
}

export const FRAG_PAIR = grenadePair(1, FRAG, 'Frags');
export const SMOKE_PAIR = grenadePair(2, SMOKE, 'Smokes');
export const GAS_PAIR = grenadePair(3, GAS, 'Gas');
export const FLASHBANG_PAIR = grenadePair(4, FLASHBANG, 'Flashbangs');
export const MINE_PAIR = grenadePair(5, MINE, 'Mines');
export const EMP_PAIR = grenadePair(6, EMP, 'EMPs');

/** Weapon items start here: weapon `w` is pickup `WEAPON_PICKUP_BASE + w.index` (wire u6, v11). */
export const WEAPON_PICKUP_BASE = 7;

/** A crate holding one weapon with full ammo. Touching a gun you hold tops its ammo up; any other takes `E` (Btn.Interact). */
function weaponItem(w: WeaponDef): PickupDef {
  return { index: WEAPON_PICKUP_BASE + w.index, id: `weapon:${w.id}`, name: w.name, kind: 'weapon', reach: 0.35, weapon: w.index };
}

/** One item per weapon, in weapon order. */
export const WEAPON_PICKUPS: readonly PickupDef[] = weapons.map(weaponItem);

export const pickups: readonly PickupDef[] = [RIOT_SHIELD_PICKUP, FRAG_PAIR, SMOKE_PAIR, GAS_PAIR, FLASHBANG_PAIR, MINE_PAIR, EMP_PAIR, ...WEAPON_PICKUPS];

/** The pickup that holds weapon `index`. */
export function weaponPickup(index: number): PickupDef | undefined {
  return pickups[WEAPON_PICKUP_BASE + index];
}

/**
 * Weapon crates on the maps (owner's playtest: "more guns I can test"): any gun, the everyday ones
 * three times as often as the power weapons (docs/03 §12's common and power tiers in one pool).
 */
export const POWER_WEAPONS: ReadonlySet<string> = new Set(['breacher', 'widow', 'longbow', 'shredder', 'arc', 'machete', 'thumper', 'popper', 'ripper', 'pulse', 'dragon']);

/** What a spawner can produce: pickups (PickupDef.id) with relative weights. */
export interface SpawnPool {
  id: string;
  items: readonly { pickup: string; weight: number }[];
}

/**
 * Spawn pools by id (docs/03 §12 names common, power, health, boost and grenades; they arrive with
 * those pickups). Maps refer to pools from MapSpawner.pool.
 */
export const SPAWN_POOLS: Readonly<Record<string, SpawnPool>> = {
  shield: { id: 'shield', items: [{ pickup: RIOT_SHIELD_PICKUP.id, weight: 1 }] },
  weapons: { id: 'weapons', items: WEAPON_PICKUPS.map((k) => ({ pickup: k.id, weight: POWER_WEAPONS.has(weapons[k.weapon!]!.id) ? 1 : 3 })) },
  // one gun each: a classic fixed weapon spawn, and the test armory's rack (GameOptions.armory)
  ...Object.fromEntries(WEAPON_PICKUPS.map((k) => [k.id, { id: k.id, items: [{ pickup: k.id, weight: 1 }] }])),
  // a random pair of one type (owner, 17 Oct): frags most often, the tricks less, the strongest least
  grenades: {
    id: 'grenades',
    items: [
      { pickup: FRAG_PAIR.id, weight: 3 },
      { pickup: SMOKE_PAIR.id, weight: 2 },
      { pickup: FLASHBANG_PAIR.id, weight: 2 },
      { pickup: GAS_PAIR.id, weight: 1 },
      { pickup: MINE_PAIR.id, weight: 1 },
      { pickup: EMP_PAIR.id, weight: 1 },
    ],
  },
};

/** Seconds a dropped item stays on the floor (docs/03 §9: dropped weapons stay 30 s). */
export const DROPPED_PICKUP_SECONDS = 30;

export function pickupById(id: string): PickupDef | undefined {
  return pickups.find((p) => p.id === id);
}
