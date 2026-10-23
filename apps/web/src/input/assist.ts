/**
 * Aim assist for sticks (pads and touch), one core for both (controls spec §3.5, §4.5, §5.4; the
 * input agent writes it, the phone agent calls it for touch: shared notes gamepad-interfaces.md).
 * Pure: no DOM, no clocks; the caller passes the targets it can see (input/sight.ts) and the weapon's
 * range. Mouse aim never gets any of this.
 *
 * Levels:
 * - **Off:** nothing.
 * - **Light:** friction: while the aim lies on a target the stick turns it at 0.45× (a thumb sweeping
 *   past an enemy lingers on it). It never turns the aim toward anyone.
 * - **Standard:** Light, plus magnetism while the stick is pushed (`pullMinPush`): the target nearest
 *   the stick's line, tested *after projecting the line out to its distance* [C12] (a body plus slack,
 *   or 2.5°, whichever is wider), pulls the aim 25% of the way per tick, at most 3° per tick (far
 *   slower than a thumb, so the player wins any disagreement), full to 0.7 × the weapon's range and
 *   fading to nothing at 0.9×. The target stays chosen unless another is 30% better.
 * - **Strong:** Standard, plus a lock: with the stick let go, the aim stays on the chosen target while
 *   it's in sight and in range (One-stick: it acquires the nearest one).
 */

export type AssistLevel = 'off' | 'light' | 'standard' | 'strong';
export const ASSIST_LEVELS: readonly AssistLevel[] = ['off', 'light', 'standard', 'strong'];

export const isAssistLevel = (v: unknown): v is AssistLevel => typeof v === 'string' && (ASSIST_LEVELS as readonly string[]).includes(v);

const DEG = Math.PI / 180;

export const ASSIST = {
  /** Light's friction: the share of the stick's turn the aim takes per tick while on a target */
  slow: 0.45,
  /** friction counts a target this wide either side of its centre (m) */
  friction: 0.9,
  /** no assist beyond this (m), whatever the weapon */
  maxRange: 40,
  /** magnetism's cone: a body's half-width plus slack (m), or this angle, whichever is wider */
  bodyHalf: 0.45,
  slack: 0.35,
  minConeDeg: 2.5,
  /** the pull: this share of the angular error per tick, at most pullMaxDeg */
  pullFrac: 0.25,
  pullMaxDeg: 3,
  /** range falloff, as shares of the weapon's range: full to rangeFull, nothing from rangeZero */
  rangeFull: 0.7,
  rangeZero: 0.9,
  /** another target takes over only when its miss is this many times smaller */
  sticky: 1.3,
  /** Strong's lock: the share of the error and the most it turns per tick (12° = 720°/s) */
  lockFrac: 0.5,
  lockMaxDeg: 12,
  /** auto-fire's test: a miss within bodyHalf, out to this share of the weapon's range */
  fireRange: 0.8,
  /** targets nearer than this (m) are inside you: no assist */
  minDist: 0.5,
} as const;

export interface AssistTarget {
  id: number;
  /** the aim point (a chest), world m */
  x: number;
  y: number;
}

/** Shortest signed difference, in (−π, π]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t <= 0 ? t + 2 * Math.PI : t) - Math.PI;
}

/**
 * The aim line from (sx, sy) along `angle`, projected out to the target's distance [C12]: how far
 * the point there misses the target (m), the distance, and the angular error (rad, signed: target − aim).
 * Behind the shooter (an error past 90°) it misses by Infinity.
 */
export function projectedMiss(angle: number, sx: number, sy: number, tx: number, ty: number): { miss: number; dist: number; err: number } {
  const dx = tx - sx;
  const dy = ty - sy;
  const dist = Math.hypot(dx, dy);
  const err = wrapAngle(Math.atan2(dy, dx) - angle);
  const miss = Math.abs(err) >= Math.PI / 2 ? Infinity : 2 * dist * Math.sin(Math.abs(err) / 2);
  return { miss, dist, err };
}

/** Strength by distance: 1 to rangeFull × range, then down to 0 at rangeZero × range. */
export function rangeFalloff(dist: number, range: number): number {
  if (!(range > 0)) return 0;
  const full = range * ASSIST.rangeFull;
  const zero = range * ASSIST.rangeZero;
  if (dist <= full) return 1;
  if (dist >= zero) return 0;
  return (zero - dist) / (zero - full);
}

/** The furthest a target counts for magnetism and the lock (m). */
const reach = (range: number) => Math.min(ASSIST.maxRange, range * ASSIST.rangeZero);

/** Is the aim on a target for friction (today's touch test: within ±0.9 m of a centre, out to 40 m)? */
export function onFriction(angle: number, sx: number, sy: number, targets: readonly AssistTarget[]): boolean {
  for (const t of targets) {
    const { dist, err } = projectedMiss(angle, sx, sy, t.x, t.y);
    if (dist < ASSIST.minDist || dist > ASSIST.maxRange) continue;
    if (Math.abs(err) <= Math.atan2(ASSIST.friction, dist)) return true;
  }
  return false;
}

/** Inside magnetism's cone: the projected miss within a body plus slack, or within 2.5°. */
export function inCone(miss: number, err: number): boolean {
  return miss <= ASSIST.bodyHalf + ASSIST.slack || Math.abs(err) <= ASSIST.minConeDeg * DEG;
}

export interface Pick {
  target: AssistTarget;
  miss: number;
  dist: number;
}

/**
 * The target magnetism goes for along `angle`: in the cone and in reach, the smallest projected
 * miss; the current one (`currentId`) stays unless another misses by 30% less [S35].
 */
export function pickTarget(angle: number, sx: number, sy: number, targets: readonly AssistTarget[], range: number, currentId: number | null): Pick | null {
  let best: Pick | null = null;
  let current: Pick | null = null;
  const far = reach(range);
  for (const t of targets) {
    const { miss, dist, err } = projectedMiss(angle, sx, sy, t.x, t.y);
    if (dist < ASSIST.minDist || dist > far || !inCone(miss, err)) continue;
    const p = { target: t, miss, dist };
    if (t.id === currentId) current = p;
    if (!best || miss < best.miss) best = p;
  }
  if (current && best && best !== current && current.miss <= best.miss * ASSIST.sticky) return current;
  return best;
}

/** The nearest target in reach (One-stick's auto-acquire), or null. */
export function nearestTarget(sx: number, sy: number, targets: readonly AssistTarget[], range: number): AssistTarget | null {
  let best: AssistTarget | null = null;
  let bestD = Infinity;
  const far = reach(range);
  for (const t of targets) {
    const d = Math.hypot(t.x - sx, t.y - sy);
    if (d >= ASSIST.minDist && d <= far && d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** The aim turned toward (tx, ty) by `frac` of the error, at most `maxRad`, scaled by `strength` (0..1). */
export function pullToward(aim: number, sx: number, sy: number, tx: number, ty: number, frac: number, maxRad: number, strength = 1): number {
  const err = wrapAngle(Math.atan2(ty - sy, tx - sx) - aim);
  const step = Math.min(Math.abs(err) * frac, maxRad) * strength;
  return wrapAngle(aim + Math.sign(err) * step);
}

/**
 * Auto-fire's on-target test (shared by touch's Auto fire and the pad's One-stick): the aim line,
 * projected to the target, misses by no more than a body's half-width, within 0.8 × the weapon's
 * range (and 40 m). Dwell and linger timers are the caller's.
 */
export function onTarget(angle: number, sx: number, sy: number, targets: readonly AssistTarget[], range: number): boolean {
  const far = Math.min(ASSIST.maxRange, range * ASSIST.fireRange);
  for (const t of targets) {
    const { miss, dist } = projectedMiss(angle, sx, sy, t.x, t.y);
    if (dist >= 0.3 && dist <= far && miss <= ASSIST.bodyHalf) return true;
  }
  return false;
}

export interface AssistInput {
  level: AssistLevel;
  /** the aim now (rad) */
  current: number;
  /** the aim this tick before assist: where the device turned it toward the stick (= current when idle) */
  desired: number;
  /** the stick's own direction (rad), for picking a target; defaults to `desired` */
  stickAngle?: number;
  /** the stick's push now, 0..1 (0: let go) */
  stick: number;
  /** magnetism needs at least this push (pad 0.50 raw, touch 0.30: the caller's) */
  pullMinPush: number;
  /** the shoulder (m) */
  sx: number;
  sy: number;
  /** the weapon in hand's effective range (m); 0: none (no magnetism or lock) */
  range: number;
  /** enemies in sight, alive, not you (the caller's filter: input/sight.ts) */
  targets: readonly AssistTarget[];
  /** Strong with the stick let go: take the nearest target when none is chosen (One-stick) */
  autoAcquire?: boolean;
}

/** One per device: keeps the chosen target (sticky) and Strong's lock between ticks. */
export class AimAssist {
  private targetId: number | null = null;

  /** the target magnetism or the lock is on, if any */
  get target(): number | null {
    return this.targetId;
  }

  reset(): void {
    this.targetId = null;
  }

  /** The aim this tick. */
  step(i: AssistInput): number {
    if (i.level === 'off') {
      this.targetId = null;
      return i.desired;
    }
    let aim = i.desired;
    // friction (Light and up): only while the stick turns the aim
    if (i.stick > 0 && onFriction(i.current, i.sx, i.sy, i.targets)) aim = wrapAngle(i.current + wrapAngle(i.desired - i.current) * ASSIST.slow);
    if (i.level === 'light') return aim;

    if (i.stick >= i.pullMinPush && i.range > 0) {
      // magnetism: the target nearest the stick's line pulls the aim a little toward its centre
      const pick = pickTarget(i.stickAngle ?? i.desired, i.sx, i.sy, i.targets, i.range, this.targetId);
      this.targetId = pick?.target.id ?? null;
      if (pick) aim = pullToward(aim, i.sx, i.sy, pick.target.x, pick.target.y, ASSIST.pullFrac, ASSIST.pullMaxDeg * DEG, rangeFalloff(pick.dist, i.range));
      return aim;
    }
    if (i.stick > 0 || i.level !== 'strong' || !(i.range > 0)) {
      // a light push, or Standard let go: no pull; the choice is kept for when the push comes back
      if (i.stick === 0 && i.level !== 'strong') this.targetId = null;
      return aim;
    }
    // Strong, the stick let go: hold the chosen target while it's in sight and in reach
    let t = this.targetId === null ? null : (i.targets.find((x) => x.id === this.targetId) ?? null);
    if (t && Math.hypot(t.x - i.sx, t.y - i.sy) > reach(i.range)) t = null;
    if (!t && i.autoAcquire) t = nearestTarget(i.sx, i.sy, i.targets, i.range);
    this.targetId = t?.id ?? null;
    if (t) aim = pullToward(aim, i.sx, i.sy, t.x, t.y, ASSIST.lockFrac, ASSIST.lockMaxDeg * DEG);
    return aim;
  }
}
