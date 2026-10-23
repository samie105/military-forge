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
  /** how far back the pose is, in ticks (fractional: between snapshots) */
  ticksBack: number;
}

/**
 * The cover rule (QA, 23 Oct 2026: "hit after reaching cover"). A rewind longer than this (150 ms)
 * doesn't count against a target that is behind solid cover now, from the shot's origin, head to
 * legs: the shot is tested against where the target is, so the wall takes it. A shorter rewind,
 * or a target still partly in the open, is rewound as usual. Favouring the shooter stops where
 * the target would see itself shot through a wall.
 */
export const REWIND_COVER_TICKS = 9;

export interface TargetRewind {
  /**
   * Writes the pose of `target` as `shooter` saw it into `out` and returns true, or returns false
   * to test the target's current state. Called during Game.step, once per target per shot.
   */
  pose(target: PlayerState, shooter: PlayerState, out: HitPose): boolean;
  /** The pose just given was turned down by the cover rule (counts, the debug log). */
  covered?(target: PlayerState, shooter: PlayerState): void;
}

export function createHitPose(): HitPose {
  return { x: 0, y: 0, crouched: false, alive: true, facing: 1, shield: false, shieldBack: false, ticksBack: 0 };
}
