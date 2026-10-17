/**
 * Dash online (docs/02 §21): the burst, cooldown and air dash ride in the local block, so a client
 * predicts its own dashes exactly. Two NetClients against a real Room through the conditioner.
 */
import { symmetric } from '@military-forge/netcode';
import { Btn, type Input } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { simulate } from './netsimHarness';

/** Dash every 1.3 s in a rotating direction, between walking, jetting and air dashes. */
const DIRECTIONS = [Btn.Right, Btn.Right | Btn.Jet, Btn.Jet, Btn.Left | Btn.Jet, Btn.Left, 0, Btn.Down, Btn.Right | Btn.Down];
function dasher(k: number, nowMs: number, _net: unknown, out: Input): void {
  const slot = Math.floor(nowMs / 1300);
  const t = nowMs % 1300;
  const dir = DIRECTIONS[(slot + k * 3) % DIRECTIONS.length]!;
  out.aim = slot % 2 ? 0 : 32768;
  if (t < 40) out.buttons = Btn.Dash | dir; // ≥ 2 ticks held: a press edge at 60 Hz
  else if (t < 600) out.buttons = slot % 3 === 0 ? Btn.Jet : dir & (Btn.Left | Btn.Right);
  else out.buttons = 0;
}

/**
 * No items on the map: a riot shield picked up on the way would stop the dashes while it is up
 * (docs/03 §9), and taking it is the server's call (one correction, apps/game-server/test/shield.test.ts).
 */
const ROOM = { dummies: false, pickups: false } as const;

describe('dash predicts exactly', () => {
  it('a clean LAN: no mispredictions while dashing 8 ways, in the air and on the ground', () => {
    const r = simulate(symmetric(20, 0, 1), 30, { warmupSeconds: 3, room: { ...ROOM, seed: 41 }, input: dasher });
    expect(r.clients.map((c) => c.mispredictions)).toEqual([0, 0]);
    expect(r.clients.map((c) => c.missedInputs)).toEqual([0, 0]);
    expect(r.clients[0]!.net.predictor!.stats.matches).toBeGreaterThan(700);
  });

  it('150 ms RTT, 2 % loss: corrections stay as rare as without dashing', () => {
    const r = simulate(symmetric(150, 2, 5), 70, { room: { ...ROOM, seed: 42 }, input: dasher });
    for (const c of r.clients) {
      expect(c.corrections / r.minutes).toBeLessThan(1);
      expect(c.resyncs).toBe(0);
    }
  });
});
