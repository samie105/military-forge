/**
 * Keyboard + mouse → Input, sampled exactly once per sim tick (docs/02 §3). The aim angle is
 * quantised to u16 before it enters the sim, so Math.atan2 here can't cause desyncs.
 *
 * Bindings are data (`InputSampler.bindings`): the app's Controls settings rebind every action.
 */
import { angleToU16 } from '@military-forge/shared';
import { Btn, createInput, type Input } from '@military-forge/sim';
import type { Camera } from './camera';

const KEY_BINDINGS: Record<string, number> = {
  KeyA: Btn.Left,
  ArrowLeft: Btn.Left,
  KeyD: Btn.Right,
  ArrowRight: Btn.Right,
  KeyW: Btn.Jet,
  Space: Btn.Jet,
  ArrowUp: Btn.Jet,
  KeyS: Btn.Down,
  ArrowDown: Btn.Down,
  KeyR: Btn.Reload,
  KeyQ: Btn.Swap,
  KeyF: Btn.Dual,
  KeyG: Btn.Grenade,
  KeyT: Btn.CycleGrenade,
  KeyE: Btn.Interact,
  KeyV: Btn.Melee,
  ShiftLeft: Btn.Dash,
  ShiftRight: Btn.Dash,
  KeyX: Btn.Shield,
};

/** Two presses of the same direction within this many ms dash (when double-tap dash is on). */
export const DOUBLE_TAP_MS = 250;

/**
 * The directions a double-tap dash listens to: whatever is bound to left, right or down. Not
 * jet/up: tapping the jet key is how you feather the jetpack, so a double-tap there would fire
 * dashes mid-hover; dash up with Shift + W.
 */
const DOUBLE_TAP_BITS = Btn.Left | Btn.Right | Btn.Down;

/** The buttons that give a dash its direction (docs/02 §21). */
const DASH_DIRECTION_BITS = Btn.Left | Btn.Right | Btn.Jet | Btn.Down;

/** Hold-to-aim (docs/02 §14): the cursor this far from the shoulder (m) throws at 70 %, this far at 100 %. */
export const THROW_NEAR = 2;
export const THROW_FAR = 10;

/** The throw strength (0..7, the input's 3 bits) for the cursor `distance` m from the shoulder. */
export function throwStrengthAt(distance: number): number {
  return Math.round(Math.min(1, Math.max(0, (distance - THROW_NEAR) / (THROW_FAR - THROW_NEAR))) * 7);
}

/** A grenade key or button let go this soon after the press is a tap: a quick throw (ms). */
export const TAP_MS = 150;
/** A quick throw's strength: input 0 = 70 % (docs/02 §14). */
export const QUICK_THROW = 0;

/**
 * Grenade throws, the keyboard's (or a mouse button bound to it) and the touch button's alike
 * (docs/02 §14; the owner's decision of 18 Oct):
 * - a tap (let go within TAP_MS) is a quick throw at 70 % when it's released, with no arc;
 * - a hold shows the arc (`aim`: the strength the throw would go with) and throws on release, as
 *   strong as its aimer says: the cursor's distance, or the touch stick's push.
 * The throw goes in the first sample after the release, so a tap shorter than a tick still throws;
 * the sim never sees the key held, so nothing throws on the press.
 */
export class ThrowLatch {
  /** while a hold aims (past a tap): the strength (0..7) the throw would go with; −1 otherwise */
  aim = -1;
  /** when the last quick throw (a tap) was let go, ms (performance.now); −Infinity before any (the HUD's "Quick throw" stamp) */
  lastQuickAt = -Infinity;
  private downAt = -1;
  private strength = QUICK_THROW;
  private pending = -1;

  /** The key or button went down at `at` (ms, performance.now: the clock samples pass to aimWith). */
  press(at: number): void {
    if (this.downAt < 0) this.downAt = at;
  }

  /** It came up at `at`: the throw goes in the next sample (a quick one after a tap). */
  release(at: number): void {
    if (this.downAt < 0) return;
    const tap = at - this.downAt < TAP_MS;
    this.pending = tap ? QUICK_THROW : this.strength;
    if (tap) this.lastQuickAt = at;
    this.downAt = -1;
    this.aim = -1;
  }

  /** No throw and no arc: focus lost, the setting turned off, a finger dragged off the screen. */
  cancel(): void {
    this.downAt = -1;
    this.pending = -1;
    this.aim = -1;
  }

  /** a throw is being held (tap or aim) */
  get holding(): boolean {
    return this.downAt >= 0;
  }

  /** The strength a release now would throw with, at `now` (ms): the arc shows once past a tap. */
  aimWith(strength: number, now: number): void {
    this.strength = strength;
    this.aim = this.downAt >= 0 && now - this.downAt >= TAP_MS ? strength : -1;
  }

  /** Once per sample: a release since the last one throws now. */
  take(out: Input): void {
    if (this.pending < 0) return;
    out.buttons |= Btn.Grenade;
    out.throwStrength = this.pending;
    this.pending = -1;
  }
}

/** Input types that take typing (their keys are the field's); a checkbox, a range or a button doesn't. */
const TEXT_INPUTS = new Set(['', 'text', 'search', 'email', 'password', 'url', 'tel', 'number']);

/**
 * The key goes into a field being typed in: an editable text input or text area, or a select. A
 * read-only one (the tuning panel's "Copy values" box, focused for Ctrl+C) or a checkbox, slider or
 * button doesn't keep the game's keys from the game.
 */
export function typingInto(target: EventTarget | null): boolean {
  if (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement) return !target.readOnly;
  if (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement) return !target.readOnly && TEXT_INPUTS.has((target.type ?? '').toLowerCase());
  return typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement;
}

/** Keys whose browser default (scrolling, focus moves) must not fire during play. */
const PREVENT_DEFAULT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

/**
 * The menus have the keyboard: a key pressed on one of their controls (#shell), or any key while a
 * menu screen shows (Home, the lobby, results: the shell's .screen--menu, or a modal over the game).
 * Tab then moves focus and Space presses buttons, as on any page.
 */
function menusHaveKeys(target: EventTarget | null): boolean {
  if (typeof Element !== 'undefined' && target instanceof Element && target.closest('#shell') !== null) return true;
  return typeof document !== 'undefined' && typeof document.querySelector === 'function' && document.querySelector('#shell .screen--menu, #shell .mf-fit--modal') !== null;
}

/** What every key and mouse button does. */
export interface KeyBindings {
  /** KeyboardEvent.code → button bits */
  readonly keys: Readonly<Record<string, number>>;
  /** MouseEvent.button (0 left, 1 middle, 2 right, 3 back, 4 forward) → button bits */
  readonly mouse: Readonly<Record<number, number>>;
  /** KeyboardEvent.code → weapon slot (Input.weaponSelect) */
  readonly slots: Readonly<Record<string, number>>;
}

export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  keys: KEY_BINDINGS,
  mouse: { 0: Btn.Fire, 2: Btn.Fire2, 4: Btn.CycleGrenade }, // mouse 5 cycles grenades (docs/01 §4)
  slots: { Digit1: 1, Digit2: 2 },
};

export class InputSampler {
  private readonly keys = new Set<string>();
  private mouseButtons = 0;
  /**
   * Menus are up (the shell's overlays, routes): their keys are theirs, so Tab, Space and the
   * arrows keep the browser's meaning (keyboard navigation). main.ts's GameInput also zeroes the
   * gameplay buttons while it's set.
   */
  blocked = false;
  /** screen-space mouse position (CSS pixels) */
  mouseX = 0;
  mouseY = 0;
  private wheelSteps = 0;
  private readonly pressedOnce = new Set<string>();
  /** what each key and mouse button does (rebindable) */
  bindings: KeyBindings = DEFAULT_KEY_BINDINGS;
  /**
   * Dash (docs/02 §21) as an alternative binding: double-tap a direction (the held direction gives
   * the dash its way, as with Shift). On by default (the owner's call, 18 Oct); Settings → Controls
   * turns it off. The dash key with no direction held dashes the way the soldier faces (the sim).
   */
  doubleTapDash = true;
  /** a dash press seen since the last sample: a tap shorter than a tick still dashes */
  private dashLatched = false;
  /** the direction buttons held (or double-tapped) at that press, kept for its sample */
  private dashLatchedDir = 0;
  /** the direction bit of the last direction press (double taps) */
  private lastDirection = 0;
  private lastDirectionAt = -Infinity;
  /** grenade throws: tap for a quick throw, hold to aim with the arc (the touch button shares it) */
  readonly throwLatch = new ThrowLatch();
  private hold = true;

  /**
   * Hold-to-aim grenades, the default (docs/02 §14; the owner's decision of 18 Oct): a tap of the
   * grenade key is a quick throw at 70 %, a hold aims with the arc and throws on release. Off (a
   * setting): every press is a quick throw at once.
   */
  get holdToAim(): boolean {
    return this.hold;
  }

  set holdToAim(on: boolean) {
    this.hold = on;
    if (!on) this.throwLatch.cancel(); // no arc left behind
  }

  /** while a throw is being aimed: the strength it would go with, 0..7 (the arc); −1 otherwise */
  get throwAim(): number {
    return this.throwLatch.aim;
  }

  /** when the last quick throw (a tap of the grenade key or button) was let go, ms (performance.now) */
  get quickThrowAt(): number {
    return this.throwLatch.lastQuickAt;
  }

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (typingInto(e.target)) return;
      // during play these keys are the game's (no scrolling, no focus moves); in the menus they're the menus'
      if (PREVENT_DEFAULT.has(e.code) && !this.blocked && !menusHaveKeys(e.target)) e.preventDefault();
      if (!e.repeat) {
        this.pressedOnce.add(e.code);
        this.notePress(this.bindings.keys[e.code] ?? 0, e.timeStamp);
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      // letting go of the grenade key throws (the latch: a tap is a quick throw)
      if ((this.bindings.keys[e.code] ?? 0) & Btn.Grenade && this.keys.has(e.code)) this.throwLatch.release(performance.now());
      this.keys.delete(e.code);
    });
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    target.addEventListener('mousemove', (e) => {
      this.mouseX = e.offsetX;
      this.mouseY = e.offsetY;
    });
    target.addEventListener('mousedown', (e) => {
      this.notePress(this.bindings.mouse[e.button] ?? 0, e.timeStamp);
      this.mouseButtons |= 1 << e.button;
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => {
      // the back/forward side buttons (mouse 4 and 5: bindable, 5 cycles grenades by default)
      // navigate on release in Chrome: not when the press was ours
      if ((e.button === 3 || e.button === 4) && this.mouseButtons & (1 << e.button)) e.preventDefault();
      if ((this.bindings.mouse[e.button] ?? 0) & Btn.Grenade && this.mouseButtons & (1 << e.button)) this.throwLatch.release(performance.now());
      this.mouseButtons &= ~(1 << e.button);
    });
    target.addEventListener('contextmenu', (e) => e.preventDefault());
    target.addEventListener(
      'wheel',
      (e) => {
        this.wheelSteps += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  /** A fresh press of a key or mouse button doing `bits`: the dash latch and double-tap directions. */
  private notePress(bits: number, at: number): void {
    if (bits & Btn.Dash) this.latchDash(0);
    if (bits & Btn.Grenade) {
      // timed on the sample clock (performance.now), not the event's: the two always agree
      const now = performance.now();
      this.throwLatch.press(now);
      if (!this.hold) this.throwLatch.release(now); // quick throw on the press
    }
    const dir = bits & DOUBLE_TAP_BITS;
    if (!dir) return;
    if (this.doubleTapDash && dir === this.lastDirection && at - this.lastDirectionAt <= DOUBLE_TAP_MS) {
      this.latchDash(dir);
      this.lastDirection = 0;
    } else {
      this.lastDirection = dir;
      this.lastDirectionAt = at;
    }
  }

  /** Remembers a dash press and the direction held with it until the next sample. */
  private latchDash(extraDirection: number): void {
    let dir = extraDirection;
    for (const code of this.keys) dir |= (this.bindings.keys[code] ?? 0) & DASH_DIRECTION_BITS;
    for (let button = 0; button < 5; button++) {
      if (this.mouseButtons & (1 << button)) dir |= (this.bindings.mouse[button] ?? 0) & DASH_DIRECTION_BITS;
    }
    this.dashLatched = true;
    this.dashLatchedDir = dir;
  }

  /** Focus lost: nothing stays held, and no latched press fires later (hold-to-aim's throw latch too, when it lands). */
  releaseAll(): void {
    this.keys.clear();
    this.mouseButtons = 0;
    this.dashLatched = false;
    this.throwLatch.cancel(); // focus lost while aiming: no throw
  }

  /** One-shot key press since the last call (for UI toggles, not gameplay). */
  consumePress(code: string): boolean {
    const had = this.pressedOnce.has(code);
    this.pressedOnce.delete(code);
    return had;
  }

  clearPresses(): void {
    this.pressedOnce.clear();
  }

  consumeWheel(): number {
    const w = this.wheelSteps;
    this.wheelSteps = 0;
    return w;
  }

  mouseWorld(camera: Camera): { x: number; y: number } {
    return { x: camera.toWorldX(this.mouseX), y: camera.toWorldY(this.mouseY) };
  }

  /**
   * Samples one tick of input; aims from the shoulder at (sx, sy) toward the mouse. `now`: ms on the
   * event clock (performance.now), for the throw latch's tap time.
   */
  sample(camera: Camera, sx: number, sy: number, out: Input = createInput(), now = performance.now()): Input {
    const b = this.bindings;
    let buttons = 0;
    let slot = 0;
    for (const code of this.keys) {
      buttons |= b.keys[code] ?? 0;
      slot ||= b.slots[code] ?? 0;
    }
    for (let button = 0; button < 5; button++) if (this.mouseButtons & (1 << button)) buttons |= b.mouse[button] ?? 0;
    if (this.dashLatched) {
      // held for at least one sample (with the direction it was pressed with), so the sim sees the
      // press even for a tap shorter than a tick
      buttons |= Btn.Dash | this.dashLatchedDir;
      this.dashLatched = false;
    }
    const m = this.mouseWorld(camera);
    // the grenade key never reaches the sim held: the latch throws on its release (a tap: quick)
    buttons &= ~Btn.Grenade;
    const dx = m.x - sx;
    const dy = m.y - sy;
    this.throwLatch.aimWith(throwStrengthAt(Math.sqrt(dx * dx + dy * dy)), now);
    // the default throw strength; the latch writes a throw's own after this line, so nothing below
    // may write it again
    out.throwStrength = 7;
    out.buttons = buttons;
    out.aim = angleToU16(Math.atan2(dy, dx));
    out.weaponSelect = slot;
    this.throwLatch.take(out);
    return out;
  }

  get hasFocus(): boolean {
    return document.hasFocus() && !document.hidden && this.target.isConnected;
  }
}
