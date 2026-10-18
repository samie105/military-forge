import { describe, expect, it } from 'vitest';
import { PlayerState } from '@military-forge/sim';
import { FLASH_FALL_PER_S, FLASH_MIN_INTERVAL_MS, FLASH_ONSET_JUMP, FlashLimiter } from '../src/fx/flash';
import { DIM_CENTRE_ALPHA, fxFrame, fxState, onMuffle, setReduceFlashes } from '../src/fx';
import { statusView } from '../src/grenadeViews';
import type { Frame, PlayerView } from '../src/view';

/** Runs the limiter over a target curve at 60 fps; returns what the screen showed each frame. */
function play(targets: (ms: number) => number, ms: number): number[] {
  const l = new FlashLimiter();
  const out: number[] = [];
  for (let t = 0; t <= ms; t += 1000 / 60) out.push(l.update(targets(t), t, 1 / 60));
  return out;
}

/** Frames where the screen jumped up by more than a fifth of full scale. */
function onsets(shown: number[]): number[] {
  const at: number[] = [];
  for (let i = 1; i < shown.length; i++) if (shown[i]! - shown[i - 1]! > 0.2) at.push(i);
  return at;
}

describe('flash limiter (photosensitivity)', () => {
  it('the first flash lands at once and follows the sim’s white-out and fade', () => {
    // 2.5 s white, 1.5 s fade
    const shown = play((t) => (t < 100 ? 0 : t < 2600 ? 1 : Math.max(0, 1 - (t - 2600) / 1500)), 4500);
    expect(onsets(shown)).toHaveLength(1);
    expect(shown[7]).toBe(1);
    expect(shown[Math.round(3.35 * 60)]).toBeCloseTo(0.5, 1);
    expect(shown.at(-1)).toBe(0);
  });

  it('never more than one full-screen flash a second, however the flashbangs land', () => {
    // a weak flash every 300 ms: 0.25 s of white, gone at once
    const strobe = (t: number) => (t % 300 < 250 ? 1 : 0);
    const shown = play(strobe, 5000);
    const at = onsets(shown).map((i) => (i * 1000) / 60);
    for (let i = 1; i < at.length; i++) expect(at[i]! - at[i - 1]!).toBeGreaterThanOrEqual(FLASH_MIN_INTERVAL_MS - 1);
    // and it never clears faster than FLASH_FALL_PER_S
    for (let i = 1; i < shown.length; i++) expect(shown[i - 1]! - shown[i]!).toBeLessThanOrEqual(FLASH_FALL_PER_S / 60 + 1e-9);
  });
});

describe('flash limiter after a hitch (review)', () => {
  it('a long frame never raises the screen by an onset\'s worth without counting it as one', () => {
    const l = new FlashLimiter();
    l.update(1, 0, 1 / 60); // the first flash: an onset
    l.update(0, 600, 0.25); // cleared a little (no faster than FLASH_FALL_PER_S)
    l.update(0, 900, 0.25);
    const before = l.value;
    const onsets = l.onsets;
    // a second flashbang 0.95 s after the first, on a 0.25 s frame: too soon for an onset, so it ramps
    const after = l.update(1, 950, 0.25);
    expect(l.onsets).toBe(onsets);
    expect(after - before).toBeLessThan(FLASH_ONSET_JUMP);
  });

  it('the frame shows the most blinded the player was over its ticks', () => {
    const p = new PlayerState(1);
    p.alive = true;
    expect(statusView(p).blind).toBe(0);
    expect(statusView(p, 1).blind).toBe(1); // a flash that came and went inside the frame
    p.alive = false;
    expect(statusView(p, 1).blind).toBe(0);
  });
});

describe('Reduce flashes (review M6)', () => {
  it('darkens as completely as the white-out whitens: at least 0.95 opaque at full strength', () => {
    expect(DIM_CENTRE_ALPHA).toBeGreaterThanOrEqual(0.95);
  });
});

function frame(over: Partial<PlayerView>): Frame {
  const me = { id: 1, alive: true, blind: 0, gasTicks: 0, ...over } as PlayerView;
  return { tick: 0, localId: 1, players: [me], grenades: [] };
}

describe('fx (no DOM: state only)', () => {
  it('shows the white-out, hears the muffle, tints for gas, and honours Reduce flashes', () => {
    const heard: number[] = [];
    const off = onMuffle((a) => heard.push(a));
    let now = 10_000;
    const step = (over: Partial<PlayerView>, n = 1) => {
      for (let i = 0; i < n; i++) fxFrame(frame(over), 1 / 60, (now += 1000 / 60));
    };
    step({ blind: 1 });
    expect(fxState().flash).toBe(1);
    expect(heard.at(-1)).toBe(1);
    step({ blind: 0, gasTicks: 20 }, 30);
    expect(fxState().flash).toBe(0);
    expect(heard.at(-1)).toBe(0);
    expect(fxState().gas).toBeCloseTo(1, 5);
    step({ blind: 0, gasTicks: 0, alive: false }, 30);
    expect(fxState().gas).toBe(0);
    setReduceFlashes(true);
    expect(fxState().reduceFlashes).toBe(true);
    setReduceFlashes(false);
    off();
  });
});
