/**
 * Browsers start audio only from a user gesture (and iOS Safari only once a sound has played
 * inside one). The unlocker makes the AudioContext on the first tap, click or key, plays one
 * silent sample in that same gesture, and resumes the context on any later gesture after the
 * system interrupted it (a call, Siri, another app's audio).
 */

export interface UnlockOptions {
  /** where gestures are heard (window) */
  target: EventTarget;
  /** makes the context (null: Web Audio isn't available) */
  create: () => AudioContext | null;
  /** the context exists and has been nudged within a gesture */
  onContext: (ctx: AudioContext) => void;
  /** the page is hidden: don't resume behind the player's back */
  hidden?: () => boolean;
}

export const GESTURES = ['pointerdown', 'pointerup', 'touchend', 'mousedown', 'keydown', 'click'] as const;

export interface Unlocker {
  readonly ctx: AudioContext | null;
  /** the context has been seen running */
  readonly unlocked: boolean;
  dispose(): void;
}

export function createUnlocker(o: UnlockOptions): Unlocker {
  let ctx: AudioContext | null = null;
  let unlocked = false;
  let failed = false;
  const handler = (e: Event) => {
    // keys held for modifiers alone aren't gestures to Safari
    if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes((e as KeyboardEvent).key)) return;
    if (failed) return;
    if (!ctx) {
      try {
        ctx = o.create();
      } catch {
        ctx = null;
      }
      if (!ctx) {
        failed = true;
        return;
      }
      playSilence(ctx);
      o.onContext(ctx);
    }
    if (ctx.state !== 'running' && ctx.state !== 'closed' && !o.hidden?.()) {
      playSilence(ctx);
      void ctx.resume().then(
        () => (unlocked ||= ctx!.state === 'running'),
        () => {},
      );
    } else if (ctx.state === 'running') unlocked = true;
  };
  for (const g of GESTURES) o.target.addEventListener(g, handler, { capture: true, passive: true });
  return {
    get ctx() {
      return ctx;
    },
    get unlocked() {
      return unlocked;
    },
    dispose() {
      for (const g of GESTURES) o.target.removeEventListener(g, handler, { capture: true });
    },
  };
}

/** One silent sample, started now: what iOS needs to let the context make sound. */
export function playSilence(ctx: AudioContext): void {
  try {
    const b = ctx.createBuffer(1, 1, Math.max(22050, ctx.sampleRate || 44100));
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start(0);
  } catch {
    /* nothing to unlock with */
  }
}

/** The browser's AudioContext (webkit's on old Safari), or null. */
export function makeAudioContext(): AudioContext | null {
  const w = globalThis as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const C = w.AudioContext ?? w.webkitAudioContext;
  if (!C) return null;
  try {
    return new C({ latencyHint: 'interactive' });
  } catch {
    return new C();
  }
}
