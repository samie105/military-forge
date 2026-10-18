/**
 * The motor: turns "put my feet at (x, y)" into movement buttons, tick by tick.
 *
 * - Walking: press toward the goal until the braking distance covers what's left.
 * - In the air: steer toward the speed that arrives at rest (pressing against the motion is the
 *   only air brake).
 * - Air goals also jet: climb until the climb would top out above the goal (plus a lip while it's
 *   still across), then go across without sinking below it over a gap.
 * - Drops through a one-way platform when the goal is below, and dives where a zone allows it.
 *
 * The nav graph is built by flying this same controller through the real movement code
 * (nav/graph.ts), so every link the planner trusts is one this controller has flown.
 */
import type { Tuning } from '@military-forge/content';
import { Btn, SegFlag, createRayHit, type BodyEnv, type CollisionWorld, type PlayerState } from '@military-forge/sim';

export interface MotorGoal {
  x: number;
  y: number;
  /** may use the jetpack (air links); walk links never do */
  jet: boolean;
  /** take off at once instead of walking in first (hops over pads and low cover the walk-in can't pass) */
  early: boolean;
}

const below = createRayHit();

/** a burn, once lit, keeps going until the climb tops out this far above its target (each ignition costs the kick) */
const JET_HYSTERESIS = 0.3;
/** ticks of pressing into something without moving before the motor jets over it */
const BLOCKED_TICKS = 4;

export class Motor {
  private burning = false;
  private blocked = 0;

  reset(): void {
    this.burning = false;
    this.blocked = 0;
  }

  step(world: CollisionWorld, p: PlayerState, t: Tuning, env: BodyEnv | null, goal: MotorGoal): number {
    let b = 0;
    const dx = goal.x - p.x;
    const adx = Math.abs(dx);
    const dir = dx >= 0 ? 1 : -1;
    const dy = goal.y - p.y;
    const gravityMul = env ? env.gravityMul : 1;
    const g = t.gravity * gravityMul;
    const speedMul = env ? env.moveSpeedMul : 1;

    // a one-way platform under us with the goal below it: hold Down to drop through
    const onPlatform = p.grounded && (p.groundFlags & SegFlag.OneWay) !== 0;
    const drop = onPlatform && dy < -0.4 && adx < 1 + 0.6 * -dy;
    if (drop) b |= Btn.Down;

    if (p.grounded) {
      const toward = p.vx * dir;
      const stop = toward > 0 ? (toward * toward) / (2 * t.groundDecel) : 0;
      if (adx > stop + 0.05) {
        b |= dir > 0 ? Btn.Right : Btn.Left;
        this.blocked = Math.abs(p.vx) < 0.3 ? this.blocked + 1 : 0;
      } else this.blocked = 0;
    } else {
      this.blocked = 0;
      const cap = (p.jetting ? t.jetAirMaxX : t.airMaxX) * speedMul;
      const want = dir * Math.min(cap, Math.sqrt(1.6 * t.airAccel * adx));
      const err = want - p.vx;
      if (err > 0.25) b |= Btn.Right;
      else if (err < -0.25) b |= Btn.Left;
    }

    if (goal.jet && !drop) {
      // climbing: the goal is above the feet (a hop takes off for a level goal too)
      const climbing = dy > 0.15 || goal.early;
      const lip = climbing && adx > 0.6 ? 0.6 : 0.05;
      const target = goal.y + lip + (this.burning ? JET_HYSTERESIS : 0);
      // where the climb tops out if the burn stopped now (zero-g: half a second of drift)
      const up = Math.max(0, p.vy);
      const apex = p.y + (g > 1 ? (up * up) / (2 * g) : up * 0.5);
      let want = (climbing || !p.grounded) && apex < target;
      // from the ground, walk in first: start the climb about 45° out, or when walking is blocked
      if (want && !goal.early && p.grounded && adx > target - p.y + 1 && this.blocked < BLOCKED_TICKS) want = false;
      if (!want && !p.grounded && adx > 0.6) {
        // crossing: keep just above the goal's height, a moment ahead (unless there's ground below at
        // about that height: then landing short and walking on is fine)
        const h = Math.min(0.35, adx / Math.max(1.5, p.vx * dir));
        if (p.y + p.vy * h - 0.5 * g * h * h < goal.y + 0.5) {
          const depth = p.y - goal.y + 0.5;
          want = depth <= 0 || !world.raycast(p.x, p.y + 0.05, 0, -1, depth + 0.05, 0, below);
        }
      }
      this.burning = want;
      if (want) b |= Btn.Jet;
    } else this.burning = false;

    // dive where a zone allows it (zero-g, reversed gravity): the only way down there
    if (!p.grounded && dy < -0.3 && env !== null && env.dive > 0 && gravityMul < 0.5 && (b & Btn.Jet) === 0) b |= Btn.Down;
    return b;
  }
}
