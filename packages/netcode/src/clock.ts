/**
 * Clock sync & tick alignment (docs/05 §4).
 *
 * The client tags each input with the server tick it is for and runs ahead of the server so the
 * input arrives just before that tick is simulated. Every snapshot reports `inputBufferHealth`:
 * how many spare ticks of this client's input were queued when the server needed one. The pacer
 * turns that into a ±3 % nudge of the client's tick rate ("time dilation"), or a hard resync when
 * the drift is large (tab asleep, clock jump).
 */
import { HEALTH_UNKNOWN } from '@military-forge/protocol';

/** RTT samples from PING/PONG (docs/05 §4.1): median for display, minimum as the floor. */
export class RttEstimator {
  private readonly samples: number[] = [];
  private sorted: number[] = [];

  constructor(private readonly capacity = 16) {}

  add(rttMs: number): void {
    if (!(rttMs >= 0) || !Number.isFinite(rttMs)) return;
    this.samples.push(rttMs);
    if (this.samples.length > this.capacity) this.samples.shift();
    this.sorted = [...this.samples].sort((a, b) => a - b);
  }

  get count(): number {
    return this.samples.length;
  }

  get median(): number {
    return this.sorted.length ? this.sorted[this.sorted.length >> 1]! : 0;
  }

  get min(): number {
    return this.sorted.length ? this.sorted[0]! : 0;
  }

  /** mean absolute deviation from the median: a robust jitter figure */
  get jitter(): number {
    if (this.sorted.length < 2) return 0;
    const m = this.median;
    let sum = 0;
    for (const s of this.samples) sum += Math.abs(s - m);
    return sum / this.samples.length;
  }
}

export interface PacerOptions {
  /** spare ticks we want queued on the server: speed up below `low`, slow down above `high` */
  low: number;
  high: number;
  /** maximum nudge (0.03 = ±3 %) */
  dilation: number;
  /** beyond this many ticks from the target band, jump instead of nudging */
  resyncTicks: number;
  /** a slow-down needs the health to stay above `high` for this long (ms): jitter makes dips */
  slowWindowMs: number;
}

export const DEFAULT_PACER: PacerOptions = { low: 1, high: 2, dilation: 0.03, resyncTicks: 8, slowWindowMs: 1000 };

/** Keeps the client 1–2 ticks ahead of when the server needs its inputs (docs/05 §4.3–4). */
export class InputPacer {
  /** multiply the client's tick rate by this */
  timeScale = 1;
  /** latest usable report, NaN before the first */
  health = Number.NaN;
  /** ticks the caller should jump: > 0 run ahead (fast-forward), < 0 fall back */
  pendingJump = 0;
  resyncs = 0;
  private target = 1;
  /**
   * After a jump, reports describe the old timeline until the server has seen an input sent after
   * it: ignore reports whose newest-seen tick (ack + health) is ≤ this.
   */
  private holdUntilSeen = -Infinity;
  /** give up waiting for a post-jump report after this (everything lost) */
  private holdDeadline = -Infinity;
  private readonly recent: { at: number; health: number }[] = [];
  readonly options: PacerOptions;

  constructor(options: Partial<PacerOptions> = {}) {
    this.options = { ...DEFAULT_PACER, ...options };
  }

  /**
   * Feed every snapshot's inputBufferHealth with the tick it was measured at (the snapshot's
   * ackInputTick): ack + health is the newest input tick the server had seen.
   */
  onReport(health: number, nowMs: number, ackTick: number): void {
    if (health === HEALTH_UNKNOWN) return;
    if (ackTick + health <= this.holdUntilSeen && nowMs < this.holdDeadline) return; // predates our jump
    this.holdUntilSeen = -Infinity;
    const o = this.options;
    this.health = health;
    if (health < o.low - o.resyncTicks || health > o.high + o.resyncTicks) {
      // far off: jump to the middle of the band; ignore everything until the jump is applied
      this.pendingJump += Math.round((o.low + o.high) / 2 - health);
      this.resyncs++;
      this.holdUntilSeen = Infinity;
      this.holdDeadline = nowMs + 2000;
      this.recent.length = 0;
      this.target = 1;
      this.timeScale = 1;
      return;
    }
    this.recent.push({ at: nowMs, health });
    while (this.recent.length > 0 && this.recent[0]!.at < nowMs - o.slowWindowMs) this.recent.shift();
    let windowMin = Infinity;
    for (const r of this.recent) windowMin = Math.min(windowMin, r.health);
    const windowFull = this.recent.length > 0 && this.recent[0]!.at <= nowMs - o.slowWindowMs * 0.8;
    if (health < o.low) this.target = 1 + o.dilation; // starving now: react at once
    else if (windowFull && windowMin > o.high) this.target = 1 - o.dilation; // consistently too early
    else this.target = 1;
  }

  /** Eases the time scale toward the target (~100 ms) and returns it. */
  update(dtSec: number): number {
    const k = Math.min(1, dtSec / 0.1);
    this.timeScale += (this.target - this.timeScale) * k;
    return this.timeScale;
  }

  /**
   * Returns and clears the pending hard-resync jump. The caller applies it, then reports the newest
   * input tick it has sent with jumpApplied().
   */
  takeJump(): number {
    const j = this.pendingJump;
    this.pendingJump = 0;
    return j;
  }

  /** Reports from before the server saw an input newer than `newestSentTick` are ignored. */
  jumpApplied(newestSentTick: number, nowMs: number): void {
    this.holdUntilSeen = newestSentTick;
    this.holdDeadline = nowMs + 2000;
  }

  reset(): void {
    this.timeScale = 1;
    this.target = 1;
    this.health = Number.NaN;
    this.pendingJump = 0;
    this.recent.length = 0;
    this.holdUntilSeen = -Infinity;
    this.holdDeadline = -Infinity;
  }
}
