/**
 * Lag-compensation hook (docs/05 §7.1). The authoritative server installs a TargetRewind on its
 * Game so hitscan tests each target where the shooter saw it: the interpolated past pose the
 * shooter's screen showed. Without one (local play, client prediction, replays) targets are tested
 * where they are now, so outcomes there are unchanged.
 */
import type { PlayerState } from './player';

/** What a hit test needs of a target. */
export interface HitPose {
  x: number;
  y: number;
  crouched: boolean;
  alive: boolean;
  /** which way it faced: a raised riot shield is on that side, a slung one on the other */
  facing: 1 | -1;
  /** its riot shield was all the way up (blocking the front): the shield is rewound with its owner */
  shield: boolean;
  /** its riot shield was slung (blocking the back) */
  shieldBack: boolean;
}

export interface TargetRewind {
  /**
   * Writes the pose of `target` as `shooter` saw it into `out` and returns true, or returns false
   * to test the target's current state. Called during Game.step, once per target per shot.
   */
  pose(target: PlayerState, shooter: PlayerState, out: HitPose): boolean;
}

export function createHitPose(): HitPose {
  return { x: 0, y: 0, crouched: false, alive: true, facing: 1, shield: false, shieldBack: false };
}
