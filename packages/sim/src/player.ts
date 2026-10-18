import {
  CROUCHED_HITBOXES,
  DEFAULT_LOADOUT,
  FRAG,
  GRENADE_TYPES,
  NO_WEAPON,
  RIOT_SHIELD,
  STANDING_HITBOXES,
  weapons,
  spawnGrenades,
  type DummyScript,
  type HitboxLayout,
  type Tuning,
} from '@military-forge/content';
import type { Brain } from './bots';
import { createInput, type Input } from './input';

export const MoveState = {
  Grounded: 0,
  Airborne: 1,
  Jetpacking: 2,
  Dead: 3,
} as const;

export interface WeaponSlot {
  /** index into `weapons`, NO_WEAPON when empty */
  def: number;
  mag: number;
  reserve: number;
  /** ticks until the next shot is allowed (fractional, decremented by 1 per tick) */
  cooldown: number;
  /** ticks left in the current reload, 0 when not reloading */
  reloadTicks: number;
  /** extra spread in degrees from sustained fire */
  bloom: number;
  ticksSinceShot: number;
}

export function createWeaponSlot(): WeaponSlot {
  return { def: NO_WEAPON, mag: 0, reserve: 0, cooldown: 0, reloadTicks: 0, bloom: 0, ticksSinceShot: 0 };
}

/**
 * Complete simulated state of one player. Everything here is either quantised at tick end or an
 * integer, so a snapshot can reproduce it exactly (docs/02 §15).
 */
export class PlayerState {
  name = '';
  isBot = false;
  /** scripted dummy (no brain) */
  script: DummyScript | null = null;
  /** a real bot's brain (packages/bots); null for humans and dummies */
  brain: Brain | null = null;
  botDir = 1;
  homeX = 0;
  homeY = 0;

  alive = false;
  respawnTicks = 0;

  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  /** last tick's feet height, for one-way platform rules */
  prevY = 0;

  grounded = false;
  groundNx = 0;
  groundNy = 1;
  groundFlags = 0;
  crouched = false;
  jetting = false;
  jetTicks = 0;
  fuel = 0;
  fuelRegenDelay = 0;
  downHeldTicks = 0;
  dropTicks = 0;
  facing: 1 | -1 = 1;
  /** radians, decoded from the u16 input so it is exactly reproducible */
  aim = 0;

  hp = 0;
  regenDelay = 0;

  weapons: [WeaponSlot, WeaponSlot] = [createWeaponSlot(), createWeaponSlot()];
  active = 0;
  dual = false;
  swapTicks = 0;
  /** grenades carried, by type (packages/content grenades); [FRAG.index] is the frag count */
  readonly grenadeCounts: number[] = new Array<number>(GRENADE_TYPES).fill(0);
  /** the type the grenade key throws (the cycle key moves it between types held) */
  grenadeType = 0;
  /** grenades given on respawn, by type (default: frag ×3) */
  grenadeLoadout: number[] = spawnGrenades();
  throwCooldown = 0;
  shotCounter = 0;
  /** 0 = not swinging; else ticks since the melee swing started (lunge, windup, cooldown) */
  meleeTicks = 0;
  /** dash (docs/02 §21): burst ticks left, 0 = not dashing */
  dashTicks = 0;
  /** 8-way direction of the current (or last) dash: 0 = right, counter-clockwise in 45° steps */
  dashDir = 0;
  /** ticks until the next dash is allowed */
  dashCooldown = 0;
  /** this airborne period's one air dash is spent (landing resets it) */
  airDashUsed = false;
  /** riot shield HP; 0 = no shield (shield.ts). The two fields below are 0/false without one */
  shieldHp = 0;
  /** slung on purpose with the shield key: it stays on the back until the key raises it again */
  shieldStowed = false;
  /** 0 = on the back; counts up while it comes up; SHIELD_RAISE_TICKS = up and blocking */
  shieldTicks = 0;
  /** weapons given on respawn: [slot 0, slot 1] weapon indices */
  loadout: [number, number] = [DEFAULT_LOADOUT[0], DEFAULT_LOADOUT[1]];

  // Status effects from grenades (grenades.ts, clouds.ts): ticks left, 0 = none. The local block
  // carries them (prediction counts them down exactly); the HUD and the bots read them.
  /** flashbang: ticks of blindness left; the last `blindFade` of them fade out (white before that) */
  blindTicks = 0;
  blindFade = 0;
  /** toxic gas: ticks left of the last gas pulse's after-effect (coughing, the green screen edge) */
  gasTicks = 0;
  /** EMP: ticks the jetpack stays dead */
  jetDisabledTicks = 0;

  kills = 0;
  deaths = 0;
  lastAttacker = -1;
  lastAttackTick = -1;

  input: Input = createInput();
  prevButtons = 0;

  constructor(readonly id: number) {}

  /** frag count (grenadeCounts[FRAG.index]), for the HUD and older code */
  get frags(): number {
    return this.grenadeCounts[FRAG.index]!;
  }

  set frags(n: number) {
    this.grenadeCounts[FRAG.index] = n;
  }

  height(t: Tuning): number {
    return this.crouched ? t.crouchHeight : t.standHeight;
  }

  shoulderY(t: Tuning): number {
    return this.y + (this.crouched ? t.shoulderCrouch : t.shoulderStand);
  }

  shoulderX(t: Tuning): number {
    return this.x + this.facing * t.shoulderForward;
  }

  /** Fills the belt from grenadeLoadout and selects the first type held (frag with the default loadout). */
  refillGrenades(): void {
    for (let i = 0; i < GRENADE_TYPES; i++) this.grenadeCounts[i] = this.grenadeLoadout[i] ?? 0;
    this.grenadeType = 0;
    while (this.grenadeType < GRENADE_TYPES - 1 && this.grenadeCounts[this.grenadeType] === 0) this.grenadeType++;
    if (this.grenadeCounts[this.grenadeType] === 0) this.grenadeType = 0;
  }

  /** Reset to a freshly spawned state at (x, y). */
  spawn(x: number, y: number, t: Tuning): void {
    this.alive = true;
    this.respawnTicks = 0;
    this.x = x;
    this.y = y;
    this.prevY = y;
    this.vx = 0;
    this.vy = 0;
    this.grounded = false;
    this.groundNx = 0;
    this.groundNy = 1;
    this.groundFlags = 0;
    this.crouched = false;
    this.jetting = false;
    this.jetTicks = 0;
    this.fuel = t.fuelMax;
    this.fuelRegenDelay = 0;
    this.downHeldTicks = 0;
    this.dropTicks = 0;
    this.hp = t.healthMax;
    this.regenDelay = 0;
    this.active = 0;
    this.dual = false;
    this.swapTicks = 0;
    this.refillGrenades();
    this.throwCooldown = 0;
    this.meleeTicks = 0;
    this.dashTicks = 0;
    this.dashDir = 0;
    this.dashCooldown = 0;
    this.airDashUsed = false;
    this.shieldHp = 0;
    this.shieldStowed = false;
    this.shieldTicks = 0;
    this.blindTicks = 0;
    this.blindFade = 0;
    this.gasTicks = 0;
    this.jetDisabledTicks = 0;
    this.lastAttacker = -1;
    this.lastAttackTick = -1;
    this.prevButtons = 0;
  }
}

/** Seconds to go from one gun to two (or back): also the cost of putting a dual pair away for the shield. */
export const DUAL_TOGGLE_TIME = 0.45;

/** Swapping weapons, or going in or out of dual, cancels reloads (docs/03 §9). */
export function cancelReloads(p: PlayerState): void {
  p.weapons[0].reloadTicks = 0;
  p.weapons[1].reloadTicks = 0;
}

/** Fills both slots with full ammo; NO_WEAPON (or an unknown index) leaves a slot empty. */
export function giveLoadout(p: PlayerState, defs: readonly { mag: number; reserve: number }[], loadout: readonly number[] = DEFAULT_LOADOUT): void {
  for (let i = 0; i < 2; i++) {
    const slot = p.weapons[i]!;
    const defIndex = loadout[i]!;
    const def = defs[defIndex];
    slot.def = def ? defIndex : NO_WEAPON;
    slot.mag = def ? def.mag : 0;
    slot.reserve = def ? def.reserve : 0;
    slot.cooldown = 0;
    slot.reloadTicks = 0;
    slot.bloom = 0;
    slot.ticksSinceShot = 999;
  }
}

export function hitboxLayout(p: PlayerState): HitboxLayout {
  return p.crouched ? CROUCHED_HITBOXES : STANDING_HITBOXES;
}

const slotSpeedMul = (slot: WeaponSlot) => weapons[slot.def]?.moveSpeedMul ?? 1;

/**
 * Weight (docs/03 §9): the held weapon's moveSpeedMul, the heaviest of a dual pair, or a riot
 * shield's when that is heavier (up or coming up it weighs moveSpeedMul, slung slungSpeedMul).
 */
export function heldSpeedMul(p: PlayerState): number {
  const held = p.dual ? Math.min(slotSpeedMul(p.weapons[0]), slotSpeedMul(p.weapons[1])) : slotSpeedMul(p.weapons[p.active]!);
  if (p.shieldHp <= 0) return held;
  return Math.min(held, p.shieldTicks > 0 ? RIOT_SHIELD.moveSpeedMul : RIOT_SHIELD.slungSpeedMul);
}

/**
 * A dash's exit (docs/02 §21): sideways speed back within the walk or air cap (× `speedMul`, the
 * weapon weight × the map's speed, and never above launchSpeedX, so a dash never turns into a
 * slow-bleeding launch), and at most dashExitUp upward. For a burst that ends and one cut short.
 */
export function capDashExit(p: PlayerState, t: Tuning, speedMul: number): void {
  const cap = Math.min(t.launchSpeedX, (p.grounded ? (p.crouched ? t.crouchMax : t.walkMax) : t.airMaxX) * speedMul);
  if (p.vx > cap) p.vx = cap;
  else if (p.vx < -cap) p.vx = -cap;
  if (p.vy > t.dashExitUp) p.vy = t.dashExitUp;
}

/**
 * A push (a bullet's hit impulse, melee, a blast) ends a dash on the spot: no invulnerability
 * frames. The burst's speed first drops to the exit caps, so the push starts from there instead of
 * from 14 m/s. `mapSpeedMul` is the map's moveSpeedMul where the player is (1 without mechanics).
 */
export function knockOutOfDash(p: PlayerState, t: Tuning, mapSpeedMul = 1): void {
  if (p.dashTicks === 0) return;
  p.dashTicks = 0;
  capDashExit(p, t, heldSpeedMul(p) * mapSpeedMul);
}
