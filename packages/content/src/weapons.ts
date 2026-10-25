/**
 * Weapon data (docs/03-weapons-and-combat.md §4–5). Phase 0 shipped two one-handed guns, Hammer .44
 * (magnum revolver, default primary) and Buzz (compact SMG), which dual-wield together (the classic
 * Buzz + Hammer combo). Arsenal milestone A adds the K-47 rifle, the Breacher pump shotgun, the
 * Widow bolt sniper and the Machete. The owner's playtest ("add more guns") adds every other
 * modelled bullet gun: Hawk .50, Rattler, Hornet, Trident (burst), Bullpup, Longbow (DMR), Shredder
 * (minigun, spin-up) and Arc (beam). Then the launchers and the flamethrower, which fire
 * projectiles (projectiles.ts) instead of bullets: Thumper (rockets), Popper (grenade launcher),
 * Ripper (saw blades, charged), Pulse (EMP orbs, charged) and Dragon (flames). Ids match the weapon
 * models (art/weapons/weapons.json).
 */
import { FLAME, ORB, ROCKET, SHELL, BLADE, type ProjectileDef } from './projectiles';

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

export type FireMode = 'semi' | 'auto' | 'burst' | 'spinup' | 'beam' | 'charge' | 'melee';

/**
 * Fire modes the button is held for (bots and touch hold the trigger for these): they keep firing
 * while held, or (charge) fire once the charge is full.
 */
export function heldTrigger(def: Pick<WeaponDef, 'fireMode'>): boolean {
  return def.fireMode === 'auto' || def.fireMode === 'burst' || def.fireMode === 'spinup' || def.fireMode === 'beam' || def.fireMode === 'charge';
}

export interface WeaponDef {
  /** wire id (u6, append-only): never reorder */
  index: number;
  id: string;
  name: string;
  class: WeaponClass;
  hands: 1 | 2;
  /**
   * 'semi': one shot per press, and while held another every `holdRepeat` s when it has one · 'auto': fires while held · 'burst': each press (or held) fires a
   * burst of `burst.count` rounds `burst.interval` apart · 'spinup': fires while held once spun up
   * (`spin`; the second fire button spins it without firing) · 'beam': fires while held, its cell
   * refills by itself (`regen`) · 'charge': a press starts a charge, held for `charge` s it fires
   * (let go early and it's lost) · 'melee': the fire button swings the weapon (no ammo)
   */
  fireMode: FireMode;
  /** seconds between shots (burst: from one burst's first round to the next's; melee: between swings) */
  interval: number;
  /**
   * 'semi' weapons that keep firing while the trigger is held (the owner's phone playtest, 25 Oct:
   * "if the user is holding fire, it should just keep on shooting, maybe after some delay"): seconds
   * from one shot to the next while held, a little slower than `interval` so tapping stays the faster
   * way to fire. Absent: one shot per press (the bolt sniper, the launchers). At most 2 s: the clock
   * is the slot's ticksSinceShot, which the local block carries up to 127 ticks.
   */
  holdRepeat?: number;
  /** 'burst' weapons: rounds per burst and seconds between them */
  burst?: { count: number; interval: number };
  /** 'spinup' weapons: seconds to spin up from rest, and to spin down from full */
  spin?: { up: number; down: number };
  /** the magazine refills by itself (a beam's cell): rounds per second, after `delay` s without firing */
  regen?: { perSec: number; delay: number };
  /** 'charge' weapons: seconds the button is held before the shot leaves */
  charge?: number;
  /** launchers and the flamethrower: each shot launches this instead of a bullet (`damage` is its direct hit) */
  projectile?: ProjectileDef;
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
  holdRepeat: 0.7, // held: a shot every 0.7 s (tapping: every 0.6 s)
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
  holdRepeat: 0.85, // held: a pump every 0.85 s (pumping by hand: 0.75 s)
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
  fireMode: 'semi', // no holdRepeat: a bolt action, one deliberate round per press (3 in the mag)
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

// ---------- the owner's "more guns" (docs/03 §5 roles; numbers sit inside today's TTK bands) ----------

/** Heavy pistol: the weakest gun per shot, quick and accurate enough to finish fights. */
export const HAWK50: WeaponDef = {
  index: 6,
  id: 'hawk50',
  name: 'Hawk .50',
  class: 'sidearm',
  hands: 1,
  fireMode: 'semi',
  interval: 0.25,
  holdRepeat: 0.3, // held: 3.3 shots/s (tapping: 4/s)
  // docs/03 says 8 (13 shots, 3.0 s): 9 is 12 shots, 2.75 s, a sidearm you can still win with
  damage: 9,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 20,
  falloffStart: 10,
  minDamageMul: 0.5,
  spread: { ...defaultSpread, base: 2.5, airMul: 2 },
  mag: 15,
  reserve: 60,
  reload: 1.25,
  equip: 0.25,
  zoomMax: 2,
  meleeDamage: 15,
  recoilPushAir: 0,
  recoilPushGround: 0,
  moveSpeedMul: 1.0,
  muzzleLength: 0.45,
};

/** Machine pistol: a one-handed spray between the Buzz and the K-47 (10 shots, 1.35 s). */
export const RATTLER: WeaponDef = {
  index: 7,
  id: 'rattler',
  name: 'Rattler',
  class: 'smg',
  hands: 1,
  fireMode: 'auto',
  interval: 0.15,
  damage: 10,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 24,
  falloffStart: 12,
  minDamageMul: 0.5,
  // docs/03 says ±4°; at 0.15 s a shot its bloom never builds (the Buzz's does), so ±5° keeps it a
  // close-to-mid gun (~70% hits at 12 m); dual-wielded it goes wild
  spread: { ...defaultSpread, base: 5, dualMul: 2 },
  mag: 40,
  reserve: 250,
  reload: 1.5,
  equip: 0.25,
  zoomMax: 3,
  meleeDamage: 25,
  recoilPushAir: 0,
  recoilPushGround: 0,
  moveSpeedMul: 1.0,
  muzzleLength: 0.45,
};

/** High-rate SMG: the fastest-firing gun (15 shots, 0.84 s), wild past close range. */
export const HORNET: WeaponDef = {
  index: 8,
  id: 'hornet',
  name: 'Hornet',
  class: 'smg',
  hands: 2,
  fireMode: 'auto',
  interval: 0.06,
  damage: 7,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 28,
  falloffStart: 14,
  minDamageMul: 0.5,
  spread: { ...defaultSpread, base: 4.5, bloomPerShot: 0.3 },
  mag: 50,
  reserve: 250,
  reload: 1.75,
  equip: 0.3,
  zoomMax: 3,
  meleeDamage: 30,
  recoilPushAir: 0, // SMGs don't kick (owner's call: pistols and SMGs push nothing)
  recoilPushGround: 0,
  moveSpeedMul: 1.0,
  muzzleLength: 0.6,
};

/** Three-round burst rifle: precise at range, 8 rounds (3 bursts, ~1.07 s) to kill. */
export const TRIDENT: WeaponDef = {
  index: 9,
  id: 'trident',
  name: 'Trident',
  class: 'rifle',
  hands: 2,
  fireMode: 'burst',
  interval: 0.5,
  burst: { count: 3, interval: 1 / 15 }, // 4 ticks: rounds 0.067 s apart, bursts exactly 0.5 s apart
  damage: 14,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 40,
  falloffStart: 20,
  minDamageMul: 0.5,
  // docs/03 says ±1.5°: its bloom resets between bursts, so 3.5° keeps it precise at mid range
  // without out-ranging the Widow and the Hammer at 18 m
  spread: { ...defaultSpread, base: 3.5, bloomPerShot: 0.4 },
  mag: 24,
  reserve: 240,
  reload: 2.0,
  equip: 0.35,
  zoomMax: 5,
  meleeDamage: 30,
  recoilPushAir: 0.3,
  recoilPushGround: 0,
  moveSpeedMul: 0.97,
  muzzleLength: 0.75,
};

/** Bullpup rifle: a steadier, lighter K-47 (12 shots, 1.32 s). */
export const BULLPUP: WeaponDef = {
  index: 10,
  id: 'bullpup',
  name: 'Bullpup',
  class: 'rifle',
  hands: 2,
  fireMode: 'auto',
  interval: 0.12,
  damage: 9,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 30,
  falloffStart: 15,
  minDamageMul: 0.5,
  // docs/03 says ±3°; its slower rate barely blooms, so 3.5° keeps it a mid-range rifle
  spread: { ...defaultSpread, base: 3.5 },
  mag: 35,
  reserve: 175,
  reload: 1.5,
  equip: 0.3,
  zoomMax: 4,
  meleeDamage: 30,
  recoilPushAir: 0.3,
  recoilPushGround: 0,
  moveSpeedMul: 1.0,
  muzzleLength: 0.6,
};

/** Marksman rifle: 3 body shots (1.1 s), 2 to the head; air shots pay a small spread. */
export const LONGBOW: WeaponDef = {
  index: 11,
  id: 'longbow',
  name: 'Longbow',
  class: 'dmr',
  hands: 2,
  fireMode: 'semi',
  interval: 0.55,
  holdRepeat: 0.65, // a self-loading marksman rifle: held, a shot every 0.65 s (tapping: 0.55 s)
  damage: 36,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 48,
  falloffStart: 24,
  minDamageMul: 0.5,
  spread: { ...defaultSpread, base: 0, minAir: 1.5 },
  mag: 6,
  reserve: 30,
  reload: 2.25,
  equip: 0.35,
  zoomMax: 6,
  meleeDamage: 35,
  recoilPushAir: 1.5, // a nudge (docs/03 §7)
  recoilPushGround: 3,
  moveSpeedMul: 0.95,
  muzzleLength: 0.85,
};

/** Minigun: spins up for 0.8 s (audible, a fair warning), then shreds; heavy (×0.7 speed). */
export const SHREDDER: WeaponDef = {
  index: 12,
  id: 'shredder',
  name: 'Shredder',
  class: 'heavy',
  hands: 2,
  fireMode: 'spinup',
  // docs/03 says 0.07 s; the sim's cooldown counts whole ticks, so 0.07 (4.2 ticks) would fire every
  // 5 (12/s): 1/15 s is exactly 4 ticks, 15 rounds a second
  interval: 1 / 15,
  spin: { up: 0.8, down: 1.0 },
  damage: 9,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 26,
  falloffStart: 13,
  minDamageMul: 0.5,
  // docs/03 says ±6°: 4.5° and a slow bloom keep it deadly at mid range once it's spinning
  spread: { ...defaultSpread, base: 4.5, bloomPerShot: 0.2, bloomMax: 3 },
  mag: 120,
  reserve: 240,
  reload: 4.25,
  equip: 0.5,
  zoomMax: 3,
  meleeDamage: 35,
  recoilPushAir: 0.35, // a long burst pushes you back steadily
  recoilPushGround: 0.15,
  moveSpeedMul: 0.7,
  muzzleLength: 0.7,
};

/**
 * Beam laser: one perfectly accurate ray every 0.15 s, no falloff over its 52 m (a zoning tool,
 * 17 ticks to kill). Its cell holds 40 ticks (6 s of beam) and refills at 10 a second after half a
 * second off the trigger; it never reloads.
 */
export const ARC: WeaponDef = {
  index: 13,
  id: 'arc',
  name: 'Arc',
  class: 'special',
  hands: 2,
  fireMode: 'beam',
  interval: 0.15,
  regen: { perSec: 10, delay: 0.5 },
  damage: 6,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1.5,
  range: 52,
  falloffStart: 52,
  minDamageMul: 1,
  spread: { ...defaultSpread, base: 0, airMul: 1, crouchMul: 1, moveMul: 1, bloomPerShot: 0, bloomMax: 0 },
  mag: 40,
  reserve: 0,
  reload: 0,
  equip: 0.35,
  zoomMax: 5,
  meleeDamage: 40,
  recoilPushAir: 0, // streams don't kick
  recoilPushGround: 0,
  moveSpeedMul: 0.95,
  muzzleLength: 0.75,
};

// ---------- launchers and the flamethrower: projectiles, not bullets (docs/03 §5, §11) ----------

/** No spread at all (the projectile flies where you aim). */
const NO_SPREAD: SpreadDef = { ...defaultSpread, base: 0, moveMul: 1, airMul: 1, crouchMul: 1, dualMul: 1, bloomPerShot: 0, bloomMax: 0 };

/**
 * Rocket launcher: a rocket at 20 m/s that blows up on anything (100 on a direct hit, 80 splash in
 * 3.5 m) and self-destructs at 60 m. Its own blast costs half: rocket jumps.
 */
export const THUMPER: WeaponDef = {
  index: 14,
  id: 'thumper',
  name: 'Thumper',
  class: 'heavy',
  hands: 2,
  fireMode: 'semi', // no holdRepeat: its blast hurts you, so each rocket is a fresh press
  interval: 1.25,
  projectile: ROCKET,
  damage: ROCKET.damage,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1,
  range: 60,
  falloffStart: 60,
  minDamageMul: 1,
  spread: { ...NO_SPREAD }, // its own: the admin page tunes each gun apart
  mag: 3,
  reserve: 6,
  reload: 4.0,
  equip: 0.5,
  zoomMax: 6,
  meleeDamage: 35,
  recoilPushAir: 6, // a launcher kicks hard (rocket jumps come from its blast)
  recoilPushGround: 4,
  moveSpeedMul: 0.85,
  muzzleLength: 0.9,
};

/** Grenade launcher: lobbed shells (17 m/s, they bounce) that go off on a player or after 1.2 s, 70 splash in 3 m. */
export const POPPER: WeaponDef = {
  index: 15,
  id: 'popper',
  name: 'Popper',
  class: 'heavy',
  hands: 2,
  fireMode: 'semi', // no holdRepeat: its splash hurts you, so each shell is a fresh press
  interval: 0.25,
  projectile: SHELL,
  damage: SHELL.explosion!.maxDamage,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1,
  range: 30,
  falloffStart: 30,
  minDamageMul: 1,
  spread: { ...NO_SPREAD, base: 2, airMul: 1.5 },
  mag: 6,
  reserve: 18,
  reload: 3.75,
  equip: 0.45,
  zoomMax: 4,
  meleeDamage: 35,
  recoilPushAir: 2.5,
  recoilPushGround: 1.5,
  moveSpeedMul: 0.9,
  muzzleLength: 0.75,
};

/**
 * Saw-blade launcher: hold 0.4 s and a blade leaves at 18 m/s. It bounces off walls without losing
 * speed and cuts through everyone in its way (100 each), its owner too once it has bounced; after
 * 5 s it blows up.
 */
export const RIPPER: WeaponDef = {
  index: 16,
  id: 'ripper',
  name: 'Ripper',
  class: 'special',
  hands: 2,
  fireMode: 'charge',
  charge: 0.4,
  interval: 1.0,
  projectile: BLADE,
  damage: BLADE.damage,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1,
  range: 90,
  falloffStart: 90,
  minDamageMul: 1,
  spread: { ...NO_SPREAD }, // its own: the admin page tunes each gun apart
  mag: 1,
  reserve: 8,
  reload: 2.5,
  equip: 0.4,
  zoomMax: 4,
  meleeDamage: 40,
  recoilPushAir: 3,
  recoilPushGround: 2,
  moveSpeedMul: 0.95,
  muzzleLength: 0.7,
};

/**
 * EMP orb gun: hold 0.7 s and a slow orb (8 m/s) floats out, through walls; on a player, or after
 * 3 s, it bursts: jetpacks dead for 3 s within 2.5 m, mines disarmed. No damage.
 */
export const PULSE: WeaponDef = {
  index: 17,
  id: 'pulse',
  name: 'Pulse',
  class: 'special',
  hands: 2,
  fireMode: 'charge',
  charge: 0.7,
  interval: 0.7,
  projectile: ORB,
  damage: 0,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1,
  range: 24,
  falloffStart: 24,
  minDamageMul: 1,
  spread: { ...NO_SPREAD }, // its own: the admin page tunes each gun apart
  mag: 1,
  reserve: 12,
  reload: 2.5,
  equip: 0.4,
  zoomMax: 4,
  meleeDamage: 50,
  recoilPushAir: 0, // orbs don't kick
  recoilPushGround: 0,
  moveSpeedMul: 0.95,
  muzzleLength: 0.7,
};

/**
 * Flamethrower: a flame every 0.15 s while held (7 m/s, ~6 m of reach, ±8°), 20 a hit and 2 s of
 * burning (4 a second). Its tank (40 flames, 6 s) refills by itself in 5 s off the trigger.
 * Flames glance off walls (and back at you), go round riot shields and burn off toxic gas.
 */
export const DRAGON: WeaponDef = {
  index: 18,
  id: 'dragon',
  name: 'Dragon',
  class: 'heavy',
  hands: 2,
  fireMode: 'auto',
  interval: 0.15,
  regen: { perSec: 8, delay: 0.5 },
  projectile: FLAME,
  damage: FLAME.damage,
  pellets: 1,
  hitImpulse: 0,
  headMul: 1,
  range: 6,
  falloffStart: 6,
  minDamageMul: 1,
  spread: { ...NO_SPREAD, base: 8 },
  mag: 40,
  reserve: 0,
  reload: 0,
  equip: 0.5,
  zoomMax: 2,
  meleeDamage: 40,
  recoilPushAir: 0, // streams don't kick
  recoilPushGround: 0,
  moveSpeedMul: 0.92,
  muzzleLength: 0.8,
};

export const weapons: readonly WeaponDef[] = [
  HAMMER,
  BUZZ,
  K47,
  BREACHER,
  WIDOW,
  MACHETE,
  HAWK50,
  RATTLER,
  HORNET,
  TRIDENT,
  BULLPUP,
  LONGBOW,
  SHREDDER,
  ARC,
  THUMPER,
  POPPER,
  RIPPER,
  PULSE,
  DRAGON,
];

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
  if (perShot <= 0) return { shots: Infinity, seconds: Infinity }; // the Pulse: it never kills
  const shots = Math.ceil(hp / perShot - 1e-9);
  // a burst gun fires its rounds burst.interval apart, bursts `interval` apart; a minigun spins up first
  const seconds = def.burst
    ? Math.floor((shots - 1) / def.burst.count) * def.interval + ((shots - 1) % def.burst.count) * def.burst.interval
    : (shots - 1) * def.interval;
  // a minigun spins up first, a charge weapon charges its first shot (the later ones wait out a reload anyway)
  return { shots, seconds: seconds + (def.spin ? def.spin.up : 0) + (def.charge ?? 0) };
}
