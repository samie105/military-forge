/**
 * The phone platform around a match (controls spec §4.9, item 9): the iOS edge-swipe guard, a back
 * gesture that pauses instead of leaving, and the screen kept awake while playing. Small and
 * browser-only; the parts with logic take their browser objects as arguments, for tests.
 */

/** How close to a physical left or right edge a touch starts an iOS edge swipe (px, [W5]). */
export const EDGE_BAND = 24;

/**
 * Does a touch at viewport x start in the band where iOS takes an edge swipe (back/forward)?
 * Viewport (client) coordinates are the physical screen's, turned page or not: the turn is a CSS
 * transform on the content, so the physical left and right edges are always x 0 and the width.
 */
export function inEdgeBand(x: number, width: number, band = EDGE_BAND): boolean {
  return x <= band || x >= width - band;
}

/** The phone can buzz (Android's Vibration API; iOS Safari has none, [W11]): haptic settings show only then. */
export function canVibrate(nav: Partial<Navigator> | undefined = typeof navigator === 'undefined' ? undefined : navigator): boolean {
  return !!nav && typeof nav.vibrate === 'function';
}

/** A refused wake lock isn't asked for again from taps for this long (ms). */
export const REFUSED_WAIT_MS = 5000;

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

/**
 * The screen stays on while a match is played (`navigator.wakeLock`, [W14]): asked for from a tap
 * (`want(true)` in a pointerdown), asked for again when the page comes back (the browser drops it
 * while hidden), let go when the match ends or the menus cover it.
 */
export class WakeLockKeeper {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private asking = false;
  /** when a request was last refused: taps don't ask again for REFUSED_WAIT_MS (the page coming back does) */
  private refusedAt = -Infinity;

  constructor(private readonly lock: WakeLockLike | undefined = typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { wakeLock?: WakeLockLike }).wakeLock) {}

  get held(): boolean {
    return !!this.sentinel && !this.sentinel.released;
  }

  /** On (from a tap, while playing) or off. */
  want(on: boolean): void {
    this.wanted = on;
    if (on) this.ask();
    else this.drop();
  }

  /** The page is visible again: the lock went with the hiding; ask again if still wanted. */
  visible(): void {
    this.refusedAt = -Infinity;
    if (this.wanted) this.ask();
  }

  private ask(now = Date.now()): void {
    if (!this.lock || this.held || this.asking || now - this.refusedAt < REFUSED_WAIT_MS) return;
    this.asking = true;
    this.lock.request('screen').then(
      (s) => {
        this.asking = false;
        if (this.wanted) this.sentinel = s;
        else void s.release().catch(() => {});
      },
      () => {
        // refused (not visible, battery saver, no permission): play goes on, the screen may dim
        this.asking = false;
        this.refusedAt = Date.now();
      },
    );
  }

  private drop(): void {
    const s = this.sentinel;
    this.sentinel = null;
    if (s && !s.released) void s.release().catch(() => {});
  }
}

interface CloseWatcherLike {
  onclose: ((e: Event) => void) | null;
  destroy(): void;
}
type CloseWatcherCtor = new () => CloseWatcherLike;

/**
 * A back gesture (Android's back button or swipe) opens the pause menu instead of leaving the page,
 * via a CloseWatcher ([W16]; Chrome 120+). A watcher answers one back and is used up, so `arm()` makes
 * a new one each time play resumes. Where there is no CloseWatcher (iOS, older browsers) nothing is
 * armed; a history sentinel would fight the shell's own routes, so it isn't used.
 */
export class BackToPause {
  private watcher: CloseWatcherLike | null = null;

  constructor(
    private readonly onBack: () => void,
    private readonly Ctor: CloseWatcherCtor | undefined = typeof window === 'undefined' ? undefined : (window as Window & { CloseWatcher?: CloseWatcherCtor }).CloseWatcher,
  ) {}

  get armed(): boolean {
    return this.watcher !== null;
  }

  /** In play: a back pauses. Out of play: the browser's back is the browser's again. */
  arm(on: boolean): void {
    if (!on) {
      this.watcher?.destroy();
      this.watcher = null;
      return;
    }
    if (this.watcher || !this.Ctor) return;
    try {
      const w = new this.Ctor();
      w.onclose = () => {
        this.watcher = null;
        this.onBack();
      };
      this.watcher = w;
    } catch {
      /* no user activation yet, or refused: armed again at the next chance */
    }
  }
}
