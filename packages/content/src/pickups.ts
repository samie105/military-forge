/**
 * Map pickups (docs/03 §12): items that appear at map spawners (MapDef.spawners) or that players
 * drop when they die, taken by touching them. The riot shield is the first; health packs, ammo
 * boxes, grenade pairs, Power Boost and weapons follow the same path: a PickupDef here, a pool
 * that lists it, and what touching it does in packages/sim/src/pickups.ts.
 */
export type PickupKind = 'shield';

export interface PickupDef {
  /** wire id (u4), append-only: never reorder */
  index: number;
  id: string;
  name: string;
  kind: PickupKind;
  /** a player whose centre line comes this close horizontally (m) touches it */
  reach: number;
}

export const RIOT_SHIELD_PICKUP: PickupDef = {
  index: 0,
  id: 'riot_shield',
  name: 'Riot Shield',
  kind: 'shield',
  reach: 0.6,
};

export const pickups: readonly PickupDef[] = [RIOT_SHIELD_PICKUP];

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
};

/** Seconds a dropped item stays on the floor (docs/03 §9: dropped weapons stay 30 s). */
export const DROPPED_PICKUP_SECONDS = 30;

export function pickupById(id: string): PickupDef | undefined {
  return pickups.find((p) => p.id === id);
}
