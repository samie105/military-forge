import {
  CloseCode,
  CmdKind,
  MsgType,
  HEALTH_UNKNOWN,
  LS,
  SnapshotDecoder,
  decodeMessage,
  encodeCmd,
  encodeHello,
  encodePing,
  encodeInput,
  type Message,
  type SnapshotMsg,
  type TuningMsg,
  type WelcomeMsg,
} from '@military-forge/protocol';
import { Btn, createHitPose, createInput } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { HOLD_TICKS, Room, type ClientConn } from '../src/room';

class FakeConn implements ClientConn {
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  /** like uWS: the socket's close handler runs synchronously inside close() */
  onClose: (() => void) | null = null;
  send(bytes: Uint8Array) {
    this.sent.push(bytes);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
    this.onClose?.();
  }
  bufferedAmount() {
    return 0;
  }
  messages(): Message[] {
    return this.sent.map((b) => decodeMessage(b));
  }
  last<T extends Message['type']>(type: T): Extract<Message, { type: T }> | undefined {
    return this.messages()
      .filter((m): m is Extract<Message, { type: T }> => m.type === type)
      .at(-1);
  }
}

function join(room: Room, name: string, resumeToken = '') {
  const conn = new FakeConn();
  const client = room.connect(conn);
  room.receive(client, encodeHello(name, resumeToken));
  const welcome = conn.last(MsgType.Welcome) as WelcomeMsg;
  return { conn, client, welcome };
}

/**
 * Sends like a real client: the input for server tick `tick` (newest first), plus up to 2 earlier
 * ones it actually sampled (redundancy).
 */
const histories = new WeakMap<object, ReturnType<typeof createInput>[]>();
function inputPacket(client: ReturnType<typeof join>['client'], tick: number, buttons: number): Uint8Array {
  const history = histories.get(client) ?? [];
  history.unshift({ ...createInput(), buttons });
  if (history.length > 3) history.pop();
  histories.set(client, history);
  return encodeInput({ newestTick: tick, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: history });
}
function sendInput(room: Room, client: ReturnType<typeof join>['client'], tick: number, buttons: number) {
  room.receive(client, inputPacket(client, tick, buttons));
}

describe('Room', () => {
  it('lets the host switch maps in the lobby and resynchronizes every connected player', () => {
    const room = new Room({ dummies: false, match: { minPlayers: 1 } });
    const host = join(room, 'Host');
    const guest = join(room, 'Guest');
    room.receive(guest.client, encodeCmd(CmdKind.MatchSettings, JSON.stringify({ mapId: 'lunar-outpost' })));
    expect(room.game.map.id).toBe('movement-test');
    room.receive(host.client, encodeCmd(CmdKind.MatchSettings, JSON.stringify({ mapId: 'lunar-outpost' })));
    expect(room.game.map.id).toBe('lunar-outpost');
    for (const player of [host, guest]) {
      expect(player.conn.last(MsgType.Welcome)?.mapId).toBe('lunar-outpost');
      expect(player.conn.last(MsgType.Welcome)?.playerId).toBe(player.welcome.playerId);
    }
    room.tick();
    expect(room.encodeMatchState()).toBeDefined();
  });

  it('welcomes two players with distinct ids and a roster including the dummies', () => {
    const room = new Room({ dummies: true });
    const a = join(room, 'Ade');
    const b = join(room, 'Kemi');
    expect(a.welcome.playerId).not.toBe(b.welcome.playerId);
    expect(a.welcome.mapId).toBe('movement-test');
    const roster = a.conn.last(MsgType.Roster)!;
    expect(roster.entries.map((e) => e.name)).toEqual(expect.arrayContaining(['Ade', 'Kemi', 'Strafer', 'Jetter']));
  });

  it('inputs move the player; both clients see it in 30 Hz snapshots', () => {
    const room = new Room({ dummies: false, aoi: false }); // they spawn at opposite ends of the map
    const a = join(room, 'A');
    const b = join(room, 'B');
    const start = room.game.players[a.welcome.playerId]!.x;
    for (let t = 1; t <= 60; t++) {
      sendInput(room, a.client, t, Btn.Right); // one tick early: health 1
      room.tick();
    }
    const snapA = a.conn.last(MsgType.Snapshot) as SnapshotMsg;
    const snapB = b.conn.last(MsgType.Snapshot) as SnapshotMsg;
    const seenByB = snapB.players.find((p) => p.id === a.welcome.playerId)!;
    expect(seenByB.x).toBeGreaterThan(start + 4);
    expect(snapA.serverTick).toBe(60);
    expect(snapA.ackInputTick).toBe(59); // the local block is the state after tick 59
    expect(snapA.inputBufferHealth).toBe(1);
    expect(snapA.local![LS.x]).toBe(Math.round(room.game.players[a.welcome.playerId]!.x * 1024));
    expect(snapB.inputBufferHealth).toBe(HEALTH_UNKNOWN); // B never sent anything
    expect(snapB.local![LS.x]).not.toBe(snapA.local![LS.x]);
    expect(a.conn.messages().filter((m) => m.type === MsgType.Snapshot).length).toBe(30);
  });

  it('AOI: a far player is not sent until it walks into view; then deltas against acked baselines', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'A');
    const b = join(room, 'B');
    const pa = room.game.players[a.welcome.playerId]!;
    const pb = room.game.players[b.welcome.playerId]!;
    pa.x = 8.5; // flat ground between the 0.2 m and 0.5 m ledges
    pb.x = 150;
    const decoder = new SnapshotDecoder();
    const seen = () => {
      const bytes = a.conn.sent.at(-1)!;
      const snap = decoder.decode(bytes);
      room.receive(a.client, encodeInput({ newestTick: room.game.tick, ackSnapshotSeq: snap.seq, renderTick: 0, renderFrac: 0, inputs: [createInput()] }));
      return snap;
    };
    for (let i = 0; i < 4; i++) room.tick();
    const far = seen();
    expect(far.players.map((p) => p.id)).toEqual([pa.id]);
    pb.x = 20.5; // flat ground, 12 m away: in view
    for (let i = 0; i < 30; i++) room.tick(); // land and settle
    seen();
    for (let i = 0; i < 2; i++) room.tick();
    const near = seen();
    expect(near.baselineSeq).not.toBe(0);
    expect(near.players.find((p) => p.id === pb.id)?.x).toBe(pb.x);
    for (let i = 0; i < 2; i++) room.tick();
    const still = seen(); // nothing moved: a few bytes
    expect(still.players).toEqual(near.players);
    expect(a.conn.sent.at(-1)!.length).toBeLessThan(40);
  });

  it('uses each input on its own tick, ignores redundant copies; a silent client is held, then lets go', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'A');
    const id = a.welcome.playerId;
    sendInput(room, a.client, 1, Btn.Right);
    sendInput(room, a.client, 2, Btn.Right); // carries ticks 2 and 1
    expect([a.client.inputs.has(0), a.client.inputs.has(1), a.client.inputs.has(2)]).toEqual([false, true, true]);
    room.tick(); // tick 0: nothing for it, but newer ones are here (lost, not late): the last input (idle)
    expect(room.game.players[id]!.vx).toBe(0);
    room.tick(); // tick 1
    room.tick(); // tick 2
    expect(a.client.inputs.used).toBe(2);
    expect(room.game.players[id]!.vx).toBeGreaterThan(0);
    // no new inputs: the player is held (they may yet come) and keeps its speed…
    const vx = room.game.players[id]!.vx;
    for (let i = 0; i < HOLD_TICKS - 1; i++) room.tick();
    expect(room.game.players[id]!.vx).toBe(vx);
    // …then the hold runs out: the missing ticks run with no keys (silent longer than MAX_REPEAT_TICKS)
    for (let i = 0; i < 40; i++) room.tick();
    expect(room.game.players[id]!.vx).toBe(0);
    expect(a.client.inputs.missed).toBeGreaterThan(HOLD_TICKS);
  });

  it('reports how early inputs arrive (min over the snapshot interval); late ones run, in order, behind (the catch-up)', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'A');
    const health = () => (a.conn.last(MsgType.Snapshot) as SnapshotMsg).inputBufferHealth;
    for (let i = 0; i < 20; i++) {
      sendInput(room, a.client, room.game.tick + 3, Btn.Right); // 3 spare ticks queued
      room.tick();
    }
    expect(health()).toBe(3);
    for (let i = 0; i < 20; i++) {
      sendInput(room, a.client, room.game.tick - 2, Btn.Left); // late: already simulated
      room.tick();
    }
    expect(health()).toBeLessThanOrEqual(-2);
    // the late "left" inputs ran (the player held for them, then caught up), and the snapshot says
    // which input its state stands at: behind the room's tick
    expect(room.game.players[a.welcome.playerId]!.vx).toBeLessThan(0);
    const snap = a.conn.last(MsgType.Snapshot) as SnapshotMsg;
    expect(snap.ackInputTick).toBeLessThan(snap.serverTick - 1);
  });

  it('INPUT decode is pooled: oversized or truncated packets are strikes', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'A');
    room.receive(a.client, new Uint8Array(65).fill(MsgType.Input));
    room.receive(a.client, Uint8Array.of(MsgType.Input, 1));
    expect(a.client.strikes).toBe(2);
  });

  it('refuses mismatched protocol versions', () => {
    const room = new Room();
    const conn = new FakeConn();
    const client = room.connect(conn);
    const hello = encodeHello('old');
    hello[1] = 99; // corrupt the protocol version
    room.receive(client, hello);
    expect(conn.closed?.code).toBe(CloseCode.VersionMismatch);
  });

  it('kicks clients that keep sending garbage', () => {
    const room = new Room();
    const a = join(room, 'A');
    for (let i = 0; i < 3; i++) room.receive(a.client, Uint8Array.from([0x77, 1, 2]));
    expect(a.conn.closed?.code).toBe(CloseCode.BadMessage);
    expect(room.game.players[a.welcome.playerId]).toBeNull();
  });

  it('enforces the room size', () => {
    const room = new Room({ maxHumans: 2, dummies: false });
    join(room, 'A');
    join(room, 'B');
    const c = join(room, 'C');
    expect(c.conn.closed?.code).toBe(CloseCode.RoomFull);
  });

  it("host tuning (pnpm playtest --tune): the host's edits reach everyone, within the panel's ranges; nobody else's", () => {
    const room = new Room({ dummies: false, dev: false, match: { countdown: 1 }, hostTuning: true });
    const a = join(room, 'A');
    const b = join(room, 'B');
    expect(room.hostId).toBe(a.welcome.playerId);
    const tuningSeen = (c: FakeConn) => c.sent.filter((m) => decodeMessage(m).type === MsgType.Tuning).length;
    room.receive(a.client, encodeCmd(CmdKind.SetTuning, JSON.stringify({ gravity: 25, fuelMax: 1e9, capsuleRadius: 0.01, grenadeThrowScale: 1.3 })));
    expect(room.game.tuning).toMatchObject({ gravity: 25, fuelMax: 300, capsuleRadius: 0.32, grenadeThrowScale: 1.3 });
    expect(JSON.parse((b.conn.last(MsgType.Tuning) as TuningMsg).tuningJson)).toMatchObject({ gravity: 25, fuelMax: 300 });
    // the host asked for more than the panel allows: it hears what the room took (#L8)
    expect(tuningSeen(a.conn)).toBe(1);
    expect(JSON.parse((a.conn.last(MsgType.Tuning) as TuningMsg).tuningJson)).toMatchObject({ fuelMax: 300, capsuleRadius: 0.32 });
    // an edit the room takes as it is: the host predicts with it already, nothing comes back
    room.receive(a.client, encodeCmd(CmdKind.SetTuning, JSON.stringify({ ...room.game.tuning, gravity: 24 })));
    expect(room.game.tuning.gravity).toBe(24);
    expect(tuningSeen(a.conn)).toBe(1);
    // a guest can't: the room keeps its tuning, and the guest's prediction is put back to it
    const before = tuningSeen(b.conn);
    room.receive(b.client, encodeCmd(CmdKind.SetTuning, JSON.stringify({ gravity: 5 })));
    expect(room.game.tuning.gravity).toBe(24);
    expect(tuningSeen(b.conn)).toBe(before + 1);
    expect(JSON.parse((b.conn.last(MsgType.Tuning) as TuningMsg).tuningJson)).toMatchObject({ gravity: 24 });
    expect(b.conn.closed).toBeNull();
  });

  it('a room without host tuning (normal production) takes no tuning from anyone, the host included', () => {
    const room = new Room({ dummies: false, dev: false, match: { countdown: 1 } });
    const a = join(room, 'A');
    const b = join(room, 'B');
    expect(room.hostId).toBe(a.welcome.playerId);
    room.receive(a.client, encodeCmd(CmdKind.SetTuning, JSON.stringify({ gravity: 25 })));
    expect(room.game.tuning.gravity).toBe(20);
    for (const c of [a.conn, b.conn]) expect(c.sent.some((m) => decodeMessage(m).type === MsgType.Tuning)).toBe(false);
  });

  it('dev command: live tuning changes the simulation', () => {
    const room = new Room({ dummies: false, dev: true });
    const a = join(room, 'A');
    const b = join(room, 'B');
    room.receive(a.client, encodeCmd(CmdKind.SetTuning, JSON.stringify({ walkMax: 9, notATuningKey: 1 })));
    expect(room.game.tuning.walkMax).toBe(9);
    // the other clients predict with the room's tuning, so they hear about it
    expect(JSON.parse((b.conn.last(MsgType.Tuning) as TuningMsg).tuningJson)).toMatchObject({ walkMax: 9 });
    let peak = 0;
    for (let t = 1; t <= 40; t++) {
      sendInput(room, a.client, t, Btn.Right);
      room.tick();
      peak = Math.max(peak, room.game.players[a.welcome.playerId]!.vx);
    }
    expect(peak).toBeCloseTo(9, 2);
  });

  it('low-bandwidth mode: 15 Hz snapshots that still carry the skipped interval\'s events', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'A');
    const b = join(room, 'B');
    room.receive(a.client, encodeCmd(CmdKind.SetLowBandwidth, '1'));
    // snapshots only (a v20 page also hears SPECTATE now and then)
    const snaps = () => a.conn.messages().filter((m) => m.type === MsgType.Snapshot).length;
    const before = snaps();
    for (let i = 0; i < 4; i++) room.tick(); // ticks 1–4: snapshots at 2 and 4 for B, only 4 for A
    expect(snaps() - before).toBe(1);
    // B dies in an interval A skips: A still hears about it
    while (room.game.tick % 4 !== 1) room.tick();
    room.game.players[b.welcome.playerId]!.y = room.game.map.bounds.minY; // fell out of the map
    room.tick(); // the hazard kills B here; B's snapshot (next tick) carries the death, A's doesn't
    room.tick();
    room.tick();
    room.tick();
    const deaths = a.conn.messages().filter((m): m is SnapshotMsg => m.type === MsgType.Snapshot).flatMap((m) => m.events.filter((e) => e.type === 'death'));
    expect(deaths).toHaveLength(1);
    room.receive(a.client, encodeCmd(CmdKind.SetLowBandwidth, '0'));
    const n = snaps();
    for (let i = 0; i < 4; i++) room.tick();
    expect(snaps() - n).toBe(2);
  });

  it('clients get the room\'s snapshot rate, and half of it in low-bandwidth mode', () => {
    const room = new Room({ dummies: false, snapshotEvery: 3 });
    const a = join(room, 'A');
    const snapshots = () => a.conn.messages().filter((m) => m.type === MsgType.Snapshot).length;
    while (room.game.tick % 6 !== 0) room.tick();
    let n = snapshots();
    for (let i = 0; i < 60; i++) room.tick();
    expect(snapshots() - n).toBe(20);
    room.receive(a.client, encodeCmd(CmdKind.SetLowBandwidth, '1'));
    n = snapshots();
    for (let i = 0; i < 60; i++) room.tick();
    expect(snapshots() - n).toBe(10);
  });

  it('low-bandwidth mode earns its wider rewind cap only after a second in it, and loses it at once', () => {
    const room = new Room({ dummies: false, dev: false });
    const a = join(room, 'A');
    const b = join(room, 'B');
    for (let i = 0; i < 40; i++) room.tick(); // pose history
    const lc = room.lagComp!;
    const shooter = room.game.players[a.welcome.playerId]!;
    const target = room.game.players[b.welcome.playerId]!;
    const out = createHitPose();
    /**
     * One tick whose input reports a view 27.5 ticks (458 ms) old: was it clamped? The cap is 250 ms
     * on top of the most the view delay can be: 200 ms (27 ticks), or in low-bandwidth mode 200 ms
     * + 1 tick of batching (28 ticks).
     */
    const clampedAt28 = () => {
      const t = room.game.tick;
      room.receive(a.client, encodeInput({ newestTick: t, ackSnapshotSeq: 0, renderTick: t - 28, renderFrac: 128, inputs: [createInput()] }));
      room.tick();
      const before = lc.clamped;
      lc.pose(target, shooter, out);
      return lc.clamped > before;
    };
    expect(clampedAt28()).toBe(true); // 450 ms cap
    room.receive(a.client, encodeCmd(CmdKind.SetLowBandwidth, '1'));
    expect(clampedAt28()).toBe(true); // just switched on: not yet
    for (let i = 0; i < 60; i++) room.tick();
    expect(clampedAt28()).toBe(false); // a second later: 200 ms view delay + 1 tick + 250 ms
    room.receive(a.client, encodeCmd(CmdKind.SetLowBandwidth, '0'));
    expect(clampedAt28()).toBe(true); // off: at once
  });

  it('CMDs beyond 20/s (bursts of 20) are dropped, never strikes; SetLowBandwidth is never dropped', () => {
    const room = new Room({ dummies: false, dev: true, snapshotEvery: 2 });
    const a = join(room, 'A');
    const tuning = (walkMax: number) => encodeCmd(CmdKind.SetTuning, JSON.stringify({ walkMax }));
    for (let round = 0; round < 5; round++) {
      // a burst of 20 is fine; the 21st is dropped
      for (let i = 0; i < 20; i++) room.receive(a.client, tuning(5));
      room.receive(a.client, tuning(7));
      expect(room.game.tuning.walkMax).toBe(5);
      // the mode switch still lands: client and server agree on it
      room.receive(a.client, encodeCmd(CmdKind.SetLowBandwidth, round % 2 ? '0' : '1'));
      expect(a.client.snapshotEvery).toBe(round % 2 ? 2 : 4);
      for (let i = 0; i < 60; i++) room.tick(); // a second refills the bucket
    }
    expect(a.conn.closed).toBeNull();
    expect(a.client.strikes).toBe(0);
    room.receive(a.client, tuning(7));
    expect(room.game.tuning.walkMax).toBe(7);
  });

  it('a 15 s stall\'s backlog arrives at once: excess INPUTs are dropped, the newest still lands, no kick', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'A');
    // like the real server: the allowance refills once a second
    const play = (seconds: number, buttons: number) => {
      for (let t = 0; t < seconds * 60; t++) {
        sendInput(room, a.client, room.game.tick + 2, buttons);
        room.tick();
        if (room.game.tick % 60 === 0) room.resetRateLimits();
      }
    };
    play(2, Btn.Right);
    // the connection stalls: the client keeps sending 60 INPUTs and a PING a second (no
    // client-side thinning), the server hears nothing, then TCP hands everything over at once
    const backlog: Uint8Array[] = [];
    for (let t = 0; t < 15 * 60; t++) {
      const last = t >= 15 * 60 - 2;
      backlog.push(inputPacket(a.client, room.game.tick + 2, last ? Btn.Jet : Btn.Left));
      if (t % 60 === 0) backlog.push(encodePing(t));
      room.tick();
      if (room.game.tick % 60 === 0) room.resetRateLimits();
    }
    for (const b of backlog) room.receive(a.client, b);
    expect(a.conn.closed).toBeNull();
    expect(a.client.inputsDropped).toBeGreaterThan(600);
    expect(a.conn.last(MsgType.Pong)).toBeDefined();
    room.tick();
    expect(a.client.lastInput.buttons).toBe(Btn.Jet); // the newest input, not a stale one
    // and play goes on as before: every tick's input arrives in time, nothing is held against it
    const missed = a.client.inputs.missed;
    play(5, Btn.Right);
    expect(a.conn.closed).toBeNull();
    expect(a.client.inputs.missed).toBe(missed);
    expect(a.client.inputFloodSeconds).toBe(0);
  });

  it('a real flood is still kicked: INPUTs over the limit 10 s in a row, or a burst of other messages', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'A');
    let seconds = 0;
    while (!a.conn.closed && seconds < 30) {
      for (let i = 0; i < 300; i++) sendInput(room, a.client, room.game.tick + 2, Btn.Right);
      room.tick();
      room.resetRateLimits();
      seconds++;
    }
    expect(a.conn.closed?.code).toBe(CloseCode.RateLimited);
    expect(seconds).toBe(10);
    // INPUTs have their own allowance: they don't use up the other messages', and vice versa
    const b = join(room, 'B');
    for (let i = 0; i < 1000; i++) sendInput(room, b.client, room.game.tick + 2, Btn.Right);
    for (let i = 0; i < 300; i++) room.receive(b.client, encodePing(i));
    expect(b.conn.closed).toBeNull();
    for (let i = 0; i < 400; i++) room.receive(b.client, encodePing(i));
    expect(b.conn.closed?.code).toBe(CloseCode.RateLimited);
  });

  it('ROSTER since is the first snapshot tick that shows the player (ids are reused)', () => {
    const room = new Room({ dummies: false, aoi: false });
    const a = join(room, 'A');
    for (let i = 0; i < 7; i++) room.tick();
    const b = join(room, 'B');
    const since = a.conn.last(MsgType.Roster)!.entries.find((e) => e.id === b.welcome.playerId)!.since;
    for (let i = 0; i < 4; i++) room.tick();
    const dec = new SnapshotDecoder();
    const snaps = a.conn.sent.filter((bytes) => bytes[0] === MsgType.Snapshot).map((bytes) => dec.decode(bytes));
    const first = snaps.find((m) => m.players.some((p) => p.id === b.welcome.playerId))!;
    expect(first.serverTick).toBe(snaps.find((m) => m.serverTick >= since)!.serverTick); // the first snapshot from `since` on
    expect(snaps.filter((m) => m.serverTick < since).every((m) => !m.players.some((p) => p.id === b.welcome.playerId))).toBe(true);
  });

  describe('sessions (reconnect, docs/05 §13)', () => {
    it('a dropped player stands idle for the grace, then the token brings it back with a full resync', () => {
      const room = new Room({ dummies: false, reconnectGraceMs: 20_000 });
      const a = join(room, 'Ade');
      const b = join(room, 'Kemi');
      const id = a.welcome.playerId;
      expect(a.welcome.resumed).toBe(false);
      expect(a.welcome.sessionToken.length).toBeGreaterThan(16);
      for (let t = 1; t <= 30; t++) {
        sendInput(room, a.client, room.game.tick + 1, Btn.Right);
        room.tick();
      }
      room.disconnect(a.client); // the socket closed
      expect(room.game.players[id]).not.toBeNull();
      expect(room.humanCount).toBe(2); // keeps its slot
      for (let i = 0; i < 120; i++) room.tick(); // 2 s: it stops walking (idle input), still there
      expect(room.game.players[id]!.vx).toBe(0);
      expect(b.conn.last(MsgType.Roster)!.entries.some((e) => e.id === id)).toBe(true);

      const again = join(room, 'Ade', a.welcome.sessionToken);
      expect(again.welcome).toMatchObject({ playerId: id, resumed: true });
      expect(again.welcome.sessionToken).not.toBe(a.welcome.sessionToken); // rotated
      expect(again.conn.last(MsgType.Roster)).toBeDefined();
      room.tick();
      room.tick();
      const snap = again.conn.last(MsgType.Snapshot) as SnapshotMsg;
      expect(snap.baselineSeq).toBe(0); // full: the new connection has no baselines
      expect(snap.local![LS.x]).toBe(Math.round(room.game.players[id]!.x * 1024));
      // once the new connection shows it has the new token (any PING/INPUT), the old one is spent
      room.receive(again.client, encodePing(0));
      const thief = join(room, 'Ade', a.welcome.sessionToken);
      expect(thief.welcome.playerId).not.toBe(id);
      expect(thief.welcome.resumed).toBe(false);
    });

    it('gives up after the grace: the player leaves and everyone gets the roster', () => {
      const room = new Room({ dummies: false, reconnectGraceMs: 1000 });
      const a = join(room, 'Ade');
      const b = join(room, 'Kemi');
      room.disconnect(a.client);
      for (let i = 0; i < 59; i++) room.tick();
      expect(room.game.players[a.welcome.playerId]).not.toBeNull();
      room.tick();
      room.tick();
      expect(room.game.players[a.welcome.playerId]).toBeNull();
      expect(room.humanCount).toBe(1);
      expect(b.conn.last(MsgType.Roster)!.entries.some((e) => e.id === a.welcome.playerId)).toBe(false);
      expect(join(room, 'Ade', a.welcome.sessionToken).welcome.resumed).toBe(false);
    });

    it('a reconnect replaces a stale connection the server still thinks is alive', () => {
      const room = new Room({ dummies: false });
      const a = join(room, 'Ade');
      const again = join(room, 'Ade', a.welcome.sessionToken); // the old socket never closed
      expect(again.welcome).toMatchObject({ playerId: a.welcome.playerId, resumed: true });
      expect(a.conn.closed?.code).toBe(CloseCode.DuplicateSession);
      room.disconnect(a.client); // its close event arrives later: must not detach the new one
      sendInput(room, again.client, room.game.tick + 1, Btn.Right);
      for (let i = 0; i < 20; i++) room.tick();
      expect(room.game.players[a.welcome.playerId]!.vx).toBeGreaterThan(0);
      expect(room.humanCount).toBe(1);
    });

    it('a resume whose WELCOME was lost can retry with the same token, even in a full room', () => {
      const room = new Room({ dummies: false, maxHumans: 2 });
      const a = join(room, 'Ade');
      join(room, 'Kemi');
      room.disconnect(a.client);
      const lost = join(room, 'Ade', a.welcome.sessionToken); // WELCOME sent, but the link died before it arrived
      room.disconnect(lost.client);
      const retry = join(room, 'Ade', a.welcome.sessionToken);
      expect(retry.conn.closed).toBeNull(); // not RoomFull
      expect(retry.welcome).toMatchObject({ playerId: a.welcome.playerId, resumed: true });
      expect(room.humanCount).toBe(2);
      // the token from the lost WELCOME (never seen by the client) is retired; the latest one works
      room.disconnect(retry.client);
      expect(join(room, 'Ade', lost.welcome.sessionToken).conn.closed?.code).toBe(CloseCode.RoomFull);
      const viaLatest = join(room, 'Ade', retry.welcome.sessionToken);
      expect(viaLatest.welcome).toMatchObject({ playerId: a.welcome.playerId, resumed: true });
    });

    it('a kick ends the session even when the socket closes re-entrantly (uWS)', () => {
      const room = new Room({ dummies: false });
      const conn = new FakeConn();
      const client = room.connect(conn);
      conn.onClose = () => room.disconnect(client); // what the uWS close handler does
      room.receive(client, encodeHello('Cheater'));
      const welcome = conn.last(MsgType.Welcome) as WelcomeMsg;
      for (let i = 0; i < 3; i++) room.receive(client, Uint8Array.from([0x77, 1, 2]));
      expect(conn.closed?.code).toBe(CloseCode.BadMessage);
      expect(room.game.players[welcome.playerId]).toBeNull();
      expect(room.humanCount).toBe(0);
      expect(join(room, 'Cheater', welcome.sessionToken).welcome.resumed).toBe(false);
    });

    it('kicked players leave at once; with no grace a drop leaves at once too', () => {
      const room = new Room({ dummies: false });
      const a = join(room, 'A');
      for (let i = 0; i < 3; i++) room.receive(a.client, Uint8Array.from([0x77, 1, 2]));
      expect(room.game.players[a.welcome.playerId]).toBeNull();
      expect(join(room, 'A', a.welcome.sessionToken).welcome.resumed).toBe(false);
      const noGrace = new Room({ dummies: false, reconnectGraceMs: 0 });
      const b = join(noGrace, 'B');
      noGrace.disconnect(b.client);
      expect(noGrace.game.players[b.welcome.playerId]).toBeNull();
    });

    it('waiting players keep their slot: the room stays full', () => {
      const room = new Room({ dummies: false, maxHumans: 2 });
      const a = join(room, 'A');
      join(room, 'B');
      room.disconnect(a.client);
      expect(join(room, 'C').conn.closed?.code).toBe(CloseCode.RoomFull);
      expect(join(room, 'A', a.welcome.sessionToken).welcome.resumed).toBe(true);
    });
  });
});
