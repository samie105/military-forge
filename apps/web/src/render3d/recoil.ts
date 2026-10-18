/**
 * Visual recoil (docs/03 §5: "visual only (camera kick + weapon kick)", and the Fire row of the
 * feedback table). On each shot:
 * - the gun kicks back along the aim and climbs, and the arm gives with it (the IK hand target
 *   moves, so the elbow bends);
 * - big guns jolt the torso back;
 * - the shooter's own 3D camera is nudged against the shot (vfx/shake.ts).
 * The aim never moves (no aim displacement, docs/03), and the sim never sees any of this.
 *
 * Sizes come from the weapon's punch per shot (damage × pellets), so new weapons get a kick
 * without a table entry. The Breacher and the Widow kick hard and settle slowly; the Buzz kicks a
 * little and settles between its rapid shots.
 */
import { weapons, type WeaponDef } from '@military-forge/content';
import type { SimEvent } from '@military-forge/sim';

export interface RecoilProfile {
  /** gun hand pushed back along the aim per shot, m */
  kick: number;
  /** muzzle climb per shot, rad */
  rise: number;
  /** spine jolted back per shot, rad */
  torso: number;
  /** how fast it settles, 1/s (the kick decays as e^(−recover·t)) */
  recover: number;
  /** the shooter's own 3D camera nudged against the shot, m */
  camera: number;
}

const NONE: RecoilProfile = { kick: 0, rise: 0, torso: 0, recover: 10, camera: 0 };

/** Recoil from the weapon's stats; a melee weapon has none. */
export function recoilProfile(def: WeaponDef | undefined): RecoilProfile {
  if (!def || def.fireMode === 'melee') return NONE;
  // the Hammer .44 (30 per shot) is 1; the Buzz ≈ 0.5, the Breacher ≈ 1.8, the Widow ≈ 1.6
  const s = Math.min(2, Math.max(0.4, Math.sqrt((def.damage * def.pellets) / 30)));
  const twoHanded = def.hands === 2;
  return {
    kick: 0.045 * s,
    // a one-handed gun flips up at the wrist; a shouldered one climbs less and pushes the body instead
    rise: (twoHanded ? 0.1 : 0.22) * s,
    torso: (twoHanded ? 0.06 : 0.03) * s * s * (def.class === 'heavy' ? 1.5 : 1),
    // settled well before the next shot: a rapid gun recovers fast, a slow one rides the kick
    recover: Math.min(30, Math.max(7, 3 / def.interval)),
    camera: 0.06 * s,
  };
}

const TABLE: readonly RecoilProfile[] = weapons.map(recoilProfile);

/** The profile for a weapon index (an unknown index or NO_WEAPON: none). */
export function recoilOf(weapon: number): RecoilProfile {
  return TABLE[weapon] ?? NONE;
}

/** Shots' worth of kick that can pile up, so a long burst never folds the arm. */
export const KICK_MAX = 1.6;

const seen = new Set<number>();

/**
 * Calls `kick` once per shooter and weapon in a batch of sim events: a shotgun's pellets are one
 * kick. `dirX`/`dirY`: the shot's unit direction.
 */
export function eachKick(events: readonly SimEvent[], kick: (shooter: number, weapon: number, dirX: number, dirY: number) => void): void {
  seen.clear();
  for (const e of events) {
    if (e.type !== 'shot') continue;
    const key = e.shooter * 64 + e.weapon;
    if (seen.has(key)) continue;
    seen.add(key);
    const dx = e.ex - e.ox;
    const dy = e.ey - e.oy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1; // sqrt: hypot allocates in optimised V8
    kick(e.shooter, e.weapon, dx / len, dy / len);
  }
}
