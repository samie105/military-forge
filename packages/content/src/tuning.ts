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
