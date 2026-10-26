/**
 * Browsers start audio only from a user gesture (and iOS Safari only once a sound has played
 * inside one). The unlocker makes the AudioContext on the first tap, click or key, plays one
 * silent sample in that same gesture, and from then on keeps it going:
 *
 * - every trusted gesture (pointer, touch, mouse, key; heard first, in the capture phase on the
 *   window, before anything else on the page can use the gesture up) resumes it if it isn't
 *   running. On a phone a finger landing is not a gesture to the browser, only its lift is, and
 *   the page's full-screen request on that same lift (ui/landscape.ts) uses the gesture up: the
 *   unlocker must be armed before it (main.ts arms it first thing);
 * - coming back to the page (visibilitychange, pageshow, focus) resumes it;
 * - the context's own state changes are watched: suspended or interrupted by the system (Android
 *   and iOS: a call, a notification, another app's audio) while the page is in view, it's resumed
 *   at once, and again on the next gesture if the browser wants one;
 * - a context that says "running" but whose clock has stopped (the phone's audio output didn't
 *   come up: silence until the tab was switched away and back, or the game paused) is restarted,
 *   suspend then resume, as switching away and back does.
 *
 * Every step goes to the device's log (diag), so a problem report from a phone says what the
 * sound was doing.
 */

export interface UnlockOptions {
  /** where gestures, pageshow and focus are heard (window) */
  target: EventTarget;
  /** where visibilitychange is heard (document; default: target) */
  doc?: EventTarget;
  /** makes the context (null: Web Audio isn't available) */
  create: () => AudioContext | null;
  /** the context exists and has been nudged within a gesture */
  onContext: (ctx: AudioContext) => void;
  /** the page is hidden (or the engine has faded out for it): don't resume behind the player's back */
  hidden?: () => boolean;
  /** the sound's health changed (running, starting, stalled…) */
  onHealth?: (health: AudioHealth) => void;
  /** one line for the device's log */
  log?: (line: string) => void;
  /** is this event the player's own (not a script's)? Default: `isTrusted` */
  trusted?: (e: Event) => boolean;
  /** wall clock, ms (tests drive it) */
  clock?: () => number;
  /** runs `fn` every `ms` until the returned stop (tests drive it) */
  every?: (fn: () => void, ms: number) => () => void;
}

/**
 * none: no context yet (no gesture yet); starting: made or resumed, not running yet (a phone's first
 * finger: until it lifts); running; suspended / interrupted: by the browser or the system, waiting
 * for a gesture or for the interruption to end; stalled: "running" but its clock doesn't move;
 * closed: gone for good.
 */
export type AudioHealth = 'none' | 'starting' | 'running' | 'suspended' | 'interrupted' | 'stalled' | 'closed';

export const GESTURES = ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'mousedown', 'keydown', 'click'] as const;
/** heard on the window: the page is back */
const RETURNS = ['pageshow', 'focus'] as const;

/** How often the clock is checked (ms), and how far behind the wall clock it may fall before it counts as stopped. */
export const WATCH_MS = 500;
const STALL_RATIO = 0.25;
/** this many checks in a row with a stopped clock: stalled */
const STALL_CHECKS = 2;
/** at most one restart this often (ms); a gesture may try again after GESTURE_HEAL_MS */
const HEAL_MS = 3000;
const GESTURE_HEAL_MS = 1000;

export interface Unlocker {
  readonly ctx: AudioContext | null;
  /** the context has been seen running */
  readonly unlocked: boolean;
  readonly health: AudioHealth;
  /** the page or a gesture asks for the sound now (also what the events call) */
  kick(reason: string, gesture?: boolean): void;
  /** one clock check (the watchdog's tick; tests call it) */
  check(): void;
  dispose(): void;
}

type CtxState = AudioContextState | 'interrupted';

export function createUnlocker(o: UnlockOptions): Unlocker {
  let ctx: AudioContext | null = null;
  let unlocked = false;
  let failed = false;
  let health: AudioHealth = 'none';
  let stalled = false;
  let stallChecks = 0;
  let lastWall = -1;
  let lastAudio = -1;
  let healAt = -Infinity;
  let healing = false;
  let stopWatch: (() => void) | null = null;
  let disposed = false;
  const clock = o.clock ?? (() => performance.now());
  const log = o.log ?? (() => {});
  const trusted = o.trusted ?? ((e: Event) => e.isTrusted);
  const hidden = () => o.hidden?.() === true;
  const every =
    o.every ??
    ((fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      return () => clearInterval(id);
    });
  const state = (): CtxState => (ctx?.state ?? 'suspended') as CtxState;

  const setHealth = (h: AudioHealth) => {
    if (h === health) return;
    health = h;
    log(`sound: ${h}${ctx ? ` (context ${state()}, ${ctx.currentTime.toFixed(2)} s)` : ''}`);
    o.onHealth?.(h);
  };
  const judge = () => {
    if (!ctx) return setHealth('none');
    const s = state();
    if (s === 'running') {
      unlocked = true;
      setHealth(stalled ? 'stalled' : 'running');
    } else if (s === 'closed') setHealth('closed');
    else if (s === 'interrupted') setHealth('interrupted');
    // made or resumed and waiting for the browser (a gesture it accepts): starting; later, suspended
    else setHealth(unlocked ? 'suspended' : 'starting');
  };

  const resume = (reason: string) => {
    if (!ctx) return;
    const c = ctx;
    let p: Promise<void> | undefined;
    try {
      p = c.resume();
    } catch (e) {
      log(`sound: resume (${reason}) threw: ${(e as Error)?.message ?? e}`);
      return;
    }
    void p?.then(
      () => judge(),
      (e: unknown) => log(`sound: resume (${reason}) refused: ${(e as Error)?.message ?? e}`),
    );
  };

  /** The output stopped while "running": restart it, as switching away and back does. */
  const heal = (reason: string, gap: number) => {
    if (!ctx || healing || hidden()) return;
    const now = clock();
    if (now - healAt < gap) return;
    healAt = now;
    healing = true;
    const c = ctx;
    log(`sound: restarting the output (${reason})`);
    const done = () => {
      healing = false;
      lastWall = -1;
      judge();
    };
    try {
      void c
        .suspend()
        .then(() => c.resume())
        .then(done, (e: unknown) => {
          log(`sound: restart refused: ${(e as Error)?.message ?? e}`);
          done();
        });
    } catch {
      done();
    }
  };

  const check = () => {
    if (!ctx || disposed) return;
    const s = state();
    if (s !== 'running' || hidden() || healing) {
      lastWall = -1;
      stallChecks = 0;
      if (s !== 'running' && stalled) {
        stalled = false;
        judge();
      }
      return;
    }
    const wall = clock();
    const audio = ctx.currentTime * 1000;
    if (lastWall >= 0) {
      const dWall = wall - lastWall;
      const dAudio = audio - lastAudio;
      if (dWall >= WATCH_MS * 0.6) {
        if (dAudio < dWall * STALL_RATIO) stallChecks++;
        else stallChecks = 0;
        if (stallChecks >= STALL_CHECKS && !stalled) {
          stalled = true;
          judge();
          heal('the clock stopped', HEAL_MS);
        } else if (stallChecks >= STALL_CHECKS) heal('still stopped', HEAL_MS);
        else if (stallChecks === 0 && stalled) {
          stalled = false;
          judge();
        }
      }
    }
    lastWall = wall;
    lastAudio = audio;
  };

  const kick = (reason: string, gesture = false) => {
    if (failed || disposed) return;
    if (!ctx) {
      // only a gesture makes it (made earlier, it would start suspended and warn)
      if (!gesture) return;
      try {
        ctx = o.create();
      } catch {
        ctx = null;
      }
      if (!ctx) {
        failed = true;
        log('sound: no Web Audio here');
        return;
      }
      const c = ctx;
      const onChange = () => {
        if (c !== ctx) return;
        judge();
        const s = state();
        // the system took it (a call, a notification, the output changing) while we're in view: ask
        // for it back now; if the browser wants a gesture, the next one does it
        if ((s === 'suspended' || s === 'interrupted') && unlocked && !hidden() && !healing) queueMicrotask(() => kick('statechange'));
      };
      if (typeof c.addEventListener === 'function') c.addEventListener('statechange', onChange);
      else c.onstatechange = onChange;
      playSilence(c);
      log(`sound: context made on ${reason} (${state()}, ${c.sampleRate} Hz)`);
      o.onContext(c);
      stopWatch = every(check, WATCH_MS);
    }
    const s = state();
    if (s === 'closed') return judge();
    if (hidden()) return judge();
    if (s === 'running') {
      if (gesture && stalled) heal(`a ${reason} on a stopped clock`, GESTURE_HEAL_MS);
      return judge();
    }
    // inside a gesture: the silent sample too (iOS counts a sound started in the gesture)
    if (gesture) playSilence(ctx);
    resume(reason);
    judge();
  };

  const onGesture = (e: Event) => {
    if (!trusted(e)) return;
    // keys held for modifiers alone aren't gestures to Safari
    if (e.type === 'keydown' && ['Shift', 'Control', 'Alt', 'Meta'].includes((e as KeyboardEvent).key)) return;
    kick(e.type, true);
  };
  const onReturn = (e: Event) => {
    lastWall = -1;
    kick(e.type);
  };
  const doc = o.doc ?? o.target;
  for (const g of GESTURES) o.target.addEventListener(g, onGesture, { capture: true, passive: true });
  for (const r of RETURNS) o.target.addEventListener(r, onReturn, { capture: true, passive: true });
  doc.addEventListener('visibilitychange', onReturn, { passive: true });
  return {
    get ctx() {
      return ctx;
    },
    get unlocked() {
      return unlocked;
    },
    get health() {
      return health;
    },
    kick,
    check,
    dispose() {
      disposed = true;
      stopWatch?.();
      for (const g of GESTURES) o.target.removeEventListener(g, onGesture, { capture: true });
      for (const r of RETURNS) o.target.removeEventListener(r, onReturn, { capture: true });
      doc.removeEventListener('visibilitychange', onReturn);
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
