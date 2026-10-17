/** Frag grenade (docs/02-physics-and-movement.md §13.2 and §14). */
export interface ExplosionDef {
  radius: number;
  /** full damage inside this distance */
  core: number;
  maxDamage: number;
  /** m/s velocity change at the centre */
  impulse: number;
  selfDamageMul: number;
  /** impulse multiplier when walls block line of sight to both torso and head */
  coveredImpulseMul: number;
  crouchDamageMul: number;
  /** upward bias added to the push direction (satisfying launches) */
  upBias: number;
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
    impulse: 14,
    selfDamageMul: 0.5,
    coveredImpulseMul: 0.35,
    crouchDamageMul: 0.75,
    upBias: 0.3,
  },
};
