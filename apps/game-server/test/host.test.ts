/**
 * Who hosts a room by code (docs/07 §5.3, UX-20): the first player in stays the host while they are
 * in the room, quiet or not, and through a reconnect or a page reload within the reconnect grace.
 * The role moves only when the host really leaves (Leave, or the grace runs out), to the
 * longest-present player still connected. Players come in through the registry's door, as on the
 * live server: HELLO, then a resume by session token (no ticket) after a drop or a reload.
 */
import { CmdKind, MsgType, decodeMessage, encodeCmd, encodeHello, encodeInput, type MatchStateMsg, type Message, type WelcomeMsg } from '@military-forge/protocol';
import { MatchPhase, createInput } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { RECONNECT_GRACE_MS, type ClientConn } from '../src/room';
import { RoomRegistry } from '../src/rooms';

const CODE = 'KMTXRA';
/** the live server's reconnect grace (60 s) */
const GRACE_TICKS = (RECONNECT_GRACE_MS / 1000) * 60;

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
  all<T extends Message['type']>(type: T): Extract<Message, { type: T }>[] {
    return this.sent.map((b) => decodeMessage(b)).filter((m): m is Extract<Message, { type: T }> => m.type === type);
  }
}

interface Player {
  name: string;
  id: number;
  token: string;
  conn: FakeConn;
  c: ReturnType<RoomRegistry['open']>;
  /** every host id this page's MATCH_STATEs carried, in order */
  hosts(): number[];
}

function setup(opts: { bots?: boolean } = {}) {
  const rooms = new RoomRegistry({
    defaultRoom: null,
    roomOptions: opts.bots ? { fillBots: { target: 4, level: 'easy' as const } } : {},
  });
  const room = () => rooms.rooms.get(CODE)!;
  const tick = (n = 1, talking: Player[] = []) => {
    for (let i = 0; i < n; i++) {
      // the players in `talking` send an input every tick; everyone else is silent (a stalled page)
      for (const p of talking) p.c?.receive(encodeInput({ newestTick: room().game.tick & 0xffff, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [createInput()] }));
      rooms.tick();
    }
  };
  /** a page opening the room's socket and saying HELLO (with its session token: a resume) */
  const connect = (name: string, token = ''): Player => {
    const conn = new FakeConn();
    const c = rooms.open(`/ws/${CODE}`, conn, null);
    c!.receive(encodeHello(name, token));
    const welcome = conn.all(MsgType.Welcome).at(-1) as WelcomeMsg | undefined;
    if (!welcome) throw new Error(`${name} wasn't let in: ${JSON.stringify(conn.closed)}`);
    return { name, id: welcome.playerId, token: welcome.sessionToken, conn, c, hosts: () => conn.all(MsgType.MatchState).map((m: MatchStateMsg) => m.hostId) };
  };
  return { rooms, room, tick, connect };
}

describe('the host stays the host (UX-20)', () => {
  for (const order of [
    ['Ade', 'Kemi'],
    ['Kemi', 'Ade'],
  ] as const) {
    it(`two players joining in either order (${order.join(' then ')}): the first in hosts, and a stall doesn't move it`, () => {
      const { room, tick, connect } = setup();
      const first = connect(order[0]);
      tick(10, [first]);
      expect(room().hostId).toBe(first.id);
      // the first player's page stalls (loading, a long frame, a phone away sharing the link) and the
      // friend joins meanwhile: 30 s of silence from the host, the friend talking all the while
      const second = connect(order[1]);
      tick(30 * 60, [second]);
      expect(room().hostId).toBe(first.id);
      // nobody's page ever heard of another host
      tick(30, [first, second]);
      expect(new Set(second.hosts())).toEqual(new Set([first.id]));
      expect(new Set(first.hosts())).toEqual(new Set([first.id]));
      expect(first.conn.closed).toBeNull();
    });
  }

  it('a host whose connection drops keeps the room through the whole grace, and is still the host on its reconnect', () => {
    const { room, tick, connect } = setup();
    const ade = connect('Ade');
    const kemi = connect('Kemi');
    tick(10, [ade, kemi]);
    ade.c!.closed(true, 'no traffic'); // resumable: a dropped socket
    tick(GRACE_TICKS - 5, [kemi]);
    expect(room().hostId).toBe(ade.id);
    const back = connect('Ade', ade.token);
    expect(back.id).toBe(ade.id); // the same player, resumed
    tick(2 * 60, [back, kemi]);
    expect(room().hostId).toBe(ade.id);
    expect(new Set(kemi.hosts())).toEqual(new Set([ade.id]));
  });

  it('a reconnect over a socket the server still thinks is open (it never saw the drop) keeps the host', () => {
    const { room, tick, connect } = setup();
    const ade = connect('Ade');
    const kemi = connect('Kemi');
    tick(6 * 60, [kemi]); // the old socket went dark without a close
    const back = connect('Ade', ade.token);
    expect(ade.conn.closed?.reason).toMatch(/resumed/);
    tick(10, [back, kemi]);
    expect(room().hostId).toBe(ade.id);
    expect(new Set(kemi.hosts())).toEqual(new Set([ade.id]));
  });

  it('a page reload (the socket closes, a fresh page comes back with the saved token seconds later) keeps the host', () => {
    const { room, tick, connect } = setup({ bots: true });
    const ade = connect('Ade');
    tick(10, [ade]);
    const kemi = connect('Kemi');
    tick(10, [ade, kemi]);
    ade.c!.closed(true, '1001: going away'); // the reload
    tick(12 * 60, [kemi]); // a slow phone: 12 s to load the page again
    const reloaded = connect('Ade', ade.token);
    tick(10, [reloaded, kemi]);
    expect(room().hostId).toBe(ade.id);
    expect(new Set(kemi.hosts())).toEqual(new Set([ade.id]));
    // and the guest reloading changes nothing either
    kemi.c!.closed(true, '1001: going away');
    tick(3 * 60, [reloaded]);
    const kemiBack = connect('Kemi', kemi.token);
    tick(10, [reloaded, kemiBack]);
    expect(room().hostId).toBe(ade.id);
  });

  it('the host leaving (Leave) hands the room over at once', () => {
    const { room, tick, connect } = setup();
    const ade = connect('Ade');
    const kemi = connect('Kemi');
    tick(10, [ade, kemi]);
    ade.c!.receive(encodeCmd(CmdKind.Leave, ''));
    tick(1, [kemi]);
    expect(room().hostId).toBe(kemi.id);
    expect(kemi.hosts().at(-1)).toBe(kemi.id);
  });

  it('a host that never comes back hands over when its grace runs out, to the longest-present player still connected', () => {
    const { room, tick, connect } = setup();
    const ade = connect('Ade');
    const kemi = connect('Kemi');
    const tunde = connect('Tunde');
    tick(10, [ade, kemi, tunde]);
    ade.c!.closed(true, 'no traffic');
    tick(30, [kemi, tunde]);
    kemi.c!.closed(true, 'no traffic'); // Kemi (next in line) is away too, waiting to reconnect
    tick(GRACE_TICKS - 40, [tunde]);
    expect(room().hostId).toBe(ade.id); // still inside Ade's grace
    tick(60, [tunde]);
    // Ade's place is given up; Kemi is waiting to reconnect, Tunde is here: Tunde runs the room
    expect(room().game.players[ade.id]).toBeFalsy();
    expect(room().hostId).toBe(tunde.id);
    expect(tunde.hosts().at(-1)).toBe(tunde.id);
  });
});

describe('a player held for a reconnect does not hold up ready-up (UX-20)', () => {
  const ready = (p: Player) => p.c!.receive(encodeCmd(CmdKind.Ready, '1'));

  it("the host reconnecting: the guests' Ready still starts the match; Start now stays the host's", () => {
    const { room, tick, connect } = setup();
    const ade = connect('Ade');
    const kemi = connect('Kemi');
    const tunde = connect('Tunde');
    tick(10, [ade, kemi, tunde]);
    ade.c!.closed(true, 'no traffic'); // the host's phone dropped: its place is held for 60 s
    tick(30, [kemi, tunde]);
    kemi.c!.receive(encodeCmd(CmdKind.StartMatch, '')); // not the host: refused
    tick(5, [kemi, tunde]);
    expect(room().match!.phase).toBe(MatchPhase.Waiting);
    ready(kemi);
    tick(5, [kemi, tunde]);
    expect(room().match!.phase).toBe(MatchPhase.Waiting); // Tunde isn't ready yet
    ready(tunde);
    tick(2, [kemi, tunde]);
    expect(room().match!.phase).toBe(MatchPhase.Countdown); // everyone here is ready: no 60 s wait
    expect(room().hostId).toBe(ade.id); // and Ade is still the host
    const back = connect('Ade', ade.token);
    tick(5, [back, kemi, tunde]);
    expect(room().hostId).toBe(ade.id);
  });

  it('a guest reconnecting: the others ready up and start without them', () => {
    const { room, tick, connect } = setup();
    const ade = connect('Ade');
    const kemi = connect('Kemi');
    tick(10, [ade, kemi]);
    kemi.c!.closed(true, 'no traffic');
    ready(ade);
    tick(2, [ade]);
    expect(room().match!.phase).toBe(MatchPhase.Countdown);
  });

  it('back from the reconnect, they count again: an unready returner holds the start', () => {
    const { room, tick, connect } = setup();
    const ade = connect('Ade');
    const kemi = connect('Kemi');
    const tunde = connect('Tunde');
    tick(10, [ade, kemi, tunde]);
    tunde.c!.closed(true, 'no traffic');
    tick(30, [ade, kemi]);
    const back = connect('Tunde', tunde.token);
    ready(ade);
    ready(kemi);
    tick(5, [ade, kemi, back]);
    expect(room().match!.phase).toBe(MatchPhase.Waiting);
    ready(back);
    tick(2, [ade, kemi, back]);
    expect(room().match!.phase).toBe(MatchPhase.Countdown);
  });
});
