/**
 * Map pickups (docs/03 §12; definitions in @military-forge/content pickups.ts). Spawners
 * (MapDef.spawners) put items on the map at random spots and times; players take them by touching
 * them and drop what they carry when they die.
 * - The riot shield:
 *   - touching one gives you the shield with the HP the item has (a spawned one is fresh);
 *   - touching one while you carry a shield with less HP left tops yours up to the item's;
 *   - dying drops your shield on the floor below you with the HP it had left, for 30 s.
 * - A grenade pair (arsenal B): two of its type onto your belt, up to the type's carry limit
 *   (addGrenades); with that type full it stays on the floor. Which type a spawner puts out is the
 *   seeded pool draw, like any item.
 *
 * Determinism: every random draw is a stateless hash of (seed, tick, spawner, draw), so a replay or
 * a re-simulation draws the same numbers. A game with pickups off (GameOptions.pickups: the client's
 * prediction world, replays recorded before pickups existed) or a map without spawners draws nothing,
 * changes nothing and hashes nothing extra: it plays bit-identically to before.
 */
import {
  DROPPED_PICKUP_SECONDS,
  GRENADE_PICKUP_COUNT,
  RIOT_SHIELD,
  RIOT_SHIELD_PICKUP,
  SPAWN_POOLS,
  pickupById,
  pickups as pickupDefs,
  type MapDef,
  type MapSpawner,
  type PickupDef,
} from '@military-forge/content';
import { POS_INV, hash4, hashToUnit, quantize } from '@military-forge/shared';
import { ticks } from './constants';
import type { Game } from './game';
import { addGrenades } from './grenades';
import type { PlayerState } from './player';
import { clearShield, giveShield } from './shield';
import { createRayHit } from './world';

/** One item on the map (a fixed pool in Game.pickups, like grenades). */
export class PickupState {
  alive = false;
  /** PickupDef.index */
  def = 0;
  /** the point it rests on */
  x = 0;
  y = 0;
  /** riot shields: the HP it carries */
  hp = 0;
  /** ticks until a dropped item vanishes; 0 = it stays until taken (spawner items) */
  ttl = 0;
  /** the spawner (index into Game.spawners) and spot it sits on; −1 for an item a player dropped */
  spawner = -1;
  spot = -1;
  constructor(readonly id: number) {}
}

/** One MapSpawner at runtime. */
export class SpawnerState {
  /** ticks until its next item; it counts down only while fewer than maxActive of its items are out */
  timer = 0;
  /** its items on the map */
  active = 0;
  readonly maxActive: number;
  /** the pool, resolved: PickupDef indices with weights */
  readonly items: readonly { def: number; weight: number }[];
  readonly totalWeight: number;

  constructor(
    readonly index: number,
    readonly def: MapSpawner,
  ) {
    const pool = SPAWN_POOLS[def.pool];
    if (!pool) throw new Error(`spawner "${def.id}": unknown pool "${def.pool}"`);
    this.items = pool.items.map((it) => {
      const pickup = pickupById(it.pickup);
      if (!pickup) throw new Error(`pool "${pool.id}": unknown pickup "${it.pickup}"`);
      if (!(it.weight > 0)) throw new Error(`pool "${pool.id}": "${it.pickup}" needs a positive weight`);
      return { def: pickup.index, weight: it.weight };
    });
    this.totalWeight = this.items.reduce((sum, it) => sum + it.weight, 0);
    if (this.items.length === 0) throw new Error(`pool "${pool.id}" is empty`);
    this.maxActive = def.maxActive ?? 1;
    if (def.spots.length === 0) throw new Error(`spawner "${def.id}" has no spots`);
    if (!(this.maxActive >= 1 && this.maxActive <= def.spots.length)) throw new Error(`spawner "${def.id}": maxActive must be 1…${def.spots.length}`);
    for (const [a, b] of [def.first, def.respawn]) if (!(a >= 0 && b >= a)) throw new Error(`spawner "${def.id}": bad time range [${a}, ${b}]`);
  }
}

export function createSpawners(map: MapDef): SpawnerState[] {
  return (map.spawners ?? []).map((def, i) => new SpawnerState(i, def));
}

/** Random draws per spawner and tick. */
const DRAW_TIMER = 0;
const DRAW_SPOT = 1;
const DRAW_ITEM = 2;
/** keeps spawner draws apart from weapon spread, which hashes player ids (0–15) in the same place */
const SPAWNER_SALT = 0x5e000;
/** a player touches an item when its feet are no higher than this above it */
const TOUCH_ABOVE = 0.5;
/** how far a dropped item falls to find a floor; over a pit it is lost */
const DROP_FALL_MAX = 64;

const ray = createRayHit();

function draw(game: Game, s: SpawnerState, which: number): number {
  return hashToUnit(hash4(game.seed, game.tick, SPAWNER_SALT + s.index, which));
}

/** Ticks until the next item: uniformly random in [min, max] seconds, at least one tick. */
function rollTimer(game: Game, s: SpawnerState, range: readonly [number, number]): number {
  return Math.max(1, ticks(range[0] + (range[1] - range[0]) * draw(game, s, DRAW_TIMER)));
}

/** Everything off the map and the spawners' first timers rolled (game start, match start). */
export function resetPickups(game: Game): void {
  for (const k of game.pickups) k.alive = false;
  for (const s of game.spawners) {
    s.active = 0;
    s.timer = rollTimer(game, s, s.def.first);
  }
}

function allocPickup(game: Game): PickupState | null {
  for (const k of game.pickups) if (!k.alive) return k;
  return null;
}

function place(k: PickupState, def: PickupDef, x: number, y: number, hp: number, ttl: number, spawner: number, spot: number): void {
  k.alive = true;
  k.def = def.index;
  k.x = x;
  k.y = y;
  k.hp = hp;
  k.ttl = ttl;
  k.spawner = spawner;
  k.spot = spot;
}

/** HP a freshly spawned item carries. */
function freshHp(def: PickupDef): number {
  return def.kind === 'shield' ? RIOT_SHIELD.hp : 0;
}

function spotTaken(game: Game, spawner: number, spot: number): boolean {
  for (const k of game.pickups) if (k.alive && k.spawner === spawner && k.spot === spot) return true;
  return false;
}

/** A random free spot of `s` gets a random item from its pool. False when there's no room. */
function spawnFrom(game: Game, s: SpawnerState): boolean {
  const spots = s.def.spots;
  let free = 0;
  for (let i = 0; i < spots.length; i++) if (!spotTaken(game, s.index, i)) free++;
  const k = free > 0 ? allocPickup(game) : null;
  if (!k) return false;
  let pick = Math.min(free - 1, Math.floor(draw(game, s, DRAW_SPOT) * free));
  let spot = 0;
  for (; spot < spots.length; spot++) if (!spotTaken(game, s.index, spot) && pick-- === 0) break;
  let w = draw(game, s, DRAW_ITEM) * s.totalWeight;
  let item = s.items[s.items.length - 1]!.def;
  for (const it of s.items) {
    if (w < it.weight) {
      item = it.def;
      break;
    }
    w -= it.weight;
  }
  const def = pickupDefs[item]!;
  place(k, def, spots[spot]!.x, spots[spot]!.y, freshHp(def), 0, s.index, spot);
  return true;
}

function touches(game: Game, p: PlayerState, k: PickupState, def: PickupDef): boolean {
  return Math.abs(p.x - k.x) <= def.reach && p.y <= k.y + TOUCH_ABOVE && p.y + p.height(game.tuning) >= k.y;
}

/** What touching the item does. False: `p` leaves it where it is. */
function take(p: PlayerState, k: PickupState, def: PickupDef): boolean {
  switch (def.kind) {
    case 'shield':
      if (p.shieldHp > 0) {
        if (k.hp <= p.shieldHp) return false;
        p.shieldHp = k.hp; // tops up the one you carry; how you carry it doesn't change
      } else giveShield(p, k.hp);
      return true;
    case 'grenades':
      return def.grenade !== undefined && addGrenades(p, def.grenade, GRENADE_PICKUP_COUNT) > 0;
  }
}

/** Spawner timers, dropped items running out, and players taking what they touch. Once per tick. */
export function stepPickups(game: Game): void {
  if (!game.pickupsEnabled) return;
  for (const k of game.pickups) if (k.alive && k.ttl > 0 && --k.ttl === 0) k.alive = false;

  for (const s of game.spawners) {
    if (s.active >= s.maxActive) continue;
    if (s.timer > 0 && --s.timer > 0) continue;
    if (!spawnFrom(game, s)) continue; // no free spot or item: try again next tick
    s.active++;
    if (s.active < s.maxActive) s.timer = rollTimer(game, s, s.def.respawn);
  }

  // in id order: when two players touch an item on the same tick, the lower id gets it
  for (const k of game.pickups) {
    if (!k.alive) continue;
    const def = pickupDefs[k.def]!;
    for (const p of game.players) {
      if (!p?.alive || !touches(game, p, k, def) || !take(p, k, def)) continue;
      k.alive = false;
      if (k.spawner >= 0) {
        const s = game.spawners[k.spawner]!;
        if (s.active === s.maxActive) s.timer = rollTimer(game, s, s.def.respawn);
        s.active--;
      }
      game.events.push({ type: 'pickup', player: p.id, item: k.def, x: k.x, y: k.y });
      break;
    }
  }
}

/**
 * Death: `p` lets go of what it carries. A shield falls straight down to the floor below with the HP
 * it had left and stays DROPPED_PICKUP_SECONDS (over a pit, or with pickups off, it is gone).
 */
export function dropCarried(game: Game, p: PlayerState): void {
  if (p.shieldHp <= 0) return;
  const hp = p.shieldHp;
  clearShield(p);
  if (!game.pickupsEnabled || !game.world.raycast(p.x, p.y + 0.5, 0, -1, DROP_FALL_MAX, 0, ray)) return;
  const k = allocPickup(game);
  if (k) place(k, RIOT_SHIELD_PICKUP, p.x, quantize(ray.y, POS_INV), hp, ticks(DROPPED_PICKUP_SECONDS), -1, -1);
}
