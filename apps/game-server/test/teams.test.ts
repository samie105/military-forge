/** Team modes in a room (protocol v21): the host's mode, the teams in MATCH_STATE, bots spread, SetTeam, team radio's team. */
import { warmNavGraphs } from '@military-forge/bots';
import { maps } from '@military-forge/content';
import { CmdKind, MsgType, decodeMessage, encodeCmd, encodeHello, type MatchStateMsg, type Message } from '@military-forge/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { CUSTOM_ROOM_RULES } from '../src/rooms';
import { Room, parseTeamsSetting, type ClientConn } from '../src/room';

class FakeConn implements ClientConn {
  readonly sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  send(b: Uint8Array) {
    this.sent.push(b);
  }
  close(code: number, reason: string) {
    this.closed = { code, reason };
  }
  bufferedAmount() {
    return 0;
  }
  state(): MatchStateMsg {
    const all = this.sent.map((b) => decodeMessage(b)).filter((m: Message): m is MatchStateMsg => m.type === MsgType.MatchState);
    return all.at(-1)!;
  }
}

beforeAll(() => warmNavGraphs([maps['movement-test']!]), 30_000);

function join(room: Room, name: string) {
  const conn = new FakeConn();
  const client = room.connect(conn);
  room.receive(client, encodeHello(name));
  const id = (conn.sent.map((b) => decodeMessage(b)).find((m) => m.type === MsgType.Welcome) as { playerId: number }).playerId;
  return { conn, client, id, cmd: (kind: number, payload = '') => room.receive(client, encodeCmd(kind, payload)) };
}

const step = (room: Room, n = 1) => {
  for (let i = 0; i < n; i++) room.tick();
};

describe('team modes in a room', () => {
  it('the host picks 2 teams: everyone and the bots are dealt evenly, MATCH_STATE says so, the kill limit follows', () => {
    const room = new Room({ dummies: false, dev: false, seed: 3, match: { ...CUSTOM_ROOM_RULES, countdown: 1 }, fillBots: { target: 6, level: 'easy' } });
    const host = join(room, 'Ade');
    const guest = join(room, 'Kemi');
    step(room, 10);
    expect(host.conn.state().teams).toBe(0);
    host.cmd(CmdKind.MatchSettings, JSON.stringify({ teams: 2 }));
    step(room, 10);
    const s = host.conn.state();
    expect(s.teams).toBe(2);
    expect(s.teamScores).toEqual([0, 0]);
    expect(s.rules.killLimit).toBe(30);
    const sizes = [0, 0];
    for (const e of s.lobby) sizes[e.team!]!++;
    expect(sizes).toEqual([3, 3]);
    // the voice relay's team radio reads the sim's team
    expect(room.game.players[host.id]!.team).toBeGreaterThanOrEqual(0);

    // a guest can't move anyone; the host can
    const theirs = s.lobby.find((e) => e.id === guest.id)!.team!;
    guest.cmd(CmdKind.SetTeam, JSON.stringify({ id: guest.id, team: 1 - theirs }));
    step(room, 10);
    expect(host.conn.state().lobby.find((e) => e.id === guest.id)!.team).toBe(theirs);
    host.cmd(CmdKind.SetTeam, JSON.stringify({ id: guest.id, team: 1 - theirs }));
    step(room, 10);
    expect(host.conn.state().lobby.find((e) => e.id === guest.id)!.team).toBe(1 - theirs);

    // 4 teams, then back to free-for-all
    host.cmd(CmdKind.MatchSettings, JSON.stringify({ teams: 4 }));
    step(room, 10);
    expect(host.conn.state()).toMatchObject({ teams: 4, rules: { killLimit: 20 } });
    host.cmd(CmdKind.MatchSettings, JSON.stringify({ teams: 0 }));
    step(room, 10);
    const ffa = host.conn.state();
    expect(ffa.teams).toBe(0);
    expect(ffa.lobby.every((e) => e.team === -1)).toBe(true);
  });

  it('parses the mode strictly', () => {
    expect(parseTeamsSetting('{"teams":3}')).toBe(3);
    expect(parseTeamsSetting('{"teams":1}')).toBeUndefined();
    expect(parseTeamsSetting('{"timeLimit":300}')).toBeUndefined();
    expect(parseTeamsSetting('nope')).toBeUndefined();
  });
});
