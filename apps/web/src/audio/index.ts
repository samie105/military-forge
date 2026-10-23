/**
 * The game's sound, from main.ts's side: a few hundred bytes in the boot chunk. The engine, the
 * sound bank, the director and the music (./runtime) load on their own once the page is idle, and
 * start on the player's first tap or key (browsers allow sound only after one). Until then calls
 * are dropped: there's nothing to hear yet.
 *
 * Everything it hears comes from the render side: events the renderer already gets, the drawn
 * frame, the shell's store. Nothing runs inside the 60 Hz sim.
 */
import type { StoreApi } from 'zustand/vanilla';
import type { AudioSettings, ShellState } from '../shell/store';
import type { Frame } from '../view';
import type { AudioEvent, FrameExtras } from './director';
import type { AudioEngine } from './engine';
import type { AudioRuntime } from './runtime';
import { createUnlocker, makeAudioContext } from './unlock';

let runtime: AudioRuntime | null = null;
let settings: [AudioSettings, boolean] | null = null;
let started = false;
let loader: Promise<typeof import('./runtime')> | null = null;

const load = () => (loader ??= import('./runtime'));

/** Starts listening for the first gesture (once). `store`: the shell's, for interface cues and music. */
export function startAudio(store: StoreApi<ShellState> | null): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  // fetch the code early, quietly; nothing plays until a gesture. Not on a phone or the data saver:
  // the runtime and the score are ~0.5 MB, which the title's first seconds on 4G need for the game
  // itself (mobile audit P1-17); there the first tap fetches it
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  const frugal = nav.connection?.saveData === true || (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches);
  const idle = (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
  if (frugal) {
    // nothing until the gesture (onContext below)
  } else if (idle) idle(() => void load());
  else setTimeout(() => void load(), 1500);
  createUnlocker({
    target: window,
    create: makeAudioContext,
    hidden: () => document.hidden,
    onContext: (ctx) => {
      void load().then(({ AudioRuntime }) => {
        runtime = new AudioRuntime(ctx, store);
        if (settings) runtime.applySettings(...settings);
        if (import.meta.env.DEV) Object.assign(window, { __audio: runtime });
      });
    },
  });
}

export const audio = {
  /** sim events (the renderer's), and online the server's off-screen SOUND events */
  onEvents(events: readonly AudioEvent[], localId: number): void {
    if (events.length) runtime?.onEvents(events, localId);
  },
  /** each drawn frame while a game runs; null in the menus */
  onFrame(frame: Frame | null, dt: number, extras: FrameExtras | null): void {
    runtime?.onFrame(frame, dt, extras);
  },
  /** a new game mode (or none): forget the last one's loops */
  reset(): void {
    runtime?.reset();
  },
  /** the running engine, null until the first tap starts the sound (voice chat plays through it) */
  engine(): AudioEngine | null {
    return runtime?.engine ?? null;
  },
  /** Settings → Audio, and Accessibility's "Soften loud bursts" */
  applySettings(a: AudioSettings, softBursts: boolean): void {
    settings = [a, softBursts];
    runtime?.applySettings(a, softBursts);
  },
};
