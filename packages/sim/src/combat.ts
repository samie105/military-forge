/**
 * Weapons and damage (docs/03 §7–§9, docs/02 §12–§13.1). Hitscan bullets and shotgun pellets,
 * seeded spread, muzzle-in-wall guard, reload/swap/dual-wield, falloff and hit zones, airborne
 * recoil push, weight, and melee (lunge, arc hit test, knockback, the one-hit Machete).
 */
import { CROUCHED_HITBOXES, FRAG, HitZone, NO_WEAPON, STANDING_HITBOXES, weapons, type WeaponClass, type WeaponDef } from '@military-forge/content';
import { DEG2RAD, hash4, hashToUnit, quantize, simCosSin, SCALAR_INV } from '@military-forge/shared';
import { DT, TICK_RATE, ticks } from './constants';
import { DamageSource } from './events';
import type { Game } from './game';
import { rayCapsule, rayCircle } from './geometry';
import { Btn, isDown, wasPressed } from './input';
import { hitboxLayout, knockOutOfDash, type PlayerState, type WeaponSlot } from './player';
import { throwGrenade } from './grenades';
import { createHitPose } from './rewind';
import { SegFlag, createRayHit } from './world';

const dir = { x: 0, y: 0 };
const aimDir = { x: 0, y: 0 };
const hit = createRayHit();
const guard = createRayHit();
const pose = createHitPose();

const DUAL_TOGGLE_TIME = 0.45;

/** Pellet jitter: each pellet strays up to ± this fraction of half the gap between neighbouring pellets (docs/03 §7). */
const PELLET_JITTER = 0.25;

// Melee (docs/02 §12): a windup, then an arc hit test; each swing starts with a short lunge.
/** hands busy before the hit lands (0.15 s); firing is blocked meanwhile */
export const MELEE_WINDUP_TICKS = ticks(0.15);
/** lunge burst (0.12 s) at the start of the swing */
const LUNGE_TICKS = ticks(0.12);
/** seconds between swings with a gun (melee weapons use their own interval) */
const MELEE_COOLDOWN = 0.6;
/** reach of a gun bash (melee weapons use their own range) */
export const MELEE_REACH = 1.1;
export const MELEE_ARC_DEG = 70;
/** rays fanned across the arc: 11.7° apart, so the gap at full reach (0.22 m) is narrower than any hitbox */
const MELEE_RAYS = 7;
const MELEE_KNOCKBACK = 6;
/** bash damage with empty hands */
const FIST_DAMAGE = 15;

/** Lunge speed (m/s): sidearms are nimble, heavy weapons sluggish. */
function lungeFor(cls: WeaponClass | undefined): number {
  return cls === 'sidearm' ? 4 : cls === 'heavy' ? 2 : 3;
}

/**
 * What a melee swing uses: the held weapon (docs/03 §9). A Machete replaces the bash only while it
 * is the active weapon (docs/03 §11); carried in the other slot it does nothing. Melee weapons never
 * dual-wield, so in a dual pair the active slot is always a gun.
 */
export function meleeWeapon(p: PlayerState): WeaponDef | undefined {
  return weapons[p.weapons[p.active]!.def];
}

/** Extra speed (m/s) along the facing during the lunge window of a swing, else 0. Read by movement. */
export function lungeSpeed(p: PlayerState): number {
  return p.meleeTicks >= 1 && p.meleeTicks <= LUNGE_TICKS ? lungeFor(meleeWeapon(p)?.class) : 0;
}

/** True while a swing's windup occupies the hands. */
export function meleeBusy(p: PlayerState): boolean {
  return p.meleeTicks > 0 && p.meleeTicks <= MELEE_WINDUP_TICKS;
}

function meleeSwingTicks(p: PlayerState): number {
  const def = meleeWeapon(p);
  return ticks(def?.fireMode === 'melee' ? def.interval : MELEE_COOLDOWN);
}

/** Current spread in degrees for a slot (docs/03 §7). Does not mutate. */
export function currentSpread(p: PlayerState, slot: WeaponSlot, def: WeaponDef): number {
  const s = def.spread;
  let spread = s.base;
  if (p.grounded) {
    if (Math.abs(p.vx) > 0.5) spread *= s.moveMul;
  } else spread *= p.jetting ? s.airMul * 1.07 : s.airMul;
  if (p.crouched) spread *= s.crouchMul;
  if (p.dual) spread *= s.dualMul;
  spread += slot.bloom;
  if (!p.grounded) spread = Math.max(spread, s.minAir);
  return spread;
}

function falloff(def: WeaponDef, dist: number): number {
  if (dist <= def.falloffStart) return 1;
  const k = (dist - def.falloffStart) / (def.range - def.falloffStart);
  return 1 - (1 - def.minDamageMul) * (k > 1 ? 1 : k);
}

function startReload(slot: WeaponSlot, def: WeaponDef): boolean {
  if (slot.reloadTicks > 0 || slot.mag >= def.mag || slot.reserve <= 0) return false;
  slot.reloadTicks = ticks(def.reload);
  return true;
}

/** One-handed guns dual-wield (docs/03 §9); melee weapons don't. */
function dualable(slot: WeaponSlot): boolean {
  const def = weapons[slot.def];
  return def !== undefined && def.hands === 1 && def.fireMode !== 'melee';
}

function cancelReloads(p: PlayerState): void {
  p.weapons[0].reloadTicks = 0;
  p.weapons[1].reloadTicks = 0;
}

/** Result of traceTargets. Module scratch: the sim is single-threaded. */
const target = { id: -1, t: 0, zone: 0 };

/**
 * The nearest player hitbox along a ray, closer than `maxT`, skipping the shooter and the players
 * in `skipMask` (bit per id). Dead players are skipped too, except those in `blockMask`: a victim
 * an earlier pellet of the same shot just killed still stops the later pellets (pellets don't
 * penetrate, docs/03 §11). Bullets, pellets and melee rays all test players here, so lag
 * compensation (rewound target poses, docs/05 §7.1) applies to all of them in one place.
 */
function traceTargets(game: Game, shooter: PlayerState, sx: number, sy: number, dx: number, dy: number, maxT: number, skipMask = 0, blockMask = 0): boolean {
  target.id = -1;
  target.t = maxT;
  target.zone = HitZone.None;
  for (const q of game.players) {
    if (!q || q.id === shooter.id || (skipMask & (1 << q.id)) !== 0) continue;
    if (!q.alive && (blockMask & (1 << q.id)) === 0) continue;
    // lag compensation (server): test the target where the shooter saw it (docs/05 §7.1)
    const rewound = game.rewind !== null && game.rewind.pose(q, shooter, pose);
    if (rewound && !pose.alive) continue;
    const qx = rewound ? pose.x : q.x;
    const qy = rewound ? pose.y : q.y;
    // cheap reject: distance from the ray to the player's centre
    const cx = qx - sx;
    const cy = qy + 0.75 - sy;
    const along = cx * dx + cy * dy;
    if (along < -1 || along > target.t + 1) continue;
    const perp = Math.abs(cx * dy - cy * dx);
    if (perp > 1.2) continue;

    const box = rewound ? (pose.crouched ? CROUCHED_HITBOXES : STANDING_HITBOXES) : hitboxLayout(q);
    const tHead = rayCircle(sx, sy, dx, dy, qx, qy + box.head.y, box.head.r);
    const tTorso = rayCapsule(sx, sy, dx, dy, qx, qy + box.torso.y0, qx, qy + box.torso.y1, box.torso.r);
    const tLegs = rayCapsule(sx, sy, dx, dy, qx, qy + box.legs.y0, qx, qy + box.legs.y1, box.legs.r);
    let tq = tTorso;
    let z: number = HitZone.Torso;
    if (tHead < tq) {
      tq = tHead;
      z = box.headIsHeadshot ? HitZone.Head : HitZone.Torso;
    }
    if (tLegs < tq) {
      tq = tLegs;
      z = HitZone.Legs;
    }
    if (tq < target.t) {
      target.t = tq;
      target.id = q.id;
      target.zone = z;
    }
  }
  return target.id >= 0;
}

/** Fires one shot: a single hitscan bullet, or a shotgun's pellets spread evenly across the cone. */
function fireShot(game: Game, p: PlayerState, slot: WeaponSlot, def: WeaponDef): void {
  const t = game.tuning;
  const world = game.world;
  const sx = p.shoulderX(t);
  const sy = p.shoulderY(t);
  simCosSin(p.aim, aimDir);

  // Muzzle-in-wall guard (docs/02 §13.1): pressed against a wall, the shot hits that wall.
  let visX = sx + aimDir.x * def.muzzleLength;
  let visY = sy + aimDir.y * def.muzzleLength;
  let maxT = def.range;
  const blocked = world.raycast(sx, sy, aimDir.x, aimDir.y, def.muzzleLength, SegFlag.BulletPass, guard);
  if (blocked) {
    visX = guard.x;
    visY = guard.y;
    maxT = guard.t;
  }

  // Seeded spread: the client predicts exactly the same angles as the server. One bullet lands
  // uniformly in ±spread; pellets sit evenly across the ±spread cone, each with a small seeded jitter.
  const spread = currentSpread(p, slot, def);
  const n = def.pellets;
  let struck = 0; // players this shot has hit: they keep blocking later pellets even once dead
  for (let i = 0; i < n; i++) {
    const u = hashToUnit(hash4(game.seed, game.tick, p.id, p.shotCounter));
    p.shotCounter = (p.shotCounter + 1) | 0;
    const offset = n === 1 ? (2 * u - 1) * spread : spread * ((2 * i) / (n - 1) - 1 + (PELLET_JITTER * (2 * u - 1)) / (n - 1));
    simCosSin(p.aim + offset * DEG2RAD, dir);
    const victim = traceBullet(game, p, def, sx, sy, visX, visY, maxT, blocked, struck);
    if (victim >= 0) struck |= 1 << victim;
  }
  slot.bloom = Math.min(def.spread.bloomMax, slot.bloom + def.spread.bloomPerShot);

  // recoil push, airborne only (docs/02 §12)
  if (!p.grounded && def.recoilPushAir > 0) {
    p.vx -= aimDir.x * def.recoilPushAir;
    p.vy -= aimDir.y * def.recoilPushAir;
  }
}

/**
 * One bullet or pellet along `dir`: world, then players; the first hit wins. Returns the player hit,
 * or -1. On maps with mechanics (docs/02 §20) its range is what the map leaves of the weapon's: a
 * map-wide multiplier, and damping zones it crosses use the range up faster; damage falls off over
 * that used-up range, not the metres flown.
 */
function traceBullet(game: Game, p: PlayerState, def: WeaponDef, sx: number, sy: number, visX: number, visY: number, maxT: number, blocked: boolean, struck: number): number {
  const mech = blocked ? null : game.mech;
  let endT = maxT;
  if (mech) {
    mech.castBullet(sx, sy, dir.x, dir.y);
    endT = mech.bulletReach(def.range);
  }
  let hitKind: 0 | 1 | 2 = 0;
  if (blocked) hitKind = 1;
  // walls only count within the bullet's reach: the weapon's range, or what the map leaves of it
  // (shorter in fog, longer under a map-wide multiplier above 1)
  else if (game.world.raycast(sx, sy, dir.x, dir.y, endT, SegFlag.BulletPass, hit)) {
    endT = hit.t;
    hitKind = 1;
  }

  let victimId = -1;
  let zone: number = HitZone.None;
  if (traceTargets(game, p, sx, sy, dir.x, dir.y, endT, 0, struck)) {
    endT = target.t;
    victimId = target.id;
    zone = target.zone;
    hitKind = 2;
  }

  game.events.push({
    type: 'shot',
    shooter: p.id,
    weapon: def.index,
    ox: visX,
    oy: visY,
    ex: sx + dir.x * endT,
    ey: sy + dir.y * endT,
    hit: hitKind,
    target: victimId,
    zone,
  });

  if (victimId >= 0) {
    const victim = game.players[victimId]!;
    const mul = zone === HitZone.Head ? def.headMul : 1;
    if (def.hitImpulse > 0 && victim.alive) push(game, victim, dir.x, dir.y, def.hitImpulse); // a corpse blocks but is not shoved
    game.damage(victim, def.damage * falloff(def, mech ? mech.bulletCost(endT) : endT) * mul, p.id, def.index, zone);
  }
  return victimId;
}

/**
 * Velocity change along a unit direction; a push with enough lift unsticks grounded players and
 * any push ends a dash. The map can scale it where the target stands (docs/02 §20).
 */
function push(game: Game, q: PlayerState, dx: number, dy: number, speed: number): void {
  knockOutOfDash(q, game.tuning, game.mech ? game.mech.moveSpeedMul(q, game.tuning) : 1);
  const kick = game.mech ? speed * game.mech.knockbackMul(q, game.tuning) : speed;
  q.vx += dx * kick;
  q.vy += dy * kick;
  if (dy > 0.2) q.grounded = false;
}

/**
 * The swing lands (docs/02 §12): a fan of rays across a 70° arc from the shoulder hits every
 * player in reach that a wall doesn't cover, once each, and shoves them along the aim.
 */
function landMelee(game: Game, p: PlayerState): void {
  const t = game.tuning;
  const def = meleeWeapon(p);
  const reach = def?.fireMode === 'melee' ? def.range : MELEE_REACH;
  const sx = p.shoulderX(t);
  const sy = p.shoulderY(t);
  let struck = 0;
  for (let k = 0; k < MELEE_RAYS; k++) {
    simCosSin(p.aim + (k / (MELEE_RAYS - 1) - 0.5) * MELEE_ARC_DEG * DEG2RAD, dir);
    const maxT = game.world.raycast(sx, sy, dir.x, dir.y, reach, SegFlag.BulletPass, hit) ? hit.t : reach;
    while (traceTargets(game, p, sx, sy, dir.x, dir.y, maxT, struck)) struck |= 1 << target.id;
  }
  if (struck === 0) return;
  simCosSin(p.aim, aimDir);
  for (const q of game.players) {
    if (!q || (struck & (1 << q.id)) === 0) continue;
    push(game, q, aimDir.x, aimDir.y, MELEE_KNOCKBACK);
    game.damage(q, def ? def.meleeDamage : FIST_DAMAGE, p.id, DamageSource.Melee, HitZone.Torso);
  }
}

/** Timers, commands and firing for one player (after movement). */
export function stepWeapons(game: Game, p: PlayerState): void {
  const buttons = p.input.buttons;
  const prev = p.prevButtons;

  // timers
  for (const slot of p.weapons) {
    if (slot.def === NO_WEAPON) continue;
    const def = weapons[slot.def]!;
    if (slot.cooldown > 0) slot.cooldown = Math.max(0, slot.cooldown - 1);
    slot.ticksSinceShot = Math.min(slot.ticksSinceShot + 1, 9999);
    if (slot.ticksSinceShot > 6 && slot.bloom > 0) {
      slot.bloom = quantize(Math.max(0, slot.bloom - def.spread.recoverPerSec * DT), SCALAR_INV);
    }
    if (slot.reloadTicks > 0 && --slot.reloadTicks === 0) {
      const take = Math.min(def.mag - slot.mag, slot.reserve);
      slot.mag += take;
      slot.reserve -= take;
    }
  }
  if (p.swapTicks > 0) p.swapTicks--;
  if (p.throwCooldown > 0) p.throwCooldown--;
  if (p.meleeTicks > 0) {
    p.meleeTicks++;
    if (p.meleeTicks === MELEE_WINDUP_TICKS + 1) landMelee(game, p);
    if (p.meleeTicks > meleeSwingTicks(p)) p.meleeTicks = 0;
  }

  // commands
  const w0 = p.weapons[0];
  const w1 = p.weapons[1];
  const canDual = dualable(w0) && dualable(w1);
  if (wasPressed(buttons, prev, Btn.Dual) && canDual) {
    p.dual = !p.dual;
    p.swapTicks = ticks(DUAL_TOGGLE_TIME);
    cancelReloads(p);
  }
  const select = p.input.weaponSelect;
  const wantSwap = wasPressed(buttons, prev, Btn.Swap) || (select >= 1 && select <= 2 && select - 1 !== p.active);
  if (wantSwap && !p.dual) {
    p.active = select >= 1 && select <= 2 ? select - 1 : p.active ^ 1;
    const def = weapons[p.weapons[p.active]!.def];
    p.swapTicks = ticks(def ? def.equip : 0.25);
    cancelReloads(p);
  }
  if (wasPressed(buttons, prev, Btn.Reload)) {
    if (p.dual) {
      // one at a time, lowest slot first
      if (w0.reloadTicks === 0 && w1.reloadTicks === 0 && !startReload(w0, weapons[w0.def]!)) startReload(w1, weapons[w1.def]!);
    } else {
      const slot = p.weapons[p.active]!;
      if (slot.def !== NO_WEAPON) startReload(slot, weapons[slot.def]!);
    }
  }
  // dual: the second gun reloads after the first finishes
  if (p.dual && w0.reloadTicks === 0 && w1.reloadTicks === 0 && w0.mag === 0 && w0.reserve > 0) startReload(w0, weapons[w0.def]!);
  if (p.dual && w0.reloadTicks === 0 && w1.reloadTicks === 0 && w1.mag === 0 && w1.reserve > 0) startReload(w1, weapons[w1.def]!);

  // melee: the melee button, or fire with a melee weapon in hand
  const held = weapons[p.weapons[p.active]!.def];
  const swingFire = !p.dual && p.swapTicks === 0 && held?.fireMode === 'melee' && wasPressed(buttons, prev, Btn.Fire);
  if (p.meleeTicks === 0 && (swingFire || wasPressed(buttons, prev, Btn.Melee))) p.meleeTicks = 1;

  // fire
  if (p.swapTicks === 0 && !meleeBusy(p)) {
    const firing = isDown(buttons, Btn.Fire);
    const pressed = wasPressed(buttons, prev, Btn.Fire);
    for (let s = 0; s < 2; s++) {
      if (!p.dual && s !== p.active) continue;
      const slot = p.weapons[s]!;
      if (slot.def === NO_WEAPON) continue;
      const def = weapons[slot.def]!;
      if (def.fireMode === 'melee') continue;
      const trigger = def.fireMode === 'auto' ? firing : pressed;
      if (!trigger || slot.reloadTicks > 0 || slot.cooldown > 1e-6) continue;
      if (slot.mag <= 0) {
        if (!p.dual) startReload(slot, def);
        continue;
      }
      fireShot(game, p, slot, def);
      slot.mag--;
      slot.cooldown += def.interval * TICK_RATE;
      slot.ticksSinceShot = 0;
      if (slot.mag === 0 && !p.dual) startReload(slot, def); // auto-reload when empty
    }
  }

  // grenade
  if (wasPressed(buttons, prev, Btn.Grenade) && p.frags > 0 && p.throwCooldown === 0) {
    if (throwGrenade(game, p, FRAG)) {
      p.frags--;
      p.throwCooldown = ticks(FRAG.throwCooldown);
    }
  }
}

/** Passive health regeneration (docs/02 §8). */
export function stepRegen(game: Game, p: PlayerState): void {
  const t = game.tuning;
  if (p.regenDelay > 0) p.regenDelay--;
  else if (p.hp < t.healthMax) p.hp = Math.min(t.healthMax, p.hp + t.healthRegen * DT);
}
