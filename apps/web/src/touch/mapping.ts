/**
 * Touch state → the same `Input` the keyboard produces (pure, unit-tested). The controller keeps the
 * state from pointer events; once per sim tick these turn it into buttons, an aim and a throw
 * strength, so the sim, prediction and the wire never know a phone was involved.
 */
import type { WeaponDef } from '@military-forge/content';
import { Btn } from '@military-forge/sim';
import type { FireMode } from './settings';
import { stickAngle, touchMoveButtons, zeroStick, type StickVector } from './stick';

export type { FireMode } from './settings';

/**
 * Hold-to-fire (Pull, §4.4) starts once the aim stick is pushed this far (27 px on a 66 px radius,
 * 4.5 mm) and stops below FIRE_OFF; inside that the stick only aims.
 */
export const FIRE_ON = 0.4;
export const FIRE_OFF = 0.3;
/** The aim follows the stick only while it's pushed this far: no wobble at the dead zone's rim, no swing as a thumb lands (§4.3). */
export const AIM_MIN = 0.15;

/** Auto: pushing the aim stick to its rim fires anyway (at mines, barrels, round a corner; §4.4). */
export const FIRE_RIM = 0.9;
/** Auto's timers (§4.5): the first shot after this long on target; firing carries on this long after it leaves (ms). */
export const AUTO_FIRE = { dwell: 100, linger: 150 } as const;

/**
 * The fire mode for the gun in hand (§4.4's per-weapon rule, Settings → Touch → "Precision weapons fire
 * on release"): in Auto and Pull, snipers and DMRs, charged guns and the launchers fire on release
 * (aiming then committing is the skill; a splash weapon mustn't fire itself at someone hugging you).
 * Fire button and Release need nothing: they already separate aiming from firing.
 */
export function effectiveFire(mode: FireMode, def: Pick<WeaponDef, 'class' | 'fireMode' | 'projectile'> | undefined, precisionRelease: boolean): FireMode {
  if (!def || !precisionRelease || (mode !== 'auto' && mode !== 'pull')) return mode;
  if (def.class === 'sniper' || def.class === 'dmr' || def.fireMode === 'charge' || (def.projectile && def.fireMode === 'semi')) return 'release';
  return mode;
}

/** How far Auto fires, as a share of the gun's range handed to the assist core's test (0.8 of it there): a shotgun only to 0.6 (§4.4). */
export function autoRange(def: Pick<WeaponDef, 'class' | 'range'> | undefined): number {
  if (!def) return 0;
  return def.class === 'shotgun' ? def.range * 0.75 : def.range;
}

/** Auto's trigger (§4.5): on target for AUTO_FIRE.dwell before the first shot, and on for AUTO_FIRE.linger after it leaves, so bursts don't stutter. */
export class AutoTrigger {
  private onSince: number | null = null;
  private lastOn = -Infinity;
  private firing = false;

  step(onTarget: boolean, now: number): boolean {
    if (onTarget) {
      this.onSince ??= now;
      this.lastOn = now;
      if (now - this.onSince >= AUTO_FIRE.dwell) this.firing = true;
    } else {
      this.onSince = null;
      if (now - this.lastOn > AUTO_FIRE.linger) this.firing = false;
    }
    return this.firing;
  }

  reset(): void {
    this.onSince = null;
    this.lastOn = -Infinity;
    this.firing = false;
  }
}

/**
 * Pull's fire line on a fixed aim stick (stick.ts AIM_FIXED): 0.57 of the push (36 px on a 66 px
 * stick, 6 mm) and off under 0.43 (30 px). Further out than the floating stick's 27 px: a thumb lands
 * on a fixed stick off its centre, and a small push there should only aim (the owner, 25 Oct). The
 * ring between 17 px (the aim follows) and 36 px is 3 mm wide, about a thumb's landing error.
 */
export const FIRE_FIXED = { on: 0.57, off: 0.43 } as const;

/** Pull's fire line with hysteresis: is the stick firing now, given whether it was? (`line`: FIRE_FIXED on a fixed stick) */
export function pullFires(push: number, was: boolean, line: { on: number; off: number } = { on: FIRE_ON, off: FIRE_OFF }): boolean {
  return was ? push >= line.off : push >= line.on;
}

/**
 * A fixed aim stick whose thumb lands past the fire line (Pull's, or Auto's rim) aims at once but holds
 * its fire until the landing has settled: 80 ms down, and not still heading in toward the centre faster
 * than 0.15 px/ms (a thumb that landed on the wrong side and is dragging across: once it passes the
 * centre it heads out again), or 200 ms down whatever it does. A thumb that lands inside the line fires
 * as soon as a drag takes it past: the drag says which way. 80 ms (five sim ticks) is about the time a
 * thumb takes to land and start a swing across (the swing itself, 100 px, takes another 100–150 ms,
 * which the heading-in test covers); a thumb landing where it means to waits only those five ticks. A
 * resting thumb's wobble is under 0.05 px/ms, so it never holds the fire. Release fires on a lift only
 * after 80 ms down (a brush of the stick isn't a shot).
 */
export const LAND_ARM = { ms: 80, maxMs: 200, inPxPerMs: 0.15 } as const;

/** Has a fixed aim stick's landing settled (LAND_ARM), `ageMs` after the thumb landed, moving in toward the centre at `inSpeed` px/ms? */
export function landSettled(ageMs: number, inSpeed: number): boolean {
  return ageMs >= LAND_ARM.maxMs || (ageMs >= LAND_ARM.ms && inSpeed < LAND_ARM.inPxPerMs);
}

/** The move stick's buttons now, from its reading and the last ones (thresholds with hysteresis, stick.ts). */
export function updateMove(s: TouchState, stickJet = true): number {
  s.moveBits = s.moveActive ? touchMoveButtons(s.move, s.moveBits) : 0;
  // Claw: the stick doesn't jet (JET is the left index finger's); pushed up, it only walks
  if (!stickJet) s.moveBits &= ~Btn.Jet;
  return s.moveBits;
}

export interface TouchState {
  move: StickVector;
  moveActive: boolean;
  /** the move stick's buttons (Left/Right/Jet/Down), kept between readings for the thresholds' hysteresis */
  moveBits: number;
  aim: StickVector;
  aimActive: boolean;
  /** the aim stick past Pull's fire line (FIRE_ON, held down to FIRE_OFF; FIRE_FIXED on a fixed stick) */
  aimFire: boolean;
  /** the aim stick may fire (Pull, Auto's rim): false while a fixed stick's landing settles (LAND_ARM) */
  aimArmed: boolean;
  /** Auto's trigger this sample (AutoTrigger: an enemy under the aim) */
  autoFiring: boolean;
  /** Release with a charged gun: the trigger held while the aim stick is pushed (a lift lets go, the charge fires when full) */
  chargeHold: boolean;
  /** buttons held down right now (bits) */
  held: number;
  /** presses since the last sample (bits): taps shorter than a tick, swipe dashes, release-to-fire */
  pulses: number;
  /** direction buttons a pulsed dash goes with (the move stick when it was pressed or swiped) */
  dashDir: number;
  /** the pulsed dash's strength 0–7 (Input.dashStrength, v14): the stick's push and how fast it got there */
  dashStrength: number;
  /**
   * the grenade button is held (the throw latch, input.ts): a tap is a quick throw at 70 %; a hold
   * shows the arc, aimed with the right stick (or the button's own drag), whose push sets the
   * strength; lifting throws
   */
  grenadeActive: boolean;
  grenade: StickVector;
}

export function createTouchState(): TouchState {
  return { move: zeroStick(), moveActive: false, moveBits: 0, aim: zeroStick(), aimActive: false, aimFire: false, aimArmed: true, autoFiring: false, chargeHold: false, held: 0, pulses: 0, dashDir: 0, dashStrength: 7, grenadeActive: false, grenade: zeroStick() };
}

/**
 * The buttons this sample: held buttons and pulses, movement from the left stick, fire per mode (the
 * mode for the gun in hand: effectiveFire). Fire button mode's FIRE is a held button (s.held);
 * Release's shot is a pulse on the lift.
 */
export function touchButtons(s: TouchState, fire: FireMode): number {
  let b = s.held | s.pulses;
  if (s.moveActive) b |= s.moveBits;
  // aiming a throw with the right stick doesn't fire the gun; the grenade itself goes through the
  // throw latch on release, never held (the sim would throw on the finger going down)
  if (!s.grenadeActive) {
    if (fire === 'pull' && s.aimActive && s.aimArmed && s.aimFire) b |= Btn.Fire;
    if (fire === 'auto' && (s.autoFiring || (s.aimActive && s.aimArmed && s.aim.mag >= FIRE_RIM))) b |= Btn.Fire;
    if (fire === 'release' && s.chargeHold) b |= Btn.Fire;
  }
  // a dash goes the way the stick pointed when it was asked for, even if the thumb has moved on
  if (s.pulses & Btn.Dash) b = (b & ~(Btn.Left | Btn.Right | Btn.Jet | Btn.Down)) | s.dashDir;
  return b;
}

/**
 * A dash's strength 0–7 (Input.dashStrength) from the move stick (the owner, 19 Oct: "it depends on
 * how fast the players are moving their joystick"): how far it's pushed, and how fast it got there.
 * A flick reaching its push at `flickFull` deflections a second or faster counts in full; a slow
 * push counts for half; the stick left alone (the dash goes the way you face) is a full dash. The
 * sim turns 0–7 into dashMinStrength…1 of a full dash's speed and fuel.
 */
export function dashStrength(mag: number, rate: number, flickFull: number): number {
  if (!(mag > 0.05)) return 7;
  const quick = flickFull > 0 ? Math.min(1, Math.max(0, rate) / flickFull) : 1;
  return Math.round(Math.min(1, mag) * (0.5 + 0.5 * quick) * 7);
}

/** How fast a stick reached its peak push, in deflections a second (`startAt`, `peakAt` in ms). */
export function flickRate(peak: number, startAt: number, peakAt: number): number {
  return peak / Math.max(1 / 60, (peakAt - startAt) / 1000);
}

/** Throw strength 0–7 (70–100 %) from a stick's push. */
export function throwStrength(v: StickVector): number {
  return Math.round(Math.min(1, v.mag) * 7);
}

/** The strength a held grenade button throws with: the right stick's push when it's pushed, else the button's own drag. */
export function grenadeStrength(s: TouchState): number {
  return throwStrength(s.aimActive && s.aim.mag > 0 ? s.aim : s.grenade);
}

/** The aim the touch controls ask for this sample (radians), or null to keep the last one. */
export function desiredAim(s: TouchState): number | null {
  if (s.grenadeActive && s.grenade.mag > 0) return stickAngle(s.grenade);
  if (s.aimActive && s.aim.mag >= AIM_MIN) return stickAngle(s.aim);
  return null;
}

/** Touch magnetism needs the aim stick pushed this far (§4.5; a pad needs 0.50 of its raw push). */
export const TOUCH_PULL_MIN = 0.3;

/**
 * The push the aim assist core (input/assist.ts) gets this tick: the aim stick's own while it aims;
 * while Auto fires with the stick short of TOUCH_PULL_MIN (or let go), just enough for magnetism, so
 * the gun follows the enemy it's shooting (§4.5: "or while Auto is firing"); otherwise 0 (let go:
 * Strong's lock, nothing for the rest).
 */
export function assistPush(s: Pick<TouchState, 'aimActive' | 'aim' | 'autoFiring'>): number {
  const push = s.aimActive && s.aim.mag >= AIM_MIN ? s.aim.mag : 0;
  return s.autoFiring ? Math.max(push, TOUCH_PULL_MIN) : push;
}
