/**
 * Bots fill rooms (RoomOptions.fillBots, bots-interfaces.md): a room with a human in it is kept at
 * the target with [BOT] players; a human coming in takes the lowest-scoring bot's place, one leaving
 * for good brings a bot back, and the last human out takes them all. They play the match like anyone.
 */
import { CmdKind, MsgType, decodeMessage, encodeCmd, encodeHello, type MatchStateMsg, type Message, type RosterMsg } from '@military-forge/protocol';
import { MatchPhase } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Room, parseBotSettings, type ClientConn } from '../src/room';
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

/** The host's room setting (the owner's "sometimes I don't want bots", protocol v17). */
describe("the host's bots", () => {
  const settings = (room: Room, who: ReturnType<typeof join>, s: object) => room.receive(who.client, encodeCmd(CmdKind.MatchSettings, JSON.stringify(s)));
  const rules = (who: ReturnType<typeof join>) => (who.conn.last(MsgType.MatchState) as MatchStateMsg).rules;
  const anyBot = (room: Room) => room.game.players.some((p) => p?.isBot);

  it('Off takes the bots out at once; none come back, not for a joiner nor a leaver; everyone sees it', () => {
    const room = matchRoom();
    const ade = join(room, 'Ade');
    run(room, 1);
    expect(room.bots).toHaveLength(3);
    expect(rules(ade)).toMatchObject({ bots: 4, botLevel: 'normal' });
    const kemi = join(room, 'Kemi');
    run(room, 1);
    settings(room, kemi, { bots: 0 }); // not the host: nothing
    run(room, 1);
    expect(room.bots).toHaveLength(2);
    settings(room, ade, { bots: 0 });
    run(room, 1);
    expect(room.bots).toHaveLength(0);
    expect(anyBot(room)).toBe(false);
    run(room, 12); // MATCH_STATE batches
    expect(rules(kemi)).toMatchObject({ bots: 0 });
    expect(botNames(kemi.conn.last(MsgType.Roster)!)).toEqual([]);
    const tunde = join(room, 'Tunde');
    leave(room, kemi);
    for (let i = 0; i < 120; i++) {
      room.tick();
      expect(anyBot(room)).toBe(false);
    }
    expect(room.humanCount).toBe(2);
    expect(rules(tunde).bots).toBe(0);
  });

  it('a room with bots off never spawns one, through a whole match', () => {
    const room = new Room({ dummies: false, dev: false, seed: 4, match: { ...CUSTOM_ROOM_RULES, countdown: 1, timeLimit: 20, minPlayers: 2 }, fillBots: { target: 4, level: 'normal' } });
    const ade = join(room, 'Ade');
    settings(room, ade, { bots: 0 }); // before the first tick: the fill never runs with bots on
    const kemi = join(room, 'Kemi');
    room.receive(ade.client, encodeCmd(CmdKind.StartMatch, ''));
    for (let i = 0; i < 26 * 60; i++) {
      room.tick();
      expect(anyBot(room)).toBe(false);
    }
    expect(room.match!.phase).toBeGreaterThanOrEqual(MatchPhase.Ending);
    expect((kemi.conn.last(MsgType.MatchState) as MatchStateMsg).standings.every((s) => !s.isBot)).toBe(true);
  });

  it('switched off mid-match: the bots go, keep their lines as leavers, and the match still ends with results', () => {
    const room = new Room({ dummies: false, dev: false, seed: 3, match: { ...CUSTOM_ROOM_RULES, countdown: 1, timeLimit: 20 }, fillBots: { target: 4, level: 'normal' } });
    const ade = join(room, 'Ade');
    run(room, 2);
    room.receive(ade.client, encodeCmd(CmdKind.StartMatch, ''));
    run(room, 8 * 60);
    expect(room.match!.phase).toBe(MatchPhase.InProgress);
    const bots = room.bots.map((b) => b.name);
    settings(room, ade, { bots: 0 });
    run(room, 1);
    expect(room.bots).toHaveLength(0);
    expect(room.match!.phase).toBe(MatchPhase.InProgress);
    const standings = room.match!.standings();
    for (const name of bots) expect(standings.find((s) => s.name === name)?.left).toBe(true);
    run(room, 14 * 60);
    expect(room.match!.phase).toBeGreaterThanOrEqual(MatchPhase.Ending);
    const end = ade.conn.last(MsgType.MatchState) as MatchStateMsg;
    expect(end.results).not.toBeNull();
    expect(end.standings.find((s) => s.name === 'Ade')).toBeDefined();
    expect(end.rules.bots).toBe(0);
    // and back on, mid-match or after: Fill to 8 at Hard
    settings(room, ade, { bots: 8, botLevel: 'hard' });
    run(room, 12);
    expect(room.bots).toHaveLength(7);
    expect(rules(ade)).toMatchObject({ bots: 8, botLevel: 'hard' });
  });

  it('reads the setting strictly: a number of players up to the room size and a known level', () => {
    const cur = { target: 4, level: 'normal' as const };
    expect(parseBotSettings('{"bots":0}', cur)).toEqual({ target: 0, level: 'normal' });
    expect(parseBotSettings('{"botLevel":"easy"}', cur)).toEqual({ target: 4, level: 'easy' });
    expect(parseBotSettings('{"timeLimit":120}', cur)).toBeUndefined();
    for (const bad of ['{"bots":-1}', '{"bots":2.5}', '{"bots":99}', '{"bots":"4"}', '{"botLevel":"insane"}', 'nope', '[1]']) expect(parseBotSettings(bad, cur)).toBeNull();
  });
});
