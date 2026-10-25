/**
 * Jet held for half a second without the player flying: the device's event log (log.ts) says what
 * stood in the way (the owner, 24 Oct: "sometimes someone can't fly as the game starts"): the fuel,
 * the ground, the jetpack switched off (an EMP), a dash, the countdown's freeze. Once in 10 s at most.
 */
import { Btn, type PlayerState } from '@military-forge/sim';
import { diag } from './log';

/** samples of jet held without flying before the log hears of it (half a second at 60 Hz) */
export const JET_WATCH_TICKS = 30;

export class JetWatch {
  private asked = 0;
  private notedAt = -Infinity;

  /** One sample: what was asked (`buttons`), the player before it, and why it might not fly. Returns the line logged, if any. */
  step(me: PlayerState | null | undefined, buttons: number, now: number, context: () => string): string | null {
    if (!me?.alive || !(buttons & Btn.Jet) || me.jetting) {
      this.asked = 0;
      return null;
    }
    if (++this.asked !== JET_WATCH_TICKS || now - this.notedAt < 10_000) return null;
    this.notedAt = now;
    const line = `jet held 0.5 s, not flying: fuel ${Math.round(me.fuel)}, ${me.grounded ? 'on the ground' : 'in the air'}, jet off ${me.jetDisabledTicks} ticks, dash ${me.dashTicks} ticks, ${context()}`;
    diag('input', line);
    return line;
  }
}
