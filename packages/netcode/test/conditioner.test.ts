import { HEALTH_UNKNOWN, MsgType, isUnreliableMessage } from '@military-forge/protocol';
import { describe, expect, it } from 'vitest';
import { ConditionedLink, DEFAULT_PACER, InputPacer, ManualScheduler as FakeScheduler, createConditionerSettings, describeNetSim, parseNetSim, symmetric } from '../src';

const unreliable = (n: number) => Uint8Array.of(MsgType.Input, n & 0xff, n >> 8);
const reliable = (n: number) => Uint8Array.of(MsgType.Roster, n & 0xff, n >> 8);
const id = (b: Uint8Array) => b[1]! | (b[2]! << 8);

function link(settings = createConditionerSettings(true).up, seed = 1) {
  const clock = new FakeScheduler();
  const got: { at: number; id: number; reliable: boolean }[] = [];
  const l = new ConditionedLink(settings, () => true, clock, (b) => got.push({ at: clock.now(), id: id(b), reliable: b[0] === MsgType.Roster }), isUnreliableMessage, seed);
  return { clock, got, l, settings };
}

describe('network conditioner', () => {
  it('adds exact latency and keeps order', () => {
    const { clock, got, l } = link(symmetric(150).up);
    for (let i = 0; i < 10; i++) {
      l.send(unreliable(i));
      clock.advance(16);
    }
    clock.advance(200);
    expect(got.map((g) => g.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    got.forEach((g, i) => expect(g.at).toBe(i * 16 + 75));
  });

  it('jitter stays within ±jitter and never reorders unless asked', () => {
    const inOrder = link(symmetric(100, 0, 20).up);
    for (let i = 0; i < 500; i++) {
      inOrder.l.send(unreliable(i));
      inOrder.clock.advance(5);
    }
    inOrder.clock.advance(500);
    expect(inOrder.got.map((g) => g.id)).toEqual(Array.from({ length: 500 }, (_, i) => i));
    const delays = inOrder.got.map((g, i) => g.at - i * 5);
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(30);
    expect(Math.max(...delays)).toBeLessThanOrEqual(70 + 5 * 8); // FIFO can hold a packet behind a slower one

    const settings = symmetric(100, 0, 20).up;
    settings.reorder = true;
    const free = link(settings);
    for (let i = 0; i < 500; i++) {
      free.l.send(unreliable(i));
      free.clock.advance(5);
    }
    free.clock.advance(500);
    const ids = free.got.map((g) => g.id);
    expect(ids.some((v, i) => i > 0 && v < ids[i - 1]!)).toBe(true);
    free.got.forEach((g) => expect(g.at - g.id * 5).toBeGreaterThanOrEqual(30));
    free.got.forEach((g) => expect(g.at - g.id * 5).toBeLessThanOrEqual(70));
  });

  it('drops ~loss% of unreliable messages and never a reliable one', () => {
    const { clock, got, l } = link(symmetric(0, 2).up, 7);
    for (let i = 0; i < 20_000; i++) l.send(unreliable(i));
    clock.advance(1);
    const lossPct = 100 - (got.length / 20_000) * 100;
    expect(lossPct).toBeGreaterThan(1.6);
    expect(lossPct).toBeLessThan(2.4);
    expect(l.stats.dropped).toBe(20_000 - got.length);

    const all = link(symmetric(40, 100).up);
    for (let i = 0; i < 50; i++) all.l.send(reliable(i));
    for (let i = 0; i < 50; i++) all.l.send(unreliable(i));
    all.clock.advance(100);
    expect(all.got.filter((g) => g.reliable).map((g) => g.id)).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(all.got.filter((g) => !g.reliable)).toEqual([]);
  });

  it('stream mode (TCP): nothing is lost, but a loss stalls everything behind it by a retransmit', () => {
    const settings = symmetric(100, 10).up;
    settings.stream = true;
    const { clock, got, l } = link(settings, 5);
    for (let i = 0; i < 200; i++) {
      l.send(unreliable(i));
      clock.advance(16);
    }
    clock.advance(1000);
    expect(got.map((g) => g.id)).toEqual(Array.from({ length: 200 }, (_, i) => i)); // all, in order
    expect(l.stats.retransmitted).toBeGreaterThan(10);
    const delays = got.map((g, i) => g.at - i * 16);
    expect(Math.min(...delays)).toBe(50);
    expect(Math.max(...delays)).toBeGreaterThanOrEqual(150); // a retransmit (+100 ms) …
    // … and the messages queued behind it waited too (head-of-line blocking)
    const stalled = delays.filter((d) => d > 50).length;
    expect(stalled).toBeGreaterThan(l.stats.retransmitted * 2);
  });

  it('duplicates unreliable messages', () => {
    const { clock, got, l } = link(symmetric(50, 0, 10, 10).up);
    for (let i = 0; i < 2000; i++) l.send(unreliable(i));
    clock.advance(200);
    expect(got.length).toBe(2000 + l.stats.duplicated);
    expect(l.stats.duplicated).toBeGreaterThan(140);
    expect(l.stats.duplicated).toBeLessThan(260);
  });

  it('is reproducible for a seed, and passes straight through when disabled', () => {
    const run = () => {
      const { clock, got, l } = link(symmetric(80, 5, 15).up, 3);
      for (let i = 0; i < 300; i++) {
        l.send(unreliable(i));
        clock.advance(3);
      }
      clock.advance(300);
      return got;
    };
    expect(run()).toEqual(run());

    const clock = new FakeScheduler();
    const got: number[] = [];
    let enabled = false;
    const settings = symmetric(100, 50).up;
    const l = new ConditionedLink(settings, () => enabled, clock, (b) => got.push(id(b)), isUnreliableMessage);
    l.send(unreliable(1));
    expect(got).toEqual([1]); // synchronous
    enabled = true;
    l.send(reliable(2));
    enabled = false;
    l.send(unreliable(3)); // must not overtake the delayed one
    expect(got).toEqual([1]);
    clock.advance(60);
    expect(got).toEqual([1, 2, 3]);
  });

  it('parses the NET_SIM / ?netsim= spec', () => {
    const s = parseNetSim('rtt=150,loss=2,jitter=5')!;
    expect(s.enabled).toBe(true);
    expect(s.up).toMatchObject({ latencyMs: 75, lossPct: 2, jitterMs: 5 });
    expect(s.down).toMatchObject({ latencyMs: 75, lossPct: 2, jitterMs: 5 });
    const asym = parseNetSim('up.lat=20 down.lat=120 down.loss=5 reorder')!;
    expect(asym.up).toMatchObject({ latencyMs: 20, lossPct: 0, reorder: true });
    expect(asym.down).toMatchObject({ latencyMs: 120, lossPct: 5, reorder: true });
    expect(parseNetSim('')).toBeNull();
    expect(() => parseNetSim('rtt=fast')).toThrow();
    expect(() => parseNetSim('speed=3')).toThrow();
    expect(describeNetSim(s)).toBe('up 75±5 ms 2% · down 75±5 ms 2%');
  });
});

describe('bursts and spikes', () => {
  it('burst loss keeps its long-run average but loses messages in runs', () => {
    const indep = link({ ...symmetric(100, 10).up }, 3);
    const bursty = link({ ...symmetric(100, 10).up, burstMs: 120 }, 3);
    const runs = (l: ReturnType<typeof link>) => {
      for (let i = 0; i < 20_000; i++) {
        l.l.send(unreliable(i & 0xffff));
        l.clock.advance(16);
      }
      l.clock.advance(1000);
      let longest = 0;
      let run = 0;
      let prev = -1;
      for (const g of l.got) {
        const gap = (g.id - prev - 1 + 0x10000) % 0x10000;
        if (gap > 0) longest = Math.max(longest, gap);
        prev = g.id;
        run++;
      }
      return { lossPct: 100 - (100 * run) / 20_000, longest };
    };
    const a = runs(indep);
    const b = runs(bursty);
    expect(a.lossPct).toBeGreaterThan(8);
    expect(a.lossPct).toBeLessThan(12);
    expect(b.lossPct).toBeGreaterThan(7);
    expect(b.lossPct).toBeLessThan(13);
    expect(b.longest).toBeGreaterThan(a.longest); // bursts: longer runs of losses
  });

  it('a latency spike delays messages by up to its peak, in order, and passes', () => {
    const l = link({ ...symmetric(100).up, spikeMs: 400, spikeEveryMs: 1000, spikeLengthMs: 1000 }, 5);
    for (let i = 0; i < 1000; i++) {
      l.l.send(unreliable(i));
      l.clock.advance(10);
    }
    l.clock.advance(2000);
    const delays = l.got.map((g) => g.at - g.id * 10);
    expect(l.got.map((g) => g.id)).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(Math.min(...delays)).toBe(50);
    expect(Math.max(...delays)).toBeGreaterThan(300);
    expect(Math.max(...delays)).toBeLessThanOrEqual(50 + 400 + 10);
  });

  it('parses the new keys', () => {
    const s = parseNetSim('rtt=500,burst=120,loss=10,up.spike=1000,up.spikeevery=7000,up.spikelen=2500')!;
    expect(s.down.burstMs).toBe(120);
    expect(s.up.spikeMs).toBe(1000);
    expect(s.up.spikeEveryMs).toBe(7000);
    expect(s.down.spikeMs).toBeUndefined();
    expect(describeNetSim(s)).toMatch(/spikes \+1000 ms/);
  });
});

describe('input pacer (clock sync, docs/05 §4)', () => {
  // the classic band (no cushion) and immediate jumps, as before 19 Oct 2026
  const classic = { maxCushion: 0, resyncAfterMs: 0 };

  it('speeds up when inputs arrive late, slows down when they sit in the queue, eases otherwise', () => {
    const p = new InputPacer(classic);
    p.onReport(HEALTH_UNKNOWN, 0, 100);
    expect(Number.isNaN(p.health)).toBe(true);
    p.onReport(0, 10, 100);
    for (let i = 0; i < 30; i++) p.update(1 / 60);
    expect(p.timeScale).toBeCloseTo(1.03, 3);
    p.onReport(1, 50, 102);
    for (let i = 0; i < 30; i++) p.update(1 / 60);
    expect(p.timeScale).toBeCloseTo(1, 3);
    // too early, but only a slow-down once it has lasted the whole window
    for (let t = 100; t < 600; t += 33) p.onReport(4, t, 100 + t / 16);
    for (let i = 0; i < 30; i++) p.update(1 / 60);
    expect(p.timeScale).toBeCloseTo(1, 3);
    for (let t = 600; t < 1400; t += 33) p.onReport(4, t, 100 + t / 16);
    for (let i = 0; i < 30; i++) p.update(1 / 60);
    expect(p.timeScale).toBeCloseTo(0.97, 3);
    expect(p.takeJump()).toBe(0);
  });

  it('jumps instead of nudging when far off, and ignores reports that predate the jump', () => {
    const p = new InputPacer(classic);
    p.onReport(-20, 0, 1000); // server at 1000 has only seen up to 980
    expect(p.takeJump()).toBe(22); // to the middle of the 1–2 band
    p.onReport(-25, 10, 1005); // before the jump is applied: ignored
    p.jumpApplied(1003, 20); // newest input we've sent, after fast-forwarding
    p.onReport(-27, 40, 1007); // server has seen 980: still the old timeline
    p.onReport(-4, 60, 1007); // seen 1003: that's our jump packet, not newer → ignored
    expect(p.takeJump()).toBe(0);
    expect(p.resyncs).toBe(1);
    p.onReport(1, 80, 1008); // seen 1009 > 1003: the new timeline
    expect(p.health).toBe(1);
    p.onReport(15, 400, 1020);
    expect(p.takeJump()).toBe(-13);
    expect(p.resyncs).toBe(2);
  });

  it('stops waiting for a post-jump report after 2 s (everything was lost)', () => {
    const p = new InputPacer(classic);
    p.onReport(-30, 0, 500);
    p.takeJump();
    p.jumpApplied(560, 0);
    p.onReport(-30, 1000, 520);
    expect(p.resyncs).toBe(1);
    p.onReport(-30, 2500, 540);
    expect(p.resyncs).toBe(2);
  });

  it('rides out a latency spike instead of jumping through it: the health comes back by itself', () => {
    const p = new InputPacer({ maxCushion: 0 });
    // a phone's upload queue: 2.5 s of inputs arriving up to a second (60 ticks) late, then back to normal
    for (let t = 0; t < 2500; t += 33) p.onReport(-Math.round((60 * t) / 2500), t, 1000 + t / 16);
    expect(p.takeJump()).toBe(0);
    for (let t = 2500; t < 3000; t += 33) p.onReport(2, t, 1000 + t / 16);
    expect(p.takeJump()).toBe(0);
    expect(p.resyncs).toBe(0);
  });

  it('jumps when the offset lasts (resyncAfterMs), or at once when it is huge (a tab that slept)', () => {
    const lasting = new InputPacer({ maxCushion: 0 });
    for (let t = 0; t <= 5100; t += 33) lasting.onReport(-20, t, 1000 + t / 16);
    expect(lasting.takeJump()).toBe(22);
    const huge = new InputPacer({ maxCushion: 0 });
    huge.onReport(-200, 0, 1000);
    expect(huge.takeJump()).toBe(202);
    const ahead = new InputPacer({ maxCushion: 0 });
    ahead.onReport(40, 0, 1000); // past what the server holds: back at once
    expect(ahead.takeJump()).toBe(-38);
  });

  it('keeps a cushion after late inputs: the band moves up by the dip, then shrinks back slowly', () => {
    const p = new InputPacer();
    p.onReport(-3, 0, 1000); // 4 ticks short of the band's bottom
    expect(p.cushion).toBe(4);
    expect(p.low).toBe(5);
    p.onReport(4, 33, 1002); // fine before, short of the cushioned band now: speed up
    for (let i = 0; i < 30; i++) p.update(1 / 60);
    expect(p.timeScale).toBeCloseTo(1.03, 3);
    for (let t = 66; t < 8100; t += 33) p.onReport(6, t, 1000 + t / 16);
    expect(p.cushion).toBe(0); // 0.5 tick a second
    expect(p.cushion).toBeLessThanOrEqual(DEFAULT_PACER.maxCushion);
  });
});
