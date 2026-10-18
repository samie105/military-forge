import { describe, expect, it } from 'vitest';
import { DynamicResolution, PRESETS, SampleWindow, parsePreset } from '../presets';

describe('graphics presets', () => {
  it('parses ?gfx= and defaults to Low (the min-spec iGPU target)', () => {
    expect(parsePreset('HIGH').name).toBe('high');
    expect(parsePreset('medium').name).toBe('medium');
    expect(parsePreset('ultra').name).toBe('low');
    expect(parsePreset(null).name).toBe('low');
  });

  it('follows docs/11 §3: DPR caps 1.0 → 2.0 (High: a Retina desktop at full sharpness), blob shadows below High, one shadow map on High', () => {
    expect([PRESETS.low.dprCap, PRESETS.medium.dprCap, PRESETS.high.dprCap]).toEqual([1, 1.25, 2]);
    // dynamic resolution never takes High below its old floor of 1.2× on a 2× screen
    expect(PRESETS.high.dprCap * PRESETS.high.minScale).toBeCloseTo(1.2);
    expect([PRESETS.low.shadows, PRESETS.medium.shadows, PRESETS.high.shadows]).toEqual(['blob', 'blob', 'map']);
    expect(PRESETS.low.minScale).toBe(0.6);
  });
});

describe('SampleWindow', () => {
  it('keeps the last N samples and gives nearest-rank percentiles', () => {
    const w = new SampleWindow(10);
    expect(w.percentile(0.5)).toBeNaN();
    for (let i = 1; i <= 15; i++) w.push(i); // keeps 6…15
    expect(w.length).toBe(10);
    expect(w.percentile(0.5)).toBe(10);
    expect(w.percentile(0.9)).toBe(14);
    expect(w.percentile(1)).toBe(15);
    expect(w.mean()).toBe(10.5);
  });
});

describe('DynamicResolution', () => {
  const feed = (d: DynamicResolution, ms: number, frames: number) => {
    let changes = 0;
    for (let i = 0; i < frames; i++) if (d.sample(ms)) changes++;
    return changes;
  };

  it('steps down 0.1 per missed-budget window, never below the preset floor', () => {
    const d = new DynamicResolution(0.6);
    expect(feed(d, 33.4, 60)).toBe(1);
    expect(d.scale).toBe(0.9);
    feed(d, 33.4, 300);
    expect(d.scale).toBe(0.6);
  });

  it('keeps stepping down on a 60 Hz display when the GPU misses every other vsync', () => {
    const d = new DynamicResolution(0.6);
    for (let i = 0; i < 60 * 20; i++) d.sample(i % 2 ? 33.4 : 16.7);
    expect(d.scale).toBe(0.6);
    expect(d.refreshMs).toBeCloseTo(16.7, 6);
  });

  it('ignores hidden-tab watchdog ticks and pauses: 1 Hz intervals never lower the scale', () => {
    const d = new DynamicResolution(0.6);
    expect(feed(d, 1000, 300)).toBe(0);
    for (let i = 0; i < 600; i++) d.sample(i % 40 === 0 ? 1000 : 16.7);
    expect(d.scale).toBe(1);
  });

  it('treats a 50 Hz display as the budget, not as a permanent miss', () => {
    const d = new DynamicResolution(0.6);
    feed(d, 20, 60 * 8);
    expect(d.refreshMs).toBe(20);
    expect(d.scale).toBe(1);
    expect(feed(d, 20, 60 * 50)).toBe(0);
    expect(d.scale).toBe(1);
    // and a real miss on that display still steps down
    feed(d, 40, 60);
    expect(d.scale).toBe(0.9);
  });

  it('probes back up after five clean windows and backs off if that misses frames', () => {
    const d = new DynamicResolution(0.6);
    feed(d, 33.4, 120);
    expect(d.scale).toBe(0.8);
    feed(d, 16.7, 60 * 4);
    expect(d.scale).toBe(0.8);
    feed(d, 16.7, 60);
    expect(d.scale).toBe(0.85);
    feed(d, 33.4, 60);
    expect(d.scale).toBe(0.75);
  });

  it('leaves a pinned scale alone', () => {
    const d = new DynamicResolution(0.6);
    d.pinned = 1;
    expect(feed(d, 50, 600)).toBe(0);
    expect(d.scale).toBe(1);
  });
});
