import { createTuning } from '@military-forge/content';
import { MsgType, encodeSnapshot, encodeWelcome } from '@military-forge/protocol';
import { Game } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { NetClient } from '../src';

function welcomed(resumed = false, client?: NetClient) {
  let now = 0;
  const net = client ?? new NetClient({ name: 't', send: () => {}, now: () => now });
  const game = new Game({ seed: 1, dummies: false });
  const me = game.addPlayer('t');
  net.onOpen();
  net.receive(
    encodeWelcome({
      playerId: me.id,
      seed: 1,
      serverTick: game.tick,
      mapId: game.map.id,
      tuningJson: JSON.stringify(createTuning()),
      sessionToken: 'tok',
      resumed,
    }),
  );
  return { net, game, me, advance: (ms: number) => (now += ms) };
}

describe('NetClient', () => {
  it('snapshot loss: nothing phantom at the 16-bit seq wrap, and a missed 15 Hz snapshot counts once', () => {
    const { net, game, advance } = welcomed();
    const feed = (seq: number) => {
      game.step([]);
      advance(33);
      expect(net.receive(encodeSnapshot(game, seq, []))?.type).toBe(MsgType.Snapshot);
    };
    for (const seq of [65533, 65534, 65535, 1, 2, 3]) feed(seq); // 0 is never used
    expect(net.stats().snapshotLossPct).toBe(0);
    // low-bandwidth: every other seq is someone else's; one missed snapshot = one lost of 5
    net.setLowBandwidth(true);
    for (const seq of [5, 7, 11, 13]) feed(seq);
    const s = net.stats();
    expect(s.snapshotLossPct).toBeCloseTo((100 * 1) / (9 + 1), 6);
  });

  it('a fresh rejoin (new server timeline) drops the old snapshots; a resume keeps them', () => {
    const { net, game, advance } = welcomed();
    for (let seq = 1; seq <= 5; seq++) {
      game.step([]);
      advance(33);
      net.receive(encodeSnapshot(game, seq, []));
    }
    expect(net.snapshots).toHaveLength(5);
    net.onClose();
    welcomed(true, net); // same player id: resumed
    expect(net.snapshots).toHaveLength(5);
    net.onClose();
    net.sessionToken = '';
    const fresh = new Game({ seed: 1, dummies: false });
    fresh.addPlayer('x');
    fresh.addPlayer('y'); // a different id: a fresh join
    net.onOpen();
    net.receive(
      encodeWelcome({
        playerId: 1,
        seed: 1,
        serverTick: 0,
        mapId: fresh.map.id,
        tuningJson: JSON.stringify(createTuning()),
        sessionToken: 'new',
        resumed: false,
      }),
    );
    expect(net.snapshots).toHaveLength(0);
  });
});
