/**
 * Movement & body tuning. Values are the starting points from docs/02-physics-and-movement.md §6/§8.
 * Units: metres, seconds, m/s, m/s². Live-editable in dev via the tuning panel.
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

  jetThrust: 38,
  jetKick: 1.35,
  jetKickTicks: 6,
  jetMaxVy: 6.5,
  jetTaperBand: 1.5,
  jetAirMaxX: 6.5,

  fuelMax: 100,
  fuelBurn: 44, // 2.25 s of thrust, ~13 m full-tank climb (playtest tuning pass, NOTES.md)
  fuelMinIgnite: 10,
  fuelRegenGround: 35,
  fuelRegenDelayGround: 0.2,
  fuelRegenAir: 12,
  fuelRegenDelayAir: 0.45,

  maxWalkSlopeDeg: 50,
  stepHeight: 0.2,
  groundSnap: 0.12,
  ceilingBonkVxMul: 0.7,
  cornerCorrection: 0.12,
  knockbackCap: 18,

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
});

export function createTuning(overrides: Partial<Tuning> = {}): Tuning {
  return { ...defaultTuning, ...overrides };
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
