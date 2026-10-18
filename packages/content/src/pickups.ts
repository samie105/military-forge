/**
 * Map pickups (docs/03 §12): items that appear at map spawners (MapDef.spawners) or that players
 * drop when they die, taken by touching them. The riot shield came first, then grenade pairs;
 * health packs, ammo boxes, Power Boost and weapons follow the same path: a PickupDef here, a pool
 * that lists it, and what touching it does in packages/sim/src/pickups.ts.
 */
import { EMP, FLASHBANG, FRAG, GAS, GRENADE_PICKUP_COUNT, MINE, SMOKE, type GrenadeDef } from './grenades';

export type PickupKind = 'shield' | 'grenades';

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

export const pickups: readonly PickupDef[] = [RIOT_SHIELD_PICKUP, FRAG_PAIR, SMOKE_PAIR, GAS_PAIR, FLASHBANG_PAIR, MINE_PAIR, EMP_PAIR];

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
