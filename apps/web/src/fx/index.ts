/**
 * Full-screen grenade effects for the local player (arsenal B), over both the 3D and the 2D view:
 * - flashbang: a white-out (sim blindness, through FlashLimiter: never more than one flash a
 *   second). With "Reduce flashes" on it is a dark-out instead: near-black and blurred, as opaque
 *   as the white (≥ 0.96 everywhere at full strength), so the setting is no advantage.
 * - toxic gas: a sickly green-yellow edge while you cough.
 * - a muffled-audio hook: `onMuffle` listeners get 0…1 (deafened by a flashbang) for a low-pass
 *   filter and ear ringing, once there is audio.
 *
 * Mount: call `fxFrame(frame, dt)` once per drawn frame (it mounts its overlay on the first call).
 * Settings (the UI agent's settings screen): `setReduceFlashes(on)`; the default follows
 * localStorage "mf.reduceFlashes", else the OS's prefers-reduced-motion.
 */
import type { Frame } from '../view';
import { FlashLimiter } from './flash';

export { FlashLimiter } from './flash';

const STORAGE_KEY = 'mf.reduceFlashes';
/** the Reduce-flashes dark-out at full strength is at least this opaque, edge to centre (review M6) */
export const DIM_CENTRE_ALPHA = 0.96;

export interface FxState {
  /** what the screen shows of the white-out (or its reduced stand-in), 0…1 */
  flash: number;
  /** the gas edge, 0…1 */
  gas: number;
  /** the muffled-audio amount last sent to listeners, 0…1 */
  muffle: number;
  reduceFlashes: boolean;
}

type MuffleListener = (amount: number) => void;

class Fx {
  readonly limiter = new FlashLimiter();
  reduceFlashes = defaultReduceFlashes();
  gas = 0;
  muffle = 0;
  readonly muffleListeners = new Set<MuffleListener>();
  private root: HTMLElement | null = null;
  private white: HTMLElement | null = null;
  private dim: HTMLElement | null = null;
  private tint: HTMLElement | null = null;

  frame(frame: Frame, dt: number, nowMs: number): void {
    const me = frame.players.find((p) => p.id === frame.localId);
    const blind = me?.alive ? (me.blind ?? 0) : 0;
    const shown = this.limiter.update(blind, nowMs, dt);
    // the gas edge eases in and out over ~0.3 s: a tint, never a flash
    const gasTarget = me?.alive && (me.gasTicks ?? 0) > 0 ? 1 : 0;
    const step = dt / 0.3;
    this.gas = Math.abs(gasTarget - this.gas) <= step ? gasTarget : this.gas + Math.sign(gasTarget - this.gas) * step;
    if (Math.abs(blind - this.muffle) > 1e-3 || (blind === 0 && this.muffle !== 0)) {
      this.muffle = blind;
      for (const l of this.muffleListeners) l(blind);
    }
    this.draw(shown);
  }

  private mount(): void {
    if (this.root || typeof document === 'undefined') return;
    const layer = (css: string) => {
      const el = document.createElement('div');
      el.style.cssText = `position:fixed;inset:0;pointer-events:none;opacity:0;${css}`;
      return el;
    };
    this.root = document.createElement('div');
    this.root.id = 'fx';
    this.root.style.cssText = 'position:fixed;inset:0;pointer-events:none';
    this.tint = layer('background:radial-gradient(ellipse at center, rgba(150,190,40,0) 45%, rgba(150,190,40,0.42) 100%)');
    this.dim = layer(`background:radial-gradient(ellipse at center, rgba(40,42,46,${DIM_CENTRE_ALPHA}) 0%, rgba(16,17,20,0.99) 75%);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)`);
    this.white = layer('background:#fff');
    this.root.append(this.tint, this.dim, this.white);
    // over the game canvases, under the debug bar, the panel and the shell
    const game = document.getElementById('game');
    if (game) game.after(this.root);
    else document.body.appendChild(this.root);
  }

  private draw(shown: number): void {
    if (!this.root && shown === 0 && this.gas === 0) return;
    this.mount();
    if (!this.white || !this.dim || !this.tint) return;
    this.white.style.opacity = this.reduceFlashes ? '0' : shown.toFixed(3);
    this.dim.style.opacity = this.reduceFlashes ? shown.toFixed(3) : '0';
    this.tint.style.opacity = this.gas.toFixed(3);
  }

  state(): FxState {
    return { flash: this.limiter.value, gas: this.gas, muffle: this.muffle, reduceFlashes: this.reduceFlashes };
  }
}

function defaultReduceFlashes(): boolean {
  try {
    const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (stored === '1' || stored === '0') return stored === '1';
  } catch {
    // storage blocked: fall through to the OS preference
  }
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const fx = new Fx();

/** Updates the full-screen effects from this frame (mounts the overlay on first use). */
export function fxFrame(frame: Frame, dt: number, nowMs = performance.now()): void {
  fx.frame(frame, dt, nowMs);
}

/** "Reduce flashes": a dark grey vignette and a blur instead of the white-out. Remembered. */
export function setReduceFlashes(on: boolean): void {
  fx.reduceFlashes = on;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, on ? '1' : '0');
  } catch {
    // not remembered: fine
  }
}

export function reduceFlashes(): boolean {
  return fx.reduceFlashes;
}

/** Muffled audio: `listener(0…1)` whenever the local player's deafness changes. Returns an unsubscribe. */
export function onMuffle(listener: MuffleListener): () => void {
  fx.muffleListeners.add(listener);
  return () => fx.muffleListeners.delete(listener);
}

/** What the effects show right now (tests, the dev hook). */
export function fxState(): FxState {
  return fx.state();
}
