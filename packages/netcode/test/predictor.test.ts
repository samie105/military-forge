import { HEALTH_UNKNOWN, LS, captureLocalState, createLocalState, describeLocalDiff, type LocalState } from '@military-forge/protocol';
import { Btn, Game, createInput, type Input, type PlayerState } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { InputBuffer, MAX_INPUT_LEAD, Predictor, VISIBLE_ERROR, type ReconcileKind } from '../src';

const SEED = 77;

/**
 * A busy but realistic script: walk, jet, crouch, fire both guns, reload, swap, dual, and two
 * grenades that land > 9 m away (own grenade flight isn't predicted yet: a blast near the thrower
 * is a correction, covered by the knockback test).
 */
function scripted(t: number): Input {
  const phase = Math.floor(t / 30) % 14;
  const buttons = [
    Btn.Right,
    Btn.Right | Btn.Jet,
    Btn.Jet,
    Btn.Left | Btn.Fire,
    Btn.Left,
    Btn.Down,
    Btn.Right | (t % 12 < 6 ? Btn.Fire : 0),
    Btn.Swap,
    Btn.Fire | Btn.Right,
    Btn.Reload,
    Btn.Dual,
    Btn.Fire | Btn.Jet | Btn.Left,
    t < 840 ? Btn.Grenade | Btn.Right : Btn.Right,
    0,
  ][phase]!;
  // aim sweeps but stays forward-ish so grenades land far away from the thrower
  return { ...createInput(), buttons, aim: (2000 + ((t * 53) % 6000)) & 0xffff };
}

interface Harness {
  server: Game;
  me: PlayerState;
  pred: Predictor;
  inputs: (Input | undefined)[];
  scratch: LocalState;
}

/** Server room game (with the dummies) and a client predictor for the same player, synced. */
function setup(): Harness {
  const server = new Game({ seed: SEED, dummies: true });
  const me = server.addPlayer('me');
  for (let i = 0; i < 10; i++) server.step([]);
  const pred = new Predictor(new Game({ map: server.map, seed: SEED, tuning: server.tuning, dummies: false }), me.id);
  const scratch = createLocalState();
  pred.reset(captureLocalState(me, scratch), server.tick);
  return { server, me, pred, inputs: [], scratch };
}

/**
 * The client predicts LEAD ticks ahead of the server (as it does online); every 2nd server tick a
 * "snapshot" of the exact local state is reconciled. `serverInput` lets a test make the server
 * simulate something else than the client predicted (a late input, a hit…).
 */
function run(
  h: Harness,
  ticks: number,
  opts: { lead?: number; serverInput?: (tick: number, sent: Input) => Input; beforeServerStep?: (tick: number) => void } = {},
): ReconcileKind[] {
  const lead = opts.lead ?? 8;
  const kinds: ReconcileKind[] = [];
  for (let i = 0; i < ticks; i++) {
    h.pred.step(scripted(h.pred.tick));
    h.pred.events.length = 0;
    const serverTick = h.server.tick;
    if (h.pred.tick - serverTick > lead) {
      const sent = h.pred.inputAt(serverTick)!;
      h.inputs[h.me.id] = opts.serverInput ? opts.serverInput(serverTick, sent) : sent;
      opts.beforeServerStep?.(serverTick);
      h.server.step(h.inputs);
      if (h.server.tick % 2 === 0) kinds.push(h.pred.reconcile(h.server.tick - 1, captureLocalState(h.me, h.scratch)));
    }
  }
  return kinds;
}

describe('prediction + reconciliation', () => {
  it('exact match: identical inputs give bit-identical state, no corrections (common case)', () => {
    const h = setup();
    const kinds = run(h, 3000);
    expect(kinds.length).toBeGreaterThan(1400);
    expect(new Set(kinds)).toEqual(new Set(['match']));
    expect(h.pred.stats.mispredictions).toBe(0);
    expect(h.pred.stats.corrections).toBe(0);
    // and it really exercised the weapon sim: shots, reloads, a grenade
    expect(h.me.shotCounter).toBeGreaterThan(20);
    expect(h.me.frags).toBeLessThan(3);
    // the prediction for the last server tick is the server's state, field for field
    const predicted = h.pred.stateAt(h.server.tick - 1)!;
    expect(describeLocalDiff(predicted, captureLocalState(h.me, createLocalState()))).toBe('');
  });

  it('mismatch → rewind and replay: a late input the server had to repeat', () => {
    const h = setup();
    run(h, 200);
    let lateTick = -1;
    // the server misses the client's input for one tick and repeats the previous one (docs/05 §13)
    let previous: Input = createInput();
    const kinds = run(h, 600, {
      serverInput: (tick, sent) => {
        const use = lateTick < 0 && (sent.buttons & Btn.Jet) !== (previous.buttons & Btn.Jet) ? previous : sent;
        if (use === previous && lateTick < 0) lateTick = tick;
        previous = { ...sent };
        return use;
      },
    });
    expect(lateTick).toBeGreaterThan(0);
    const firstMiss = kinds.findIndex((k) => k !== 'match');
    expect(kinds[firstMiss]).toBe('corrected');
    // after one replay the prediction is exact again: everything later matches
    expect(kinds.slice(firstMiss + 1).every((k) => k === 'match')).toBe(true);
    expect(h.pred.stats.mispredictions).toBe(1);
    expect(h.pred.stats.replayedTicks).toBeGreaterThan(5);
    expect(describeLocalDiff(h.pred.stateAt(h.server.tick - 1)!, captureLocalState(h.me, createLocalState()))).toBe('');
  });

  it('the visual error is smoothed over ~80 ms instead of popping', () => {
    const h = setup();
    run(h, 100);
    // knock the server's player sideways (an explosion the client could not predict)
    let kicked = false;
    const kinds = run(h, 120, {
      beforeServerStep: () => {
        if (kicked) return;
        h.me.vx += 6;
        kicked = true;
      },
    });
    expect(kinds).toContain('corrected');
    const offset = Math.hypot(h.pred.offset.x, h.pred.offset.y);
    expect(offset).toBeGreaterThan(VISIBLE_ERROR);
    const render = h.pred.renderPosition(0.5, { x: 0, y: 0 });
    expect(Math.hypot(render.x - h.pred.player.x, render.y - h.pred.player.y)).toBeGreaterThan(0);
    for (let f = 0; f < 6; f++) h.pred.decayOffset(1 / 60); // 100 ms
    expect(Math.hypot(h.pred.offset.x, h.pred.offset.y)).toBeLessThan(offset * 0.35);
    for (let f = 0; f < 30; f++) h.pred.decayOffset(1 / 60);
    expect(Math.hypot(h.pred.offset.x, h.pred.offset.y)).toBeLessThan(VISIBLE_ERROR);
  });

  it('damage from others is a misprediction but not a visible correction', () => {
    const h = setup();
    run(h, 100);
    let hit = false;
    const kinds = run(h, 60, {
      beforeServerStep: () => {
        if (hit) return;
        h.server.damage(h.me, 10, 0, 0, 1);
        hit = true;
      },
    });
    expect(kinds).toContain('mispredicted');
    expect(kinds).not.toContain('corrected');
    expect(h.pred.player.hp).toBe(h.me.hp);
  });

  it('death and respawn follow the server (spawn point included), then prediction is exact again', () => {
    const h = setup();
    run(h, 100);
    let killed = false;
    const kinds = run(h, 400, {
      beforeServerStep: () => {
        if (killed) return;
        h.server.damage(h.me, 1000, 0, 0, 1);
        killed = true;
      },
    });
    expect(h.me.alive).toBe(true); // respawned on the server (3 s)
    expect(kinds).toContain('snapped'); // respawn = teleport, not smoothed
    expect(h.pred.player.alive).toBe(true);
    const last = kinds.slice(-20);
    expect(last.every((k) => k === 'match')).toBe(true);
    expect(describeLocalDiff(h.pred.stateAt(h.server.tick - 1)!, captureLocalState(h.me, createLocalState()))).toBe('');
  });

  it('adopts the server state when a tick is no longer in the history', () => {
    const h = setup();
    run(h, 50);
    const server = captureLocalState(h.me, createLocalState());
    server[LS.x]! += 2048; // somewhere else entirely
    expect(h.pred.reconcile(h.pred.tick + 5, server)).toBe('adopted'); // server ahead of us
    expect(h.pred.tick).toBe(h.pred.lastAck + 1);
    expect(h.pred.player.x).toBe(server[LS.x]! / 1024);
    expect(h.pred.reconcile(h.pred.lastAck, server)).toBe('stale');
  });
});

describe('InputBuffer (server)', () => {
  it('serves each tick its own input, repeats when missing, drops late and too-early inputs', () => {
    const buf = new InputBuffer();
    const out = createInput();
    expect(buf.health(100)).toBe(HEALTH_UNKNOWN);
    buf.notePacket(102);
    for (const t of [102, 101, 100, 99]) buf.push(t, { ...createInput(), buttons: t }, 100);
    expect(buf.health(100)).toBe(2);
    expect(buf.take(100, out)).toBe(true);
    expect(out.buttons).toBe(100);
    expect(buf.take(101, out)).toBe(true);
    expect(buf.take(102, out)).toBe(true);
    expect(buf.take(103, out)).toBe(false); // never arrived → caller repeats `out` (102)
    expect(out.buttons).toBe(102);
    expect(buf.missed).toBe(1);
    expect(buf.push(103, createInput(), 104)).toBe(false); // late: the past is never rewritten
    expect(buf.push(104 + MAX_INPUT_LEAD, createInput(), 104)).toBe(false);
    expect(buf.refused).toBe(1);
    expect(buf.push(104 + MAX_INPUT_LEAD - 1, createInput(), 104)).toBe(true);
  });

  it('applies a press that arrived too late for its tick on the next one, once (docs/05 §13)', () => {
    const buf = new InputBuffer();
    const out = createInput();
    const press = (buttons: number) => ({ ...createInput(), buttons });
    buf.notePacket(100);
    buf.push(100, press(Btn.Right), 100);
    buf.take(100, out);
    expect(buf.forSim(100, out).buttons).toBe(Btn.Right);
    // 101–103 never arrive in time: the sim repeats Right
    for (const t of [101, 102, 103]) {
      expect(buf.take(t, out)).toBe(false);
      expect(buf.forSim(t, out).buttons).toBe(Btn.Right);
    }
    // a late packet: a dash tapped on 102, released on 103, and the on-time 104 (no dash)
    buf.notePacket(104);
    for (const [t, b] of [[104, Btn.Left], [103, Btn.Left], [102, Btn.Left | Btn.Dash], [101, Btn.Left]] as const) buf.push(t, press(b), 104);
    expect(buf.take(104, out)).toBe(true);
    const sim = buf.forSim(104, out);
    expect(sim.buttons).toBe(Btn.Left | Btn.Dash); // the dash happens, two ticks late
    expect(out.buttons).toBe(Btn.Left); // the input that repeats if 105 goes missing stays clean
    expect(buf.latched).toBe(1);
    // the same late inputs again (redundant copies): applied once only
    for (const [t, b] of [[103, Btn.Left], [102, Btn.Left | Btn.Dash]] as const) buf.push(t, press(b), 105);
    buf.push(105, press(Btn.Left), 105);
    buf.take(105, out);
    expect(buf.forSim(105, out).buttons).toBe(Btn.Left);
    expect(buf.latched).toBe(1);
  });

  it("doesn't latch what the sim already had down, or a held button (no press edge)", () => {
    const buf = new InputBuffer();
    const out = createInput();
    const press = (buttons: number) => ({ ...createInput(), buttons });
    buf.notePacket(200);
    buf.push(200, press(Btn.Fire), 200);
    buf.take(200, out);
    buf.forSim(200, out);
    buf.take(201, out); // missed: Fire repeated
    buf.forSim(201, out);
    buf.notePacket(202);
    buf.push(202, press(0), 202);
    buf.push(201, press(Btn.Fire), 202); // late, Fire held since 200: no new press
    buf.take(202, out);
    expect(buf.forSim(202, out).buttons).toBe(0);
    expect(buf.latched).toBe(0);
  });
});
