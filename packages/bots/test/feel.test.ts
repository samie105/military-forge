/**
 * Feel targets (NOTES §23): against a standing target at 12 m, a Normal bot lands 35–45% of its
 * automatic fire and takes about twice a human's time to kill (the human: perfect torso aim,
 * packages/sim/scripts/feel-lib.ts); Easy is worse and Hard better on both.
 */
import { weapons } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { measureWeapon } from '../../sim/scripts/feel-lib';
import { measureDuel } from './feelLib';

const humanTtk = (id: string, d: number) => measureWeapon(weapons.find((w) => w.id === id)!.index, d, false, {}, 20).ttk;

describe('feel: hit rate and time-to-kill against a standing target', () => {
  it('Normal at 12 m: 35–45% of automatic fire lands, and a kill takes about twice a human’s time', () => {
    for (const w of ['buzz', 'k47']) {
      const r = measureDuel('normal', w, 12, true, 30);
      expect(r.hitRate, w).toBeGreaterThanOrEqual(0.33);
      expect(r.hitRate, w).toBeLessThanOrEqual(0.47);
      const ratio = r.ttk / humanTtk(w, 12);
      expect(ratio, w).toBeGreaterThan(1.6);
      expect(ratio, w).toBeLessThan(2.6);
    }
  }, 60_000);

  it('Easy < Normal < Hard on hit rate, and the other way round on time-to-kill', () => {
    const [easy, normal, hard] = (['easy', 'normal', 'hard'] as const).map((l) => measureDuel(l, 'k47', 12, true, 30));
    expect(easy!.hitRate).toBeLessThan(normal!.hitRate);
    expect(normal!.hitRate).toBeLessThan(hard!.hitRate);
    expect(easy!.ttk).toBeGreaterThan(normal!.ttk);
    expect(normal!.ttk).toBeGreaterThan(hard!.ttk);
  }, 60_000);
});
