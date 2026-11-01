/** Host remove (protocol v22, audit-2 L-11): the host removes a player, who leaves at once and can't come back to that room. */
import { CloseCode, CmdKind, HelloFlag, MsgType, decodeMessage, encodeCmd, encodeHello, encodeRemovePlayerCmd, parseRemovePlayer, type RosterMsg } from '@military-forge/protocol';
import { warmNavGraphs } from '@military-forge/bots';
import { maps } from '@military-forge/content';
import { beforeAll, describe, expect, it } from 'vitest';
import { CUSTOM_ROOM_RULES } from '../src/rooms';
import { Room, type ClientConn } from '../src/room';

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
  roster(): string[] {
    const all = this.sent.map((b) => decodeMessage(b)).filter((m): m is RosterMsg => m.type === MsgType.Roster);
    return all.at(-1)!.entries.filter((e) => !e.isBot).map((e) => e.name);
  }
}

/** a player joining `room` (with an account id: the join ticket's `sub`, as rooms.ts sets it) */
function join(room: Room, name: string, accountId: string | null = null, flags = 0) {
  const conn = new FakeConn();
  const client = room.connect(conn);
  client.accountId = accountId;
  client.protocolVersion = 22;
  room.receive(client, encodeHello(name, '', '', null, flags));
  const welcome = conn.sent.map((b) => decodeMessage(b)).find((m) => m.type === MsgType.Welcome) as { playerId: number; sessionToken: string } | undefined;
  return { conn, client, id: welcome?.playerId ?? -1, token: welcome?.sessionToken ?? '', send: (bytes: Uint8Array) => room.receive(client, bytes) };
}

beforeAll(() => warmNavGraphs([maps['movement-test']!]), 30_000);

const matchRoom = () => new Room({ dummies: false, dev: false, seed: 5, match: { ...CUSTOM_ROOM_RULES, countdown: 1 }, code: 'ABCDEF' });

describe('host remove (v22)', () => {
  it('the host removes a player: closed with Removed, gone from the roster, kept out by account, as a spectator too', () => {
    const room = matchRoom();
    const host = join(room, 'Ade', 'u_host');
    const pest = join(room, 'Pest', 'u_pest');
    const other = join(room, 'Kemi', 'u_kemi');
    room.tick();
    expect(host.conn.roster()).toEqual(['Ade', 'Pest', 'Kemi']);

    host.send(encodeRemovePlayerCmd(pest.id));
    expect(pest.conn.closed).toEqual({ code: CloseCode.Removed, reason: 'the host removed you from this room' });
    expect(host.conn.roster()).toEqual(['Ade', 'Kemi']);
    expect(room.humanCount).toBe(2);

    // the same account, under any name, as a player or a spectator: closed again
    const back = join(room, 'PestAgain', 'u_pest');
    expect(back.conn.closed?.code).toBe(CloseCode.Removed);
    const watching = join(room, 'Pest', 'u_pest', HelloFlag.Spectate);
    expect(watching.conn.closed?.code).toBe(CloseCode.Removed);
    // their old session token resumes nothing (rooms.ts then asks for a ticket, which names the account)
    expect(room.hasSession(pest.token)).toBe(false);
    // someone else still joins
    expect(join(room, 'Tolu', 'u_tolu').conn.closed).toBeNull();
    void other;
  });

  it('only the host; never the host itself, a bot or nobody; a bad payload is a strike', () => {
    const room = new Room({ dummies: false, dev: false, seed: 6, match: { ...CUSTOM_ROOM_RULES, countdown: 1 }, fillBots: { target: 4, level: 'easy' }, code: 'ABCDEF' });
    const host = join(room, 'Ade', 'u_host');
    const guest = join(room, 'Kemi', 'u_kemi');
    for (let i = 0; i < 10; i++) room.tick();
    const bot = room.game.players.find((p) => p?.isBot);
    expect(bot).toBeTruthy();

    guest.send(encodeRemovePlayerCmd(host.id)); // not the host: ignored
    host.send(encodeRemovePlayerCmd(host.id)); // yourself: ignored
    host.send(encodeRemovePlayerCmd(bot!.id)); // a bot: ignored (the bot controls are for that)
    host.send(encodeRemovePlayerCmd(30)); // nobody there
    expect(host.conn.closed).toBeNull();
    expect(guest.conn.closed).toBeNull();
    expect(room.game.players[bot!.id]?.isBot).toBe(true);
    expect(host.client.strikes).toBe(0);
    host.send(encodeCmd(CmdKind.RemovePlayer, 'Kemi'));
    expect(host.client.strikes).toBe(1);
  });

  it('a player waiting to reconnect is removed too; without tickets the name is kept out', () => {
    const room = matchRoom();
    const host = join(room, 'Ade');
    const pest = join(room, 'Pest');
    room.disconnect(pest.client); // a drop: the place is kept for the grace
    expect(room.humanCount).toBe(2);
    host.send(encodeRemovePlayerCmd(pest.id));
    expect(room.humanCount).toBe(1);
    expect(join(room, 'pest').conn.closed?.code).toBe(CloseCode.Removed);
    expect(join(room, 'Kemi').conn.closed).toBeNull();
  });

  it('parses the payload strictly', () => {
    expect(parseRemovePlayer('5')).toBe(5);
    expect(parseRemovePlayer('31')).toBe(31);
    for (const bad of ['', '32', '-1', '1.5', ' 5', '100', 'x']) expect(parseRemovePlayer(bad), bad).toBeNull();
  });
});
