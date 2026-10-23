/**
 * Rooms by code (rooms.ts) and the match lifecycle inside a Room (MATCH_STATE 0x23, lobby CMDs,
 * host rights), then the same over real sockets on both transports.
 */
import {
  CloseCode,
  CmdKind,
  MsgType,
  decodeMessage,
  encodeCmd,
  encodeHello,
  encodeInput,
  encodePing,
  type MatchStateMsg,
  type Message,
  type WelcomeMsg,
} from '@military-forge/protocol';
import { generateKeyPairSync, sign } from 'node:crypto';
import { Btn, MatchPhase, createInput, ticks } from '@military-forge/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket as WsClient } from 'ws';
import { Room, parseMatchSettings, sanitizeName, type ClientConn } from '../src/room';
import { CUSTOM_ROOM_RULES, RoomRegistry, roomCodeFromUrl } from '../src/rooms';
import { createServer, type RunningServer } from '../src/server';
import { TICKET_AUDIENCE, TICKET_ISSUER, TicketVerifier } from '../src/tickets';
import { forwardedFor, loadUws, startUws, startWs, type RoomTarget, type TransportKind } from '../src/transports';

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
  match(): MatchStateMsg {
    const m = this.all(MsgType.MatchState).at(-1);
    if (!m) throw new Error('no MATCH_STATE yet');
    return m;
  }
}

function join(room: Room, name: string) {
  const conn = new FakeConn();
  const client = room.connect(conn);
  room.receive(client, encodeHello(name));
  const welcome = conn.all(MsgType.Welcome).at(-1)!;
  return { conn, client, id: welcome.playerId, cmd: (kind: number, payload = '') => room.receive(client, encodeCmd(kind, payload)) };
}

const step = (room: Room, n = 1) => {
  for (let i = 0; i < n; i++) room.tick();
};

describe('room codes in WebSocket URLs', () => {
  it('reads /ws/CODE, /CODE and ?room=CODE; / and /ws are the default room', () => {
    expect(roomCodeFromUrl('/ws/KQXMZP')).toBe('KQXMZP');
    expect(roomCodeFromUrl('/ws/kqxmzp/')).toBe('KQXMZP');
    expect(roomCodeFromUrl('/KQXMZP')).toBe('KQXMZP');
    expect(roomCodeFromUrl('/ws?room=KQXMZP')).toBe('KQXMZP');
    expect(roomCodeFromUrl('/?room=kqxmzp&x=1')).toBe('KQXMZP');
    expect(roomCodeFromUrl('/')).toBe('');
    expect(roomCodeFromUrl('/ws')).toBe('');
    expect(roomCodeFromUrl('')).toBe('');
    for (const bad of ['/ws/KQXMZ', '/ws/KQ0MZP', '/health', '/ws/KQXMZP/extra', '/ws?room=nope', '/%E0%A4%A']) expect(roomCodeFromUrl(bad)).toBeNull();
  });
});

/** A connection through the registry's door, saying HELLO at once (with a ticket or a session token when given). */
function enter(rooms: RoomRegistry, path: string, name: string, opts: { ticket?: string; token?: string; ip?: string } = {}) {
  const conn = new FakeConn();
  const c = rooms.open(path, conn, opts.ip ?? null);
  c?.receive(encodeHello(name, opts.token ?? '', opts.ticket ?? ''));
  return {
    conn,
    c,
    welcome: () => conn.all(MsgType.Welcome).at(-1),
    cmd: (kind: number, payload = '') => c!.receive(encodeCmd(kind, payload)),
  };
}

describe('RoomRegistry', () => {
  it('opens a room for its first HELLO, one per code, up to maxRooms, and closes rooms that stay empty', () => {
    const rooms = new RoomRegistry({ maxRooms: 2, emptyTicks: 30, defaultRoom: null });
    for (const [path, reason] of [
      ['/', 'no room code'],
      ['/ws/AAAAAA/x', 'invalid room code'],
    ] as const) {
      const conn = new FakeConn();
      expect(rooms.open(path, conn, null)).toBeNull();
      expect(conn.closed).toEqual({ code: CloseCode.NoRoom, reason });
    }
    // a socket alone opens nothing: rooms wait for a HELLO
    const idle = new FakeConn();
    expect(rooms.open('/ws/AAAAAA', idle, null)).not.toBeNull();
    expect(rooms.rooms.size).toBe(0);

    const a = enter(rooms, '/ws/AAAAAA', 'Ade');
    const again = enter(rooms, '/AAAAAA', 'Kemi');
    const room = rooms.rooms.get('AAAAAA')!;
    expect([a.welcome()?.playerId, again.welcome()?.playerId]).toEqual([0, 1]);
    expect(room.match?.rules).toMatchObject({ timeLimit: CUSTOM_ROOM_RULES.timeLimit, killLimit: CUSTOM_ROOM_RULES.killLimit, onNoRematch: 'lobby' });
    expect(room.game.players.filter((p) => p !== null).map((p) => p.name)).toEqual(['Ade', 'Kemi']); // no dummies in rooms by code
    const b = enter(rooms, '/ws/BBBBBB', 'Tunde');
    expect(b.welcome()).toBeDefined();
    const full = enter(rooms, '/ws/CCCCCC', 'Bisi');
    expect(full.conn.closed).toEqual({ code: CloseCode.NoRoom, reason: expect.stringMatching(/server full/) });

    // players keep AAAAAA open; BBBBBB's only player leaves and it closes after 30 ticks
    b.cmd(CmdKind.Leave);
    for (let i = 0; i < 29; i++) rooms.tick();
    expect([...rooms.rooms.keys()]).toEqual(['AAAAAA', 'BBBBBB']);
    rooms.tick();
    expect([...rooms.rooms.keys()]).toEqual(['AAAAAA']);
    expect(enter(rooms, '/ws/CCCCCC', 'Bisi').welcome()).toBeDefined();
    // the last players leave for good: the room goes too
    a.cmd(CmdKind.Leave);
    again.cmd(CmdKind.Leave);
    expect(a.conn.closed?.code).toBe(1000);
    for (let i = 0; i < 30; i++) rooms.tick();
    expect(rooms.rooms.has('AAAAAA')).toBe(false);
  });

  it('a room whose tick throws is closed on its own; the others keep running', () => {
    const logs: string[] = [];
    const rooms = new RoomRegistry({ defaultRoom: { dummies: false }, log: (m) => logs.push(m) });
    const victim = enter(rooms, '/ws/DDDDDD', 'Ade');
    enter(rooms, '/ws/EEEEEE', 'Kemi');
    const bad = rooms.rooms.get('DDDDDD')!;
    const good = rooms.rooms.get('EEEEEE')!;
    bad.tick = () => {
      throw new Error('boom');
    };
    const before = good.game.tick;
    rooms.tick();
    expect(rooms.rooms.has('DDDDDD')).toBe(false);
    expect(victim.conn.closed?.code).toBe(1011);
    expect(good.game.tick).toBe(before + 1);
    expect(rooms.defaultRoom!.game.tick).toBe(1);
    expect(logs.some((l) => l.includes('DDDDDD crashed'))).toBe(true);
  });
});

describe('the door: connections without a HELLO', () => {
  it('hold no room, leave after 5 s, and are capped per IP, per room and overall', () => {
    let now = 0;
    const rooms = new RoomRegistry({ defaultRoom: null, maxRooms: 2, now: () => now, door: { total: 8, perIp: 3, perRoom: 4 } });
    const idle: FakeConn[] = [];
    const knock = (path: string, ip: string) => {
      const conn = new FakeConn();
      idle.push(conn);
      return { conn, c: rooms.open(path, conn, ip) };
    };
    // one address: three sockets waiting, then no more
    for (const code of ['AAAAAA', 'BBBBBB', 'CCCCCC']) expect(knock(`/ws/${code}`, '198.51.100.1').c).not.toBeNull();
    const fourth = knock('/ws/DDDDDD', '198.51.100.1');
    expect(fourth.c).toBeNull();
    expect(fourth.conn.closed).toEqual({ code: CloseCode.RateLimited, reason: 'too many connections from your network' });
    // one room: four waiting, then no more
    for (const ip of ['198.51.100.2', '198.51.100.3', '198.51.100.4']) expect(knock('/ws/AAAAAA', ip).c).not.toBeNull();
    expect(knock('/ws/AAAAAA', '198.51.100.5').conn.closed?.reason).toBe('too many players joining this room at once');
    // in all: eight waiting
    expect(knock('/ws/EEEEEE', '198.51.100.6').c).not.toBeNull();
    expect(knock('/ws/FFFFFF', '198.51.100.7').c).not.toBeNull();
    expect(rooms.atDoor).toBe(8);
    expect(knock('/ws/GGGGGG', '198.51.100.8').conn.closed?.reason).toMatch(/server busy/);
    // none of them opened a room: idle sockets can't hold the server's room slots
    expect(rooms.rooms.size).toBe(0);

    now = 4999;
    rooms.closeSilentVisitors();
    expect(rooms.atDoor).toBe(8);
    now = 5000;
    rooms.closeSilentVisitors();
    expect(rooms.atDoor).toBe(0);
    const timedOut = idle.filter((c) => c.closed?.code === 1008);
    expect(timedOut).toHaveLength(8);
    expect(timedOut[0]!.closed!.reason).toBe('no HELLO within 5 s');

    // a PING is answered before HELLO (the playtest's ping tool), a flood isn't, nor garbage
    const p = knock('/ws/GGGGGG', '198.51.100.8');
    p.c!.receive(encodePing(12.5));
    expect(p.conn.all(MsgType.Pong)).toEqual([{ type: MsgType.Pong, clientTime: 12.5, serverTick: 0 }]);
    for (let i = 0; i < 40 && !p.conn.closed; i++) p.c!.receive(encodePing(i));
    expect(p.conn.closed?.code).toBe(CloseCode.RateLimited);
    const garbage = knock('/ws/GGGGGG', '198.51.100.9');
    garbage.c!.receive(new Uint8Array([0x7f, 1, 2]));
    expect(garbage.conn.closed?.code).toBe(CloseCode.BadMessage);

    // players get in as before, and once in, the deadline is behind them
    now = 6000;
    const player = enter(rooms, '/ws/HHHHHH', 'Ade', { ip: '198.51.100.10' });
    expect(player.welcome()).toBeDefined();
    expect(rooms.atDoor).toBe(0);
    now = 60_000;
    rooms.closeSilentVisitors();
    expect(player.conn.closed).toBeNull();
  });

  it('turns an old client away before it costs a room', () => {
    const rooms = new RoomRegistry({ defaultRoom: null });
    const conn = new FakeConn();
    const c = rooms.open('/ws/AAAAAA', conn, null)!;
    const hello = encodeHello('Ade');
    hello[1] = 0xff; // protocol version
    c.receive(hello);
    expect(conn.closed?.code).toBe(CloseCode.VersionMismatch);
    expect(rooms.rooms.size).toBe(0);
  });
});

describe('join tickets (docs/06 §6)', () => {
  const keys = generateKeyPairSync('ed25519');
  const other = generateKeyPairSync('ed25519');
  let nowS = 1_760_000_000;
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
  let jti = 0;
  /** a ticket as the API signs one (apps/api/src/rooms/routes.ts) */
  const ticket = (over: Record<string, unknown> = {}, key = keys.privateKey) => {
    const claims = { iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, sub: 'u_1', iat: nowS, exp: nowS + 30, nick: 'Ade', room: 'AAAAAA', jti: `t${++jti}`, ...over };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), key).toString('base64url')}`;
  };
  const registry = () => new RoomRegistry({ defaultRoom: null, tickets: new TicketVerifier(keys.publicKey, () => nowS) });

  it('a new player needs a valid ticket for that room, and plays under its name', () => {
    const rooms = registry();
    const refused = (t: string) => {
      const p = enter(rooms, '/ws/AAAAAA', 'Ade', { ticket: t });
      expect(p.conn.closed?.code, t.slice(-12)).toBe(CloseCode.TicketInvalid);
      return p.conn.closed!.reason;
    };
    expect(refused('')).toMatch(/needs an invite/);
    expect(refused(ticket({}, other.privateKey))).toMatch(/invalid join ticket/);
    expect(refused(ticket({ room: 'BBBBBB' }))).toMatch(/another room/);
    expect(refused(ticket({ exp: nowS - 10, iat: nowS - 40 }))).toMatch(/expired/);
    expect(refused(ticket({ aud: 'api' }))).toMatch(/invalid join ticket/); // an access token isn't a ticket
    expect(refused(ticket({ exp: nowS + 3600 }))).toMatch(/expired/); // nothing lives that long
    expect(refused('a.b.c')).toMatch(/invalid join ticket/);
    expect(rooms.rooms.size).toBe(0); // no room for any of them

    const good = ticket({ nick: 'Kemi' });
    const p = enter(rooms, '/ws/AAAAAA', 'Admin', { ticket: good });
    expect(p.welcome()).toBeDefined();
    const room = rooms.rooms.get('AAAAAA')!;
    expect(room.game.players[p.welcome()!.playerId]!.name).toBe('Kemi'); // the API's name, not the HELLO's
    // a ticket admits once
    expect(refused(good)).toMatch(/already used/);
  });

  it('a player coming back resumes with its session token; an unknown token still needs a ticket', () => {
    const rooms = registry();
    const first = enter(rooms, '/ws/AAAAAA', 'Ade', { ticket: ticket() });
    const token = first.welcome()!.sessionToken;
    first.c!.closed(); // the tab reloads: the player waits for its session
    nowS += 600; // long after the ticket expired
    const back = enter(rooms, '/ws/AAAAAA', 'Ade', { token, ticket: 'stale' });
    expect(back.welcome()).toMatchObject({ resumed: true, playerId: first.welcome()!.playerId });
    const stranger = enter(rooms, '/ws/AAAAAA', 'Mallory', { token: 'made-up-token' });
    expect(stranger.conn.closed?.code).toBe(CloseCode.TicketInvalid);
    expect(rooms.rooms.get('AAAAAA')!.humanCount).toBe(1);
  });

  it('the dev room needs none', () => {
    const rooms = new RoomRegistry({ defaultRoom: { dummies: false }, tickets: new TicketVerifier(keys.publicKey, () => nowS) });
    expect(enter(rooms, '/', 'Ade').welcome()).toBeDefined();
  });
});

describe('message handler errors', () => {
  it('cost only the client whose message threw: kicked (1011), logged; the room plays on', () => {
    const logs: string[] = [];
    const room = new Room({ dummies: false, dev: false, match: { countdown: 1 }, log: (m) => logs.push(m) });
    const a = join(room, 'Ade');
    const b = join(room, 'Kemi');
    // a bug in one handler: ReportPing throws
    const internals = room as unknown as { onCmd(client: unknown, kind: number, payload: string): void };
    const original = internals.onCmd.bind(room);
    internals.onCmd = (client, kind, payload) => {
      if (kind === CmdKind.ReportPing) throw new TypeError('a bug');
      original(client, kind, payload);
    };
    a.cmd(CmdKind.ReportPing, '42');
    expect(a.conn.closed).toEqual({ code: 1011, reason: 'server error' });
    expect(logs.some((l) => l.includes('threw') && l.includes('a bug'))).toBe(true);
    b.cmd(CmdKind.Ready, '1');
    step(room, 3);
    expect(b.conn.closed).toBeNull();
    expect(room.humanCount).toBe(1);
  });
});

describe('match rooms', () => {
  const quick = { countdown: 1, timeLimit: 2, killLimit: 0, ending: 1, postgame: 2, onNoRematch: 'lobby' as const };

  it('sends MATCH_STATE: host, lobby flags, rules; everyone ready → countdown → match → results', () => {
    const room = new Room({ dummies: false, dev: false, match: quick });
    const a = join(room, 'Ade');
    step(room);
    let s = a.conn.match();
    expect(s).toMatchObject({ phase: MatchPhase.Waiting, hostId: a.id, mapId: 'movement-test', number: 0 });
    expect(s.rules).toMatchObject({ timeLimit: 2, killLimit: 0, countdown: 1 });
    expect(s.lobby).toEqual([{ id: a.id, team: -1, ready: false, rematch: false, pingMs: -1 }]);

    const b = join(room, 'Kemi');
    a.cmd(CmdKind.Ready, '1');
    a.cmd(CmdKind.ReportPing, '42');
    step(room, 7);
    s = b.conn.match();
    expect(s.hostId).toBe(a.id);
    expect(s.lobby).toEqual(
      expect.arrayContaining([
        { id: a.id, ready: true, rematch: false, pingMs: 42, team: -1 },
        { id: b.id, ready: false, rematch: false, pingMs: -1, team: -1 },
      ]),
    );
    expect(s.phase).toBe(MatchPhase.Waiting); // Kemi isn't ready

    b.cmd(CmdKind.Ready, '1');
    step(room);
    s = b.conn.match(); // phase changes go out the same tick
    expect(s.phase).toBe(MatchPhase.Countdown);
    expect(s.phaseStartTick).toBe(room.game.tick);
    // the countdown freezes inputs on the server: walking right does nothing
    const x0 = room.game.players[a.id]!.x;
    for (let t = 0; t < 20; t++) {
      room.receive(a.client, encodeInput({ newestTick: room.game.tick & 0xffff, ackSnapshotSeq: 0, renderTick: 0, renderFrac: 0, inputs: [{ ...createInput(), buttons: Btn.Right }] }));
      step(room);
    }
    expect(room.game.players[a.id]!.x).toBe(x0);
    step(room, ticks(1));
    s = a.conn.match();
    expect(s).toMatchObject({ phase: MatchPhase.InProgress, number: 1 });
    expect(s.phaseStartTick).toBe(room.game.tick - room.match!.phaseTick);
    expect(s.standings.map((r) => r.name).sort()).toEqual(['Ade', 'Kemi']);

    step(room, ticks(2));
    s = a.conn.match();
    expect(s.phase).toBe(MatchPhase.Ending);
    expect(s.results).toMatchObject({ number: 1, reason: 2, durationTicks: ticks(2) });

    // both vote: straight back to the lobby, ready, and on into the next countdown
    a.cmd(CmdKind.Rematch);
    b.cmd(CmdKind.Rematch);
    step(room, 2);
    expect(a.conn.match().phase).toBe(MatchPhase.Countdown);
  });

  it('only the host changes settings (lobby only, valid values), starts or ends the match; the host role moves on', () => {
    const room = new Room({ dummies: false, dev: false, match: { ...quick, timeLimit: 300, killLimit: 20 } });
    const a = join(room, 'Ade');
    const b = join(room, 'Kemi');
    b.cmd(CmdKind.MatchSettings, JSON.stringify({ timeLimit: 120 }));
    step(room, 7);
    expect(a.conn.match().rules.timeLimit).toBe(300);
    a.cmd(CmdKind.MatchSettings, JSON.stringify({ timeLimit: 120, killLimit: 0 }));
    step(room, 7);
    expect(b.conn.match().rules).toMatchObject({ timeLimit: 120, killLimit: 0 });
    a.cmd(CmdKind.MatchSettings, JSON.stringify({ timeLimit: 0, killLimit: 0 })); // a match must be able to end
    a.cmd(CmdKind.MatchSettings, JSON.stringify({ timeLimit: 30 }));
    a.cmd(CmdKind.MatchSettings, '{"killLimit": 1e9}');
    a.cmd(CmdKind.MatchSettings, 'not json');
    step(room, 7);
    expect(b.conn.match().rules).toMatchObject({ timeLimit: 120, killLimit: 0 });

    b.cmd(CmdKind.StartMatch); // not the host
    step(room, 2);
    expect(room.match!.phase).toBe(MatchPhase.Waiting);
    a.cmd(CmdKind.StartMatch);
    step(room, 2);
    expect(room.match!.phase).toBe(MatchPhase.Countdown);
    a.cmd(CmdKind.MatchSettings, JSON.stringify({ timeLimit: 600 })); // not between rounds
    b.cmd(CmdKind.ReturnToLobby); // not the host
    step(room, 7);
    expect(room.match!.phase).toBe(MatchPhase.Countdown);
    expect(room.match!.rules.timeLimit).toBe(120);

    // the host leaves for good: Kemi (next longest present) gets the role and sends everyone back
    a.cmd(CmdKind.Leave);
    step(room);
    expect(b.conn.match().hostId).toBe(b.id);
    b.cmd(CmdKind.ReturnToLobby);
    step(room, 2);
    expect(b.conn.match().phase).toBe(MatchPhase.Waiting);
  });

  it('free-play rooms ignore lobby commands but honour Leave', () => {
    const room = new Room({ dummies: false, dev: false });
    const a = join(room, 'Ade');
    a.cmd(CmdKind.Ready, '1');
    a.cmd(CmdKind.StartMatch);
    step(room, 10);
    expect(a.conn.all(MsgType.MatchState)).toHaveLength(0);
    a.cmd(CmdKind.Leave);
    expect(room.humanCount).toBe(0);
  });
});

describe('message rate limit', () => {
  it('a stalled stream delivering seconds of honest messages at once passes; a sustained flood does not', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade');
    // ~5 s of an honest client's traffic (61/s) arriving in one go, after a tunnel hiccup
    for (let i = 0; i < 300; i++) room.receive(a.client, encodePing(i));
    expect(a.conn.closed).toBeNull();
    room.resetRateLimits();
    const b = join(room, 'Kemi');
    let seconds = 0;
    while (!b.conn.closed && seconds < 10) {
      for (let i = 0; i < 400; i++) room.receive(b.client, encodePing(i));
      room.resetRateLimits();
      seconds++;
    }
    expect(b.conn.closed?.code).toBe(CloseCode.RateLimited);
    expect(seconds).toBeLessThanOrEqual(3);
    expect(a.conn.closed).toBeNull();
  });
});

describe('room helpers', () => {
  it('trims names by character, never through one, to 16 characters and 48 bytes', () => {
    expect(sanitizeName('  Ade\u0007 ', 'x')).toBe('Ade');
    expect(sanitizeName('ABCDEFGHIJKLMNOPQRST', 'x')).toBe('ABCDEFGHIJKLMNOP');
    expect(sanitizeName('Kemi🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀', 'x')).toBe('Kemi🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀🚀'); // 4 + 11 × 4 bytes = 48
    expect(sanitizeName('​‮', 'Player 2')).toBe('Player 2');
    expect(sanitizeName('Ọlá'.normalize('NFD').repeat(6), 'x').normalize('NFC')).toBe('ỌláỌláỌláỌláỌláỌ');
  });

  it('parses host settings strictly', () => {
    const now = { timeLimit: 300, killLimit: 20 };
    expect(parseMatchSettings('{"timeLimit":180}', now, 'movement-test')).toEqual({ timeLimit: 180, killLimit: 20, mapId: 'movement-test' });
    expect(parseMatchSettings('{"killLimit":0,"timeLimit":1200}', now, 'movement-test')).toEqual({ timeLimit: 1200, killLimit: 0, mapId: 'movement-test' });
    for (const bad of ['{"timeLimit":59}', '{"timeLimit":1201}', '{"killLimit":4}', '{"killLimit":2.5}', '{"timeLimit":"300"}', '{"mapId":"nope"}', '{"mapId":"__proto__"}', 'null', '[]', '{"timeLimit":0,"killLimit":0}'])
      expect(parseMatchSettings(bad, now, 'movement-test'), bad).toBeNull();
  });
});

const transports: TransportKind[] = loadUws() ? ['uws', 'ws'] : ['ws'];

describe.each(transports)('rooms over WebSockets (%s)', (transport) => {
  let server: RunningServer;

  beforeAll(async () => {
    server = await createServer(0, {}, () => {}, transport, undefined, { host: '127.0.0.1', defaultRoom: false, maxRooms: 3 });
  });
  afterAll(() => server?.close());

  function open(path: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}${path}`);
    ws.binaryType = 'arraybuffer';
    const messages: Message[] = [];
    ws.onmessage = (ev) => messages.push(decodeMessage(new Uint8Array(ev.data as ArrayBuffer)));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => (ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason })));
    const opened = new Promise<void>((resolve) => (ws.onopen = () => resolve()));
    const waitFor = async <T extends Message['type']>(type: T, timeoutMs = 3000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = messages.find((m): m is Extract<Message, { type: T }> => m.type === type);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for 0x${type.toString(16)}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    return { ws, messages, opened, closed, waitFor };
  }

  it('players with the same code share a room; another code is another room; bad or missing codes are refused', async () => {
    const a = open('/ws/FGHJKM');
    const b = open('/FGHJKM');
    const c = open('/ws?room=NPQRST');
    await Promise.all([a.opened, b.opened, c.opened]);
    a.ws.send(encodeHello('Ade'));
    b.ws.send(encodeHello('Kemi'));
    c.ws.send(encodeHello('Tunde'));
    const [wa, wb, wc] = (await Promise.all([a.waitFor(MsgType.Welcome), b.waitFor(MsgType.Welcome), c.waitFor(MsgType.Welcome)])) as WelcomeMsg[];
    expect(wa!.playerId).not.toBe(wb!.playerId);
    expect(wc!.playerId).toBe(0); // alone in its own room
    expect(server.rooms.rooms.size).toBe(2);
    const state = (await a.waitFor(MsgType.MatchState)) as MatchStateMsg;
    expect(state.hostId).toBe(wa!.playerId);

    for (const path of ['/', '/ws/BAD', '/ws/KQ0MZP']) {
      const bad = open(path);
      const { code, reason } = await bad.closed;
      expect(code).toBe(CloseCode.NoRoom);
      expect(reason).toMatch(/room code/);
    }
    const health = (await (await fetch(`http://127.0.0.1:${server.port}/health`)).json()) as { players: number; rooms: number };
    expect(health).toMatchObject({ players: 3, rooms: 2 });
    for (const x of [a, b, c]) x.ws.close();
  });

  it('refuses a new room once maxRooms are open (a room opens at its first HELLO)', async () => {
    // FGHJKM / NPQRST from the last test may still be open (reconnect grace): fill up to 3 either way
    const held: ReturnType<typeof open>[] = [];
    for (const code of ['UVWXYZ', 'ABCDEF', 'GHJKMN']) {
      if (server.rooms.rooms.size >= 3) break;
      const h = open(`/ws/${code}`);
      await h.opened;
      h.ws.send(encodeHello('Ade'));
      await h.waitFor(MsgType.Welcome);
      held.push(h);
    }
    expect(server.rooms.rooms.size).toBe(3);
    const refused = open('/ws/HJKMNP');
    await refused.opened;
    refused.ws.send(encodeHello('Kemi'));
    expect((await refused.closed).reason).toMatch(/server full/);
    for (const h of held) h.ws.close();
  });
});

describe.each(transports)('the door and tickets over WebSockets (%s)', (transport) => {
  const keys = generateKeyPairSync('ed25519');
  let server: RunningServer;

  beforeAll(async () => {
    server = await createServer(0, {}, () => {}, transport, undefined, {
      host: '127.0.0.1',
      defaultRoom: false,
      tickets: new TicketVerifier(keys.publicKey),
      trustProxy: true,
      door: { perIp: 1 },
      helloTimeoutMs: 300,
    });
  });
  afterAll(() => server?.close());

  /** a socket with headers (the browser API can't set them), as the playtest proxy sends it */
  function dial(path: string, forwardedFrom?: string) {
    const ws = new WsClient(`ws://127.0.0.1:${server.port}${path}`, forwardedFrom ? { headers: { 'x-forwarded-for': forwardedFrom } } : {});
    const messages: Message[] = [];
    ws.on('message', (data: Buffer) => messages.push(decodeMessage(new Uint8Array(data))));
    const opened = new Promise<void>((resolve) => ws.once('open', () => resolve()));
    const closed = new Promise<{ code: number; reason: string }>((resolve) => ws.once('close', (code: number, reason: Buffer) => resolve({ code, reason: reason.toString() })));
    ws.on('error', () => {});
    return { ws, messages, opened, closed };
  }

  it('a silent socket is closed after the HELLO deadline, and holds nothing meanwhile', async () => {
    const silent = dial('/ws/QRSTUV', '203.0.113.7');
    await silent.opened;
    expect(server.rooms.atDoor).toBe(1);
    expect(server.rooms.rooms.size).toBe(0);
    expect(await silent.closed).toEqual({ code: 1008, reason: 'no HELLO within 0.3 s' });
    expect(server.rooms.atDoor).toBe(0);
  });

  it('caps waiting sockets per client address (X-Forwarded-For behind our proxy)', async () => {
    const first = dial('/ws/WXYZAB', '203.0.113.8');
    await first.opened;
    const second = dial('/ws/WXYZAB', '203.0.113.8');
    expect(await second.closed).toEqual({ code: CloseCode.RateLimited, reason: 'too many connections from your network' });
    const neighbour = dial('/ws/WXYZAB', '203.0.113.9');
    await neighbour.opened;
    expect(server.rooms.atDoor).toBe(2);
    first.ws.close();
    neighbour.ws.close();
  });

  it('a HELLO needs a ticket for the room; with one, the player is in', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const iat = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(JSON.stringify({ iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, sub: 'u_1', iat, exp: iat + 30, nick: 'Kemi', room: 'CDEFGH', jti: 'j1' })).toString('base64url');
    const ticket = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`;

    const without = dial('/ws/CDEFGH', '203.0.113.10');
    await without.opened;
    without.ws.send(encodeHello('Kemi'));
    expect((await without.closed).code).toBe(CloseCode.TicketInvalid);
    expect(server.rooms.rooms.size).toBe(0);

    const player = dial('/ws/CDEFGH', '203.0.113.11');
    await player.opened;
    player.ws.send(encodeHello('Kemi', '', ticket));
    for (let i = 0; i < 300 && !player.messages.some((m) => m.type === MsgType.Welcome); i++) await new Promise((r) => setTimeout(r, 10));
    expect(player.messages.some((m) => m.type === MsgType.Welcome)).toBe(true);
    expect(server.rooms.rooms.has('CDEFGH')).toBe(true);
    player.ws.close();
  });
});

describe.each(transports)('a handler that throws (%s)', (transport) => {
  it('closes only that socket (1011); the server keeps serving', async () => {
    const logs: string[] = [];
    const target: RoomTarget = {
      open: (_url, conn) => ({
        receive: (bytes) => {
          if (bytes[0] === 0x66) throw new Error('boom');
          conn.send(bytes); // echo
        },
        closed: () => {},
      }),
      humanCount: 0,
      roomCount: 0,
      tick: 0,
    };
    const options = { host: '127.0.0.1', log: (m: string) => logs.push(m) };
    const uws = loadUws();
    const started = transport === 'uws' && uws ? await startUws(uws.mod, 0, target, options) : await startWs(0, target, options);
    try {
      const url = `ws://127.0.0.1:${started.port}/ws/ABCDEF`;
      const victim = new WebSocket(url);
      const bystander = new WebSocket(url);
      victim.binaryType = bystander.binaryType = 'arraybuffer';
      await Promise.all([victim, bystander].map((ws) => new Promise((r) => (ws.onopen = r))));
      const closed = new Promise<number>((r) => (victim.onclose = (ev) => r(ev.code)));
      victim.send(new Uint8Array([0x66]));
      expect(await closed).toBe(1011);
      expect(logs.some((l) => l.includes('a message handler threw') && l.includes('boom'))).toBe(true);
      const echo = new Promise<number>((r) => (bystander.onmessage = (ev) => r(new Uint8Array(ev.data as ArrayBuffer)[0]!)));
      bystander.send(new Uint8Array([0x42]));
      expect(await echo).toBe(0x42);
      expect((await fetch(`http://127.0.0.1:${started.port}/health`)).status).toBe(200);
      bystander.close();
    } finally {
      started.close();
    }
  });
});

describe('X-Forwarded-For', () => {
  it('takes the last entry (the one our proxy wrote) and only an address', () => {
    expect(forwardedFor('203.0.113.7')).toBe('203.0.113.7');
    expect(forwardedFor('10.0.0.1, 203.0.113.7')).toBe('203.0.113.7');
    expect(forwardedFor(['1.1.1.1', '2001:db8::1'])).toBe('2001:db8::1');
    expect(forwardedFor('')).toBeNull();
    expect(forwardedFor(undefined)).toBeNull();
    expect(forwardedFor('evil<script>')).toBeNull();
  });
});
