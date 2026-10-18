/**
 * Bots fill rooms (RoomOptions.fillBots, bots-interfaces.md): a room with a human in it is kept at
 * the target with [BOT] players; a human coming in takes the lowest-scoring bot's place, one leaving
 * for good brings a bot back, and the last human out takes them all. They play the match like anyone.
 */
import { CmdKind, MsgType, decodeMessage, encodeCmd, encodeHello, type MatchStateMsg, type Message, type RosterMsg } from '@military-forge/protocol';
import { MatchPhase } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Room, type ClientConn } from '../src/room';
import { CUSTOM_ROOM_RULES } from '../src/rooms';

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
  last<T extends Message['type']>(type: T): Extract<Message, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i--) {
      if (this.sent[i]![0] !== type) continue;
      return decodeMessage(this.sent[i]!) as Extract<Message, { type: T }>;
    }
    return undefined;
  }
}

function join(room: Room, name: string) {
  const conn = new FakeConn();
  const client = room.connect(conn);
  room.receive(client, encodeHello(name, ''));
  return { conn, client };
}

const leave = (room: Room, who: ReturnType<typeof join>) => room.receive(who.client, encodeCmd(CmdKind.Leave, ''));
const run = (room: Room, ticks: number) => {
  for (let i = 0; i < ticks; i++) room.tick();
};
const botNames = (roster: RosterMsg) => roster.entries.filter((e) => e.isBot).map((e) => e.name);

function matchRoom(target = 4) {
  return new Room({ dummies: false, dev: false, seed: 3, match: { ...CUSTOM_ROOM_RULES, countdown: 1 }, fillBots: { target, level: 'normal' } });
}

describe('bots fill rooms', () => {
  it('a room with a human in it fills up to the target with [BOT] players; they leave with the last human', () => {
    const room = matchRoom();
    run(room, 30);
    expect(room.bots).toHaveLength(0); // nobody here: no bots playing to an empty room
    const ade = join(room, 'Ade');
    run(room, 1);
    expect(room.bots).toHaveLength(3);
    expect(botNames(ade.conn.last(MsgType.Roster)!)).toEqual(['[BOT] Badger', '[BOT] Kestrel', '[BOT] Mantis']);
    expect(room.humanCount).toBe(1);

    const kemi = join(room, 'Kemi'); // takes a bot's place
    run(room, 1);
    expect(room.bots).toHaveLength(2);
    expect(room.game.players.filter(Boolean)).toHaveLength(4);
    expect(botNames(kemi.conn.last(MsgType.Roster)!)).toHaveLength(2);

    leave(room, ade);
    leave(room, kemi);
    run(room, 1);
    expect(room.bots).toHaveLength(0);
    expect(room.game.players.filter(Boolean)).toHaveLength(0);
    expect(room.empty).toBe(true);
  });

  it('a lone human starts the match with the bots; they play it: kills, standings, MATCH_STATE marks them', () => {
    const room = matchRoom();
    const ade = join(room, 'Ade');
    run(room, 2);
    room.receive(ade.client, encodeCmd(CmdKind.StartMatch, '')); // bots count towards minPlayers
    run(room, 2 * 60);
    expect(room.match!.phase).toBe(MatchPhase.InProgress);
    run(room, 40 * 60);
    const state = ade.conn.last(MsgType.MatchState) as MatchStateMsg;
    const bots = state.standings.filter((s) => s.isBot);
    expect(bots.map((s) => s.name).sort()).toEqual(['[BOT] Badger', '[BOT] Kestrel', '[BOT] Mantis']);
    expect(state.standings.reduce((n, s) => n + s.kills, 0)).toBeGreaterThan(0); // they fight (each other, and Ade standing there)
    expect(state.lobby.map((p) => p.id).sort()).toEqual(state.standings.filter((s) => !s.left).map((s) => s.id).sort());
  });

  it('mid-match, a joiner takes the lowest-scoring bot’s place (not its stats); a human leaving for good brings a bot back', () => {
    const room = matchRoom();
    const ade = join(room, 'Ade');
    run(room, 2);
    room.receive(ade.client, encodeCmd(CmdKind.StartMatch, ''));
    run(room, 30 * 60);
    expect(room.match!.phase).toBe(MatchPhase.InProgress);
    const score = (id: number) => room.match!.players[id]!.score;
    const before = room.bots.map((b) => ({ id: b.id, name: b.name, score: score(b.id) }));
    const lowest = Math.min(...before.map((b) => b.score));

    const kemi = join(room, 'Kemi');
    run(room, 1);
    const left = before.filter((b) => !room.bots.some((p) => p.name === b.name));
    expect(left).toHaveLength(1);
    expect(left[0]!.score).toBe(lowest);
    // the leaver keeps its line in the standings; Kemi starts from nothing
    const standings = room.match!.standings();
    expect(standings.find((s) => s.name === left[0]!.name)?.left).toBe(true);
    expect(standings.find((s) => s.name === 'Kemi')?.score).toBe(0);

    leave(room, kemi);
    run(room, 1);
    expect(room.bots).toHaveLength(3);
    expect(room.game.players.filter(Boolean)).toHaveLength(4);
  });

  it('a human waiting to reconnect keeps their place: no bot comes in for a dropped connection', () => {
    const room = new Room({ dummies: false, dev: false, fillBots: { target: 3, level: 'easy' } });
    const ade = join(room, 'Ade');
    const kemi = join(room, 'Kemi');
    run(room, 1);
    expect(room.bots).toHaveLength(1);
    room.disconnect(kemi.client); // resumable: the grace keeps the session
    run(room, 60);
    expect(room.bots).toHaveLength(1);
    expect(ade.conn.closed).toBeNull();
  });

  it('humans can’t pass for bots: the [BOT] tag comes off their names', () => {
    const room = new Room({ dummies: false, dev: false, fillBots: { target: 4, level: 'normal' } });
    join(room, '[BOT] Kemi');
    join(room, '[ bot ]Tunde');
    const last = join(room, '[BOT]');
    run(room, 1);
    const roster = last.conn.last(MsgType.Roster)!;
    expect(roster.entries.filter((e) => !e.isBot).map((e) => e.name)).toEqual(['Kemi', 'Tunde', 'Player 3']);
    expect(botNames(roster)).toEqual(['[BOT] Badger']);
  });

  it('no fillBots, no bots (and a target of 0 is none)', () => {
    for (const fillBots of [undefined, { target: 0, level: 'hard' as const }]) {
      const room = new Room({ dummies: false, dev: false, ...(fillBots ? { fillBots } : {}) });
      join(room, 'Ade');
      run(room, 5);
      expect(room.bots).toHaveLength(0);
    }
  });
});
