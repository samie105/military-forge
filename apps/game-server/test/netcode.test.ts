/**
 * End-to-end netcode on a simulated network: two NetClients (prediction, clock sync, pacing) talk
 * to a real Room through the network conditioner, on a manual clock so it runs in milliseconds and
 * is reproducible. This is the automated half of the "150 ms RTT / 2 % loss" acceptance check.
 */
import { MsgType } from '@military-forge/protocol';
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
    // the pacer keeps 1–2 spare ticks queued on the server, plus a tick or two of cushion after dips
    const inBand = r.healths.filter((h) => h >= 1 && h <= 4).length / r.healths.length;
    expect(inBand).toBeGreaterThan(0.9);
    expect(Math.abs(mean(r.timeScales) - 1)).toBeLessThan(0.005);
    // the client runs ahead by ~one-way latency + the buffer: 75 ms ≈ 4.5 ticks, + 1–2 (+ cushion)
    expect(mean(r.leadTicks)).toBeGreaterThan(5);
    expect(mean(r.leadTicks)).toBeLessThan(9.5);
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

  it('a 15 s TCP stall: the client holds its INPUTs back, nobody is kicked, and play picks up again', () => {
    const stall = { fromMs: 10_000, toMs: 25_000 };
    const during = { inputs: 0, other: 0 };
    const r = simulate(symmetric(80, 0, 3), 40, {
      transport: 'ws',
      warmupSeconds: 32,
      stall,
      onSend: (k, b, now) => {
        if (k !== 0 || now < stall.fromMs || now >= stall.toMs) return;
        if (b[0] === MsgType.Input) during.inputs++;
        else during.other++;
      },
    });
    const me = r.clients[0]!;
    // ½ s at the full rate before the silence counts as a stall, then 4 a second instead of 60
    expect(during.inputs).toBeLessThan(100);
    expect(during.other).toBeLessThanOrEqual(16); // a PING a second
    expect(me.net.inputsHeldBack).toBeGreaterThan(800);
    // the backlog arrives at once and fits the server's allowance: no kick, nothing even dropped
    expect(me.server.closed).toBe(false);
    expect(me.server.inputsDropped).toBe(0);
    expect(me.net.isConnected).toBe(true);
    expect(me.net.reconnects).toBe(0);
    // the pacer resyncs on the way out, then prediction is exact again
    expect(me.net.pacer.resyncs).toBeLessThanOrEqual(3);
    expect(me.resyncs).toBe(0);
    expect(me.corrections).toBe(0);
    expect(me.missedInputs).toBe(0);
  });

  it('a WebSocket whose send buffer backs up gets 4 INPUTs a second too, and the full rate once it drains', () => {
    const window = { fromMs: 10_000, toMs: 12_000 };
    const inputs = { during: 0, after: 0 };
    const r = simulate(symmetric(80, 0, 3), 20, {
      transport: 'ws',
      warmupSeconds: 15,
      backlog: (k, now) => (k === 0 && now >= window.fromMs && now < window.toMs ? 4096 : 0),
      onSend: (k, b, now) => {
        if (k !== 0 || b[0] !== MsgType.Input) return;
        if (now >= window.fromMs && now < window.toMs) inputs.during++;
        else if (now >= window.toMs && now < window.toMs + 2000) inputs.after++;
      },
    });
    const me = r.clients[0]!;
    expect(inputs.during).toBeLessThanOrEqual(11); // about 4 a second, not 120 in the 2 s
    expect(inputs.after).toBeGreaterThan(110);
    expect(me.server.closed).toBe(false);
    expect(me.corrections).toBe(0);
    // WebTransport never holds them back: its datagrams don't queue
    const udp = simulate(symmetric(80, 0, 3), 20, { warmupSeconds: 15, backlog: () => 4096 }).clients[0]!;
    expect(udp.net.inputsHeldBack).toBe(0);
  });

  it('UDP datagrams vs a TCP stream at 150 ms / 2 %: no head-of-line stalls, no corrections', () => {
    const tcp = simulate(symmetric(150, 2, 5), 50, { transport: 'ws' }).clients[0]!;
    const udp = simulate(symmetric(150, 2, 5), 50, { transport: 'wt' }).clients[0]!;
    // every TCP loss holds everything behind it for ~1 RTT; datagrams lose only themselves
    expect(tcp.snapshotAgeP99).toBeGreaterThan(udp.snapshotAgeP99 + 80);
    expect(udp.interpStallPct).toBeLessThan(0.5);
    expect(tcp.interpStallPct).toBeGreaterThan(2);
    expect(udp.corrections).toBe(0);
    // inputs stuck behind a retransmit come late: the server holds the player for them and catches up
    // (it used to run on a guess and correct the client: > 2 a run before the late-input catch-up)
    expect(tcp.corrections).toBeLessThanOrEqual(1);
  });
});

