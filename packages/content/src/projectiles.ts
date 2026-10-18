/**
 * Projectiles (docs/03 §11): what the launchers and the flamethrower fire. They fly in the grenade
 * pool (sim GrenadeState, the grenade records of the snapshot) with wire type
 * `PROJECTILE_TYPE_BASE + index`, after the grenade types, and the server runs them like grenades:
 * never predicted, nor lag-compensated (they hit what is there on the tick they get there).
 *
 * What one does is in its fields: what a wall does to it (`walls`), what touching a player does
 * (`players`), and what happens when its life runs out (`expire`). Blowing up is its `explosion`,
 * or an EMP burst (`emp`).
 */
import type { EmpDef, ExplosionDef } from './grenades';

/** Grenade-pool types from here on are projectiles (grenade types are 0–5; 6 and 7 stay free for grenades). */
export const PROJECTILE_TYPE_BASE = 8;

export interface BurnDef {
  /** damage per second while burning, dealt in `pulse` s steps */
  dps: number;
  /** seconds a hit sets you burning for (a new hit starts it again) */
  seconds: number;
  pulse: number;
}

export interface ProjectileDef {
  /** 0… in this list (append-only); its grenade-pool and wire type is PROJECTILE_TYPE_BASE + index */
  index: number;
  id: string;
  name: string;
  /** collision radius (m) at launch */
  radius: number;
  /** the radius it grows to over its life (flames), else `radius` */
  radiusEnd: number;
  /** m/s at the muzzle */
  speed: number;
  /** share of the shooter's velocity it keeps */
  inheritVelocity: number;
  /** × gravity (negative: it rises) */
  gravityScale: number;
  /** a bounce: normal speed kept, and tangential speed lost */
  restitution: number;
  friction: number;
  /** seconds before `expire` */
  life: number;
  /** 'explode': its blast at the wall · 'bounce' · 'pass': straight through */
  walls: 'explode' | 'bounce' | 'pass';
  /**
   * 'explode': direct `damage`, then its blast · 'pierce': `damage` to everyone it passes through,
   * once each between bounces, and flies on · 'consume': `damage` (and `burn`), then it's gone
   */
  players: 'explode' | 'pierce' | 'consume';
  /** 'explode': its blast · 'vanish' */
  expire: 'explode' | 'vanish';
  /** direct-hit damage */
  damage: number;
  /** after its first bounce it can hit its own shooter (a saw blade, a flame off a wall), × this */
  ownerAfterBounce: number;
  explosion?: ExplosionDef;
  emp?: EmpDef;
  burn?: BurnDef;
  /** it puts out the toxic gas clouds it touches (flames) */
  clearsGas?: boolean;
}

/** Thumper's rocket: straight and fast, blows up on anything; rocket jumps cost half the blast. */
export const ROCKET: ProjectileDef = {
  index: 0,
  id: 'rocket',
  name: 'Rocket',
  radius: 0.12,
  radiusEnd: 0.12,
  speed: 20,
  inheritVelocity: 0,
  gravityScale: 0,
  restitution: 0,
  friction: 0,
  life: 3, // self-destructs at 60 m
  walls: 'explode',
  players: 'explode',
  expire: 'explode',
  damage: 100,
  ownerAfterBounce: 0,
  explosion: {
    radius: 3.5,
    core: 0.6,
    maxDamage: 80,
    impulse: 26,
    selfDamageMul: 0.5,
    selfImpulseMul: 0.7, // a rocket jump: ~8 m up for 40 HP (a frag's 0.6 gives ~6 m)
    coveredImpulseMul: 0.35,
    crouchDamageMul: 0.75,
    upBias: 0.3,
    minLift: 0.7,
  },
};

/** Popper's shell: a lobbed grenade that bounces (e 0.3) and goes off on a player or after 1.2 s. */
export const SHELL: ProjectileDef = {
  index: 1,
  id: 'shell',
  name: 'Launcher shell',
  radius: 0.08,
  radiusEnd: 0.08,
  speed: 17,
  inheritVelocity: 0.3,
  gravityScale: 1,
  restitution: 0.3,
  friction: 0.3,
  life: 1.2,
  walls: 'bounce',
  players: 'explode',
  expire: 'explode',
  damage: 0,
  ownerAfterBounce: 0,
  explosion: {
    radius: 3,
    core: 0.5,
    maxDamage: 70,
    impulse: 12, // a knock, not a launch: at 4 a second, a launched target would be out of the next shell's way
    selfDamageMul: 0.5,
    selfImpulseMul: 0.6,
    coveredImpulseMul: 0.35,
    crouchDamageMul: 0.75,
    upBias: 0.3,
    minLift: 0.7,
  },
};

/** Ripper's saw blade: bounces off walls without losing speed, cuts through everyone in its way. */
export const BLADE: ProjectileDef = {
  index: 2,
  id: 'blade',
  name: 'Saw blade',
  radius: 0.15,
  radiusEnd: 0.15,
  speed: 18,
  inheritVelocity: 0,
  gravityScale: 0,
  restitution: 1,
  friction: 0,
  life: 5,
  walls: 'bounce',
  players: 'pierce',
  expire: 'explode',
  damage: 100,
  ownerAfterBounce: 1, // deadly to its owner
  explosion: {
    radius: 2.5,
    core: 0.4,
    maxDamage: 60,
    impulse: 16,
    selfDamageMul: 1,
    selfImpulseMul: 0.6,
    coveredImpulseMul: 0.35,
    crouchDamageMul: 0.75,
    upBias: 0.3,
    minLift: 0.7,
  },
};

/** Pulse's orb: slow, through walls; an EMP burst on a player or at the end (jetpacks dead 3 s, mines disarmed). */
export const ORB: ProjectileDef = {
  index: 3,
  id: 'orb',
  name: 'EMP orb',
  radius: 0.25,
  radiusEnd: 0.25,
  speed: 8,
  inheritVelocity: 0,
  gravityScale: 0,
  restitution: 0,
  friction: 0,
  life: 3,
  walls: 'pass',
  players: 'explode',
  expire: 'explode',
  damage: 0,
  ownerAfterBounce: 0,
  emp: { radius: 2.5, jetDisable: 3 },
};

/** Dragon's flame: drifts up a little, grows 0.15 → 0.6 m over 0.8 s, glances off walls; sets you burning. */
export const FLAME: ProjectileDef = {
  index: 4,
  id: 'flame',
  name: 'Flame',
  radius: 0.15,
  radiusEnd: 0.6,
  speed: 7,
  inheritVelocity: 0.5,
  gravityScale: -0.2,
  restitution: 0.3,
  friction: 0.4,
  life: 0.8,
  walls: 'bounce',
  players: 'consume',
  expire: 'vanish',
  damage: 20,
  ownerAfterBounce: 0.5, // too close to a wall, it comes back at you
  burn: { dps: 4, seconds: 2, pulse: 0.25 },
  clearsGas: true,
};

/** Every projectile by index (wire type PROJECTILE_TYPE_BASE + index). */
export const projectiles: readonly ProjectileDef[] = [ROCKET, SHELL, BLADE, ORB, FLAME];

/** The projectile a grenade-pool type stands for, or undefined (a grenade). */
export function projectileOfType(type: number): ProjectileDef | undefined {
  return type >= PROJECTILE_TYPE_BASE ? projectiles[type - PROJECTILE_TYPE_BASE] : undefined;
}

/** A projectile's collision radius `age` seconds into its life (flames grow). */
export function projectileRadius(def: ProjectileDef, age: number): number {
  if (def.radiusEnd === def.radius) return def.radius;
  const k = Math.max(0, Math.min(1, age / def.life));
  return def.radius + (def.radiusEnd - def.radius) * k;
}
