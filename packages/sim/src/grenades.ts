/**
 * Grenades (docs/02 §13.2, §14): the belt a player carries (counts per type, the selected type, the
 * cycle key) and the thrown projectiles. Every type flies the same way: swept-circle CCD against
 * segments, bounce with restitution + tangential friction, rest/roll, fuse. When the fuse runs out
 * it does its effect: a frag explodes, smoke and gas pop into clouds (clouds.ts), a flashbang
 * blinds whoever sees it, an EMP kills jetpacks and disarms mines. Mines run their own state
 * machine instead (mines.ts).
 */
import { GRENADE_TYPES, grenades, projectileOfType, type EmpDef, type ExplosionDef, type FlashDef, type GrenadeDef } from '@military-forge/content';
import { POS_INV, VEL_INV, quantize, simCosSin } from '@military-forge/shared';
import { smokeBlocks, spawnCloud } from './clouds';
import { DT, TICK_RATE, ticks } from './constants';
import { DamageSource } from './events';
import type { Game } from './game';
import { closestPointOnSegment, rayCapsule } from './geometry';
import { Btn, wasPressed } from './input';
import { createBodyEnv, type BodyEnv } from './mechanics';
import { chainMines, disarmMines, mineOf, retireMines, stepMine } from './mines';
import { hitboxLayout, knockOutOfDash, type PlayerState } from './player';
import { stepProjectile } from './projectiles';
import { SegFlag, createRayHit, type CollisionWorld } from './world';

export class GrenadeState {
  alive = false;
  owner = -1;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  fuse = 0;
  /** grenade type (packages/content grenades); 0 = frag */
  type = 0;
  /** a mine's state (mines.ts MineState: flying, arming, armed, triggered); always 0 for the other types */
  state = 0;
  /** a mine's hit points left once a bullet has hit it (0 = untouched); always 0 for the other types */
  hp = 0;
  /** the tick it was thrown (allocGrenade): the oldest mine is the one a new one retires; a flame's age */
  born = 0;
  /** projectiles (projectiles.ts): the weapon that fired it (damage credit), else −1 */
  weapon = -1;
  /** projectiles: players a saw blade has cut since its last bounce (bit per player id) */
  hits = 0;
  constructor(readonly id: number) {}
}

const aim = { x: 0, y: 0 };
const pt = { x: 0, y: 0 };
const ray = createRayHit();
/** Result of sweepCircle (module scratch: the sim is single-threaded). */
export const sweepHit = { t: 0, nx: 0, ny: 0 };

// ---------- the belt ----------

/**
 * Gives `p` up to `n` grenades of `type`, capped at the type's maxCount; returns how many it took
 * (0 = full: a pickup should stay on the floor). An empty selection moves to the new type. For map
 * pickups, which give grenades in pairs (GRENADE_PICKUP_COUNT).
 */
export function addGrenades(p: PlayerState, type: number, n: number): number {
  const def = grenades[type];
  if (!def || n <= 0) return 0;
  const before = p.grenadeCounts[type]!;
  const after = Math.min(def.maxCount, before + n);
  p.grenadeCounts[type] = after;
  if (after > before && p.grenadeCounts[p.grenadeType] === 0) p.grenadeType = type;
  return after - before;
}

/** The next type after the selected one that `p` holds (wrapping round), or the selected type if none. */
export function nextHeldGrenade(p: PlayerState): number {
  for (let k = 1; k < GRENADE_TYPES; k++) {
    const type = (p.grenadeType + k) % GRENADE_TYPES;
    if (p.grenadeCounts[type]! > 0) return type;
  }
  return p.grenadeType;
}

/** The cycle key, then the grenade key (docs/02 §14 "Carrying & cycling"). Runs with the weapons. */
export function stepGrenadeBelt(game: Game, p: PlayerState): void {
  const buttons = p.input.buttons;
  const prev = p.prevButtons;
  if (wasPressed(buttons, prev, Btn.CycleGrenade)) p.grenadeType = nextHeldGrenade(p);
  if (!wasPressed(buttons, prev, Btn.Grenade) || p.throwCooldown !== 0) return;
  const type = p.grenadeType;
  const def = grenades[type];
  if (!def || p.grenadeCounts[type] === 0 || !throwGrenade(game, p, def)) return;
  p.grenadeCounts[type] = p.grenadeCounts[type]! - 1;
  p.throwCooldown = ticks(def.throwCooldown);
  // out of that type: the next one held comes up, so the key keeps throwing
  if (p.grenadeCounts[type] === 0) p.grenadeType = nextHeldGrenade(p);
}

/** Counts grenade status effects down at the end of a tick (blindness, the gas cough, a dead jetpack). */
export function stepStatus(p: PlayerState): void {
  if (p.blindTicks > 0) p.blindTicks--;
  if (p.blindTicks === 0) p.blindFade = 0;
  if (p.gasTicks > 0) p.gasTicks--;
  if (p.jetDisabledTicks > 0) p.jetDisabledTicks--;
}

/** White-out 0…1 of a blinded player: full white, then the last `blindFade` ticks fade out. */
export function blindIntensity(p: { blindTicks: number; blindFade: number }): number {
  if (p.blindTicks <= 0) return 0;
  return p.blindTicks >= p.blindFade ? 1 : p.blindTicks / p.blindFade;
}

// ---------- flight ----------

/** Earliest hit of a circle moving by (mx, my) this step, into sweepHit. */
export function sweepCircle(world: CollisionWorld, x: number, y: number, mx: number, my: number, radius: number): boolean {
  const count = world.queryAabb(
    Math.min(x, x + mx) - radius - 0.05,
    Math.min(y, y + my) - radius - 0.05,
    Math.max(x, x + mx) + radius + 0.05,
    Math.max(y, y + my) + radius + 0.05,
  );
  let bestT = Infinity;
  let bestSeg = -1;
  let bestNx = 0;
  let bestNy = 0;
  for (let k = 0; k < count; k++) {
    const seg = world.queryResult[k]!;
    const flags = world.flags[seg]!;
    if (flags & SegFlag.OneWay && flags & SegFlag.BulletPass) {
      // platforms only stop grenades falling onto them from above (a slab that stops bullets, both ways)
      if (my >= 0 || y - radius < world.segmentYAt(seg, x) - 0.01) continue;
    }
    const ax = world.ax[seg]!;
    const ay = world.ay[seg]!;
    const bx = world.bx[seg]!;
    const by = world.by[seg]!;
    const t = rayCapsule(x, y, mx, my, ax, ay, bx, by, radius);
    if (t > 1 || t > bestT) continue;
    const hx = x + mx * t;
    const hy = y + my * t;
    closestPointOnSegment(hx, hy, ax, ay, bx, by, pt);
    let nx = hx - pt.x;
    let ny = hy - pt.y;
    const len = Math.sqrt(nx * nx + ny * ny);
    if (len > 1e-9) {
      nx /= len;
      ny /= len;
    } else {
      nx = world.nx[seg]!;
      ny = world.ny[seg]!;
    }
    if (mx * nx + my * ny >= 0) continue; // moving away (e.g. escaping an initial overlap)
    if (t < bestT) {
      bestT = t;
      bestSeg = seg;
      bestNx = nx;
      bestNy = ny;
    }
  }
  if (bestSeg < 0) return false;
  sweepHit.t = bestT;
  sweepHit.nx = bestNx;
  sweepHit.ny = bestNy;
  return true;
}

export function throwGrenade(game: Game, p: PlayerState, def: GrenadeDef): boolean {
  // a thrower keeps a few mines out at most; the shared pool never fills up with them (review M4)
  if (def.effect === 'mine') retireMines(game, p.id, def.mine.maxLive - 1);
  const g = game.allocGrenade() ?? (retireMines(game, -1, 0, 1) ? game.allocGrenade() : null);
  if (!g) return false;
  const t = game.tuning;
  const sx = p.shoulderX(t);
  const sy = p.shoulderY(t);
  simCosSin(p.aim, aim);
  const strength = 0.7 + (0.3 * Math.max(0, Math.min(7, p.input.throwStrength))) / 7;
  const speed = def.throwSpeed * strength * t.grenadeThrowScale;
  // spawn just in front of the shoulder, unless a wall is in the way
  let spawnDist = 0.35;
  if (game.world.raycast(sx, sy, aim.x, aim.y, spawnDist + def.radius, SegFlag.BulletPass, ray)) {
    spawnDist = Math.max(0, ray.t - def.radius - 0.02);
  }
  g.alive = true;
  g.owner = p.id;
  g.type = def.index;
  g.state = 0;
  g.x = sx + aim.x * spawnDist;
  g.y = sy + aim.y * spawnDist;
  g.vx = aim.x * speed + p.vx * def.inheritVelocity;
  g.vy = aim.y * speed + p.vy * def.inheritVelocity;
  g.fuse = ticks(def.fuse);
  game.events.push({ type: 'throw', owner: p.id, grenade: g.id });
  return true;
}

/** Fastest a grenade falls (m/s), and rises under reversed gravity. */
const GRENADE_TERMINAL = 30;
const grenadeEnv = createBodyEnv();

/** Map mechanics on a grenade (docs/02 §20): pads, wind and drag, then gravity scaled by the map. */
/**
 * A player left (Game.removePlayer): what it left behind stops being its, so the next player given
 * its id doesn't inherit it (review M5). Its mines go; its grenades in flight and its clouds are
 * nobody's (their damage is the world's).
 */
export function forgetOwner(game: Game, id: number): void {
  for (const g of game.grenades) {
    if (!g.alive || g.owner !== id) continue;
    if (mineOf(g)) g.alive = false;
    else g.owner = -1;
  }
  for (const c of game.clouds) if (c.alive && c.owner === id) c.owner = -1;
}

/** The map's pull on a grenade (docs/02 §20): pads, wind, drag, and gravity × `gravityScale` × the zone's multiplier. */
export function grenadeForces(game: Game, g: GrenadeState, gravityScale: number, env: BodyEnv): void {
  for (let i = 0; i < env.padCount; i++) {
    const ux = env.padUx[i]!;
    const uy = env.padUy[i]!;
    const short = env.padSpeed[i]! - (g.vx * ux + g.vy * uy);
    if (short <= 0) continue;
    g.vx += short * ux;
    g.vy += short * uy;
  }
  if (env.windX !== 0 || env.windY !== 0) {
    g.vx += env.windX * DT;
    g.vy += env.windY * DT;
  }
  if (env.dragKeep !== 1) {
    g.vx *= env.dragKeep;
    g.vy *= env.dragKeep;
  }
  const gravity = game.tuning.gravity * gravityScale * env.gravityMul;
  g.vy = gravity >= 0 ? Math.max(-GRENADE_TERMINAL, g.vy - gravity * DT) : Math.min(GRENADE_TERMINAL, g.vy - gravity * DT);
}

export function stepGrenade(game: Game, g: GrenadeState): void {
  const proj = projectileOfType(g.type);
  if (proj) {
    stepProjectile(game, g, proj);
    return;
  }
  const def = grenades[g.type];
  if (!def) {
    g.alive = false;
    return;
  }
  if (def.effect === 'mine') {
    stepMine(game, g, def);
    return;
  }
  if (--g.fuse <= 0) {
    detonate(game, g, def);
    return;
  }
  if (game.mech) grenadeForces(game, g, def.gravityScale, game.mech.envAt(g.x, g.y, grenadeEnv));
  else g.vy = Math.max(-GRENADE_TERMINAL, g.vy - game.tuning.gravity * def.gravityScale * DT);

  let remaining = 1;
  for (let iter = 0; iter < 3 && remaining > 1e-6; iter++) {
    const mx = g.vx * DT * remaining;
    const my = g.vy * DT * remaining;
    if (!sweepCircle(game.world, g.x, g.y, mx, my, def.radius)) {
      g.x += mx;
      g.y += my;
      break;
    }
    const { t, nx, ny } = sweepHit;
    g.x += mx * t + nx * 1e-4;
    g.y += my * t + ny * 1e-4;
    const vn = g.vx * nx + g.vy * ny;
    if (vn < 0) {
      const tx = g.vx - nx * vn;
      const ty = g.vy - ny * vn;
      if (-vn < def.restNormalSpeed && ny > 0.7) {
        // resting / rolling: no bounce, rolling friction on the tangential part
        const ts = Math.sqrt(tx * tx + ty * ty);
        const k = ts > 1e-9 ? Math.max(0, 1 - (def.rollFriction * DT) / ts) : 0;
        g.vx = tx * k;
        g.vy = ty * k;
      } else {
        g.vx = tx * (1 - def.friction) - nx * vn * def.restitution;
        g.vy = ty * (1 - def.friction) - ny * vn * def.restitution;
      }
    }
    remaining *= 1 - t;
  }

  g.x = quantize(g.x, POS_INV);
  g.y = quantize(g.y, POS_INV);
  g.vx = quantize(g.vx, VEL_INV);
  g.vy = quantize(g.vy, VEL_INV);
}

/** The fuse ran out: the grenade's effect, by type. */
function detonate(game: Game, g: GrenadeState, def: GrenadeDef): void {
  g.alive = false;
  switch (def.effect) {
    case 'explode':
      explode(game, g.x, g.y, g.owner, def.explosion, DamageSource.Grenade, def.index);
      break;
    case 'cloud':
      spawnCloud(game, def.index, g.x, g.y, g.owner);
      break;
    case 'flash':
      flash(game, g.x, g.y, g.owner, def.flash, def.index);
      break;
    case 'emp':
      emp(game, g.x, g.y, g.owner, def.emp, def.index);
      break;
    case 'mine':
      break; // mines.ts runs mines
  }
}

/**
 * An EMP burst (docs/02 §14): every jetpack within the radius (to the torso, through walls) is dead
 * for jetDisable seconds, the thrower's too; mines within it are disarmed. No damage.
 */
export function emp(game: Game, x: number, y: number, owner: number, def: EmpDef, grenade: number): void {
  game.events.push({ type: 'explosion', x, y, radius: def.radius, owner, grenade });
  const off = ticks(def.jetDisable);
  for (const q of game.players) {
    if (!q?.alive) continue;
    const box = hitboxLayout(q);
    closestPointOnSegment(x, y, q.x, q.y + box.torso.y0, q.x, q.y + box.torso.y1, pt);
    const dx = pt.x - x;
    const dy = pt.y - y;
    if (Math.sqrt(dx * dx + dy * dy) - box.torso.r > def.radius) continue;
    q.jetDisabledTicks = Math.max(q.jetDisabledTicks, off);
    q.jetting = false;
  }
  disarmMines(game, x, y, def.radius);
}

/**
 * How hard a flash at (x, y) hits `q`'s eyes, 0…1 (docs/02 §14): distance (full inside fullRadius,
 * linear to 0 at radius) × facing (by the cosine between the aim and the flash: 1 looking at it,
 * awayMul looking away) × cover (a wall: coverMul; smoke: smokeMul).
 */
export function flashStrength(game: Game, q: PlayerState, x: number, y: number, def: FlashDef): number {
  const ex = q.x;
  const ey = q.y + hitboxLayout(q).head.y;
  const dx = x - ex;
  const dy = y - ey;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d >= def.radius) return 0;
  const near = d <= def.fullRadius ? 1 : 1 - (d - def.fullRadius) / (def.radius - def.fullRadius);
  if (d <= 1e-6) return near; // in your face
  simCosSin(q.aim, aim);
  const cos = (aim.x * dx + aim.y * dy) / d;
  const facing = def.awayMul + ((1 - def.awayMul) * (1 + cos)) / 2;
  let cover = 1;
  if (game.world.raycast(ex, ey, dx / d, dy / d, d, SegFlag.BulletPass, ray)) cover = def.coverMul;
  else if (smokeBlocks(game, x, y, ex, ey)) cover = def.smokeMul;
  return near * facing * cover;
}

/**
 * A flashbang goes off: everyone it reaches is blinded for `white × strength` seconds of full
 * white then `fade × strength` (at least minFade) of fading out; the thrower too. A longer
 * blindness already running is kept. No damage.
 */
export function flash(game: Game, x: number, y: number, owner: number, def: FlashDef, grenade: number): void {
  game.events.push({ type: 'explosion', x, y, radius: def.fullRadius, owner, grenade });
  for (const q of game.players) {
    if (!q?.alive) continue;
    const strength = flashStrength(game, q, x, y, def);
    if (strength < def.minStrength) continue;
    const fade = Math.max(ticks(def.minFade), Math.round(def.fade * strength * TICK_RATE));
    const total = Math.round(def.white * strength * TICK_RATE) + fade;
    if (total <= q.blindTicks) continue;
    q.blindTicks = total;
    q.blindFade = fade;
  }
}

/**
 * Radial damage with line-of-sight and knockback (docs/02 §12, §14). `shielded`: the player whose
 * riot shield the blast went off against (a launcher's projectile stopped at its face): covered,
 * as behind a wall.
 */
export function explode(game: Game, x: number, y: number, owner: number, def: ExplosionDef, source: number = DamageSource.Grenade, grenade = 0, shielded = -1): void {
  game.events.push({ type: 'explosion', x, y, radius: def.radius, owner, grenade });
  const world = game.world;
  for (const q of game.players) {
    if (!q || !q.alive) continue;
    const box = hitboxLayout(q);
    // damage point: closest point on the torso capsule
    closestPointOnSegment(x, y, q.x, q.y + box.torso.y0, q.x, q.y + box.torso.y1, pt);
    const tx = pt.x;
    const ty = pt.y;
    const dx = tx - x;
    const dy = ty - y;
    const centreDist = Math.sqrt(dx * dx + dy * dy);
    const d = Math.max(0, centreDist - box.torso.r);
    if (d > def.radius) continue;

    // line of sight to torso, then head
    let covered = centreDist > 1e-6 && world.raycast(x, y, dx / centreDist, dy / centreDist, centreDist, SegFlag.BulletPass, ray);
    if (covered) {
      const hx = q.x - x;
      const hy = q.y + box.head.y - y;
      const hd = Math.sqrt(hx * hx + hy * hy);
      covered = hd > 1e-6 && world.raycast(x, y, hx / hd, hy / hd, hd, SegFlag.BulletPass, ray);
    }
    if (q.id === shielded) covered = true; // the shield it went off against is between them

    let damage = 0;
    if (!covered) {
      if (d <= def.core) damage = def.maxDamage;
      else {
        const k = (d - def.core) / (def.radius - def.core);
        damage = def.maxDamage * (1 - k * Math.sqrt(k)); // k^1.5
      }
      if (q.crouched) damage *= def.crouchDamageMul;
      if (q.id === owner) damage *= def.selfDamageMul;
    }

    // knockback
    const k = 1 - (d / def.radius) * (d / def.radius);
    const cx = q.x - x;
    const cy = q.y + (box.torso.y0 + box.torso.y1) / 2 - y + def.upBias;
    const cl = Math.sqrt(cx * cx + cy * cy);
    if (cl > 1e-6 && k > 0) {
      knockOutOfDash(q, game.tuning, game.mech ? game.mech.moveSpeedMul(q, game.tuning) : 1); // blasts end a dash (docs/02 §21)
      let mag = def.impulse * game.tuning.blastImpulseScale * k * (covered ? def.coveredImpulseMul : 1) * (q.id === owner ? def.selfImpulseMul : 1);
      if (game.mech) mag *= game.mech.knockbackMul(q, game.tuning);
      let ux = cx / cl;
      let uy = cy / cl;
      // level or low blasts launch in an arc (minLift); blasts from above keep pushing down
      if (uy > -0.2 && uy < def.minLift) {
        uy = def.minLift;
        ux = (ux < 0 ? -1 : 1) * Math.sqrt(1 - uy * uy);
      }
      q.vx += ux * mag;
      q.vy += uy * mag;
      if (uy > 0.2) q.grounded = false;
    }
    if (damage > 0) game.damage(q, damage, owner, source, 2);
  }
  // mines in the blast go off too, a moment later (staggered chains)
  chainMines(game, x, y, def.radius);
}
