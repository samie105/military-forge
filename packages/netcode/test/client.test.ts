import { FRAG, K47, adminField, createTuning } from '@military-forge/content';
import { CmdKind, MsgType, decodeMessage, encodeOverrides, encodePong, encodeRoster, encodeSnapshot, encodeWelcome } from '@military-forge/protocol';
import { Game } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { NetClient, REMOTE_EXTRAPOLATE_TICKS, extrapolationTicks, swingAt } from '../src';

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
      overridesJson: '{}',
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

  it('switching low-bandwidth mode off: the 15 Hz snapshots still in flight are not counted as lost', () => {
    const { net, game, advance } = welcomed();
    const now = advance(1000);
    for (let i = 0; i < 5; i++) net.receive(encodePong(now - 150, 0)); // 150 ms RTT
    net.setLowBandwidth(true);
    let seq = 1;
    const feed = (step: number) => {
      seq += step;
      game.step([]);
      advance(66);
      net.receive(encodeSnapshot(game, seq, []));
    };
    for (let i = 0; i < 10; i++) feed(2);
    net.setLowBandwidth(false);
    feed(2); // sent before the server saw the CMD
    feed(2);
    advance(1000);
    for (let i = 0; i < 10; i++) feed(1); // full rate again
    expect(net.stats().snapshotLossPct).toBe(0);
    feed(2); // a real loss is still a loss
    expect(net.stats().snapshotLossPct).toBeGreaterThan(0);
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
        overridesJson: '{}',
      }),
    );
    expect(net.snapshots).toHaveLength(0);
  });

  it('starts a new prediction timeline when a room changes maps', () => {
    const { net, game, advance } = welcomed();
    game.step([]);
    advance(33);
    net.receive(encodeSnapshot(game, 1, []));
    const oldPrediction = net.predictor;
    net.receive(encodeWelcome({
      playerId: net.myId,
      seed: game.seed,
      serverTick: game.tick,
      mapId: 'lunar-outpost',
      tuningJson: JSON.stringify(createTuning()),
      sessionToken: 'same-room',
      resumed: false,
      overridesJson: '{}',
    }));
    expect(net.map.id).toBe('lunar-outpost');
    expect(net.predictor).not.toBe(oldPrediction);
    expect(net.snapshots).toHaveLength(0);
  });

  it('a reused id is never drawn at the departed player\'s poses', () => {
    const { net, game, me, advance } = welcomed();
    const leaver = game.addPlayer('leaver');
    const id = leaver.id;
    leaver.x = 149;
    // ROSTER since: the room's rule (shown from the tick after the one it joined in)
    const since = new Map<object, number>();
    const added = (p: object) => since.set(p, game.tick + 1);
    added(me);
    added(leaver);
    let seq = 0;
    const snapshot = () => {
      game.step([]);
      advance(33);
      net.receive(encodeSnapshot(game, ++seq, []));
    };
    const roster = () =>
      net.receive(encodeRoster(game.players.filter((p) => p !== null).map((p) => ({ id: p.id, name: p.name, isBot: false, since: since.get(p) ?? 0 }))));
    roster();
    for (let i = 0; i < 6; i++) snapshot();
    const before = net.snapshots.at(-1)!.msg.serverTick;
    game.removePlayer(id);
    roster();
    const joiner = game.addPlayer('joiner');
    added(joiner);
    expect(joiner.id).toBe(id);
    joiner.x = 120;
    roster();
    const pose: Parameters<typeof net.remotePose>[2] = { x: 0, y: 0, src: null!, meleeTicks: 0 };
    expect(net.remotePose(id, before - 2, pose)).toBeNull(); // not in any snapshot yet: not drawn
    snapshot();
    snapshot();
    // a render tick from the leaver's time: the joiner at its newest pose, not the leaver's spot
    expect(net.remotePose(id, before - 2, pose)?.x).toBeCloseTo(joiner.x, 3);
    // other players are unaffected
    expect(net.remotePose(me.id, before - 2, pose)).not.toBeNull();
  });
});

describe('NetClient: the admin page\'s overrides (v13)', () => {
  it('a WELCOME\'s and an OVERRIDES\' values go into this page\'s content; leaving puts the shipped ones back', () => {
    let now = 0;
    const net = new NetClient({ name: 't', send: () => {}, now: () => now });
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
        resumed: false,
        overridesJson: JSON.stringify({ 'weapon.k47.damage': 33, 'tuning.gravity': 10, 'pickups.armoryRespawn': 9 }),
      }),
    );
    expect(K47.damage).toBe(33);
    expect(net.adminTuned).toBe(true);
    now += 100;
    net.receive(encodeOverrides(JSON.stringify({ [`grenade.${FRAG.id}.fuse`]: 2.5 })));
    expect([K47.damage, FRAG.fuse]).toEqual([adminField('weapon.k47.damage')!.def, 2.5]);
    net.receive(encodeOverrides('not json'));
    expect(net.adminTuned).toBe(false);
    expect(FRAG.fuse).toBe(adminField(`grenade.${FRAG.id}.fuse`)!.def);
    net.receive(encodeOverrides('{"weapon.k47.damage": 40}'));
    net.clearOverrides();
    expect([K47.damage, net.adminTuned]).toEqual([adminField('weapon.k47.damage')!.def, false]);
  });
});

describe('NetClient: content shared with the server (one process)', () => {
  it('ownContent false: the values are recorded, the shared content is left to the server', () => {
    const net = new NetClient({ name: 't', send: () => {}, now: () => 0, ownContent: false });
    const game = new Game({ seed: 1, dummies: false });
    const me = game.addPlayer('t');
    net.onOpen();
    net.receive(
      encodeWelcome({
        playerId: me.id,
        seed: 1,
        serverTick: 0,
        mapId: game.map.id,
        tuningJson: JSON.stringify(createTuning()),
        sessionToken: 'tok',
        resumed: false,
        overridesJson: '{"weapon.k47.damage": 33}',
      }),
    );
    expect(net.adminTuned).toBe(true);
    expect(K47.damage).toBe(adminField('weapon.k47.damage')!.def);
    net.clearOverrides();
    expect(K47.damage).toBe(adminField('weapon.k47.damage')!.def);
  });

  it("a host's tuning edit made while disconnected goes out with the next WELCOME, and stays ours (the audit, L8)", () => {
    const sent: Uint8Array[] = [];
    const net = new NetClient({ name: 't', send: (b) => sent.push(b), now: () => 0 });
    welcomed(false, net);
    net.onClose(); // the connection dropped
    sent.length = 0;
    net.setTuning(createTuning({ gravity: 9 }));
    expect(sent.length).toBe(0); // nowhere to send it: kept
    expect(net.tuning.gravity).toBe(9); // our prediction has it already
    welcomed(true, net); // back: the room's WELCOME still says the old gravity
    const cmds = sent.map((b) => decodeMessage(b)).filter((m) => m.type === MsgType.Cmd);
    expect(cmds.some((m) => m.type === MsgType.Cmd && m.kind === CmdKind.SetTuning && JSON.parse(m.payload).gravity === 9)).toBe(true);
    expect(net.tuning.gravity).toBe(9);
    expect(net.pendingTuning).toBeNull();
  });
});

describe('a remote swing at the render tick (v16)', () => {
  it('counts on from the snapshots, starts between them, and ends', () => {
    expect(swingAt(0, 100, 0, 102, 101)).toBe(0); // idle
    expect(swingAt(3, 100, 5, 102, 101)).toBe(4); // one swing, between its snapshots
    expect(swingAt(3, 100, 5, 102, 101.5)).toBe(4.5); // fractional render ticks
    expect(swingAt(0, 100, 2, 102, 101.5)).toBe(1.5); // started at 101: shown from then
    expect(swingAt(0, 100, 2, 102, 100.5)).toBe(0); // not yet
    expect(swingAt(35, 100, 0, 102, 101)).toBe(36); // ending within the gap: carried at most the gap
    expect(swingAt(35, 100, 1, 102, 101)).toBe(36); // a fresh swing at 102: the old one until then
  });
});

describe('a remote player past the newest snapshot (a late or lost one)', () => {
  it('is carried on along its velocity for a moment, slowing to a stop, then held; never into a wall; a dead one stays put', () => {
    const { net, game, me, advance } = welcomed();
    const runner = game.addPlayer('runner');
    // runs right at the thin wall of the shooting range (x 160–160.4)
    runner.x = 158.9;
    runner.y = 0;
    let seq = 0;
    const snapshot = () => {
      runner.vx = 6;
      game.step([]);
      advance(33);
      net.receive(encodeSnapshot(game, ++seq, []));
    };
    net.receive(encodeRoster([me, runner].map((p) => ({ id: p.id, name: p.name, isBot: false, since: 0 }))));
    for (let i = 0; i < 4; i++) snapshot();
    const newest = net.snapshots.at(-1)!.msg;
    const pb = newest.players.find((p) => p.id === runner.id)!;
    expect(pb.vx).toBeGreaterThan(3);
    const pose: Parameters<typeof net.remotePose>[2] = { x: 0, y: 0, src: null!, meleeTicks: 0 };
    const at = (ahead: number) => net.remotePose(runner.id, newest.serverTick + ahead, pose)!.x;
    expect(at(0)).toBeCloseTo(pb.x, 6);
    // full speed for 3 ticks, then slowing: 6 ticks of motion at most, from 9 ticks on
    expect([0, 1, 3, 6, 9, 12].map(extrapolationTicks)).toEqual([0, 1, 3, 5.25, 6, 6]);
    expect(at(2)).toBeCloseTo(pb.x + (pb.vx * 2) / 60, 6);
    expect(at(REMOTE_EXTRAPOLATE_TICKS)).toBeCloseTo(at(REMOTE_EXTRAPOLATE_TICKS + 30), 9); // then held
    // 6 ticks at its speed would take it into the wall: it stops a body's half-width short
    expect(pb.x + (pb.vx * 6) / 60).toBeGreaterThan(160 - 0.35);
    expect(at(REMOTE_EXTRAPOLATE_TICKS)).toBeCloseTo(160 - 0.35, 3);
    // a dead player isn't carried on
    runner.alive = false;
    snapshot();
    const last = net.snapshots.at(-1)!.msg;
    const dead = last.players.find((p) => p.id === runner.id)!;
    expect(net.remotePose(runner.id, last.serverTick + 5, pose)!.x).toBe(dead.x);
  });
});
