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
import { diag } from '../diag/log';
import type { AudioSettings, ShellState } from '../shell/store';
import type { Frame } from '../view';
import type { AudioEvent, FrameExtras } from './director';
import type { AudioEngine } from './engine';
import type { AudioRuntime } from './runtime';
import { createUnlocker, makeAudioContext, type AudioHealth, type Unlocker } from './unlock';

let runtime: AudioRuntime | null = null;
let settings: [AudioSettings, boolean] | null = null;
let unlocker: Unlocker | null = null;
/** the shell's store once startAudio has it (undefined: not yet; null: the page has none) */
let shellStore: StoreApi<ShellState> | null | undefined;
let started = false;
let mod: typeof import('./runtime') | null = null;
let loader: Promise<typeof import('./runtime')> | null = null;

const load = () =>
  (loader ??= import('./runtime').then(
    (m) => (mod = m),
    (e: unknown) => {
      // a failed fetch (a dropped connection) is tried again on the next gesture
      loader = null;
      diag('audio', `sound: the sound code didn't load: ${(e as Error)?.message ?? e}`);
      throw e;
    },
  ));

/** The runtime, once there are a context, its code and the shell's store. */
function build(): void {
  const ctx = unlocker?.ctx;
  if (runtime || !ctx || !mod || shellStore === undefined) return;
  runtime = new mod.AudioRuntime(ctx, shellStore);
  if (settings) runtime.applySettings(...settings);
  runtime.engine.setStalled(unlocker?.health === 'stalled');
  if (import.meta.env.DEV) Object.assign(window, { __audio: runtime, __unlock: unlocker });
}

function onHealth(h: AudioHealth): void {
  const e = runtime?.engine;
  if (!e) return;
  e.setStalled(h === 'stalled');
  if (h === 'running') e.wake();
}

/**
 * Starts listening for gestures, first of everything on the page (main.ts calls it before the
 * full-screen request and the touch controls arm theirs): a phone's finger lift is the gesture the
 * browser starts sound on, and the full-screen request on that same lift uses it up.
 */
export function armAudio(): void {
  if (unlocker || typeof window === 'undefined') return;
  unlocker = createUnlocker({
    target: window,
    doc: document,
    create: makeAudioContext,
    hidden: () => document.hidden || runtime?.engine.isHidden === true,
    log: (line) => diag('audio', line),
    onHealth,
    onContext: () => {
      if (mod) build();
      else void load().then(build, () => {});
    },
  });
  // a gesture after a failed load: try the code again
  const retry = () => {
    if (!mod && unlocker?.ctx) void load().then(build, () => {});
  };
  window.addEventListener('pointerup', retry, { capture: true, passive: true });
  window.addEventListener('keydown', retry, { capture: true, passive: true });
}

/** Starts the sound (once). `store`: the shell's, for interface cues and music. */
export function startAudio(store: StoreApi<ShellState> | null): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  shellStore = store;
  armAudio();
  // fetch the code early, quietly; nothing plays until a gesture. On a phone, not while the title
  // shows (its first seconds on 4G need the network for the game itself: mobile audit P1-17), and
  // never on the data saver: there the first tap fetches it. A page that opens straight into play
  // (a reload in a room) fetches it at once, so the first shot after the first tap is heard
  const nav = navigator as Navigator & { connection?: { saveData?: boolean } };
  const phone = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const idle = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  const soon = () => (idle ? idle(() => void load().then(build, () => {}), { timeout: 3000 }) : setTimeout(() => void load().then(build, () => {}), 1500));
  const titleUp = () => store?.getState().title === 'on';
  if (nav.connection?.saveData === true) {
    // nothing until the gesture (onContext)
  } else if (!phone || !titleUp()) soon();
  else if (store) {
    const off = store.subscribe(() => {
      if (titleUp()) return;
      off();
      soon();
    });
  }
  build();
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
  /** where the sound is (the problem report and the console) */
  health(): AudioHealth {
    return unlocker?.health ?? 'none';
  },
  /** Settings → Audio, and Accessibility's "Soften loud bursts" */
  applySettings(a: AudioSettings, softBursts: boolean): void {
    settings = [a, softBursts];
    runtime?.applySettings(a, softBursts);
  },
};
