/**
 * End-to-end netcode on a simulated network: two NetClients (prediction, clock sync, pacing) talk
 * to a real Room through the network conditioner, on a manual clock so it runs in milliseconds and
 * is reproducible. This is the automated half of the "150 ms RTT / 2 % loss" acceptance check.
 */
import { symmetric } from '@military-forge/netcode';
import { describe, expect, it } from 'vitest';
import { simulate } from './netsimHarness';

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('netcode end to end (simulated network)', () => {
  it('150 ms RTT, 2 % loss, ±5 ms jitter: < 1 correction per minute while walking/jetting', () => {
    const r = simulate(symmetric(150, 2, 5), 70);
    for (const c of r.clients) {
      expect(c.net.joined).toBe(true);
      expect(c.net.predictor!.stats.matches).toBeGreaterThan(1500);
      expect(c.corrections / r.minutes).toBeLessThan(1);
      expect(c.resyncs).toBe(0);
    }
    // the pacer keeps 1–2 spare ticks queued on the server
    const inBand = r.healths.filter((h) => h >= 1 && h <= 2).length / r.healths.length;
    expect(inBand).toBeGreaterThan(0.9);
    expect(Math.abs(mean(r.timeScales) - 1)).toBeLessThan(0.005);
    // the client runs ahead by ~one-way latency + the buffer: 75 ms ≈ 4.5 ticks, + 1–2
    expect(mean(r.leadTicks)).toBeGreaterThan(5);
    expect(mean(r.leadTicks)).toBeLessThan(8.5);
    const stats = r.clients[0]!.net.stats();
    expect(stats.rttMs).toBeGreaterThan(140);
    expect(stats.rttMs).toBeLessThan(170);
    expect(stats.snapshotLossPct).toBeLessThan(5);
  });

  it('a 2nd client sees the 1st one move (snapshots for interpolation still flow)', () => {
    const r = simulate(symmetric(150, 2, 5), 12, { warmupSeconds: 2, room: { aoi: false } }); // they spawn far apart
    const [a, b] = r.clients.map((c) => c.net);
    const newest = b!.snapshots.at(-1)!.msg;
    const seen = newest.players.find((p) => p.id === a!.myId)!;
    expect(seen.alive).toBe(true);
    expect(Math.abs(seen.x - a!.predictor!.player.x)).toBeLessThan(4); // within RTT + buffer of motion
  });

  it('a clean LAN: no mispredictions at all after start-up', () => {
    const r = simulate(symmetric(20, 0, 1), 8, { warmupSeconds: 3 });
    expect(r.clients.map((c) => c.mispredictions)).toEqual([0, 0]);
    expect(r.clients.map((c) => c.missedInputs)).toEqual([0, 0]);
    expect(Math.min(...r.healths)).toBeGreaterThanOrEqual(1);
  });

  it('heavy jitter (±40 ms, reordering) is absorbed by a deeper buffer, not by corrections', () => {
    const settings = symmetric(200, 3, 40);
    settings.up.reorder = settings.down.reorder = true;
    const r = simulate(settings, 70);
    for (const c of r.clients) expect(c.corrections / r.minutes).toBeLessThan(3);
    expect(mean(r.leadTicks)).toBeGreaterThan(8);
  });

  it('a tab that slept 3 s (1 Hz frames, throttled timers) resyncs once or twice and is exact again', () => {
    const r = simulate(symmetric(150, 2, 5), 30, { warmupSeconds: 15, sleep: { fromMs: 8000, toMs: 11_000 } });
    const me = r.clients[0]!;
    expect(me.net.pacer.resyncs).toBeGreaterThanOrEqual(1);
    expect(me.net.pacer.resyncs).toBeLessThanOrEqual(3);
    expect(me.resyncs).toBe(0); // nothing after it settled (warm-up ends 4 s after waking)
    expect(me.corrections).toBe(0);
    expect(r.healths.filter((h) => h >= 1 && h <= 3).length / r.healths.length).toBeGreaterThan(0.95);
  });

  it('a dropped connection comes back as the same player and predicts exactly again', () => {
    const r = simulate(symmetric(150, 2, 5), 30, { warmupSeconds: 14, drop: { fromMs: 6000, toMs: 9000 } });
    const me = r.clients[0]!;
    expect(me.net.reconnects).toBe(1);
    expect(me.net.isConnected).toBe(true);
    expect(me.net.status).toBe('connected (resumed)');
    expect(me.server.playerId).toBe(me.net.myId); // same player id on the new connection
    expect(me.corrections).toBe(0); // after re-anchoring, prediction is exact again
    expect(me.resyncs).toBe(0);
    expect(r.healths.filter((h) => h >= 1 && h <= 3).length / r.healths.length).toBeGreaterThan(0.95);
  });

  it('low-bandwidth mode: half the packets each way, prediction still exact', () => {
    const r = simulate(symmetric(150, 2, 5), 50, { lowBandwidth: [0] });
    const [slim, normal] = r.clients;
    expect(slim!.net.lowBandwidth).toBe(true);
    expect(slim!.upPacketsPerSec).toBeLessThan(normal!.upPacketsPerSec * 0.6); // 30 Hz inputs (+ 1 Hz pings)
    expect(slim!.corrections).toBe(0);
    expect(slim!.resyncs).toBe(0);
    expect(slim!.net.stats().snapshotLossPct).toBeLessThan(6); // the halved rate isn't counted as loss
    expect(r.healths.filter((h) => h >= 0 && h <= 4).length / r.healths.length).toBeGreaterThan(0.95);
  });
});

