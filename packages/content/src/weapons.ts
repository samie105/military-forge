/**
 * Weapon data (docs/03-weapons-and-combat.md §4–5). Phase 0 shipped two one-handed guns, Hammer .44
 * (magnum revolver, default primary) and Buzz (compact SMG), which dual-wield together (the classic
 * Buzz + Hammer combo). Arsenal milestone A adds the K-47 rifle, the Breacher pump shotgun, the
 * Widow bolt sniper and the Machete. Ids match the weapon models (art/weapons/weapons.json).
 */
export interface SpreadDef {
  /** ± degrees */
  base: number;
  moveMul: number;
  airMul: number;
  crouchMul: number;
  dualMul: number;
  bloomPerShot: number;
  bloomMax: number;
  /** degrees per second, after 0.1 s without firing */
  recoverPerSec: number;
  /** minimum spread while airborne (snipers/DMRs) */
  minAir: number;
}

export type WeaponClass = 'sidearm' | 'smg' | 'rifle' | 'dmr' | 'sniper' | 'shotgun' | 'heavy' | 'special' | 'melee';

export interface WeaponDef {
  /** wire id (u6, append-only): never reorder */
  index: number;
  id: string;
  name: string;
  class: WeaponClass;
  hands: 1 | 2;
  /** 'melee': the fire button swings the weapon (no ammo) */
  fireMode: 'semi' | 'auto' | 'melee';
  /** seconds between shots (melee: between swings) */
  interval: number;
  /** per bullet / pellet */
  damage: number;
  /** bullets per shot: 1, or a shotgun's evenly spread pellets (docs/03 §7) */
  pellets: number;
  /** m/s shove along the bullet for each bullet or pellet that hits (docs/03 §11) */
  hitImpulse: number;
  headMul: number;
  /** metres (melee weapons: reach of the swing) */
  range: number;
  falloffStart: number;
  minDamageMul: number;
  spread: SpreadDef;
  mag: number;
  reserve: number;
  /** seconds */
  reload: number;
  equip: number;
  zoomMax: number;
  meleeDamage: number;
  /**
   * Recoil push (docs/02 §12, "rebounds after shots"): m/s along −aim per shot while airborne, so a
   * shotgun fired down is a jump and a sniper shot knocks you back. Light guns don't push (0).
   */
  recoilPushAir: number;
  /** m/s of horizontal slide against the aim per shot while grounded: heavy guns only (0 = none) */
  recoilPushGround: number;
  /** weight: multiplies walk and air speed caps while held (docs/03 §9) */
  moveSpeedMul: number;
  /** visual muzzle distance from the shoulder, also the muzzle-in-wall guard length */
  muzzleLength: number;
}

/** Accuracy defaults (docs/03 §7). */
const defaultSpread = {
  moveMul: 1.25,
  airMul: 1.5,
  crouchMul: 0.6,
  dualMul: 1.4,
  bloomPerShot: 0.5,
  bloomMax: 4,
  recoverPerSec: 10,
  minAir: 0,
};

export const HAMMER: WeaponDef = {
  index: 0,
  id: 'hammer44',
  name: 'Hammer .44',
  class: 'sidearm',
  hands: 1,
  fireMode: 'semi',
  interval: 0.6,
  damage: 30,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 26,
  falloffStart: 13,
  minDamageMul: 0.5,
  // flying costs accuracy: ~75% hits at 18 m airborne vs 100% planted (playtest tuning pass, NOTES.md)
  spread: { ...defaultSpread, base: 1.5, airMul: 2.25 },
  mag: 6,
  reserve: 30,
  reload: 2.0,
  equip: 0.25,
  zoomMax: 3,
  meleeDamage: 25,
  recoilPushAir: 0,
  recoilPushGround: 0,
  moveSpeedMul: 1.0,
  muzzleLength: 0.55,
};

export const BUZZ: WeaponDef = {
  index: 1,
  id: 'buzz',
  name: 'Buzz',
  class: 'smg',
  hands: 1,
  fireMode: 'auto',
  interval: 0.1,
  damage: 7,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 20,
  falloffStart: 10,
  minDamageMul: 0.5,
  // tight enough to work at mid range (~60% hits at 12 m); dualMul keeps dual-wield spread at 8.4°
  spread: { ...defaultSpread, base: 3.5, dualMul: 2.4 },
  mag: 40,
  reserve: 250,
  reload: 1.5,
  equip: 0.25,
  zoomMax: 3,
  meleeDamage: 20,
  recoilPushAir: 0,
  recoilPushGround: 0,
  moveSpeedMul: 1.0,
  muzzleLength: 0.5,
};

/** Hard-hitting, wild assault rifle: 10 body shots, ~0.9 s TTK. */
export const K47: WeaponDef = {
  index: 2,
  id: 'k47',
  name: 'K-47',
  class: 'rifle',
  hands: 2,
  fireMode: 'auto',
  interval: 0.1,
  damage: 10,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 32,
  falloffStart: 16,
  minDamageMul: 0.5,
  // docs/03 says ±5°: 46% hits and a 2.1 s TTK at 12 m, short of the ≤ 2 s mid-range target, so
  // ±4° (55%, 1.7 s; still wilder than a Buzz, which is 3.5°). See the arsenal feel table, NOTES.md.
  spread: { ...defaultSpread, base: 4 },
  mag: 35,
  reserve: 210,
  reload: 2.0,
  equip: 0.35,
  zoomMax: 4,
  meleeDamage: 30,
  recoilPushAir: 0.3, // spraying in the air drifts you back gently (~3 m/s per second of fire)
  recoilPushGround: 0,
  moveSpeedMul: 0.97,
  muzzleLength: 0.75,
};

/** Pump shotgun: 5 pellets in an even ±10° cone, one-shot kill inside ~4 m. */
export const BREACHER: WeaponDef = {
  index: 3,
  id: 'breacher',
  name: 'Breacher',
  class: 'shotgun',
  hands: 2,
  fireMode: 'semi',
  interval: 0.75,
  damage: 20,
  pellets: 5,
  hitImpulse: 0.6,
  headMul: 1.5,
  range: 13,
  falloffStart: 6.5,
  minDamageMul: 0.5,
  spread: { ...defaultSpread, base: 10 },
  mag: 5,
  reserve: 20,
  reload: 2.5,
  equip: 0.35,
  zoomMax: 2,
  meleeDamage: 40,
  recoilPushAir: 10, // fired down at the top of a hop: a ~2.5 m shotgun jump (NOTES §22.4)
  recoilPushGround: 6, // a short slide back (~0.3 m)
  moveSpeedMul: 0.97,
  muzzleLength: 0.75,
};

/** Bolt sniper: perfectly accurate on the ground, a one-shot headshot (crouching denies it). */
export const WIDOW: WeaponDef = {
  index: 4,
  id: 'widow',
  name: 'Widow',
  class: 'sniper',
  hands: 2,
  fireMode: 'semi',
  interval: 0.8,
  damage: 75,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 60,
  falloffStart: 30,
  minDamageMul: 0.5,
  // air-sniping is a flex, not a default (docs/03 §7)
  spread: { ...defaultSpread, base: 0, minAir: 1.5 },
  mag: 3,
  reserve: 15,
  reload: 2.5,
  equip: 0.35,
  zoomMax: 7,
  meleeDamage: 35,
  recoilPushAir: 2,
  recoilPushGround: 8.5, // each shot kicks you back ~0.7 m standing (crouching braces against it)
  moveSpeedMul: 0.9,
  muzzleLength: 0.9,
};

/**
 * Melee pickup: one-hit kill, swung with Fire while held or with Melee while carried (it replaces
 * the default bash, docs/03 §11). No ammo; can't be dual-wielded.
 */
export const MACHETE: WeaponDef = {
  index: 5,
  id: 'machete',
  name: 'Machete',
  class: 'melee',
  hands: 1,
  fireMode: 'melee',
  interval: 0.55,
  damage: 0,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1,
  range: 1.2,
  falloffStart: 1.2,
  minDamageMul: 1,
  spread: { ...defaultSpread, base: 0 },
  mag: 0,
  reserve: 0,
  reload: 0,
  equip: 0.25,
  zoomMax: 1,
  meleeDamage: 100,
  recoilPushAir: 0,
  recoilPushGround: 0,
  moveSpeedMul: 1.05,
  muzzleLength: 0.5,
};

export const weapons: readonly WeaponDef[] = [HAMMER, BUZZ, K47, BREACHER, WIDOW, MACHETE];

export const NO_WEAPON = 63;

/** Default spawn loadout for Phase 0: slot 0 Hammer .44, slot 1 Buzz. */
export const DEFAULT_LOADOUT: readonly [number, number] = [HAMMER.index, BUZZ.index];

/** Damage of one trigger pull at point-blank range: all pellets, or the swing for melee weapons. */
export function shotDamage(def: WeaponDef): number {
  return def.fireMode === 'melee' ? def.meleeDamage : def.damage * def.pellets;
}

/** Shots to kill `hp` and the time it takes when every shot hits (docs/03 §6; no regen). */
export function timeToKill(def: WeaponDef, hp: number, headshots = false): { shots: number; seconds: number } {
  const perShot = shotDamage(def) * (headshots && def.fireMode !== 'melee' ? def.headMul : 1);
  const shots = Math.ceil(hp / perShot - 1e-9);
  return { shots, seconds: (shots - 1) * def.interval };
}
