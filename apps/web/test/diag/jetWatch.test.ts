/** Jet held without flying (diag/jetWatch.ts): the log hears of it after half a second, once in 10 s, with why it might be. */
import { Btn } from '@military-forge/sim';
import { afterEach, describe, expect, it } from 'vitest';
import { JET_WATCH_TICKS, JetWatch } from '../../src/diag/jetWatch';
import { clearDiag, diagEvents } from '../../src/diag/log';

const player = (over: Record<string, unknown> = {}) => ({ alive: true, jetting: false, fuel: 80, grounded: true, jetDisabledTicks: 0, dashTicks: 0, ...over }) as never;

afterEach(() => clearDiag());

describe('the jet watch', () => {
  it('logs jet held half a second without flying, with what stood in the way, once in 10 s', () => {
    const w = new JetWatch();
    let line: string | null = null;
    for (let i = 0; i < JET_WATCH_TICKS; i++) line = w.step(player({ jetDisabledTicks: 90 }), Btn.Jet, 1000, () => 'not frozen') ?? line;
    expect(line).toBe('jet held 0.5 s, not flying: fuel 80, on the ground, jet off 90 ticks, dash 0 ticks, not frozen');
    expect(diagEvents().filter((e) => e.k === 'input')).toHaveLength(1);
    for (let i = 0; i < JET_WATCH_TICKS * 2; i++) w.step(player(), Btn.Jet, 2000, () => '');
    expect(diagEvents().filter((e) => e.k === 'input')).toHaveLength(1);
  });

  it('says nothing while the player flies, lets go of jet, or is dead', () => {
    const w = new JetWatch();
    for (let i = 0; i < 100; i++) {
      w.step(player({ jetting: true }), Btn.Jet, 0, () => '');
      w.step(player(), 0, 0, () => '');
      w.step(player({ alive: false }), Btn.Jet, 0, () => '');
    }
    expect(diagEvents()).toHaveLength(0);
  });
});
