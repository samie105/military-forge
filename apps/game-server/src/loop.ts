/**
 * Fixed-rate tick loop with hrtime drift correction (docs/02 §3). Sleeps with setTimeout instead
 * of spinning (kind to laptops); wakes up to ~1 ms late, and catches up by running due ticks.
 * Between ticks it can lend spare time to `onIdle` (the bots' nav graph builds): up to
 * IDLE_MAX_MS of a gap, never the last IDLE_MARGIN_MS before the next tick.
 */
export interface TickLoopStats {
  ticks: number;
  /** milliseconds spent inside onTick during the current window */
  busyMs: number;
  maxTickMs: number;
  /** ticks dropped because we fell more than maxCatchUp behind */
  dropped: number;
  /** milliseconds lent to onIdle during the current window */
  idleWorkMs: number;
}

/** the most of one gap between ticks lent to idle work (ms): I/O waits no longer than this */
export const IDLE_MAX_MS = 6;
/** idle work leaves this much of the gap before the next tick (ms): a step can run ~2.5 ms over */
export const IDLE_MARGIN_MS = 4;

export function startTickLoop(
  rateHz: number,
  onTick: () => void,
  maxCatchUp = 5,
  /** work for spare time: given a budget (ms), it stops near it; true while it has more */
  onIdle?: (budgetMs: number) => boolean,
): { stop(): void; stats: TickLoopStats } {
  const tickNs = BigInt(Math.round(1e9 / rateHz));
  let next = process.hrtime.bigint() + tickNs;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const stats: TickLoopStats = { ticks: 0, busyMs: 0, maxTickMs: 0, dropped: 0, idleWorkMs: 0 };

  const run = () => {
    if (stopped) return;
    let now = process.hrtime.bigint();
    let steps = 0;
    while (now >= next && steps < maxCatchUp) {
      const t0 = process.hrtime.bigint();
      onTick();
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      stats.ticks++;
      stats.busyMs += ms;
      if (ms > stats.maxTickMs) stats.maxTickMs = ms;
      next += tickNs;
      steps++;
      now = process.hrtime.bigint();
    }
    if (now - next > tickNs * BigInt(maxCatchUp)) {
      // hopelessly behind (process was paused): resync instead of fast-forwarding the world
      stats.dropped += Number((now - next) / tickNs);
      next = now + tickNs;
    }
    const spareMs = Number(next - now) / 1e6 - IDLE_MARGIN_MS;
    if (onIdle && spareMs > 0.5) {
      onIdle(Math.min(spareMs, IDLE_MAX_MS));
      const after = process.hrtime.bigint();
      stats.idleWorkMs += Number(after - now) / 1e6;
      now = after;
    }
    const waitMs = Number(next - now) / 1e6;
    timer = setTimeout(run, Math.max(0, waitMs - 0.5));
  };
  timer = setTimeout(run, 0);

  return {
    stats,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
