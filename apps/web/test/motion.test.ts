/** The motion system's script half (ui/motion.ts, docs/design/ui-motion-spec.md): its pure parts. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flipTransform, floodRadius, reduced, rollPlan, stagger, staggerIndex } from '../src/ui/motion';

afterEach(() => vi.unstubAllGlobals());

describe('motion helpers', () => {
  it('reduced(): the game\'s switch wins over the system preference both ways (the OS is only its default; audit 28 Oct)', () => {
    const doc = (on: boolean) => ({ documentElement: { classList: { contains: (c: string) => on && c === 'reduce-motion' } } }) as unknown as Document;
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(reduced(doc(true))).toBe(true);
    expect(reduced(doc(false))).toBe(false);
    // the system asks for less motion, but the player switched Reduce motion off in Settings
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q.includes('prefers-reduced-motion') }));
    expect(reduced(doc(false))).toBe(false);
    expect(reduced(doc(true))).toBe(true);
  });

  it('P3 stagger: the row index sets --i, capped at 10 so the last row lands within 300 ms', () => {
    expect([0, 3, 10, 25, -2, 2.7].map(staggerIndex)).toEqual([0, 3, 10, 10, 0, 2]);
    const set: [string, string][] = [];
    stagger({ style: { setProperty: (n, v) => set.push([n, v]) } }, 14);
    expect(set).toEqual([['--i', '10']]);
  });

  it('P2 shared element: the inverse transform puts the new box where the old one was', () => {
    expect(flipTransform({ left: 100, top: 50, width: 200, height: 100 }, { left: 300, top: 250, width: 400, height: 200 })).toBe('translate(-200px, -200px) scale(0.5, 0.5)');
    expect(flipTransform({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 0, height: 0 })).toBe('translate(0px, 0px) scale(1, 1)');
  });

  it('P4 roll: only the digits that changed roll, matched from the right', () => {
    expect(rollPlan('30', '29')).toEqual([
      { char: '2', changed: true },
      { char: '9', changed: true },
    ]);
    expect(rollPlan('12', '13').map((p) => p.changed)).toEqual([false, true]);
    expect(rollPlan('9', '10').map((p) => p.changed)).toEqual([true, true]);
    expect(rollPlan('1:05', '1:04').map((p) => p.changed)).toEqual([false, false, false, true]);
  });

  it('P6 flood: the circle reaches past the farthest corner', () => {
    expect(floodRadius(0, 0, 300, 400)).toBe(500);
    expect(floodRadius(150, 200, 300, 400)).toBe(250);
  });
});
