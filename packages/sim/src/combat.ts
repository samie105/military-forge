/**
 * Weapons and damage (docs/03 §7–§9, docs/02 §12–§13.1). Hitscan bullets and shotgun pellets,
 * seeded spread, muzzle-in-wall guard, reload/swap/dual-wield, falloff and hit zones, airborne
 * recoil push, weight, and melee (lunge, arc hit test, knockback, the one-hit Machete).
 */
import { CROUCHED_HITBOXES, HitZone, NO_WEAPON, RIOT_SHIELD, STANDING_HITBOXES, heldTrigger, weapons, type WeaponClass, type WeaponDef } from '@military-forge/content';
import { DEG2RAD, hash4, hashToUnit, quantize, simCosSin, SCALAR_INV } from '@military-forge/shared';
import { DT, TICK_RATE, ticks } from './constants';
import { DamageSource } from './events';
import type { Game } from './game';
import { rayCapsule, rayCircle } from './geometry';
import { Btn, isDown, wasPressed } from './input';
import { DUAL_TOGGLE_TIME, allies, cancelReloads, knockOutOfDash, type PlayerState, type WeaponSlot } from './player';
import { stepGrenadeBelt } from './grenades';
import { launchProjectile } from './projectiles';
import { damageMine, mineHit, shootableMine } from './mines';
import { REWIND_COVER_TICKS, createHitPose } from './rewind';
import { damageShield, shieldHitT, shieldInFront, shieldRaised, shieldSlung } from './shield';
import { SegFlag, createRayHit } from './world';

const dir = { x: 0, y: 0 };
const aimDir = { x: 0, y: 0 };
const hit = createRayHit();
const guard = createRayHit();
const pose = createHitPose();

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

/** A minigun is spun up at this (WeaponSlot.spin): spin-up and spin-down rates are whole steps per tick. */
export const SPIN_FULL = 240;
/** seconds a minigun stays spun up on the second button alone, without firing (review M1) */
export const PRE_SPIN_HOLD = 2;

/** Spin gained per tick while spinning up (`up` s from rest) and lost per tick spinning down (`down` s from full). */
function spinRates(def: WeaponDef): { up: number; down: number } {
  const s = def.spin!;
  return { up: Math.max(1, Math.round(SPIN_FULL / ticks(s.up))), down: Math.max(1, Math.round(SPIN_FULL / ticks(s.down))) };
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

/**
 * The target is hidden from (sx, sy) now: solid level geometry (what stops a bullet) between there
 * and its head, its torso and its legs alike.
 */
function inCover(game: Game, sx: number, sy: number, q: PlayerState): boolean {
  const box = q.crouched ? CROUCHED_HITBOXES : STANDING_HITBOXES;
  return hidden(game, sx, sy, q.x, q.y + box.head.y) && hidden(game, sx, sy, q.x, q.y + (box.torso.y0 + box.torso.y1) / 2) && hidden(game, sx, sy, q.x, q.y + (box.legs.y0 + box.legs.y1) / 2);
}

/** Something that stops a bullet lies between (sx, sy) and (x, y). */
function hidden(game: Game, sx: number, sy: number, x: number, y: number): boolean {
  const dx = x - sx;
  const dy = y - sy;
  const len = Math.sqrt(dx * dx + dy * dy);
  return len > 1e-6 && game.world.raycast(sx, sy, dx / len, dy / len, len, SegFlag.BulletPass, coverHit);
}
const coverHit = createRayHit();

/** Result of traceTargets. Module scratch: the sim is single-threaded. */
const target = { id: -1, t: 0, zone: 0, shield: false, nx: 1 };

/**
 * The nearest player hitbox along a ray, closer than `maxT`, skipping the shooter and the players
 * in `skipMask` (bit per id). Dead players are skipped too, except those in `blockMask`: a victim
 * an earlier pellet of the same shot just killed still stops the later pellets (pellets don't
 * penetrate, docs/03 §11). Bullets, pellets and melee rays all test players here, so lag
 * compensation (rewound target poses, docs/05 §7.1) applies to all of them in one place.
 *
 * With `shields` (bullets and pellets: melee bypasses shields, docs/03 §9), a riot shield in the
 * way is struck before the body behind it: `target.shield`, with its outward normal's x in
 * `target.nx`. A raised one guards the front, a slung one the back. The shield is rewound with its
 * owner; one that broke since the shooter saw it no longer blocks.
 */
function traceTargets(
  game: Game,
  shooter: PlayerState,
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  maxT: number,
  skipMask = 0,
  blockMask = 0,
  shields = false,
): boolean {
  target.id = -1;
  target.t = maxT;
  target.zone = HitZone.None;
  target.shield = false;
  const passAllies = game.tuning.friendlyFire < 1;
  for (const q of game.players) {
    if (!q || q.id === shooter.id || (skipMask & (1 << q.id)) !== 0) continue;
    if (!q.alive && (blockMask & (1 << q.id)) === 0) continue;
    // team modes, friendly fire off: shots and swings go through teammates (and their shields)
    if (passAllies && allies(shooter, q)) continue;
    // lag compensation (server): test the target where the shooter saw it (docs/05 §7.1), unless
    // that was long ago and the target is behind cover now (the cover rule, rewind.ts)
    let rewound = game.rewind !== null && game.rewind.pose(q, shooter, pose);
    if (rewound && pose.ticksBack > REWIND_COVER_TICKS && inCover(game, sx, sy, q)) {
      rewound = false;
      game.rewind!.covered?.(q, shooter);
    }
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

    const crouched = rewound ? pose.crouched : q.crouched;
    const box = crouched ? CROUCHED_HITBOXES : STANDING_HITBOXES;
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
    let onShield = false;
    let side = 0;
    if (shields && q.shieldHp > 0) {
      const facing = rewound ? pose.facing : q.facing;
      const front = rewound ? pose.shield : shieldRaised(q);
      if (front || (rewound ? pose.shieldBack : shieldSlung(q))) {
        side = front ? facing : -facing;
        const ts = shieldHitT(sx, sy, dx, dy, qx, qy, side, crouched, front ? RIOT_SHIELD.forward : RIOT_SHIELD.backOffset);
        if (ts < tq) {
          tq = ts;
          z = HitZone.None;
          onShield = true;
        }
      }
    }
    if (tq < target.t) {
      target.t = tq;
      target.id = q.id;
      target.zone = z;
      target.shield = onShield;
      target.nx = side;
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
  const blocked = world.raycastBullet(sx, sy, aimDir.x, aimDir.y, def.muzzleLength, SegFlag.BulletPass, guard);
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
  recoilPush(game, p, def);
}

/** Where a shot fired now would go, before its spread (aimRay). */
export interface AimRay {
  /** the sim muzzle: on the ray, where a tracer starts (the wall's face when the muzzle is in one) */
  ox: number;
  oy: number;
  /** where the bullet stops: the first solid it meets, else the end of its reach */
  ex: number;
  ey: number;
  /** a solid stops it (false: it flies to its full reach) */
  hit: boolean;
  /** ± degrees the shot may stray from this line now (0: it goes exactly here) */
  spread: number;
}

export function createAimRay(): AimRay {
  return { ox: 0, oy: 0, ex: 0, ey: 0, hit: false, spread: 0 };
}

const rayDir = { x: 0, y: 0 };
const rayHit = createRayHit();
const rayGuard = createRayHit();

/**
 * The line a bullet from `slot` would fly if `p` fired now, cut at the first solid: fireShot's own
 * steps (the shoulder, the muzzle-in-wall guard, the map's bullet reach, the bullet raycast), without
 * the spread, the players or the mines. For the sniper's aim line (apps/web aimLine.ts). Reads the
 * game, never changes it (the map's ray scratch is set again by every shot), so it's safe between
 * ticks, on the server's game or a client's predicted one.
 */
export function aimRay(game: Game, p: PlayerState, slot: WeaponSlot, def: WeaponDef, out: AimRay): AimRay {
  const t = game.tuning;
  const world = game.world;
  const sx = p.shoulderX(t);
  const sy = p.shoulderY(t);
  simCosSin(p.aim, rayDir);
  out.spread = currentSpread(p, slot, def);
  if (world.raycastBullet(sx, sy, rayDir.x, rayDir.y, def.muzzleLength, SegFlag.BulletPass, rayGuard)) {
    out.ox = out.ex = rayGuard.x;
    out.oy = out.ey = rayGuard.y;
    out.hit = true;
    return out;
  }
  out.ox = sx + rayDir.x * def.muzzleLength;
  out.oy = sy + rayDir.y * def.muzzleLength;
  let endT = def.range;
  const mech = game.mech;
  if (mech) {
    mech.castBullet(sx, sy, rayDir.x, rayDir.y);
    endT = mech.bulletReach(def.range);
  }
  out.hit = world.raycastBullet(sx, sy, rayDir.x, rayDir.y, endT, SegFlag.BulletPass, rayHit);
  if (out.hit) endT = rayHit.t;
  out.ex = sx + rayDir.x * endT;
  out.ey = sy + rayDir.y * endT;
  return out;
}

/**
 * A launcher's or the flamethrower's shot (docs/03 §11): a projectile instead of a bullet
 * (projectiles.ts), the same seeded spread, bloom and kick, and a `shot` event at the muzzle for the
 * flash and the sound (no tracer: it starts and ends there). False when the grenade pool is full:
 * nothing leaves and the round isn't spent.
 */
function fireProjectile(game: Game, p: PlayerState, slot: WeaponSlot, def: WeaponDef): boolean {
  const g = launchProjectile(game, p, def, currentSpread(p, slot, def));
  if (!g) return false;
  game.events.push({ type: 'shot', shooter: p.id, weapon: def.index, ox: g.x, oy: g.y, ex: g.x, ey: g.y, hit: 0, target: -1, zone: HitZone.None });
  slot.bloom = Math.min(def.spread.bloomMax, slot.bloom + def.spread.bloomPerShot);
  simCosSin(p.aim, aimDir);
  recoilPush(game, p, def);
  return true;
}

// Recoil push (docs/02 §12, the owner's "rebounds physics after shots").
/** Recoil alone never takes the horizontal speed past this share of launchSpeedX: launches get the low launch drag (NOTES §17), shots don't. */
export const RECOIL_MAX_VX_SHARE = 0.9;
/** A shot fired down never takes the rise past this (m/s): one Breacher jump is ~2.5 m, more shots hover instead of rocketing. */
export const RECOIL_MAX_RISE = 10;
/** Crouching braces against the grounded slide. */
export const RECOIL_CROUCH_BRACE = 0.5;

/**
 * The kick of one shot, against the aim: in the air the whole push (a shotgun fired down lifts
 * you), on the ground a horizontal slide for the heavy guns. Speeds already past the caps (a blast
 * launch) are never cut, only not raised.
 */
function recoilPush(game: Game, p: PlayerState, def: WeaponDef): void {
  let push: number;
  if (p.grounded) {
    if (def.recoilPushGround <= 0) return;
    push = def.recoilPushGround * (p.crouched ? RECOIL_CROUCH_BRACE : 1);
  } else {
    if (def.recoilPushAir <= 0) return;
    push = def.recoilPushAir;
  }
  // like any push: the map scales it where you stand (docs/02 §20), and it ends a dash (docs/02 §21)
  const mech = game.mech;
  if (mech) push *= mech.knockbackMul(p, game.tuning);
  knockOutOfDash(p, game.tuning, mech ? mech.moveSpeedMul(p, game.tuning) : 1);
  const kx = -aimDir.x * push;
  const ky = p.grounded ? 0 : -aimDir.y * push;
  const capX = Math.max(Math.abs(p.vx), game.tuning.launchSpeedX * RECOIL_MAX_VX_SHARE);
  const vx = p.vx + kx;
  p.vx = vx > capX ? capX : vx < -capX ? -capX : vx;
  p.vy = ky > 0 ? Math.max(p.vy, Math.min(p.vy + ky, RECOIL_MAX_RISE)) : p.vy + ky;
}

/**
 * One bullet or pellet along `dir`: world, then players; the first hit wins. A riot shield in the
 * way takes it instead, and it may bounce off (strikeShield). Returns the player hit by the bullet
 * or its ricochet, or -1. On maps with mechanics (docs/02 §20) its range is what the map leaves of
 * the weapon's: a map-wide multiplier, and damping zones it crosses use the range up faster;
 * damage falls off over that used-up range, not the metres flown.
 */
function traceBullet(game: Game, p: PlayerState, def: WeaponDef, sx: number, sy: number, visX: number, visY: number, maxT: number, blocked: boolean, struck: number): number {
  const mech = blocked ? null : game.mech;
  let endT = maxT;
  if (mech) {
    mech.castBullet(sx, sy, dir.x, dir.y);
    endT = mech.bulletReach(def.range);
  }
  let hitKind: 0 | 1 | 2 | 3 = 0;
  if (blocked) hitKind = 1;
  // walls only count within the bullet's reach: the weapon's range, or what the map leaves of it
  // (shorter in fog, longer under a map-wide multiplier above 1)
  else if (game.world.raycastBullet(sx, sy, dir.x, dir.y, endT, SegFlag.BulletPass, hit)) {
    endT = hit.t;
    hitKind = 1;
  }
  // mines are shootable (mines.ts): the nearest one before the wall stops the bullet
  const mine = !blocked && shootableMine(game, sx, sy, dir.x, dir.y, endT) ? mineHit.grenade : -1;
  if (mine >= 0) {
    endT = mineHit.t;
    hitKind = 1;
  }

  let victimId = -1;
  let zone: number = HitZone.None;
  if (traceTargets(game, p, sx, sy, dir.x, dir.y, endT, 0, struck, true)) {
    endT = target.t;
    victimId = target.id;
    zone = target.zone;
    hitKind = target.shield ? 3 : 2;
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

  // weapon range used up so far (the map's damping and multiplier included): falloff reads it
  const used = mech ? mech.bulletCost(endT) : endT;
  if (hitKind === 3) return strikeShield(game, p, def, victimId, target.nx, sx + dir.x * endT, sy + dir.y * endT, used, 0, struck, 1, 0);
  if (victimId >= 0) {
    const victim = game.players[victimId]!;
    const mul = zone === HitZone.Head ? def.headMul : 1;
    if (def.hitImpulse > 0 && victim.alive) push(game, victim, dir.x, dir.y, def.hitImpulse); // a corpse blocks but is not shoved
    game.damage(victim, def.damage * falloff(def, used) * mul, p.id, def.index, zone);
  } else if (mine >= 0) damageMine(game.grenades[mine]!, def.damage * falloff(def, used), p.id);
  return victimId;
}

/**
 * A bullet travelling along `dir`, with `used` of its weapon range spent and `damageMul` of its
 * damage left, strikes `ownerId`'s shield (raised or slung) at (bx, by); the shield's outward normal
 * is (nx, 0). The shield takes the damage, with the same falloff as a body hit (a Breacher's pellets
 * shove its owner too). Unless that breaks it, or the bullet is out of bounces, the bullet reflects
 * about the normal and flies on with the range it has left and ricochetDamageMul of its damage. On
 * maps with mechanics the ricochet leg spends the same budget: the map's reach from the bounce
 * point (castBullet + bulletReach), and its falloff reads the range used over both legs. A ricochet
 * goes through the same target loop (lag compensation applies) and can hit anyone but the shield's
 * owner and the shooter: bullets never hurt their shooter (docs/03 §8; owner's call, 17 Oct 2026).
 * Returns the player the ricochet hit, or -1.
 */
function strikeShield(
  game: Game,
  p: PlayerState,
  def: WeaponDef,
  ownerId: number,
  nx: number,
  bx: number,
  by: number,
  used: number,
  bounces: number,
  struck: number,
  damageMul: number,
  skipMask: number,
): number {
  const owner = game.players[ownerId]!;
  if (def.hitImpulse > 0) {
    push(game, owner, dir.x, dir.y, def.hitImpulse);
    // a shove is an attack: a carrier pushed into a pit is the shooter's kill (docs/03 §8), as with a body hit
    owner.lastAttacker = p.id;
    owner.lastAttackTick = game.tick;
  }
  if (damageShield(game, owner, def.damage * damageMul * falloff(def, used), p.id, bx, by)) return -1; // the bullet that breaks it is spent
  if (bounces >= RIOT_SHIELD.maxBounces) return -1;

  // reflect about the normal n = (nx, 0), nx = ±1: d − 2(d·n)n turns the horizontal part around
  dir.x = -dir.x;
  const mul = damageMul * RIOT_SHIELD.ricochetDamageMul;
  const skip = skipMask | (1 << ownerId);
  const left = Math.max(0, def.range - used);
  const mech = game.mech;
  let endT = left;
  if (mech) {
    mech.castBullet(bx, by, dir.x, dir.y);
    endT = mech.bulletReach(left);
  }
  let hitKind: 0 | 1 | 2 | 3 = 0;
  if (game.world.raycastBullet(bx, by, dir.x, dir.y, endT, SegFlag.BulletPass, hit)) {
    endT = hit.t;
    hitKind = 1;
  }
  // a mine in the way stops the ricochet as it would the bullet (mines.ts)
  const mine = shootableMine(game, bx, by, dir.x, dir.y, endT) ? mineHit.grenade : -1;
  if (mine >= 0) {
    endT = mineHit.t;
    hitKind = 1;
  }
  let victimId = -1;
  let zone: number = HitZone.None;
  if (traceTargets(game, p, bx, by, dir.x, dir.y, endT, skip, struck, true)) {
    endT = target.t;
    victimId = target.id;
    zone = target.zone;
    hitKind = target.shield ? 3 : 2;
  }
  const ex = bx + dir.x * endT;
  const ey = by + dir.y * endT;
  game.events.push({ type: 'ricochet', shooter: p.id, owner: ownerId, weapon: def.index, x: bx, y: by, nx, ny: 0, ex, ey, hit: hitKind, target: victimId, zone });

  const usedNow = used + (mech ? mech.bulletCost(endT) : endT);
  if (hitKind === 3) return strikeShield(game, p, def, victimId, target.nx, ex, ey, usedNow, bounces + 1, struck, mul, skip);
  if (victimId >= 0) {
    const victim = game.players[victimId]!;
    const zoneMul = zone === HitZone.Head ? def.headMul : 1;
    if (def.hitImpulse > 0 && victim.alive) push(game, victim, dir.x, dir.y, def.hitImpulse);
    game.damage(victim, def.damage * mul * falloff(def, usedNow) * zoneMul, p.id, def.index, zone);
  } else if (mine >= 0) damageMine(game.grenades[mine]!, def.damage * mul * falloff(def, usedNow), p.id);
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
 * player in reach that a wall doesn't cover, once each, and shoves them along the aim. Melee
 * bypasses riot shields (docs/03 §9).
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
  // a gun's bash with the riot shield up is a shield bash (docs/03 §5); a melee weapon swings as itself
  const damage = def?.fireMode === 'melee' ? def.meleeDamage : shieldInFront(p) ? RIOT_SHIELD.bashDamage : def ? def.meleeDamage : FIST_DAMAGE;
  simCosSin(p.aim, aimDir);
  for (const q of game.players) {
    if (!q || (struck & (1 << q.id)) === 0) continue;
    push(game, q, aimDir.x, aimDir.y, MELEE_KNOCKBACK);
    game.damage(q, damage, p.id, DamageSource.Melee, HitZone.Torso);
  }
}

/**
 * A semi weapon with `holdRepeat`, its trigger held: has it been long enough since its last shot for
 * the next? The clock is the slot's ticksSinceShot (the local block carries it, so prediction agrees),
 * and the cooldown still applies on top. A held trigger fires at once on a gun that hasn't fired in a
 * while (just swapped to, reloaded, picked up), like an automatic's.
 */
export function repeatsHeld(slot: Pick<WeaponSlot, 'ticksSinceShot'>, def: Pick<WeaponDef, 'holdRepeat'>): boolean {
  return def.holdRepeat !== undefined && slot.ticksSinceShot >= Math.min(HOLD_REPEAT_MAX_TICKS, ticks(def.holdRepeat));
}

/** ticksSinceShot rides the local block as 7 bits: a longer hold-repeat could never be reached on a client. */
export const HOLD_REPEAT_MAX_TICKS = 127;

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
    // a beam's cell refills by itself once off the trigger for a moment (held on an empty cell, it waits)
    const triggerHeld = isDown(buttons, Btn.Fire) && (p.dual || slot === p.weapons[p.active]);
    if (def.regen && slot.mag < def.mag && !triggerHeld && slot.ticksSinceShot >= ticks(def.regen.delay) && game.tick % Math.max(1, Math.round(TICK_RATE / def.regen.perSec)) === 0) slot.mag++;
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
  const ready = p.swapTicks === 0 && !meleeBusy(p);
  const firing = isDown(buttons, Btn.Fire);
  const pressed = wasPressed(buttons, prev, Btn.Fire);
  for (let s = 0; s < 2; s++) {
    const slot = p.weapons[s]!;
    if (slot.def === NO_WEAPON) continue;
    const def = weapons[slot.def]!;
    const inHand = p.dual || s === p.active;
    // a minigun spins while either fire button is held in hand, and winds down otherwise. Spun up
    // on the second button alone it winds down after PRE_SPIN_HOLD s without a shot (review M1): the
    // clock (ticksSinceShot) starts when a spin-up starts from rest (a press, or firing), and only a
    // shot restarts it, so pressing the second button again keeps nothing spinning (#107 review)
    if (def.spin) {
      const rate = spinRates(def);
      const wants = inHand && ready && slot.reloadTicks === 0 && (firing || isDown(buttons, Btn.Fire2));
      if (wants && slot.spin === 0 && (firing || wasPressed(buttons, prev, Btn.Fire2))) slot.ticksSinceShot = 0;
      const spinning = wants && (firing || slot.ticksSinceShot < ticks(PRE_SPIN_HOLD));
      slot.spin = spinning ? Math.min(SPIN_FULL, slot.spin + rate.up) : Math.max(0, slot.spin - rate.down);
    }
    // a charge weapon (`spin` counts the ticks charged): a press starts it, holding fills it, letting
    // go (or swapping away) loses it; it fires once full, then waits for the next press
    if (def.charge) {
      const canCharge = inHand && ready && slot.reloadTicks === 0 && slot.cooldown <= 1e-6 && slot.mag > 0;
      slot.spin = canCharge && firing && (slot.spin > 0 || pressed) ? Math.min(255, slot.spin + 1) : 0;
    }
    if (!inHand || !ready || def.fireMode === 'melee') continue;
    // a burst under way carries on by itself; a charge fires when full; held modes fire while held,
    // semi on a press, and held again once `holdRepeat` has passed since its last shot (repeatsHeld)
    const trigger = def.charge ? slot.spin >= ticks(def.charge) : slot.burst > 0 || (heldTrigger(def) ? firing : pressed || (firing && repeatsHeld(slot, def)));
    if (!trigger || slot.reloadTicks > 0 || slot.cooldown > 1e-6) continue;
    if (def.spin && slot.spin < SPIN_FULL) continue;
    if (slot.mag <= 0) {
      slot.burst = 0;
      if (!p.dual) startReload(slot, def);
      continue;
    }
    if (def.projectile) {
      if (!fireProjectile(game, p, slot, def)) continue; // the pool is full: the round stays
    } else fireShot(game, p, slot, def);
    if (def.charge) slot.spin = 0;
    slot.mag--;
    slot.ticksSinceShot = 0;
    if (def.burst) {
      // the burst's rounds come burst.interval apart; the next burst starts `interval` after this one did
      if (slot.burst === 0) slot.burst = def.burst.count;
      slot.burst--;
      slot.cooldown += (slot.burst > 0 ? def.burst.interval : def.interval - (def.burst.count - 1) * def.burst.interval) * TICK_RATE;
    } else slot.cooldown += def.interval * TICK_RATE;
    if (slot.mag === 0) {
      slot.burst = 0;
      if (!p.dual) startReload(slot, def); // auto-reload when empty
    }
  }

  // grenades: the cycle key, then the grenade key throws the selected type
  stepGrenadeBelt(game, p);
}

/** Passive health regeneration (docs/02 §8). */
export function stepRegen(game: Game, p: PlayerState): void {
  const t = game.tuning;
  if (p.regenDelay > 0) p.regenDelay--;
  else if (p.hp < t.healthMax) p.hp = Math.min(t.healthMax, p.hp + t.healthRegen * DT);
}
