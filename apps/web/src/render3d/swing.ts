/**
 * A melee swing on the soldier (the sim's `meleeTicks`, docs/02 §12). The 3D view drew nothing for
 * it before: the arm and the blade now act it out over the sim's own timing.
 * - Windup (MELEE_WINDUP_TICKS, 0.15 s): the gun arm draws back. A blade rises over the shoulder;
 *   a gun pulls in for a bash.
 * - Strike: the swing lands on the tick after the windup. A blade sweeps down through the sim's
 *   70° arc and past it; a gun (or a fist) jabs out along the aim.
 * - Recover: the arm eases back into its hold.
 * Online, a remote player's `meleeTicks` isn't sent: its swing plays from the strike when one of its
 * melee hits arrives (Avatar.struck).
 */
import { DT, MELEE_WINDUP_TICKS } from '@military-forge/sim';

export const SWING_WINDUP_S = MELEE_WINDUP_TICKS * DT;
export const SWING_STRIKE_S = 0.1;
export const SWING_RECOVER_S = 0.24;
/** the whole swing, start to back in the hold */
export const SWING_S = SWING_WINDUP_S + SWING_STRIKE_S + SWING_RECOVER_S;

/** a blade's arc, from the aim (rad; + toward up and back for the facing): raised, then struck through */
export const SLASH_FROM = 1.9;
export const SLASH_TO = -1.15;
/** a jab: the gun cocks up a little, then thrusts along the aim */
const JAB_FROM = 0.35;
const JAB_TO = -0.05;

export interface SwingPose {
  /** 0 the hold … 1 the swing owns the arm */
  weight: number;
  /** the hand's direction from the shoulder, from the aim (rad; + toward up for the facing) */
  angle: number;
  /** how far out, as a share of the arm's length */
  reach: number;
  /** the strike is under way (the blade's trail) */
  striking: boolean;
}

const smooth = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const easeOut = (u: number): number => 1 - (1 - Math.min(1, Math.max(0, u))) ** 3;

/** The swing `t` s after it started (negative or past SWING_S: none). `slash`: a melee weapon's. */
export function swingPose(t: number, slash: boolean, out: SwingPose): SwingPose {
  out.weight = 0;
  out.striking = false;
  if (!(t >= 0) || t >= SWING_S) return out;
  const from = slash ? SLASH_FROM : JAB_FROM;
  const to = slash ? SLASH_TO : JAB_TO;
  if (t < SWING_WINDUP_S) {
    const k = smooth(t / SWING_WINDUP_S);
    out.weight = smooth(Math.min(1, (t / SWING_WINDUP_S) * 2.5));
    out.angle = from * k;
    out.reach = 0.85 - 0.3 * k;
    return out;
  }
  const s = t - SWING_WINDUP_S;
  if (s < SWING_STRIKE_S) {
    const u = easeOut(s / SWING_STRIKE_S);
    out.weight = 1;
    out.angle = from + (to - from) * u;
    out.reach = 0.55 + (slash ? 0.45 : 0.6) * u;
    out.striking = true;
    return out;
  }
  const v = (s - SWING_STRIKE_S) / SWING_RECOVER_S;
  out.weight = 1 - smooth(v);
  out.angle = to;
  out.reach = slash ? 1 : 1.15;
  return out;
}

/**
 * A swing's clock (s) from the view's `meleeTicks` as frames arrive: synced to the tick count, run
 * smoothly between ticks, then on through the recovery after the sim's swing ends.
 */
export class SwingClock {
  /** seconds since the swing started; −1: none */
  t = -1;
  private last = 0;

  update(meleeTicks: number | undefined, dt: number): number {
    const ticks = meleeTicks ?? 0;
    if (ticks > 0) {
      const at = (ticks - 1) * DT;
      // a new swing (from rest, or a fresh one before the last recovered), or drifted: resync
      if (this.t < 0 || ticks < this.last || Math.abs(this.t + dt - at) > 2 * DT) this.t = at;
      else this.t += dt;
    } else if (this.t >= 0) {
      this.t += dt;
      if (this.t >= SWING_S) this.t = -1;
    }
    this.last = ticks;
    return this.t;
  }

  /** A remote swing seen only by its hit (no `meleeTicks` on the wire): play it from the strike. */
  struck(): void {
    if (this.t < 0 || this.t > SWING_WINDUP_S + SWING_STRIKE_S) this.t = SWING_WINDUP_S;
  }
}
