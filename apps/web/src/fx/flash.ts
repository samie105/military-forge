/**
 * The flashbang white-out as shown on screen (photosensitivity guard). The sim says how blind the
 * local player is (PlayerView.blind, 0…1: full white, then a fade); this decides what the screen
 * shows, so that it never flashes more than once a second:
 * - a jump up is instant at most once per second (the first flash lands at once); any other rise
 *   ramps up over a second, which reads as a glow, not a flash, and never by an onset's worth in
 *   one frame, however long the frame (a hitch);
 * - the screen never clears faster than in half a second, so a weak flash can't strobe off.
 */

/** a rise bigger than this is a full-screen flash (smaller ones always ramp) */
export const FLASH_ONSET_JUMP = 0.2;
/** at most one flash onset per this many ms (WCAG 2.3: far below three per second) */
export const FLASH_MIN_INTERVAL_MS = 1000;
/** rate-limited rises, per second (a full rise takes a second) */
export const FLASH_RAMP_PER_S = 1;
/** the fastest the white-out may clear, per second */
export const FLASH_FALL_PER_S = 2;

export class FlashLimiter {
  /** what the screen shows, 0…1 */
  value = 0;
  /** onsets shown so far (tests, debugging) */
  onsets = 0;
  private lastOnsetMs = Number.NEGATIVE_INFINITY;

  /** Follows the sim's white-out `target` (0…1) at `nowMs`, `dtSec` after the previous frame. */
  update(target: number, nowMs: number, dtSec: number): number {
    const t = Math.max(0, Math.min(1, target));
    if (t > this.value) {
      if (t - this.value >= FLASH_ONSET_JUMP && nowMs - this.lastOnsetMs >= FLASH_MIN_INTERVAL_MS) {
        this.value = t;
        this.lastOnsetMs = nowMs;
        this.onsets++;
      } else this.value = Math.min(t, this.value + Math.min(FLASH_RAMP_PER_S * dtSec, FLASH_ONSET_JUMP * 0.9));
    } else {
      const v = this.value - FLASH_FALL_PER_S * dtSec;
      this.value = v - t < 1e-9 ? t : v; // no rounding residue: clear means 0
    }
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.lastOnsetMs = Number.NEGATIVE_INFINITY;
  }
}
