/**
 * The bot's hands: which gun suits the range, when to pull the trigger, reloading, swapping and
 * melee. Same buttons as a human, same rules: a semi-automatic needs a fresh press per shot (and a
 * human's finger isn't a metronome), automatics fire while held, in bursts at range so the bloom
 * settles, and a gun only fires once the aim is on the body. Never at a body its bullets can't
 * reach (its range, or what a map's fog leaves of it), and never with nothing in it.
 */
import { NO_WEAPON, heldTrigger, weapons, type WeaponDef } from '@military-forge/content';
import { Btn, type PlayerState } from '@military-forge/sim';
import { DEG2RAD, type Xoshiro128 } from '@military-forge/shared';
import { BODY_HALF_WIDTH } from './aim';
import type { BotLevel } from './levels';

/** Damage multiplier at a distance (docs/03 §7 falloff, as combat.ts applies it). */
export function falloffAt(def: WeaponDef, dist: number): number {
  if (dist <= def.falloffStart) return 1;
  const k = (dist - def.falloffStart) / (def.range - def.falloffStart);
  return 1 - (1 - def.minDamageMul) * (k > 1 ? 1 : k);
}

/** the bash reaches a body this close (m) */
export const BASH_REACH = 1.15;

/** a bot's typical aim error at the target (m), for judging guns */
const TYPICAL_AIM = 0.6;

/** How well a gun's class suits a distance (0…1): snipers far, shotguns close, the rest in between. */
function classFit(def: WeaponDef, dist: number): number {
  switch (def.class) {
    case 'sniper':
      return dist < 10 ? 0.4 : dist < 15 ? 0.7 : 1;
    case 'shotgun':
      return dist < 6 ? 1 : Math.max(0.3, 1 - (dist - 6) / 10);
    case 'smg':
      return dist < 12 ? 1 : Math.max(0.5, 1 - (dist - 12) / 16);
    case 'rifle':
    case 'dmr':
      return dist < 6 ? 0.8 : 1;
    case 'heavy':
      return dist < 14 ? 1 : 0.7;
    default:
      return 0.8;
  }
}

/**
 * What a gun is worth against a body at `dist`: damage per second × the share that lands with a
 * bot's aim (a pellet fan forgives aim, a single bullet doesn't) × how its class suits the range.
 * `used` is the weapon range a bullet uses up getting there: the metres, or on a map with damping
 * zones what they make of them (combat.ts bulletCost); falloff reads it, as combat.ts does.
 * 0 = useless (out of its reach, or a blade out of reach).
 */
export function weaponValue(def: WeaponDef, dist: number, used = dist): number {
  if (def.fireMode === 'melee') return dist <= def.range + 0.3 ? (def.meleeDamage / def.interval) * 2 : 0;
  if (used > def.range) return 0;
  const fan = Math.max(0.5, dist) * Math.max(0.05, def.spread.base * def.spread.moveMul) * DEG2RAD;
  let hit: number;
  if (def.pellets > 1) {
    // pellets on the body when the fan's centred, × the chance the fan reaches it at all
    hit = Math.min(1, BODY_HALF_WIDTH / Math.max(BODY_HALF_WIDTH, fan)) * Math.min(1, (fan + BODY_HALF_WIDTH) / (1.5 * TYPICAL_AIM));
  } else hit = Math.min(1, BODY_HALF_WIDTH / Math.sqrt(TYPICAL_AIM * TYPICAL_AIM + fan * fan));
  // a burst rifle fires burst.count rounds per interval
  return ((def.damage * def.pellets * (def.burst?.count ?? 1) * falloffAt(def, used)) / def.interval) * hit * classFit(def, dist);
}

/** Something to fire in slot `s`: a blade, or a gun with rounds in it or to reload. */
export function loaded(self: PlayerState, s: number): boolean {
  const slot = self.weapons[s]!;
  if (slot.def === NO_WEAPON) return false;
  return weapons[slot.def]!.fireMode === 'melee' || slot.mag + slot.reserve > 0;
}

/** Both hands empty of rounds: all that's left is the bash. */
export function dry(self: PlayerState): boolean {
  return !loaded(self, 0) && !loaded(self, 1);
}

export interface Trigger {
  /** the fight: who to shoot, how far, and whether the aim is on them */
  target: PlayerState | null;
  dist: number;
  /** weapon range a bullet uses up getting there (weaponValue) */
  used: number;
  onTarget: boolean;
  /** a fight is on (keep the gun loaded rather than topping it up) */
  fighting: boolean;
}

export class Gunner {
  private burstLeft = 0;
  private pause = 0;
  private extraDelay = 0;
  /** the swap or reload just asked for (wait for it to take) */
  private asked = 0;

  constructor(
    readonly level: BotLevel,
    private readonly rng: Xoshiro128,
  ) {}

  /**
   * The slot (0/1) whose gun does most at this distance (`used`: see weaponValue), sticking to the
   * one in hand unless it's clearly worse; −1 when neither does anything (dry, or out of reach).
   */
  bestSlot(self: PlayerState, dist: number, used = dist): number {
    let best = -1;
    let bestValue = 0;
    for (let s = 0; s < 2; s++) {
      if (!loaded(self, s)) continue;
      let v = weaponValue(weapons[self.weapons[s]!.def]!, dist, used);
      if (s === self.active) v *= 1.25; // a swap costs time: switch only for a clear gain
      if (v > bestValue) {
        bestValue = v;
        best = s;
      }
    }
    return best;
  }

  /** This tick's Fire / Reload / Melee buttons and weapon select, written into `out`. */
  step(self: PlayerState, trig: Trigger, out: { buttons: number; weaponSelect: number }): void {
    if (this.asked > 0) this.asked--;
    const slot = self.weapons[self.active]!;
    const def = slot.def === NO_WEAPON ? undefined : weapons[slot.def];
    const busy = self.swapTicks > 0 || slot.reloadTicks > 0;

    // the right gun for the range (and out of a dry one if the other is loaded)
    if (trig.target && !busy && this.asked === 0) {
      let want = this.bestSlot(self, trig.dist, trig.used);
      const other = self.weapons[self.active ^ 1]!;
      if (def && def.fireMode !== 'melee' && slot.mag === 0 && this.level.quickSwap && other.def !== NO_WEAPON && other.mag > 0) want = self.active ^ 1;
      if (want >= 0 && want !== self.active) {
        out.weaponSelect = want + 1;
        this.asked = 20;
        return;
      }
    }

    // melee: a body within reach gets the bash (or the Machete in hand)
    if (trig.target && trig.dist < BASH_REACH && self.meleeTicks === 0 && (self.prevButtons & Btn.Melee) === 0 && (!def || def.fireMode !== 'melee')) {
      out.buttons |= Btn.Melee;
      return;
    }

    if (!def) return;
    // top up between fights
    if (!trig.fighting && def.fireMode !== 'melee' && !busy && slot.reserve > 0 && slot.mag < def.mag * 0.6 && this.asked === 0) {
      if ((self.prevButtons & Btn.Reload) === 0) out.buttons |= Btn.Reload;
      this.asked = 10;
      return;
    }

    if (!trig.target || busy) {
      this.burstLeft = 0;
      return;
    }
    if (this.pause > 0) {
      this.pause--;
      return;
    }
    if (def.fireMode === 'melee') {
      if (trig.dist <= def.range + 0.2 && self.meleeTicks === 0 && (self.prevButtons & Btn.Fire) === 0) out.buttons |= Btn.Fire;
      return;
    }
    // a gun fires at a body its bullets reach, with something in it: never Fire held for nothing
    if (trig.used > def.range || slot.mag + slot.reserve === 0) {
      this.burstLeft = 0;
      return;
    }
    if (heldTrigger(def)) {
      // keep a burst going while the aim is close; start one only on target (a minigun spins up
      // while held, a beam fires while held, a burst rifle bursts while held)
      if (this.burstLeft <= 0 && !trig.onTarget) return;
      if (this.burstLeft <= 0) this.burstLeft = this.level.burst > 0 && trig.dist > 8 ? Math.round(this.level.burst * def.interval * 60) : 1 << 20;
      out.buttons |= Btn.Fire;
      if (--this.burstLeft <= 0 && this.level.burst > 0 && trig.dist > 8) this.pause = Math.round(this.level.burstPause * 60 * (0.7 + 0.6 * this.rng.nextFloat()));
      return;
    }
    // semi-auto: a fresh press per shot, when the gun is ready and the aim is on
    if (this.extraDelay > 0) {
      this.extraDelay--;
      return;
    }
    if (!trig.onTarget || slot.cooldown > 1e-6 || (self.prevButtons & Btn.Fire) !== 0) return;
    out.buttons |= Btn.Fire;
    this.extraDelay = this.rng.int(4 + Math.round(this.level.reaction * 10));
  }
}
