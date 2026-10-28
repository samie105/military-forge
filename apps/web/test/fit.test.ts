/** The screens' fit to the window (ui/fit.ts): the menus' readable floor on small laptops (review L4). */
import { describe, expect, it } from 'vitest';
import { menuFit, menuShape } from '../src/ui/fit';

describe('menuFit', () => {
  it('fills a 1920×1080 window or bigger as designed', () => {
    expect(menuFit(1920, 1080)).toEqual({ fit: 1, w: 1920, h: 1080 });
    expect(menuFit(2560, 1440).fit).toBeCloseTo(4 / 3, 6);
    expect(menuFit(1600, 900).fit).toBeCloseTo(1600 / 1920, 6); // 0.83: over the floor already
  });

  it('keeps the zoom at 0.8 on small laptops, the screens reflowing into 1600×900 or more', () => {
    const at720 = menuFit(1280, 720);
    expect(at720.fit).toBeCloseTo(0.8, 6); // 14 px text → 11.2 px, not 9.3
    expect([at720.w, at720.h]).toEqual([1600, 900]);
    const at768 = menuFit(1366, 768);
    expect(at768.fit).toBeCloseTo(0.8, 6);
    expect(at768.w).toBeGreaterThanOrEqual(1600);
    expect(at768.h).toBeGreaterThanOrEqual(900);
  });

  it('a phone still gets the whole screen, with at least 1600×900 design pixels', () => {
    const phone = menuFit(812, 375);
    expect(phone.h).toBeCloseTo(900, 6);
    expect(phone.w).toBeGreaterThanOrEqual(1600);
  });

  it('the short reflow starts below the full 1080 (1280×800 was 1600×1000: neither full height nor reflowed; audit 28 Oct)', () => {
    expect(menuShape(menuFit(1280, 800))).toEqual({ narrow: true, short: true });
    expect(menuShape(menuFit(900, 600))).toEqual({ narrow: true, short: true });
    expect(menuShape(menuFit(1440, 900))).toEqual({ narrow: false, short: false });
    expect(menuShape(menuFit(1920, 1080))).toEqual({ narrow: false, short: false });
    expect(menuShape(menuFit(1366, 768)).short).toBe(true);
  });
});
