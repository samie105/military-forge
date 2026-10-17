/** Frag grenade (docs/02-physics-and-movement.md §13.2 and §14). */
export interface ExplosionDef {
  radius: number;
  /** full damage inside this distance */
  core: number;
  maxDamage: number;
  /** m/s velocity change at the centre */
  impulse: number;
  selfDamageMul: number;
  /**
   * impulse multiplier on the thrower's own blast: a grenade jump is a real move (at a health cost)
   * but can't skip the map's ledges (NOTES.md §10.4 heights)
   */
  selfImpulseMul: number;
  /** impulse multiplier when walls block line of sight to both torso and head */
  coveredImpulseMul: number;
  crouchDamageMul: number;
  /** upward bias added to the push direction (satisfying launches) */
  upBias: number;
  /**
   * Minimum upward share (sine of the launch angle) of the push from a blast that is level with or
   * below the target: a ground-level blast launches players in an arc instead of shoving them along
   * the floor, where ground friction would stop them within a few frames. Blasts from above still
   * push down.
   */
  minLift: number;
}

export interface GrenadeDef {
  id: string;
  radius: number;
  throwSpeed: number;
  inheritVelocity: number;
  gravityScale: number;
  restitution: number;
  friction: number;
  rollFriction: number;
  /** below this normal speed on near-flat ground the grenade stops bouncing and rolls */
  restNormalSpeed: number;
  fuse: number;
  spawnCount: number;
  maxCount: number;
  throwCooldown: number;
  explosion: ExplosionDef;
}

export const FRAG: GrenadeDef = {
  id: 'frag',
  radius: 0.1,
  throwSpeed: 14,
  inheritVelocity: 0.4,
  gravityScale: 1,
  restitution: 0.45,
  friction: 0.25,
  rollFriction: 6,
  restNormalSpeed: 1.0,
  fuse: 1.6,
  spawnCount: 3,
  maxCount: 5,
  throwCooldown: 0.5,
  explosion: {
    radius: 4,
    core: 0.8,
    maxDamage: 110,
    impulse: 26,
    selfDamageMul: 0.5,
    selfImpulseMul: 0.6, // a frag at your own feet: ~6 m grenade jump for 55 HP
    coveredImpulseMul: 0.35,
    crouchDamageMul: 0.75,
    upBias: 0.3,
    minLift: 0.7, // ~45° launch: blasts throw players in an arc (2 m away: ~16 m flight, 5 m high)
  },
};
