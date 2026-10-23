/**
 * The tick loop lends spare time between ticks to idle work (the bots' nav graph builds), and its
 * report counts only time spent working: the live box logged "nav builds 2 ms between ticks"
 * every 10 s with nothing to build (23 Oct 2026).
 */
import { describe, expect, it } from 'vitest';
import { IDLE_MAX_MS, startTickLoop } from '../src/loop';

const run = (onIdle: (budgetMs: number) => boolean, ms = 300) =>
  new Promise<ReturnType<typeof startTickLoop>['stats']>((done) => {
    const loop = startTickLoop(60, () => {}, 5, onIdle);
    setTimeout(() => {
      loop.stop();
      done(loop.stats);
    }, ms);
  });

describe('the tick loop between ticks', () => {
  it('nothing to do: no time counted as idle work', async () => {
    let asked = 0;
    const stats = await run(() => (asked++, false));
    expect(asked).toBeGreaterThan(5);
    expect(stats.idleWorkMs).toBe(0);
  });

  it('work to do: given at most IDLE_MAX_MS a gap, and its time counted', async () => {
    const budgets: number[] = [];
    const stats = await run((budgetMs) => {
      budgets.push(budgetMs);
      const end = performance.now() + budgetMs;
      while (performance.now() < end);
      return true;
    });
    expect(budgets.length).toBeGreaterThan(5);
    expect(Math.max(...budgets)).toBeLessThanOrEqual(IDLE_MAX_MS);
    expect(stats.idleWorkMs).toBeGreaterThan(0);
  });
});
