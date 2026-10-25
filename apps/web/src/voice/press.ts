/**
 * The radio's one finger (the owner, 24 Oct: one voice control, not a mic in every corner): what a
 * press on it means, apart from the DOM so it's unit-tested.
 * - Hold (HOLD_MS or longer): push to talk while held; slide down LOCK_PX onto the lock: hands-free.
 * - A quick tap: the comms sheet (how you talk, volume, who's here, mutes).
 * - Locked: any press stops it (and opens nothing).
 * - Open mic, or a mic the browser blocked: every press is a tap (the sheet).
 * A tap opens the sheet on the click that follows the lift (else that click lands on the sheet's own
 * scrim or close button, which open under the finger, and shuts it again), or after CLICK_WAIT_MS
 * when no click comes.
 */
import type { VoiceChat } from './voice';

/** A press shorter than this is a tap (the sheet); longer, it talks. Talk starts when it's reached. */
export const HOLD_MS = 200;
/** How far down (CSS px) the finger slides to lock the radio on. */
export const LOCK_PX = 44;
/** A tap's click normally follows its lift at once; past this, the sheet opens without it. */
export const CLICK_WAIT_MS = 350;
/** A long press on a voice's chip mutes that player. */
export const MUTE_HOLD_MS = 500;

type Talker = Pick<VoiceChat, 'touchDown' | 'touchUp' | 'lock' | 'warmMic'>;

export interface PressClock {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realClock: PressClock = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class RadioPress {
  private mode: 'idle' | 'pending' | 'talking' | 'locked' | 'unlocking' | 'tap' = 'idle';
  private timer: unknown = null;
  private tapTimer: unknown = null;
  private y0 = 0;
  /** when the finger landed (the event's clock: a busy page runs its timers late, not its input) */
  private t0 = 0;

  constructor(
    private readonly chat: Talker,
    private readonly openSheet: () => void,
    private readonly clock: PressClock = realClock,
  ) {}

  /** The finger landed. `locked`: the radio is on hands-free; `canTalk`: push to talk with a usable mic. */
  down(y: number, locked: boolean, canTalk: boolean, t = 0): void {
    this.cancelTimer();
    this.y0 = y;
    this.t0 = t;
    if (locked) {
      this.mode = 'unlocking';
      this.chat.touchDown();
      return;
    }
    if (!canTalk) {
      this.mode = 'tap';
      return;
    }
    this.chat.warmMic();
    this.mode = 'pending';
    this.timer = this.clock.set(() => {
      this.timer = null;
      if (this.mode !== 'pending') return;
      this.mode = 'talking';
      this.chat.touchDown();
    }, HOLD_MS);
  }

  /** The finger moved: returns how far along the slide to the lock is (0…1, for the lock's glow). */
  move(y: number): number {
    if (this.mode !== 'talking') return 0;
    const dy = y - this.y0;
    if (dy >= LOCK_PX) {
      this.mode = 'locked';
      this.chat.lock();
      return 1;
    }
    return Math.max(0, dy / LOCK_PX);
  }

  /**
   * The finger lifted (`t` on the events' clock). A press shorter than HOLD_MS is a tap even if a busy
   * page ran the hold's timer first: the talk that started stops, and the sheet opens.
   */
  up(t?: number): void {
    let was = this.mode;
    this.cancelTimer();
    this.mode = 'idle';
    if (was === 'talking' && t !== undefined && t - this.t0 < HOLD_MS) {
      this.chat.touchUp();
      was = 'tap';
    }
    if (was === 'pending' || was === 'tap') {
      this.tapTimer = this.clock.set(() => this.click(), CLICK_WAIT_MS);
    } else if (was === 'talking' || was === 'unlocking') this.chat.touchUp();
  }

  /** The browser took the touch (a scroll, a system gesture): stop talking, open nothing. */
  cancel(): void {
    const was = this.mode;
    this.cancelTimer();
    this.mode = 'idle';
    if (was === 'talking' || was === 'unlocking') this.chat.touchUp();
  }

  /** The click after a tap (or a keyboard's or a pad's click, which have no press): the sheet. */
  click(keyboard = false): void {
    if (this.tapTimer === null && !keyboard) return;
    if (this.tapTimer !== null) this.clock.clear(this.tapTimer);
    this.tapTimer = null;
    this.openSheet();
  }

  get talking(): boolean {
    return this.mode === 'talking';
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
  }
}

/** A long press on a voice's chip: `onMute` after MUTE_HOLD_MS unless the finger lifts first. */
export class LongPress {
  private timer: unknown = null;
  constructor(
    private readonly onDone: () => void,
    private readonly clock: PressClock = realClock,
    private readonly ms = MUTE_HOLD_MS,
  ) {}

  down(): void {
    this.up();
    this.timer = this.clock.set(() => {
      this.timer = null;
      this.onDone();
    }, this.ms);
  }

  up(): void {
    if (this.timer !== null) this.clock.clear(this.timer);
    this.timer = null;
  }
}
