/**
 * The onboarding/sockets audit (19 Oct 2026), server side: a stalled client stops moving, admin
 * edits keep the rooms' own match limits, the admin's TUNING comes after its OVERRIDES, a host that
 * left or went quiet hands the room over, and a host's clamped edit comes back to it.
 */
import { MAX_REPEAT_TICKS } from '@military-forge/netcode';
import { CmdKind, MsgType, decodeMessage, encodeCmd, encodeHello, encodeInput, type Message, type WelcomeMsg } from '@military-forge/protocol';
import { Btn, MatchPhase, createInput } from '@military-forge/sim';
import { afterEach, describe, expect, it } from 'vitest';
import { setAdminValues } from '../src/admin';
import { HOST_AWAY_TICKS, Room, type ClientConn } from '../src/room';

afterEach(() => {
  setAdminValues({});
});

class FakeConn implements ClientConn {
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  send(bytes: Uint8Array) {
    this.sent.push(bytes);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  bufferedAmount() {
    return 0;
  }
  types(): Message['type'][] {
    return this.sent.map((b) => decodeMessage(b).type);
  }
  last<T extends Message['type']>(type: T): Extract<Message, { type: T }> | undefined {
    return this.sent
      .map((b) => decodeMessage(b))
      .filter((m): m is Extract<Message, { type: T }> => m.type === type)
      .at(-1);
  }
}

function join(room: Room, name: string) {
  const conn = new FakeConn();
  const client = room.connect(conn);
  room.receive(client, encodeHello(name, ''));
  return { conn, client, welcome: conn.last(MsgType.Welcome) as WelcomeMsg };
}

function input(room: Room, client: ReturnType<typeof join>['client'], tick: number, buttons: number) {
  const i = createInput();
  i.buttons = buttons;
  room.receive(client, encodeInput({ newestTick: tick & 0xffff, ackSnapshotSeq: 0, renderTick: tick & 0xffff, renderFrac: 0, inputs: [i] }));
}

describe('a stalled client (M1)', () => {
  it('is moved by its last input for half a second, then lets go of the keys', () => {
    const room = new Room({ dummies: false, dev: false });
    const a = join(room, 'A');
    const p = room.game.players[a.welcome.playerId]!;
    for (let i = 0; i < 30; i++) {
      input(room, a.client, room.game.tick, Btn.Right);
      room.tick();
    }
    // nothing more arrives: a black hole
    let movedLate = 0;
    for (let i = 0; i < 240; i++) {
      const x = p.x;
      room.tick();
      if (i > MAX_REPEAT_TICKS + 30 && p.x !== x) movedLate++;
    }
    expect(a.client.inputs.neutral).toBeGreaterThan(200);
    expect(movedLate).toBe(0); // stopped (it was walking right for 4 s before)
  });
});

describe('admin limits (M2)', () => {
  const rules = () => ({ countdown: 1 });

  it("an admin edit to something else keeps a host's limits, even mid-match", () => {
    const room = new Room({ dummies: false, dev: false, match: rules() });
    const a = join(room, 'Host');
    join(room, 'Guest');
    room.receive(a.client, encodeCmd(CmdKind.MatchSettings, JSON.stringify({ timeLimit: 60, killLimit: 5 })));
    expect(room.match!.rules).toMatchObject({ timeLimit: 60, killLimit: 5 });
    room.receive(a.client, encodeCmd(CmdKind.StartMatch, ''));
    for (let i = 0; i < 200 && room.match!.phase !== MatchPhase.InProgress; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.InProgress);
    setAdminValues({ 'tuning.fuelMax': 120 });
    expect(room.match!.rules).toMatchObject({ timeLimit: 60, killLimit: 5 });
  });

  it("the admin's limits apply in the lobby at once, and to a running match only when it's over", () => {
    const room = new Room({ dummies: false, dev: false, match: rules() });
    const a = join(room, 'Host');
    join(room, 'Guest');
    setAdminValues({ 'match.killLimit': 8 });
    expect(room.match!.rules.killLimit).toBe(8); // lobby: now
    room.receive(a.client, encodeCmd(CmdKind.StartMatch, ''));
    for (let i = 0; i < 200 && room.match!.phase !== MatchPhase.InProgress; i++) room.tick();
    setAdminValues({ 'match.killLimit': 12 });
    expect(room.match!.rules.killLimit).toBe(8); // running: unchanged
    room.receive(a.client, encodeCmd(CmdKind.ReturnToLobby, ''));
    for (let i = 0; i < 10 && room.match!.phase !== MatchPhase.Waiting; i++) room.tick();
    expect(room.match!.phase).toBe(MatchPhase.Waiting);
    expect(room.match!.rules.killLimit).toBe(12); // back in the lobby: the admin's new one
  });
});

describe("the admin's tuning (M3)", () => {
  it('comes right after its OVERRIDES, so clients can tell it from a host\'s', () => {
    const room = new Room({ dummies: false, dev: false, match: { countdown: 1 }, hostTuning: true });
    const b = join(room, 'B');
    const from = b.conn.sent.length;
    setAdminValues({ 'tuning.gravity': 12 });
    const types = b.conn.types().slice(from);
    expect(types).toEqual([MsgType.Overrides, MsgType.Tuning]);
  });
});

describe('a host that left or went quiet (L4)', () => {
  it('hands the room to the longest-present player still here after HOST_AWAY_TICKS', () => {
    const room = new Room({ dummies: false, dev: false, match: { countdown: 1 } });
    const a = join(room, 'A');
    const b = join(room, 'B');
    join(room, 'C');
    expect(room.hostId).toBe(a.welcome.playerId);
    room.disconnect(a.client); // resumable: the 20 s grace
    const keepTalking = () => {
      for (const c of room.clients) input(room, c, room.game.tick, 0);
    };
    for (let i = 0; i < HOST_AWAY_TICKS - 2; i++) {
      keepTalking();
      room.tick();
    }
    expect(room.hostId).toBe(a.welcome.playerId); // a blip: still the host
    for (let i = 0; i < 4; i++) {
      keepTalking();
      room.tick();
    }
    expect(room.hostId).toBe(b.welcome.playerId);
  });

  it('a connected host that has gone silent (a stall the server never saw close) hands over too', () => {
    const room = new Room({ dummies: false, dev: false, match: { countdown: 1 } });
    const a = join(room, 'A');
    const b = join(room, 'B');
    for (let i = 0; i < HOST_AWAY_TICKS + 2; i++) {
      input(room, b.client, room.game.tick, 0); // only B talks
      room.tick();
    }
    expect(room.hostId).toBe(b.welcome.playerId);
    expect(a.conn.closed).toBeNull(); // A keeps its player; it just isn't the host
  });
});
