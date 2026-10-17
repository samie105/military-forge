/**
 * Fixed-rate tick loop with hrtime drift correction (docs/02 §3). Sleeps with setTimeout instead
 * of spinning (kind to laptops); wakes up to ~1 ms late, and catches up by running due ticks.
 */
export interface TickLoopStats {
  ticks: number;
  /** milliseconds spent inside onTick during the current window */
  busyMs: number;
  maxTickMs: number;
  /** ticks dropped because we fell more than maxCatchUp behind */
  dropped: number;
}

export function startTickLoop(rateHz: number, onTick: () => void, maxCatchUp = 5): { stop(): void; stats: TickLoopStats } {
  const tickNs = BigInt(Math.round(1e9 / rateHz));
  let next = process.hrtime.bigint() + tickNs;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const stats: TickLoopStats = { ticks: 0, busyMs: 0, maxTickMs: 0, dropped: 0 };

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
