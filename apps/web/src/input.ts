/**
 * Keyboard + mouse → Input, sampled exactly once per sim tick (docs/02 §3). The aim angle is
 * quantised to u16 before it enters the sim, so Math.atan2 here can't cause desyncs.
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
  KeyE: Btn.Interact,
  KeyV: Btn.Melee,
};

/** Keys whose browser default (scrolling, focus moves) must not fire during play. */
const PREVENT_DEFAULT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);

export class InputSampler {
  private readonly keys = new Set<string>();
  private mouseButtons = 0;
  /** screen-space mouse position (CSS pixels) */
  mouseX = 0;
  mouseY = 0;
  private wheelSteps = 0;
  private readonly pressedOnce = new Set<string>();

  constructor(private readonly target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
      if (!e.repeat) this.pressedOnce.add(e.code);
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
      this.mouseButtons |= 1 << e.button;
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => (this.mouseButtons &= ~(1 << e.button)));
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

  releaseAll(): void {
    this.keys.clear();
    this.mouseButtons = 0;
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
    let buttons = 0;
    for (const code of this.keys) buttons |= KEY_BINDINGS[code] ?? 0;
    if (this.mouseButtons & 1) buttons |= Btn.Fire;
    if (this.mouseButtons & 4) buttons |= Btn.Fire2;
    const m = this.mouseWorld(camera);
    out.buttons = buttons;
    out.aim = angleToU16(Math.atan2(m.y - sy, m.x - sx));
    out.weaponSelect = this.keys.has('Digit1') ? 1 : this.keys.has('Digit2') ? 2 : 0;
    out.throwStrength = 7;
    return out;
  }

  get hasFocus(): boolean {
    return document.hasFocus() && !document.hidden && this.target.isConnected;
  }
}
