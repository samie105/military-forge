/**
 * Lag compensation end to end (docs/05 §7): a shooter aims at a strafing target exactly where its
 * own screen draws it (interpolated snapshots), through the network conditioner. With lag
 * compensation the server tests the shot against that same picture; without it, against where
 * the target is ~RTT + buffer + interpolation later.
 */
import { symmetric } from '@military-forge/netcode';
import { describe, expect, it } from 'vitest';
import { shootingRange } from './shootingRange';

const pct = (n: number, d: number) => (100 * n) / Math.max(1, d);

describe('lag compensation (simulated network)', () => {
  it('150 ms RTT / 2 % loss: shots land where the shooter saw the target', () => {
    const on = shootingRange(symmetric(150, 2, 5), true);
    expect(on.shots).toBeGreaterThan(30);
    expect(pct(on.hits, on.shots)).toBeGreaterThan(90);
    // the server tested (almost) exactly the picture on the shooter's screen
    const exact = on.poseErrors.filter((e) => e < 0.01).length;
    expect(pct(exact, on.poseErrors.length)).toBeGreaterThan(90);
    expect(on.clamped).toBe(0);
    // rewind ≈ RTT + input buffer + 100 ms interpolation ≈ 16–18 ticks
    const mean = on.rewindTicks.reduce((a, b) => a + b, 0) / on.rewindTicks.length;
    expect(mean).toBeGreaterThan(14);
    expect(mean).toBeLessThan(19);

    const off = shootingRange(symmetric(150, 2, 5), false);
    expect(pct(off.hits, off.shots)).toBeLessThan(pct(on.hits, on.shots) - 40);
  });

  it('a view older than the cap is clamped (players lead their shots beyond it)', () => {
    const r = shootingRange(symmetric(150, 0, 0), { maxRewindMs: 150 }, 20);
    expect(r.clamped).toBe(r.rewindTicks.length);
    expect(r.clamped).toBeGreaterThan(5);
  });

  it('batched inputs (low-bandwidth mode at 30 fps) still rewind to exactly what was on screen', () => {
    // two ticks are sampled in each 33 ms frame and sent in one packet: every input carries its own
    // render lag. (A 30 fps view is a frame older, past the 300/367 ms caps at 150 ms RTT, so the cap
    // is lifted here to test the lags alone.)
    // Shots on even and odd ticks, so some land on the older (non-newest) input of a packet.
    for (const fireOffset of [0, 1]) {
      const r = shootingRange(symmetric(150, 2, 5), { maxRewindMs: 500 }, 40, true, 33, fireOffset);
      expect(r.shots).toBeGreaterThan(30);
      const exact = r.poseErrors.filter((e) => e < 0.01).length;
      expect(pct(exact, r.poseErrors.length)).toBeGreaterThan(90);
      expect(pct(r.hits, r.shots)).toBeGreaterThan(90);
    }
  });
});

