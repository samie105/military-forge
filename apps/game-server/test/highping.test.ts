/**
 * High ping (the owner's report, 19 Oct 2026: Nigeria on mobile data to Johannesburg): the fixes
 * scripts/netfeel.ts measures, held in place. A real Room, two NetClients, the conditioner, a
 * manual clock.
 */
import { FEEL_PRESETS, OWN_ID_BASE, symmetric, type NetClient } from '@military-forge/netcode';
import { Btn } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { movement, simulate } from './netsimHarness';

const TICK = 1000 / 60;

describe('high ping', () => {
  it('an own grenade is drawn from the throw, then stands in for the server copy (never both)', () => {
    let thrownAt = -1;
    let shownAt = -1;
    let both = 0;
    let views = 0;
    const r = simulate(symmetric(300, 0, 20), 16, {
      warmupSeconds: 4,
      room: { dummies: false },
      input: (k, now, _net, out) => {
        out.buttons = k === 0 && Math.floor(now / TICK) % 240 === 100 ? Btn.Grenade : 0;
        out.aim = 0x1800;
      },
      beforeTick: (room, nets) => {
        const p = nets[0]!.myId >= 0 ? room.game.players[nets[0]!.myId] : null;
        if (p && p.grenadeCounts[0]! < 2) p.grenadeCounts[0] = 2;
      },
      onFrame: (k, now, net: NetClient) => {
        if (k !== 0) return;
        for (const e of net.drainEvents()) if (e.type === 'throw' && thrownAt < 0) thrownAt = now;
        const own = net.grenadeViews(now).filter((g) => g.owner === net.myId);
        if (own.some((g) => g.id >= OWN_ID_BASE) && shownAt < 0) shownAt = now;
        if (own.some((g) => g.id >= OWN_ID_BASE) && own.some((g) => g.id < OWN_ID_BASE && net.predictsGrenade(g.id))) both++;
        views += own.length;
      },
    });
    const stats = r.clients[0]!.net.ownShots!.stats;
    expect(thrownAt).toBeGreaterThan(0);
    expect(shownAt).toBe(thrownAt); // the same frame: no round trip
    expect(both).toBe(0);
    expect(views).toBeGreaterThan(0);
    expect(stats.predicted).toBeGreaterThanOrEqual(3);
    expect(stats.matched).toBe(stats.predicted); // the server threw every one
    expect(stats.diverged).toBe(0); // and they flew the same way
  });

  it('a press that a latency spike delays past its tick still happens on the server', () => {
    // the phone's upload queue (+1 s spikes): the server repeats old inputs through each one
    let pressed = 0;
    let dashes = 0;
    const r = simulate(FEEL_PRESETS['MTN 4G (500 ms, spikes to 1.3 s)']!, 60, {
      warmupSeconds: 10,
      room: { dummies: false },
      input: (k, now, _net, out) => {
        const t = Math.floor(now / TICK);
        out.buttons = movement(now, k * 1700) | (k === 0 && t % 150 === 0 ? Btn.Dash : 0);
        if (k === 0 && t % 150 === 0 && now > 10_000) pressed++;
      },
      afterTick: (room, nets) => {
        if (room.game.tick * TICK <= 10_000) return;
        for (const e of room.game.events) if (e.type === 'dash' && e.player === nets[0]!.myId) dashes++;
      },
    });
    const server = r.clients[0]!.server;
    expect(server.inputs.missed).toBeGreaterThan(100); // the spikes really starve the server
    // late presses happen: held for (the late-input catch-up) and run in order, or latched past it
    expect(pressed).toBeGreaterThan(15);
    expect(dashes / pressed).toBeGreaterThan(0.8); // (a dash needs fuel and the server's state: the odd one may not go)
  });

  it('the interpolation delay follows the jitter: short on a clean path, longer on a jittery one, capped', () => {
    const delay = (rtt: number, loss: number, jitter: number) => {
      const r = simulate(symmetric(rtt, loss, jitter), 20, { warmupSeconds: 10 });
      return r.clients[0]!.net.interpDelay;
    };
    const clean = delay(90, 0, 2);
    const jittery = delay(150, 3, 40);
    expect(clean).toBeLessThan(70); // was a fixed 100 ms: remote players are drawn fresher
    expect(jittery).toBeGreaterThan(120); // enough for ±40 ms and a lost snapshot
    expect(jittery).toBeLessThanOrEqual(200);
  });

  it('a latency spike does not make the client jump ahead and back (it rides it out)', () => {
    const r = simulate(FEEL_PRESETS['MTN 4G (500 ms, spikes to 1.3 s)']!, 70, { warmupSeconds: 10 });
    expect(r.clients[0]!.resyncs).toBeLessThanOrEqual(2);
  });
});
