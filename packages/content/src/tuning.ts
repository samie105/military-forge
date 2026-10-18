/**
 * Movement & body tuning. Values are the starting points from docs/02-physics-and-movement.md §6/§8.
 * Units: metres, seconds, m/s, m/s². Live-editable with the tuning panel: in dev, and by a room's host in
 * pnpm playtest (TUNING_GROUPS below).
 */
export interface Tuning {
  // World
  gravity: number;
  terminalVy: number;

  // Ground movement
  walkMax: number;
  crouchMax: number;
  groundAccel: number;
  groundDecel: number;
  groundReverse: number;

  // Air movement
  airAccel: number;
  airMaxX: number;
  airDragX: number;
  /** above this horizontal speed (m/s) a player is being launched by a blast and bleeds speed at launchDragX instead */
  launchSpeedX: number;
  /** horizontal drag (1/s) on a launch: low, so blasts throw players far; melee lunges never get this fast */
  launchDragX: number;

  // Jetpack
  jetThrust: number;
  jetKick: number;
  jetKickTicks: number;
  jetMaxVy: number;
  jetTaperBand: number;
  jetAirMaxX: number;

  // Fuel ("nitro")
  fuelMax: number;
  fuelBurn: number;
  fuelMinIgnite: number;
  fuelRegenGround: number;
  fuelRegenDelayGround: number;
  fuelRegenAir: number;
  fuelRegenDelayAir: number;

  // Collision feel
  maxWalkSlopeDeg: number;
  stepHeight: number;
  groundSnap: number;
  ceilingBonkVxMul: number;
  cornerCorrection: number;
  knockbackCap: number;

  // Health & respawn
  healthMax: number;
  healthRegen: number;
  healthRegenDelay: number;
  respawnDelay: number;

  // Body
  capsuleRadius: number;
  standHeight: number;
  crouchHeight: number;
  shoulderStand: number;
  shoulderCrouch: number;
  shoulderForward: number;

  // One-way platforms
  dropThroughHold: number;
  dropThroughTime: number;

  // Dash (docs/02 §21): a brief 8-way jetpack burst
  /** m/s along the dash direction during the burst (× weapon weight × map speed) */
  dashSpeed: number;
  /** burst length in ticks */
  dashBurstTicks: number;
  /** seconds between dashes */
  dashCooldown: number;
  /** fuel per dash (0 = free) */
  dashFuelCost: number;
  /** the most upward speed a dash leaves you with (m/s): an up-dash can't become a jet launch */
  dashExitUp: number;

  // Grenades and blasts: scales on every grenade's own numbers (grenades.ts), for live tuning
  /** × each grenade's throw speed (the sim's throw, the aiming arc and the bots' throws) */
  grenadeThrowScale: number;
  /** × each blast's push on players (how far explosions launch them) */
  blastImpulseScale: number;
}

export const defaultTuning: Readonly<Tuning> = Object.freeze({
  gravity: 20,
  terminalVy: -16,

  walkMax: 5.0,
  crouchMax: 2.2,
  groundAccel: 45,
  groundDecel: 55,
  groundReverse: 80,

  airAccel: 20,
  airMaxX: 6.0,
  airDragX: 1.5,
  launchSpeedX: 12,
  launchDragX: 0.3,

  jetThrust: 38,
  jetKick: 1.35,
  jetKickTicks: 6,
  jetMaxVy: 6.5,
  jetTaperBand: 1.5,
  jetAirMaxX: 6.5,

  // the owner's playtest ("the fuel finishes quick"): a 40% bigger tank at the same burn and air
  // regen, so feathering and hovering keep their rhythm; ground regen grows with it, so a refill
  // from empty still takes ~3 s
  fuelMax: 140,
  fuelBurn: 44, // 3.2 s of thrust (was 2.25 s on a 100 tank), ~18 m full-tank climb
  fuelMinIgnite: 10,
  fuelRegenGround: 49,
  fuelRegenDelayGround: 0.2,
  fuelRegenAir: 12,
  fuelRegenDelayAir: 0.45,

  maxWalkSlopeDeg: 50,
  stepHeight: 0.2,
  groundSnap: 0.12,
  ceilingBonkVxMul: 0.7,
  cornerCorrection: 0.12,
  knockbackCap: 26,

  healthMax: 100,
  healthRegen: 6,
  healthRegenDelay: 4,
  respawnDelay: 3,

  capsuleRadius: 0.32,
  standHeight: 1.5,
  crouchHeight: 1.05,
  shoulderStand: 1.08,
  shoulderCrouch: 0.74,
  shoulderForward: 0.08,

  dropThroughHold: 0.15,
  dropThroughTime: 0.25,

  dashSpeed: 14,
  dashBurstTicks: 8,
  dashCooldown: 1.0,
  dashFuelCost: 8,
  dashExitUp: 2,

  grenadeThrowScale: 1,
  blastImpulseScale: 1,
});

export function createTuning(overrides: Partial<Tuning> = {}): Tuning {
  return { ...defaultTuning, ...overrides };
}

/** A number the tuning panel edits, with the range it may take. */
export interface TuningField {
  key: { [K in keyof Tuning]: Tuning[K] extends number ? K : never }[keyof Tuning];
  /** what the host's panel calls it (the dev panel shows the key) */
  label: string;
  min: number;
  max: number;
  step: number;
}

/**
 * What the live tuning panel offers, by group, with each value's range (docs/02 §19.2). The game
 * server holds a room host's edits to these keys and ranges (pnpm playtest --tune: limitTuning).
 */
export const TUNING_GROUPS: readonly { title: string; fields: readonly TuningField[] }[] = [
  {
    title: 'Jetpack',
    fields: [
      { key: 'jetThrust', label: 'Thrust (m/s²)', min: 10, max: 80, step: 0.5 },
      { key: 'jetKick', label: 'Take-off kick (×)', min: 1, max: 3, step: 0.05 },
      { key: 'jetKickTicks', label: 'Kick length (ticks)', min: 0, max: 30, step: 1 },
      { key: 'jetMaxVy', label: 'Top climb speed (m/s)', min: 2, max: 15, step: 0.1 },
      { key: 'jetTaperBand', label: 'Thrust fade near top speed (m/s)', min: 0.1, max: 5, step: 0.1 },
      { key: 'jetAirMaxX', label: 'Top sideways speed, flying (m/s)', min: 1, max: 15, step: 0.1 },
    ],
  },
  {
    title: 'Fuel',
    fields: [
      { key: 'fuelMax', label: 'Tank size', min: 10, max: 300, step: 1 },
      { key: 'fuelBurn', label: 'Burn per second', min: 5, max: 120, step: 1 },
      { key: 'fuelMinIgnite', label: 'Fuel needed to relight', min: 0, max: 50, step: 1 },
      { key: 'fuelRegenGround', label: 'Refill per second, on the ground', min: 0, max: 150, step: 1 },
      { key: 'fuelRegenDelayGround', label: 'Refill delay, on the ground (s)', min: 0, max: 2, step: 0.05 },
      { key: 'fuelRegenAir', label: 'Refill per second, in the air', min: 0, max: 80, step: 1 },
      { key: 'fuelRegenDelayAir', label: 'Refill delay, in the air (s)', min: 0, max: 3, step: 0.05 },
    ],
  },
  {
    title: 'Air & gravity',
    fields: [
      { key: 'gravity', label: 'Gravity (m/s²)', min: 2, max: 40, step: 0.5 },
      { key: 'terminalVy', label: 'Fastest fall (m/s)', min: -40, max: -4, step: 0.5 },
      { key: 'airAccel', label: 'Air control (m/s²)', min: 0, max: 80, step: 1 },
      { key: 'airMaxX', label: 'Top air speed (m/s)', min: 1, max: 15, step: 0.1 },
      { key: 'airDragX', label: 'Air drag (1/s)', min: 0, max: 10, step: 0.1 },
    ],
  },
  {
    title: 'Dash',
    fields: [
      { key: 'dashSpeed', label: 'Speed (m/s)', min: 4, max: 30, step: 0.5 },
      { key: 'dashBurstTicks', label: 'Length (ticks)', min: 1, max: 30, step: 1 },
      { key: 'dashCooldown', label: 'Cooldown (s)', min: 0, max: 4, step: 0.05 },
      { key: 'dashFuelCost', label: 'Fuel per dash', min: 0, max: 50, step: 1 },
      { key: 'dashExitUp', label: 'Most upward speed after (m/s)', min: 0, max: 10, step: 0.1 },
    ],
  },
  {
    title: 'Blast launch',
    fields: [
      { key: 'blastImpulseScale', label: 'Blast push (×)', min: 0.25, max: 3, step: 0.05 },
      { key: 'launchSpeedX', label: 'Counts as launched above (m/s)', min: 6, max: 30, step: 0.5 },
      { key: 'launchDragX', label: 'Drag while launched (1/s)', min: 0, max: 10, step: 0.1 },
      { key: 'knockbackCap', label: 'Most push from one hit (m/s)', min: 2, max: 40, step: 0.5 },
    ],
  },
  {
    title: 'Grenades',
    fields: [{ key: 'grenadeThrowScale', label: 'Throw speed (×)', min: 0.5, max: 2, step: 0.05 }],
  },
  {
    title: 'Ground',
    fields: [
      { key: 'walkMax', label: 'Run speed (m/s)', min: 1, max: 12, step: 0.1 },
      { key: 'crouchMax', label: 'Crouch speed (m/s)', min: 0.5, max: 6, step: 0.1 },
      { key: 'groundAccel', label: 'Speed-up (m/s²)', min: 5, max: 150, step: 1 },
      { key: 'groundDecel', label: 'Braking (m/s²)', min: 5, max: 150, step: 1 },
      { key: 'groundReverse', label: 'Turn-around (m/s²)', min: 5, max: 200, step: 1 },
    ],
  },
  {
    title: 'Collision feel',
    fields: [
      { key: 'maxWalkSlopeDeg', label: 'Steepest walkable slope (°)', min: 20, max: 70, step: 1 },
      { key: 'stepHeight', label: 'Step-up height (m)', min: 0, max: 0.5, step: 0.01 },
      { key: 'groundSnap', label: 'Ground snap (m)', min: 0, max: 0.4, step: 0.01 },
      { key: 'ceilingBonkVxMul', label: 'Speed kept on a ceiling bump (×)', min: 0, max: 1, step: 0.05 },
      { key: 'cornerCorrection', label: 'Corner nudge (m)', min: 0, max: 0.3, step: 0.01 },
    ],
  },
  {
    title: 'Health',
    fields: [
      { key: 'healthRegen', label: 'Health back per second', min: 0, max: 30, step: 0.5 },
      { key: 'healthRegenDelay', label: 'Health regen delay (s)', min: 0, max: 10, step: 0.1 },
      { key: 'respawnDelay', label: 'Respawn time (s)', min: 0, max: 10, step: 0.1 },
    ],
  },
];

/**
 * The panel's values out of an untrusted edit: only TUNING_GROUPS keys, finite numbers, kept inside
 * each range (whole-number fields rounded). Anything else is dropped.
 */
export function limitTuning(raw: unknown): Partial<Tuning> {
  const src = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: Partial<Tuning> = {};
  for (const group of TUNING_GROUPS) {
    for (const f of group.fields) {
      const v = src[f.key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const within = Math.min(f.max, Math.max(f.min, v));
      out[f.key] = Number.isInteger(f.step) ? Math.round(within) : within;
    }
  }
  return out;
}

/** The values that differ from the defaults (the panel's "Copy values"). */
export function changedTuning(t: Tuning): Partial<Tuning> {
  const diff: Partial<Tuning> = {};
  for (const k of Object.keys(defaultTuning) as (keyof Tuning)[]) if (t[k] !== defaultTuning[k]) diff[k] = t[k];
  return diff;
}

/** FNV-1a over sorted key=value pairs; stamped into handshakes so mismatched builds are refused. */
export function tuningHash(tuning: Tuning): number {
  const text = (Object.keys(tuning) as (keyof Tuning)[])
    .sort()
    .map((k) => `${k}=${tuning[k]}`)
    .join(';');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
