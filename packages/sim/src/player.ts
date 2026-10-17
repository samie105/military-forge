import {
  CROUCHED_HITBOXES,
  DEFAULT_LOADOUT,
  FRAG,
  NO_WEAPON,
  STANDING_HITBOXES,
  type DummyScript,
  type HitboxLayout,
  type Tuning,
} from '@military-forge/content';
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
  script: DummyScript | null = null;
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
  frags = 0;
  throwCooldown = 0;
  shotCounter = 0;
  /** 0 = not swinging; else ticks since the melee swing started (lunge, windup, cooldown) */
  meleeTicks = 0;
  /** weapons given on respawn: [slot 0, slot 1] weapon indices */
  loadout: [number, number] = [DEFAULT_LOADOUT[0], DEFAULT_LOADOUT[1]];

  kills = 0;
  deaths = 0;
  lastAttacker = -1;
  lastAttackTick = -1;

  input: Input = createInput();
  prevButtons = 0;

  constructor(readonly id: number) {}

  height(t: Tuning): number {
    return this.crouched ? t.crouchHeight : t.standHeight;
  }

  shoulderY(t: Tuning): number {
    return this.y + (this.crouched ? t.shoulderCrouch : t.shoulderStand);
  }

  shoulderX(t: Tuning): number {
    return this.x + this.facing * t.shoulderForward;
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
    this.frags = FRAG.spawnCount;
    this.throwCooldown = 0;
    this.meleeTicks = 0;
    this.lastAttacker = -1;
    this.lastAttackTick = -1;
    this.prevButtons = 0;
  }
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
