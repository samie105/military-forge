/**
 * Spectating end to end (v20) on the simulated network: client A plays, client B joins as a
 * spectator and follows A. B never sends INPUT, gets A in every snapshot, draws A where A really
 * was the delay ago (the server's own record), keeps delta snapshots flowing with its acks, and
 * takes a player slot when it asks to play.
 */
import { MsgType, SnapshotDecoder } from '@military-forge/protocol';
import { symmetric, type RemotePose } from '@military-forge/netcode';
import { afterEach, describe, expect, it } from 'vitest';
import { setAdminValues } from '../src/adminState';
import { simulate } from './netsimHarness';

afterEach(() => setAdminValues({}));

describe('spectating end to end (simulated network)', () => {
  it('A plays, B spectates and follows A, 3 s behind; then B asks to play and gets a slot', () => {
    const trail = new Map<number, number>(); // server tick → A's x
    let aId = -1;
    const sent = { inputs: 0, acks: 0 };
    const pose: RemotePose = { x: 0, y: 0, src: null! };
    const errors: number[] = [];
    const lags: number[] = [];
    let deltas = 0;
    let snaps = 0;
    let played = false;
    const r = simulate(symmetric(120, 1, 5), 20, {
      warmupSeconds: 2,
      room: { dummies: false, aoi: true },
      spectate: [1],
      onSend: (k, b, now) => {
        if (k !== 1 || now >= 15_000) return; // while it watches
        if (b[0] === MsgType.Input) sent.inputs++;
        if (b[0] === MsgType.SpectateAck) sent.acks++;
      },
      afterTick: (room, nets) => {
        aId = nets[0]!.myId;
        const a = room.game.players[aId];
        if (a) trail.set(room.game.tick, a.x);
      },
      onFrame: (k, now, net) => {
        if (k !== 1) return;
        if (net.spectating && now > 6000 && now < 15_000) {
          const newest = net.snapshots.at(-1);
          if (!newest) return;
          const tick = net.remoteRenderTick(now);
          if (net.remotePose(aId, tick, pose)) {
            const at = trail.get(Math.round(tick));
            if (at !== undefined) errors.push(Math.abs(pose.x - at));
          }
          if (now % 500 < 17) {
            snaps++;
            if (newest.msg.baselineSeq !== 0) deltas++;
            lags.push(trail.size > 0 ? Math.max(...trail.keys()) - tick : 0);
          }
        }
        // at 15 s B asks for a slot (the room has plenty)
        if (now >= 15_000 && !played) {
          played = true;
          net.follow(aId);
          net.play('now');
        }
      },
    });
    const [a, b] = r.clients;
    // B watched: no player, no INPUT, acks instead
    expect(errors.length).toBeGreaterThan(300);
    expect(sent.inputs).toBe(0);
    expect(sent.acks).toBeGreaterThan(200);
    // B drew A where A really was: within a few cm of the server's own record at B's render tick
    errors.sort((x, y) => x - y);
    expect(errors[Math.floor(errors.length * 0.95)]!).toBeLessThan(0.25);
    // …which is about 3 s (180 ticks) plus the interpolation delay behind the room
    const lag = lags.reduce((s, x) => s + x, 0) / lags.length;
    expect(lag).toBeGreaterThan(180);
    expect(lag).toBeLessThan(200);
    expect(deltas / snaps).toBeGreaterThan(0.9);
    // and then B plays: a player of its own, predicting, on the same connection
    expect(b!.net.spectating).toBe(false);
    expect(b!.net.joined).toBe(true);
    expect(b!.net.myId).not.toBe(a!.net.myId);
    expect(b!.net.predictor?.started).toBe(true);
    expect(b!.server.spectator).toBe(false);
    expect(new SnapshotDecoder().size).toBe(64);
  });
});
