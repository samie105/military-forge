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
      /** 0 = nothing, 1 = wall, 2 = player, 3 = a riot shield (`target` is its owner; a `ricochet` may follow) */
      hit: 0 | 1 | 2 | 3;
      target: number;
      zone: number;
    }
  | { type: 'hit'; attacker: number; target: number; damage: number; zone: number; source: number }
  | { type: 'death'; victim: number; killer: number; source: number }
  | { type: 'spawn'; player: number }
  | { type: 'throw'; owner: number; grenade: number }
  | { type: 'explosion'; x: number; y: number; radius: number; owner: number }
  /** a dash started (docs/02 §21): feet position at the start, 8-way direction (0 = right, CCW) */
  | { type: 'dash'; player: number; x: number; y: number; dir: number }
  /**
   * A map event's warning started, it started, or it ended (mapEvents.ts, docs/02 §20.7). `event`
   * indexes the map's event defs; `ticks` is what is left of the phase that just began (0 on end).
   */
  | {
      type: 'mapEvent';
      event: number;
      /** MapEventPhase: 0 warning, 1 start, 2 end */
      phase: 0 | 1 | 2;
      /** counts occurrences across the schedule */
      occurrence: number;
      /** the event zone switched on this time (pickOneZone), −1 = all of them */
      zone: number;
      /** the event's wind blows the other way this time */
      flip: boolean;
      ticks: number;
    }
  /** a player took an item (PickupDef.index) lying at (x, y) */
  | { type: 'pickup'; player: number; item: number; x: number; y: number }
  /**
   * A bullet or pellet bounced off `owner`'s riot shield at (x, y), whose normal is (nx, ny), and
   * flew on to (ex, ey). `hit`, `target` and `zone` say what that ricochet struck, as in `shot`.
   * The `shot` event of the same bullet ends at (x, y) with hit 3 (shield) and target `owner`.
   */
  | {
      type: 'ricochet';
      shooter: number;
      owner: number;
      weapon: number;
      x: number;
      y: number;
      nx: number;
      ny: number;
      ex: number;
      ey: number;
      hit: 0 | 1 | 2 | 3;
      target: number;
      zone: number;
    }
  /** `owner`'s riot shield broke at (x, y) under `attacker`'s fire */
  | { type: 'shieldBreak'; owner: number; attacker: number; x: number; y: number };

export type SimEventType = SimEvent['type'];
