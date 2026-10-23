/** Auto-fade and Button fade (the owner, 23 Oct; controls spec §4.7): touch/fade.ts and the settings. */
import { describe, expect, it } from 'vitest';
import { AUTO_FADE_MS, FadeClock, WAKE_NEAR_PX, cueLit, nearControls } from '../../src/touch/fade';
import { DEFAULT_TOUCH_SETTINGS, loadSettings, sanitizeSettings } from '../../src/touch/settings';

describe('Auto-fade', () => {
  it('a touch lights the control under it and the ones near it (a thumb heading there), not the far ones', () => {
    const controls = new Map([
      ['dash', { x: 600, y: 200, r: 26 }],
      ['reload', { x: 640, y: 150, r: 26 }],
      ['scores', { x: 60, y: 120, r: 24 }],
    ]);
    expect(nearControls(600, 200, controls)).toEqual(['dash', 'reload']); // on dash; reload is 64 px away
    expect(nearControls(600 + 26 + WAKE_NEAR_PX - 1, 200, controls)).toContain('dash');
    expect(nearControls(600 + 26 + WAKE_NEAR_PX + 1, 200, controls)).not.toContain('dash');
    expect(nearControls(600, 200, controls)).not.toContain('scores');
  });

  it('a woken control stays lit for about 2.5 s, then fades', () => {
    const f = new FadeClock();
    expect(f.lit('dash', 0)).toBe(false);
    f.wake('dash', 1000);
    expect(f.lit('dash', 1000 + AUTO_FADE_MS - 1)).toBe(true);
    expect(f.lit('dash', 1000 + AUTO_FADE_MS)).toBe(false);
    f.wakeAll(['move', 'aim'], 5000);
    expect(f.lit('aim', 5100)).toBe(true);
    expect(AUTO_FADE_MS).toBe(2500);
  });

  it('critical cues never fade: a reload that is needed, Take with a gun underfoot, a raised shield', () => {
    expect(cueLit('reload', new Set(['empty']))).toBe(true);
    expect(cueLit('reload', new Set(['low-ammo']))).toBe(true);
    expect(cueLit('reload', new Set(['reloading']))).toBe(true);
    expect(cueLit('reload', new Set(['alive']))).toBe(false);
    expect(cueLit('take', new Set(['near-crate']))).toBe(true);
    expect(cueLit('shield', new Set(['shield-up']))).toBe(true);
    expect(cueLit('dash', new Set(['empty', 'near-crate']))).toBe(false);
  });
});

describe('Button fade (settings.opacity) and Auto-fade', () => {
  it('on by default: idle buttons at 50 %; the slider runs 15–100 %', () => {
    expect(DEFAULT_TOUCH_SETTINGS).toMatchObject({ opacity: 0.5, autoFade: true });
    expect(sanitizeSettings({ opacity: 0.05 }).opacity).toBe(0.15);
    expect(sanitizeSettings({ autoFade: false }).autoFade).toBe(false);
  });

  it('a save from before Button fade with the old default (1) takes the new one; a chosen opacity stays', () => {
    const store = (v: unknown) => ({ getItem: () => JSON.stringify(v), setItem: () => {}, removeItem: () => {} });
    expect(loadSettings(store({ opacity: 1, rev: 2 })).opacity).toBe(0.5);
    expect(loadSettings(store({ opacity: 0.7, rev: 2 })).opacity).toBe(0.7);
    expect(loadSettings(store({ opacity: 1, rev: 4 })).opacity).toBe(1); // chosen with the slider, after
  });
});
