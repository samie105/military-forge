/**
 * Map mechanics online (docs/02 §20): zones, rules and the event schedule come from the map and the
 * room seed, so a client's prediction of its own player stays exact through all of them. Two
 * NetClients against a real Room on the mechanics-test map, through the network conditioner.
 */
import { symmetric } from '@military-forge/netcode';
import { Btn, type Input } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { simulate } from './netsimHarness';

/**
 * Client 0 crosses the whole strip left to right: hops every 2 s (a held jet in low-g, zero-g, the
 * pocket, long flight and the EMP field), dives now and then (zero-g, the reversed pocket), and
 * lands on both pads. Client 1 jets and walks around the pocket sites at the far end.
 */
function tour(k: number, nowMs: number, _net: unknown, out: Input): void {
  const t = nowMs % 2000;
  out.aim = 0;
  if (k === 0) out.buttons = Btn.Right | (t < 500 ? Btn.Jet : 0) | (t > 1500 && t < 1800 ? Btn.Down : 0);
  else out.buttons = (nowMs % 6000 < 3000 ? Btn.Left : Btn.Right) | (t < 300 ? Btn.Jet : 0);
}

describe('map mechanics predict exactly', () => {
  it('a clean LAN: no mispredictions through every zone and a whole event loop', () => {
    const r = simulate(symmetric(20, 0, 1), 58, { warmupSeconds: 3, room: { mapId: 'mechanics-test', dummies: false, seed: 77 }, input: tour });
    const me = r.clients[0]!;
    expect(me.net.map.id).toBe('mechanics-test');
    expect(r.clients.map((c) => c.mispredictions)).toEqual([0, 0]);
    expect(r.clients.map((c) => c.missedInputs)).toEqual([0, 0]);
    expect(me.net.predictor!.stats.matches).toBeGreaterThan(1500);
    // it really went through the zones: past the EMP field and the fog
    expect(me.net.predictor!.player.x).toBeGreaterThan(170);
  });

  it('150 ms RTT, 2 % loss, ±5 ms jitter: corrections stay as rare as on a plain map', () => {
    const r = simulate(symmetric(150, 2, 5), 70, { room: { mapId: 'mechanics-test', dummies: false, seed: 78 }, input: tour });
    for (const c of r.clients) {
      expect(c.corrections / r.minutes).toBeLessThan(1);
      expect(c.resyncs).toBe(0);
    }
  });
});
