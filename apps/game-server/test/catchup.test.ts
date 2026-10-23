/**
 * The late-input catch-up (owner on 4G, 23 Oct 2026: "keeps returning and returning"). A phone's
 * uplink stalls for a moment; its inputs come late. The server used to run the player on a guess
 * (the last input, then none) and pull the client back when the real inputs differed. Now it holds
 * the player for up to HOLD_TICKS (1 s) and catches up through the inputs when they come: the
 * client's prediction stands, no correction.
 */
import { symmetric, upSpikes } from '@military-forge/netcode';
import { describe, expect, it } from 'vitest';
import { HOLD_TICKS } from '../src/room';
import { simulate } from './netsimHarness';

describe('late inputs: hold, then catch up', () => {
  it('uplink stalls shorter than the hold: no corrections while walking, jetting and turning', () => {
    // +700 ms on the way up, 1 s long, every 4 s (a phone's upload queue, like MTN's)
    const r = simulate(upSpikes(symmetric(100, 0, 5), 700, 4000, 1000), 40, { linkSeed: 2 });
    const me = r.clients[0]!;
    expect(me.missedInputs).toBeGreaterThan(20); // the stalls really did leave the server waiting
    expect(me.corrections).toBe(0);
  }, 60_000);

  it('a stall longer than the hold: the old way after HOLD_TICKS (the last input, then a correction)', () => {
    expect(HOLD_TICKS).toBe(60);
    const r = simulate(upSpikes(symmetric(100, 0, 5), 1800, 6000, 2400), 40, { linkSeed: 2 });
    expect(r.clients[0]!.corrections).toBeGreaterThan(0);
  }, 60_000);
});
