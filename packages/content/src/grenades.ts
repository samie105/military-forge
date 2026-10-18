/**
 * Grenades (docs/02-physics-and-movement.md §13.2 and §14). Players carry several types with counts:
 * the grenade key throws the selected type, the cycle key switches between the types they hold.
 * Every type flies with the same projectile code (throw speed, gravity, bounce, fuse) and does its
 * `effect` at the end of the fuse. `index` is the wire id (u3, append-only: never reorder).
 */
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

/** A lingering cloud (smoke, toxic gas): it grows in, holds, then thins out and shrinks. */
export interface CloudDef {
  /** full radius (m) */
  radius: number;
  /** seconds from the pop until it is gone */
  duration: number;
  /** seconds to grow from `startFraction` of the radius to all of it */
  grow: number;
  startFraction: number;
  /** the last seconds of its life: it thins out and shrinks to `endFraction` of the radius */
  fade: number;
  endFraction: number;
  /** blocks sight lines (bots, aim assist, the server's AOI, rendering) while it is dense */
  blocksVision: boolean;
  /** damage per second inside `core` and at the edge (linear in between); 0 = harmless */
  dpsCore: number;
  dpsEdge: number;
  core: number;
  /** seconds between damage pulses (one hit event each) */
  pulse: number;
  selfDamageMul: number;
}

/**
 * A flashbang's blinding (docs/02 §14): per player, strength = distance × facing × cover, then
 * `white × strength` seconds of full white and `fade × strength` seconds of fading out.
 */
export interface FlashDef {
  /** nothing happens to eyes farther than this (m) */
  radius: number;
  /** full strength inside this distance; linear down to 0 at `radius` */
  fullRadius: number;
  /** seconds of full white at full strength */
  white: number;
  /** seconds of fading out after it at full strength (at least `minFade`) */
  fade: number;
  minFade: number;
  /** strength looking straight away from it (looking at it = 1; linear in between, by the cosine) */
  awayMul: number;
  /** strength when a wall is between the flash and the eyes */
  coverMul: number;
  /** strength when smoke is between them */
  smokeMul: number;
  /** weaker than this: no effect */
  minStrength: number;
}

/**
 * A proximity mine (docs/02 §14): it flies straight for the grenade's `fuse` seconds, then drops,
 * and sticks to the first surface it touches. It arms, then waits for an enemy.
 */
export interface MineDef {
  /** seconds after sticking until it is armed */
  arm: number;
  /** an enemy's body this close (m), in line of sight, starts the beep */
  triggerRadius: number;
  /** seconds from the beep to the blast */
  beep: number;
  /** hit points: bullets set it off (whoever does gets the credit) */
  hp: number;
  /** bullets hit it within this radius (m) */
  hitRadius: number;
  /** seconds armed before it despawns */
  lifetime: number;
  /** a thrower's live mines at most: a new one retires its oldest (the 64-slot grenade pool stays free for throws) */
  maxLive: number;
  /** seconds before another blast sets it off (staggered chains, docs/02 §14) */
  chainDelay: number;
  explosion: ExplosionDef;
}

/** An EMP burst (docs/02 §14): dead jetpacks and disarmed mines in its radius, through walls. */
export interface EmpDef {
  radius: number;
  /** seconds the jetpacks it reaches stay dead (the thrower's too) */
  jetDisable: number;
}

/** What a grenade does when its fuse runs out. */
export type GrenadeEffect = 'explode' | 'cloud' | 'flash' | 'mine' | 'emp';

interface GrenadeBase {
  /** wire id (u3), append-only: never reorder */
  index: number;
  id: string;
  name: string;
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
  /** carried at spawn (the default spawn loadout: frag ×3) */
  spawnCount: number;
  maxCount: number;
  throwCooldown: number;
}

export type GrenadeDef =
  | (GrenadeBase & { effect: 'explode'; explosion: ExplosionDef })
  | (GrenadeBase & { effect: 'cloud'; cloud: CloudDef })
  | (GrenadeBase & { effect: 'flash'; flash: FlashDef })
  | (GrenadeBase & { effect: 'mine'; mine: MineDef })
  | (GrenadeBase & { effect: 'emp'; emp: EmpDef });

export const FRAG = {
  index: 0,
  id: 'frag',
  name: 'Frag',
  radius: 0.1,
  throwSpeed: 16.2,
  inheritVelocity: 0.4,
  gravityScale: 1,
  restitution: 0.45,
  friction: 0.25,
  rollFriction: 6,
  restNormalSpeed: 1.0,
  fuse: 1.8,
  spawnCount: 3,
  maxCount: 5,
  throwCooldown: 0.5,
  effect: 'explode',
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
} satisfies GrenadeDef;

/** Smoke: a vision-blocking cloud, ~R 4 m for 12 s; cover, not damage. */
export const SMOKE = {
  index: 1,
  id: 'smoke',
  name: 'Smoke',
  radius: 0.1,
  throwSpeed: 15,
  inheritVelocity: 0.4,
  gravityScale: 1,
  restitution: 0.35,
  friction: 0.3,
  rollFriction: 6,
  restNormalSpeed: 1.0,
  fuse: 1.6,
  spawnCount: 0,
  maxCount: 2,
  throwCooldown: 0.5,
  effect: 'cloud',
  cloud: {
    radius: 4,
    duration: 12,
    grow: 1.2,
    startFraction: 0.3,
    fade: 2.5,
    endFraction: 0.6,
    blocksVision: true,
    dpsCore: 0,
    dpsEdge: 0,
    core: 0,
    pulse: 0.25,
    selfDamageMul: 0,
  },
} satisfies GrenadeDef;

/**
 * Toxic gas (docs/02 §14 "Gas"): a 15 s cloud, R 3.5 m, 14 dmg/s at the core falling to 4 at the
 * edge, so staying in the middle kills (~7 s) while crossing the edge costs a few HP. Flames clear it.
 */
export const GAS = {
  index: 2,
  id: 'gas',
  name: 'Toxic gas',
  radius: 0.1,
  throwSpeed: 15,
  inheritVelocity: 0.4,
  gravityScale: 1,
  restitution: 0.35,
  friction: 0.3,
  rollFriction: 6,
  restNormalSpeed: 1.0,
  fuse: 1.6,
  spawnCount: 0,
  maxCount: 2,
  throwCooldown: 0.5,
  effect: 'cloud',
  cloud: {
    radius: 3.5,
    duration: 15,
    grow: 1.0,
    startFraction: 0.35,
    fade: 1.5,
    endFraction: 0.7,
    blocksVision: false,
    dpsCore: 14,
    dpsEdge: 4,
    core: 1,
    pulse: 0.25,
    selfDamageMul: 0.5,
  },
} satisfies GrenadeDef;

/**
 * Flashbang: up to 2.5 s of white then a 1.5 s fade, less when you're farther, looking away or
 * behind cover; the thrower too. No damage. A blinded bot aims off target.
 */
export const FLASHBANG = {
  index: 3,
  id: 'flash',
  name: 'Flashbang',
  radius: 0.1,
  throwSpeed: 15,
  inheritVelocity: 0.4,
  gravityScale: 1,
  restitution: 0.4,
  friction: 0.3,
  rollFriction: 6,
  restNormalSpeed: 1.0,
  fuse: 1.7,
  spawnCount: 0,
  maxCount: 2,
  throwCooldown: 0.5,
  effect: 'flash',
  flash: {
    radius: 16,
    fullRadius: 4,
    white: 2.5,
    fade: 1.5,
    minFade: 0.3,
    awayMul: 0.25,
    coverMul: 0.15,
    smokeMul: 0.5,
    minStrength: 0.08,
  },
} satisfies GrenadeDef;

/**
 * Proximity mine (docs/02 §14): thrown at 11 m/s with no gravity for 0.9 s (its `fuse` is that
 * straight flight), then it drops; it sticks to the first surface and arms after 2 s (green
 * flying → yellow arming → flashing red armed). An enemy within 1.6 m starts a 0.25 s beep, then
 * 120 damage in 3.2 m. A direct hit on a player in flight sets it off; so do bullets (10 HP),
 * explosions (after 4 ticks) and nothing else; an EMP disarms it. Gone after 180 s.
 */
export const MINE = {
  index: 4,
  id: 'mine',
  name: 'Proximity mine',
  radius: 0.12,
  throwSpeed: 13.3,
  inheritVelocity: 0.4,
  gravityScale: 0,
  restitution: 0,
  friction: 1,
  rollFriction: 0,
  restNormalSpeed: 0,
  fuse: 1.0,
  spawnCount: 0,
  maxCount: 2,
  throwCooldown: 0.5,
  effect: 'mine',
  mine: {
    arm: 2,
    triggerRadius: 1.6,
    beep: 0.25,
    hp: 10,
    hitRadius: 0.25,
    lifetime: 180,
    maxLive: 3,
    chainDelay: 0.07,
    explosion: {
      radius: 3.2,
      core: 0.6,
      maxDamage: 120,
      impulse: 24,
      selfDamageMul: 0.5,
      selfImpulseMul: 0.6,
      coveredImpulseMul: 0.35,
      crouchDamageMul: 0.75,
      upBias: 0.3,
      minLift: 0.7,
    },
  },
} satisfies GrenadeDef;

/** EMP grenade (docs/02 §14): jetpacks dead for 3 s within 4 m (the thrower's too), mines disarmed. No damage. */
export const EMP = {
  index: 5,
  id: 'emp',
  name: 'EMP',
  radius: 0.1,
  throwSpeed: 15,
  inheritVelocity: 0.4,
  gravityScale: 1,
  restitution: 0.4,
  friction: 0.3,
  rollFriction: 6,
  restNormalSpeed: 1.0,
  fuse: 1.35,
  spawnCount: 0,
  maxCount: 2,
  throwCooldown: 0.5,
  effect: 'emp',
  emp: { radius: 4, jetDisable: 3 },
} satisfies GrenadeDef;

/** Every grenade type by wire index. */
export const grenades: readonly GrenadeDef[] = [FRAG, SMOKE, GAS, FLASHBANG, MINE, EMP];

/** Grenade types a player can carry (counts in PlayerState and the local block). */
export const GRENADE_TYPES = 6;

/** A map pickup's grenades come in pairs (docs/02 §14, a genre convention). */
export const GRENADE_PICKUP_COUNT = 2;

/** The default spawn loadout: each type's spawnCount (frag ×3). */
export function spawnGrenades(): number[] {
  const out = new Array<number>(GRENADE_TYPES).fill(0);
  for (const g of grenades) out[g.index] = g.spawnCount;
  return out;
}
