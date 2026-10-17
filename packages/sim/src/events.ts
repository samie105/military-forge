/** Things that happened during a tick, for rendering, HUD, audio and the network. */

/** Damage sources beyond the weapon indices (0..59 are weapons from @military-forge/content). */
export const DamageSource = {
  /** a melee swing, whatever it was made with (its own kill-feed icon, docs/02 §12) */
  Melee: 60,
  World: 61,
  Grenade: 62,
} as const;

export type SimEvent =
  | {
      type: 'shot';
      shooter: number;
      weapon: number;
      /** visual origin (muzzle, or the wall hit by the muzzle-in-wall guard) */
      ox: number;
      oy: number;
      ex: number;
      ey: number;
      /** 0 = nothing, 1 = wall, 2 = player */
      hit: 0 | 1 | 2;
      target: number;
      zone: number;
    }
  | { type: 'hit'; attacker: number; target: number; damage: number; zone: number; source: number }
  | { type: 'death'; victim: number; killer: number; source: number }
  | { type: 'spawn'; player: number }
  | { type: 'throw'; owner: number; grenade: number }
  | { type: 'explosion'; x: number; y: number; radius: number; owner: number };

export type SimEventType = SimEvent['type'];
