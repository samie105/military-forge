import { movementTestMap } from '@military-forge/content';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRESETS } from '../presets';
import { MOBILE_DPR_CAP } from '../../touch';
import { PlaneCamera, create3d, pixelRatio, softwareGl } from '../index';

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
  it('an override caps the preset, never raises it; a phone has its own caps (touchDprCap)', () => {
    expect(pixelRatio(3, 1, 1.5, 1)).toBe(1); // the lower cap wins
    expect(pixelRatio(3, 1.5, 1.5, 1)).toBe(1.5);
    expect(pixelRatio(2, 1.25, null, 0.8)).toBeCloseTo(1); // no override: the preset, then the dynamic scale
    expect(pixelRatio(1, 1.5, 1.5, 1)).toBe(1); // never above the device
    // High on a Retina desktop: the full 2×; a phone on High its full 3×; on a 1× screen, 1×
    expect(pixelRatio(2, PRESETS.high.dprCap, null, 1)).toBe(2);
    expect(pixelRatio(3, PRESETS.high.touchDprCap, null, 1)).toBe(3);
    expect(pixelRatio(3, PRESETS.low.touchDprCap, null, 1)).toBe(MOBILE_DPR_CAP); // Low on a phone: the old phone cap
    expect(pixelRatio(1, PRESETS.high.dprCap, null, 1)).toBe(1);
  });
});
