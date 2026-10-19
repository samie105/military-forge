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
  /** beyond this many ticks from the target band for resyncAfterMs, jump instead of nudging */
  resyncTicks: number;
  /**
   * How long the health must stay beyond resyncTicks before a jump. A latency spike (a phone's
   * upload queue filling) pushes it far off for a second or two and then gives it back: jumping
   * through one gains nothing (the inputs sent after the jump wait in the same queue) and costs a
   * lurch, then a freeze when the spike drains. A clock that really moved stays off.
   */
  resyncAfterMs: number;
  /** this far behind, jump at once (a tab that slept, a clock that jumped) */
  hardResyncTicks: number;
  /** this far ahead, jump back at once: the server holds 48 ticks at most (MAX_INPUT_LEAD) */
  hardAheadTicks: number;
  /** a slow-down needs the health to stay above `high` for this long (ms): jitter makes dips */
  slowWindowMs: number;
  /**
   * The cushion (jitter buffer, docs/05 §4.2 "targetBuffer = 1.5 ticks + 2 × jitter"): when inputs
   * arrive late, the band moves up by how late they were, at most this many ticks, so the next dip
   * of the same size is absorbed. 0 turns it off.
   */
  maxCushion: number;
  /** how fast the cushion shrinks back when the path calms down, ticks per second */
  cushionDecayPerSec: number;
  /** below the band the client speeds up by `dilation` plus this per tick short, up to maxBoost */
  boostPerTick: number;
  maxBoost: number;
}

/**
 * 19 Oct 2026, the owner's mobile path (500 ms median, spikes to 1.3 s): a fixed 1–2 tick band and a
 * ±3 % nudge left the client starving through every latency spike: the server repeated old inputs
 * for whole seconds (862 missed inputs/min), shots and dashes were lost, and the hard resyncs
 * lurched. Now the band carries a cushion that remembers recent dips, and the client speeds up in
 * proportion to how far behind it is (scripts/netfeel.ts).
 */
export const DEFAULT_PACER: PacerOptions = { low: 1, high: 2, dilation: 0.03, resyncTicks: 8, resyncAfterMs: 5000, hardResyncTicks: 120, hardAheadTicks: 30, slowWindowMs: 1000, maxCushion: 6, cushionDecayPerSec: 0.5, boostPerTick: 0, maxBoost: 0.03 };

/** Keeps the client 1–2 ticks (plus the cushion) ahead of when the server needs its inputs (docs/05 §4.3–4). */
export class InputPacer {
  /** multiply the client's tick rate by this */
  timeScale = 1;
  /** latest usable report, NaN before the first */
  health = Number.NaN;
  /** ticks the caller should jump: > 0 run ahead (fast-forward), < 0 fall back */
  pendingJump = 0;
  resyncs = 0;
  /** extra spare ticks the band asks for after recent late inputs (PacerOptions.maxCushion) */
  cushion = 0;
  private target = 1;
  private lastReportAt = Number.NaN;
  /** when the health last went beyond resyncTicks (NaN: it's within) */
  private offSince = Number.NaN;
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

  /** the band's bottom now: `low` plus the cushion */
  get low(): number {
    return this.options.low + this.cushion;
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
    // the cushion: peak-hold of how far below `low` reports have dipped, decaying slowly
    if (!Number.isNaN(this.lastReportAt)) this.cushion = Math.max(0, this.cushion - (o.cushionDecayPerSec * (nowMs - this.lastReportAt)) / 1000);
    this.lastReportAt = nowMs;
    // (not from a huge dip: a tab that slept says nothing about the path)
    const hard = health < o.low + this.cushion - o.hardResyncTicks || health > o.high + this.cushion + o.hardAheadTicks;
    if (o.maxCushion > 0 && health < o.low && !hard) this.cushion = Math.min(o.maxCushion, Math.max(this.cushion, o.low - health));
    const low = o.low + this.cushion;
    const high = o.high + this.cushion;
    this.health = health;
    const off = health < low - o.resyncTicks || health > high + o.resyncTicks;
    if (!off) this.offSince = Number.NaN;
    else if (Number.isNaN(this.offSince)) this.offSince = nowMs;
    if (off && (hard || nowMs - this.offSince >= o.resyncAfterMs)) {
      this.offSince = Number.NaN;
      // a lasting offset (a tab that slept, a clock that moved) taught the cushion nothing about the path
      this.cushion = 0;
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
    // starving now: react at once, harder the further behind
    if (health < low) this.target = 1 + Math.min(o.maxBoost, o.dilation + o.boostPerTick * (low - health));
    else if (windowFull && windowMin > high) this.target = 1 - o.dilation; // consistently too early
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
    // the cushion stays: it is what we learned about this path, not about the connection
    this.lastReportAt = Number.NaN;
    this.offSince = Number.NaN;
    this.timeScale = 1;
    this.target = 1;
    this.health = Number.NaN;
    this.pendingJump = 0;
    this.recent.length = 0;
    this.holdUntilSeen = -Infinity;
    this.holdDeadline = -Infinity;
  }
}
