import { movementTestMap } from '@military-forge/content';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../presets';
import { MOBILE_DPR_CAP } from '../../touch';
import { PlaneCamera, TOUCH_MIN_DPR, TOUCH_MIN_SCALE, create3d, pixelRatio, softwareGl } from '../index';

afterEach(() => vi.unstubAllGlobals());

describe('3D fallbacks (review M6)', () => {
  it('accepts software WebGL only for automated browsers or ?softgl', () => {
    vi.stubGlobal('navigator', { webdriver: false });
    expect(softwareGl(new URLSearchParams(''))).toBe(false);
    expect(softwareGl(new URLSearchParams('softgl'))).toBe(true);
    vi.stubGlobal('navigator', { webdriver: true });
    expect(softwareGl(new URLSearchParams(''))).toBe(true);
  });

  it('create3d gives null (main.ts then draws in 2D) when WebGL does not start', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const canvas = { getContext: () => null, addEventListener: () => {}, removeEventListener: () => {}, style: {} } as unknown as HTMLCanvasElement;
    expect(create3d(canvas, new PlaneCamera(), movementTestMap, PRESETS.low)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('pixel ratio (review L7)', () => {
  it("a phone's picture never drops under TOUCH_MIN_DPR (0.85 × 1.5), whatever the scale or the tier; never above the device", () => {
    expect(TOUCH_MIN_DPR).toBeCloseTo(0.85 * 1.5);
    // Low at its floor scale on a 3× phone: was 1.5 × 0.6 = 0.9 (2.7× upscaled), now 1.275
    expect(pixelRatio(3, PRESETS.low.touchDprCap, null, PRESETS.low.minScale, TOUCH_MIN_DPR)).toBeCloseTo(TOUCH_MIN_DPR);
    expect(pixelRatio(3, PRESETS.high.touchDprCap, null, 0.6, TOUCH_MIN_DPR)).toBeCloseTo(TOUCH_MIN_DPR);
    expect(pixelRatio(3, PRESETS.high.touchDprCap, null, 1, TOUCH_MIN_DPR)).toBe(2); // full: 2×, not 3×
    expect(pixelRatio(1, PRESETS.high.touchDprCap, null, 0.6, TOUCH_MIN_DPR)).toBe(1); // a 1× tablet keeps 1
    expect(pixelRatio(2, PRESETS.low.dprCap, null, 0.6)).toBeCloseTo(0.6); // desktop: no floor
    // the phone's scale floor: High and Medium keep 1.7×, Low 1.275×, on a 3× phone
    expect(pixelRatio(3, PRESETS.high.touchDprCap, null, TOUCH_MIN_SCALE, TOUCH_MIN_DPR)).toBeCloseTo(1.7);
    expect(pixelRatio(3, PRESETS.medium.touchDprCap, null, Math.max(PRESETS.medium.minScale, TOUCH_MIN_SCALE), TOUCH_MIN_DPR)).toBeCloseTo(1.7);
    expect(pixelRatio(3, PRESETS.low.touchDprCap, null, TOUCH_MIN_SCALE, TOUCH_MIN_DPR)).toBeCloseTo(1.275);
  });

  it('an override caps the preset, never raises it; a phone has its own caps (touchDprCap)', () => {
    expect(pixelRatio(3, 1, 1.5, 1)).toBe(1); // the lower cap wins
    expect(pixelRatio(3, 1.5, 1.5, 1)).toBe(1.5);
    expect(pixelRatio(2, 1.25, null, 0.8)).toBeCloseTo(1); // no override: the preset, then the dynamic scale
    expect(pixelRatio(1, 1.5, 1.5, 1)).toBe(1); // never above the device
    // High on a Retina desktop: the full 2×; a phone on High its full 3×; on a 1× screen, 1×
    expect(pixelRatio(2, PRESETS.high.dprCap, null, 1)).toBe(2);
    expect(pixelRatio(3, PRESETS.high.touchDprCap, null, 1)).toBe(2);
    expect(pixelRatio(3, PRESETS.low.touchDprCap, null, 1)).toBe(MOBILE_DPR_CAP); // Low on a phone: the old phone cap
    expect(pixelRatio(1, PRESETS.high.dprCap, null, 1)).toBe(1);
  });
});
