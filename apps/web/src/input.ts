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

/** Keys whose browser default (scrolling, focus moves) must not fire during play. */
const PREVENT_DEFAULT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

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
  /** screen-space mouse position (CSS pixels) */
  mouseX = 0;
  mouseY = 0;
  private wheelSteps = 0;
  private readonly pressedOnce = new Set<string>();
  /** what each key and mouse button does (rebindable) */
  bindings: KeyBindings = DEFAULT_KEY_BINDINGS;
  /**
   * Dash (docs/02 §21) as an alternative binding: double-tap a direction (the held direction gives
   * the dash its way, as with Shift). Off by default; the settings screen turns it on.
   */
  doubleTapDash = false;
  /** a dash press seen since the last sample: a tap shorter than a tick still dashes */
  private dashLatched = false;
  /** the direction buttons held (or double-tapped) at that press, kept for its sample */
  private dashLatchedDir = 0;
  /** the direction bit of the last direction press (double taps) */
  private lastDirection = 0;
  private lastDirectionAt = -Infinity;

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return;
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
      if (!e.repeat) {
        this.pressedOnce.add(e.code);
        this.notePress(this.bindings.keys[e.code] ?? 0, e.timeStamp);
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
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

  /** Samples one tick of input; aims from the shoulder at (sx, sy) toward the mouse. */
  sample(camera: Camera, sx: number, sy: number, out: Input = createInput()): Input {
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
    // the quick throw's strength; render3d-b's hold-to-aim sets the aimed one after this line, so
    // nothing below may write it again
    out.throwStrength = 7;
    out.buttons = buttons;
    out.aim = angleToU16(Math.atan2(m.y - sy, m.x - sx));
    out.weaponSelect = slot;
    return out;
  }

  get hasFocus(): boolean {
    return document.hasFocus() && !document.hidden && this.target.isConnected;
  }
}
