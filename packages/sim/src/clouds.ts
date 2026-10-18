/**
 * Smoke and toxic gas clouds (docs/02 §14). A grenade with a `cloud` effect pops into one when its
 * fuse runs out. The cloud stays where it popped, grows in, holds, then thins out and shrinks. Its
 * size is a pure function of its type and age (cloudRadius), so a client draws it from the snapshot
 * exactly as the server sees it.
 *
 * Smoke blocks sight lines (lineOfSight, canSee: bots, aim assist, the server's AOI). Gas hurts
 * whoever is inside it, most at the centre, in pulses. Walls stop both: a cloud never reaches
 * through a wall, and a point on the far side of one from the cloud's centre is not inside it.
 */
import { HitZone, grenades, weapons, type CloudDef } from '@military-forge/content';
import { POS_INV, quantize } from '@military-forge/shared';
import { MAX_CLOUDS, MAX_PLAYERS, TICK_RATE, ticks } from './constants';
import { DamageSource } from './events';
import type { Game } from './game';
import { closestPointOnSegment } from './geometry';
import { hitboxLayout, type PlayerState } from './player';
import { SegFlag, createRayHit } from './world';

export class CloudState {
  alive = false;
  /** grenade type (packages/content grenades) */
  type = 0;
  owner = -1;
  /** centre (m) */
  x = 0;
  y = 0;
  /** ticks since it popped */
  age = 0;
  constructor(readonly id: number) {}
}

/** The cloud sits this far above where its grenade popped (on the floor it covers standing bodies)... */
const CLOUD_LIFT = 1;
/** ...but stays this far below a ceiling. */
const CEILING_GAP = 0.2;
/** Smoke blocks sight inside this share of its radius (the rim is thin haze)... */
const OPAQUE_FRACTION = 0.85;
/** ...while it is at least this dense (the second half of its fade lets sight through). */
const OPAQUE_DENSITY = 0.5;
/** A gas pulse leaves the victim coughing this long (HUD, bots). */
export const GAS_LINGER_TICKS = ticks(0.5);

const ray = createRayHit();
const pt = { x: 0, y: 0 };

/** The cloud a grenade type makes, or null for types that don't make one. */
export function cloudDef(type: number): CloudDef | null {
  const def = grenades[type];
  return def?.effect === 'cloud' ? def.cloud : null;
}

/** Radius (m) at `age` ticks: grows in (ease-out), holds, then shrinks as it thins out. */
export function cloudRadius(def: CloudDef, age: number): number {
  const t = age / TICK_RATE;
  if (t < def.grow) {
    const u = 1 - t / def.grow;
    return def.radius * (def.startFraction + (1 - def.startFraction) * (1 - u * u));
  }
  const fadeStart = def.duration - def.fade;
  if (t <= fadeStart) return def.radius;
  return def.radius * (1 - (1 - def.endFraction) * Math.min(1, (t - fadeStart) / def.fade));
}

/** Opacity 0…1: dense from the pop, thinning out linearly over the fade. */
export function cloudDensity(def: CloudDef, age: number): number {
  const t = age / TICK_RATE;
  const fadeStart = def.duration - def.fade;
  return t <= fadeStart ? 1 : Math.max(0, 1 - (t - fadeStart) / def.fade);
}

/** Radius (m) inside which a cloud blocks sight now; 0 for gas, or smoke that has thinned out. */
export function visionRadius(def: CloudDef, age: number): number {
  if (!def.blocksVision || cloudDensity(def, age) < OPAQUE_DENSITY) return 0;
  return cloudRadius(def, age) * OPAQUE_FRACTION;
}

/** True if a wall (not a fence or platform) separates the cloud's centre from (x, y). */
function walled(game: Game, c: CloudState, x: number, y: number): boolean {
  const dx = x - c.x;
  const dy = y - c.y;
  const d = Math.sqrt(dx * dx + dy * dy);
  return d > 1e-6 && game.world.raycast(c.x, c.y, dx / d, dy / d, d, SegFlag.BulletPass, ray);
}

/** Pops a cloud of grenade `type` at (x, y). With every slot taken, the oldest cloud makes room. */
export function spawnCloud(game: Game, type: number, x: number, y: number, owner: number): CloudState | null {
  if (!cloudDef(type)) return null;
  let slot: CloudState | null = null;
  for (const c of game.clouds) {
    if (!c.alive) {
      slot = c;
      break;
    }
    if (!slot || c.age > slot.age) slot = c;
  }
  if (!slot) return null;
  // rise a metre, but not into a ceiling (the ray starts a hair up: a canister lying exactly on
  // the floor would otherwise hit the floor itself)
  let lift = CLOUD_LIFT;
  if (game.world.raycast(x, y + 0.01, 0, 1, CLOUD_LIFT + CEILING_GAP, SegFlag.BulletPass, ray)) lift = Math.max(0, ray.t + 0.01 - CEILING_GAP);
  slot.alive = true;
  slot.type = type;
  slot.owner = owner;
  slot.x = x;
  slot.y = quantize(y + lift, POS_INV);
  slot.age = 0;
  return slot;
}

/** Ages every cloud, retires the expired ones and applies gas damage pulses (after grenades). */
export function stepClouds(game: Game): void {
  for (const c of game.clouds) {
    if (!c.alive) continue;
    const def = cloudDef(c.type);
    c.age++;
    if (!def || c.age >= ticks(def.duration)) {
      c.alive = false;
      continue;
    }
    if (def.dpsCore > 0 && c.age % ticks(def.pulse) === 0) gasPulse(game, c, def);
  }
}

/** One damage pulse: everyone whose torso is inside, by distance from the centre (docs/02 §14). */
function gasPulse(game: Game, c: CloudState, def: CloudDef): void {
  const r = cloudRadius(def, c.age);
  for (const q of game.players) {
    if (!q?.alive) continue;
    const box = hitboxLayout(q);
    closestPointOnSegment(c.x, c.y, q.x, q.y + box.torso.y0, q.x, q.y + box.torso.y1, pt);
    const dx = pt.x - c.x;
    const dy = pt.y - c.y;
    const d = Math.max(0, Math.sqrt(dx * dx + dy * dy) - box.torso.r);
    if (d > r || walled(game, c, pt.x, pt.y)) continue;
    const dps = d <= def.core || r <= def.core ? def.dpsCore : def.dpsCore + ((def.dpsEdge - def.dpsCore) * (d - def.core)) / (r - def.core);
    q.gasTicks = GAS_LINGER_TICKS;
    game.damage(q, dps * def.pulse * (q.id === c.owner ? def.selfDamageMul : 1), c.owner, DamageSource.Gas, HitZone.Torso);
  }
}

/**
 * Clears gas clouds that a flame at (x, y) with radius `r` touches (docs/03 §11: the Dragon's fire
 * burns gas away). For the flamethrower when it lands; nothing calls it yet.
 */
export function clearGasAt(game: Game, x: number, y: number, r: number): number {
  let cleared = 0;
  for (const c of game.clouds) {
    const def = c.alive ? cloudDef(c.type) : null;
    if (!def || def.dpsCore <= 0) continue;
    const reach = cloudRadius(def, c.age) + r;
    if ((c.x - x) * (c.x - x) + (c.y - y) * (c.y - y) > reach * reach || walled(game, c, x, y)) continue;
    c.alive = false;
    cleared++;
  }
  return cleared;
}

/** Bit per cloud slot (MAX_CLOUDS ≤ 32): the smoke clouds whose opaque part holds the point (x, y). */
export function smokeMaskAt(game: Game, x: number, y: number): number {
  let mask = 0;
  for (const c of game.clouds) {
    const def = c.alive ? cloudDef(c.type) : null;
    const r = def ? visionRadius(def, c.age) : 0;
    if (r <= 0 || (x - c.x) * (x - c.x) + (y - c.y) * (y - c.y) > r * r || walled(game, c, x, y)) continue;
    mask |= 1 << c.id;
  }
  return mask;
}

/**
 * Bit per cloud slot: the smoke clouds that hide all of `p`, feet to head (the server's AOI
 * doesn't send such a player to viewers outside the cloud).
 */
export function smokeMaskBody(game: Game, p: PlayerState): number {
  const t = game.tuning;
  const r = t.capsuleRadius;
  const yLow = p.y + r;
  const yHigh = p.y + p.height(t) - r;
  let mask = 0;
  for (const c of game.clouds) {
    const def = c.alive ? cloudDef(c.type) : null;
    const vr = def ? visionRadius(def, c.age) - r : 0;
    if (vr <= 0) continue;
    const dx = p.x - c.x;
    const lo = yLow - c.y;
    const hi = yHigh - c.y;
    if (dx * dx + lo * lo > vr * vr || dx * dx + hi * hi > vr * vr || walled(game, c, p.x, (yLow + yHigh) / 2)) continue;
    mask |= 1 << c.id;
  }
  return mask;
}

/** True if a smoke cloud's opaque part lies across the segment from (ax, ay) to (bx, by). */
export function smokeBlocks(game: Game, ax: number, ay: number, bx: number, by: number): boolean {
  for (const c of game.clouds) {
    const def = c.alive ? cloudDef(c.type) : null;
    const r = def ? visionRadius(def, c.age) : 0;
    if (r <= 0) continue;
    closestPointOnSegment(c.x, c.y, ax, ay, bx, by, pt);
    const dx = pt.x - c.x;
    const dy = pt.y - c.y;
    if (dx * dx + dy * dy < r * r && !walled(game, c, pt.x, pt.y)) return true;
  }
  return false;
}

/** Nothing solid (fences and platforms are see-through) and no smoke between the two points. */
export function lineOfSight(game: Game, ax: number, ay: number, bx: number, by: number): boolean {
  const dx = bx - ax;
  const dy = by - ay;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > 1e-6 && game.world.raycast(ax, ay, dx / d, dy / d, d, SegFlag.BulletPass, ray)) return false;
  return !smokeBlocks(game, ax, ay, bx, by);
}

/**
 * Can `viewer` see `target`: a clear line from the viewer's eyes to the target's head or torso.
 * For bots and aim assist (smoke hides you from both); blindness is the caller's business.
 */
export function canSee(game: Game, viewer: PlayerState, target: PlayerState): boolean {
  const vb = hitboxLayout(viewer);
  const tb = hitboxLayout(target);
  const ex = viewer.x;
  const ey = viewer.y + vb.head.y;
  return (
    lineOfSight(game, ex, ey, target.x, target.y + tb.head.y) ||
    lineOfSight(game, ex, ey, target.x, target.y + (tb.torso.y0 + tb.torso.y1) / 2)
  );
}

/**
 * Sight lines through at least this much opaque smoke (m) are blocked: you can see out of a
 * cloud's edge, not through it.
 */
export const SMOKE_BLOCK_CHORD = 1;
/**
 * Inside a cloud, sight reaches this far (m): a sight line through this much of a core both ends
 * are in is blocked, so you see who's next to you in the smoke, not who's across it.
 */
export const SMOKE_NEAR_SIGHT = 1.5;
/** A tracer through a core a wall cuts through is checked for smoke every this many metres. */
const TRACER_STEP = 0.25;
/** Sight lines go to these points of a body: the top of the head, the chest, the feet. */
const SIGHT_POINTS = 3;

/** Length (m) of the part of the segment A→B inside the circle (cx, cy, r); its ends (fractions of A→B) into `chordAt`. */
const chordAt = { t1: 1, t2: 1 };
function chord(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, r: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const fx = ax - cx;
  const fy = ay - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  chordAt.t1 = chordAt.t2 = 1;
  if (a <= 1e-12 || disc <= 0) return 0;
  const sq = Math.sqrt(disc);
  const t1 = Math.max(0, (-b - sq) / (2 * a));
  const t2 = Math.min(1, (-b + sq) / (2 * a));
  if (t2 <= t1) return 0;
  chordAt.t1 = t1;
  chordAt.t2 = t2;
  return (t2 - t1) * Math.sqrt(a);
}

/**
 * Who can see what through smoke: the server's AOI anti-wallhack (snapshot.ts) and local mode's
 * renderer use this, so a player vanishes offline exactly where the server would stop sending it.
 * Built once per snapshot (or frame) from the opaque smoke cores, then answered with a few
 * circle–segment tests: usually 0–3 cores, 3 sight lines per pair, and a raycast only for a core a
 * wall cuts through.
 *
 * A target is hidden from a viewer when
 * - all of it is inside a core the viewer's eyes are outside of, or
 * - every sight line from the viewer's eyes to it (top of the head, chest, feet) runs through at
 *   least SMOKE_BLOCK_CHORD of a core, or SMOKE_NEAR_SIGHT of a core both of them are in: inside
 *   the same cloud you see each other only up close.
 * It's one-way at the rim: eyes within a metre of a core's edge see out, while a body all inside
 * the core is hidden from everyone outside it. Dead players are never hidden.
 */
export class SmokeSight {
  /** opaque cores this tick */
  count = 0;
  /** carryOn's answer: where the line ends, and how (1 at a wall, 0 at the end of its range) */
  readonly missed = { x: 0, y: 0, hit: 0 };
  private readonly cx = new Float64Array(MAX_CLOUDS);
  private readonly cy = new Float64Array(MAX_CLOUDS);
  private readonly cr = new Float64Array(MAX_CLOUDS);
  /** a wall cuts through the core: whether it's on a sight line needs a raycast */
  private readonly walledCore = new Uint8Array(MAX_CLOUDS);
  private readonly alive = new Uint8Array(MAX_PLAYERS);
  private readonly eyeX = new Float64Array(MAX_PLAYERS);
  private readonly eyeY = new Float64Array(MAX_PLAYERS);
  private readonly ptY = new Float64Array(MAX_PLAYERS * SIGHT_POINTS);
  /** per player, a bit per core: holding its eyes / touching its body / holding all of it */
  private readonly eyeMask = new Int32Array(MAX_PLAYERS);
  private readonly bodyMask = new Int32Array(MAX_PLAYERS);
  private readonly fullMask = new Int32Array(MAX_PLAYERS);
  private game: Game | null = null;

  gather(game: Game): void {
    this.game = game;
    this.count = 0;
    for (const c of game.clouds) {
      const def = c.alive ? cloudDef(c.type) : null;
      const r = def ? visionRadius(def, c.age) : 0;
      if (r <= 0) continue;
      const k = this.count++;
      this.cx[k] = c.x;
      this.cy[k] = c.y;
      this.cr[k] = r;
      this.walledCore[k] = coreWalled(game, c.x, c.y, r) ? 1 : 0;
    }
    const t = game.tuning;
    for (let id = 0; id < MAX_PLAYERS; id++) {
      const p = game.players[id];
      this.alive[id] = p?.alive ? 1 : 0;
      this.eyeMask[id] = this.bodyMask[id] = this.fullMask[id] = 0;
      if (!p) continue;
      const box = hitboxLayout(p);
      this.eyeX[id] = p.x;
      this.eyeY[id] = p.y + box.head.y;
      const o = id * SIGHT_POINTS;
      this.ptY[o] = p.y + box.head.y + box.head.r;
      this.ptY[o + 1] = p.y + (box.torso.y0 + box.torso.y1) / 2;
      this.ptY[o + 2] = p.y + box.legs.y0;
      if (this.count === 0 || !p.alive) continue;
      const r = t.capsuleRadius;
      const yLow = p.y + r;
      const yHigh = p.y + p.height(t) - r;
      for (let k = 0; k < this.count; k++) {
        const bit = 1 << k;
        if (this.inCore(k, p.x, this.eyeY[id]!)) this.eyeMask[id]! |= bit;
        for (let i = 0; i < SIGHT_POINTS; i++) if (this.inCore(k, p.x, this.ptY[o + i]!)) this.bodyMask[id]! |= bit;
        // all of it: both ends of the body capsule a capsule radius inside the core
        const vr = this.cr[k]! - r;
        const dx = p.x - this.cx[k]!;
        const lo = yLow - this.cy[k]!;
        const hi = yHigh - this.cy[k]!;
        if (vr > 0 && dx * dx + lo * lo <= vr * vr && dx * dx + hi * hi <= vr * vr && this.open(k, p.x, (yLow + yHigh) / 2)) this.fullMask[id]! |= bit;
      }
    }
  }

  /** Is `target` hidden by smoke from `viewer`'s eyes? (−1 viewer: no eyes in any cloud) */
  hides(viewer: number, target: number): boolean {
    if (this.count === 0 || viewer === target || !this.alive[target]) return false;
    const eyes = viewer >= 0 ? this.eyeMask[viewer]! : 0;
    if ((this.fullMask[target]! & ~eyes) !== 0) return true;
    if (viewer < 0) return false;
    const both = eyes & this.bodyMask[target]!;
    const ex = this.eyeX[viewer]!;
    const ey = this.eyeY[viewer]!;
    const tx = this.eyeX[target]!;
    for (let i = 0; i < SIGHT_POINTS; i++) {
      if (!this.blocked(ex, ey, tx, this.ptY[target * SIGHT_POINTS + i]!, both)) return false; // that part of it is in plain sight
    }
    return true;
  }

  /**
   * Is the point hidden from `viewer` by smoke: inside a core its eyes are outside of, or out of
   * its sight through smoke (the same sight lines as a body's). Grenades the server doesn't send.
   */
  pointHidden(viewer: number, x: number, y: number): boolean {
    if (this.count === 0) return false;
    let inside = 0;
    for (let k = 0; k < this.count; k++) if (this.inCore(k, x, y)) inside |= 1 << k;
    const eyes = viewer >= 0 ? this.eyeMask[viewer]! : 0;
    if ((inside & ~eyes) !== 0) return true;
    return viewer >= 0 && this.blocked(this.eyeX[viewer]!, this.eyeY[viewer]!, x, y, inside & eyes);
  }

  /**
   * Where a tracer from A to B vanishes into smoke for `viewer`, as a fraction of the way (1: it
   * doesn't): where it first enters a core the viewer's eyes are outside of (on the centre's side
   * of a wall that cuts the core), or, in the core the viewer is in, where it gets out of the
   * viewer's near sight. The server cuts it there and sends it as a miss with no target, whatever
   * it hit inside.
   */
  tracerCut(viewer: number, ax: number, ay: number, bx: number, by: number): number {
    let first = 1;
    const eyes = viewer >= 0 ? this.eyeMask[viewer]! : 0;
    for (let k = 0; k < this.count; k++) {
      if (chord(ax, ay, bx, by, this.cx[k]!, this.cy[k]!, this.cr[k]!) <= 0 || chordAt.t1 >= first) continue;
      let t1 = chordAt.t1;
      const t2 = chordAt.t2;
      if ((eyes & (1 << k)) !== 0) {
        // the viewer is in this cloud: it sees the stretch within SMOKE_NEAR_SIGHT of its eyes
        if (chord(ax, ay, bx, by, this.eyeX[viewer]!, this.eyeY[viewer]!, SMOKE_NEAR_SIGHT) > 0 && chordAt.t1 <= t1) {
          if (chordAt.t2 >= t2) continue;
          t1 = chordAt.t2;
        }
      } else if (this.walledCore[k]) {
        t1 = this.firstOpen(k, ax, ay, bx, by, t1, t2);
        if (t1 < 0) continue;
      }
      first = Math.min(first, t1);
    }
    return first;
  }

  /**
   * A shot (or ricochet) from (ox, oy) that hit a player smoke hides at (ex, ey), carried on along
   * its line to where it would have ended had it missed (into `missed`): the first wall within
   * what's left of the weapon's range. A tracer stopping in the open would mark the hidden body;
   * this one reads like any miss.
   */
  carryOn(ox: number, oy: number, ex: number, ey: number, weapon: number): void {
    const out = this.missed;
    const dx = ex - ox;
    const dy = ey - oy;
    const d = Math.sqrt(dx * dx + dy * dy);
    const reach = Math.max(0, (weapons[weapon]?.range ?? d) - d);
    out.x = ex;
    out.y = ey;
    out.hit = 0;
    if (d < 1e-6 || reach <= 0) return;
    const ux = dx / d;
    const uy = dy / d;
    let t = reach;
    if (this.game!.world.raycast(ex, ey, ux, uy, reach, SegFlag.BulletPass, ray)) {
      t = ray.t;
      out.hit = 1;
    }
    out.x = ex + ux * t;
    out.y = ey + uy * t;
  }

  /** Does smoke block the sight line from (ex, ey) to (tx, ty)? `both`: the cores both ends are in. */
  private blocked(ex: number, ey: number, tx: number, ty: number, both: number): boolean {
    for (let k = 0; k < this.count; k++) {
      const limit = (both & (1 << k)) !== 0 ? SMOKE_NEAR_SIGHT : SMOKE_BLOCK_CHORD;
      if (chord(ex, ey, tx, ty, this.cx[k]!, this.cy[k]!, this.cr[k]!) < limit) continue;
      if (!this.walledCore[k] || this.lineInCore(k, ex, ey, tx, ty)) return true;
    }
    return false;
  }

  private inCore(k: number, x: number, y: number): boolean {
    const dx = x - this.cx[k]!;
    const dy = y - this.cy[k]!;
    return dx * dx + dy * dy < this.cr[k]! * this.cr[k]! && this.open(k, x, y);
  }

  /** No wall between core k's centre and (x, y) (only walled cores need the raycast). */
  private open(k: number, x: number, y: number): boolean {
    if (!this.walledCore[k]) return true;
    const dx = x - this.cx[k]!;
    const dy = y - this.cy[k]!;
    const d = Math.sqrt(dx * dx + dy * dy);
    return d <= 1e-6 || !this.game!.world.raycast(this.cx[k]!, this.cy[k]!, dx / d, dy / d, d, SegFlag.BulletPass, ray);
  }

  /** For a core a wall cuts through: is the sight line's nearest point to the centre on the centre's side of the wall? */
  private lineInCore(k: number, ax: number, ay: number, bx: number, by: number): boolean {
    closestPointOnSegment(this.cx[k]!, this.cy[k]!, ax, ay, bx, by, pt);
    return this.open(k, pt.x, pt.y);
  }

  /** The first point of A→B between t1 and t2 that's in core k's smoke (on the centre's side of its walls), or −1. */
  private firstOpen(k: number, ax: number, ay: number, bx: number, by: number, t1: number, t2: number): number {
    const len = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    const steps = Math.max(1, Math.ceil(((t2 - t1) * len) / TRACER_STEP));
    for (let i = 0; i <= steps; i++) {
      const t = t1 + ((t2 - t1) * i) / steps;
      if (this.open(k, ax + (bx - ax) * t, ay + (by - ay) * t)) return t;
    }
    return -1;
  }
}

/** Does a solid wall (not a fence or a platform) cross the circle? */
function coreWalled(game: Game, x: number, y: number, r: number): boolean {
  const w = game.world;
  const n = w.queryAabb(x - r, y - r, x + r, y + r);
  for (let i = 0; i < n; i++) {
    const seg = w.queryResult[i]!;
    if (w.flags[seg]! & SegFlag.BulletPass) continue;
    closestPointOnSegment(x, y, w.ax[seg]!, w.ay[seg]!, w.bx[seg]!, w.by[seg]!, pt);
    if ((pt.x - x) * (pt.x - x) + (pt.y - y) * (pt.y - y) < r * r) return true;
  }
  return false;
}
