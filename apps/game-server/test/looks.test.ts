/**
 * Looks on the wire (protocol v19): the room holds each player's look to what they own, tells everyone in
 * the ROSTER, gives bots seeded looks, and keeps v17/v18 pages playing. Then end to end: two NetClients over
 * real sockets, and B sees A's look.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  DEFAULT_COSMETIC_LOADOUT,
  botLook,
  cosmeticLoadoutFromWireIds,
  cosmeticLoadoutWireIds,
  loadoutBody,
  lookSeed,
  maps,
  type CosmeticLoadout,
} from '@military-forge/content';
import { NetClient } from '@military-forge/netcode';
import { BitWriter, CmdKind, CONTENT_HASH, MsgType, decodeMessage, encodeCmd, encodeHello, encodeLookCmd, type Message } from '@military-forge/protocol';
import { warmNavGraphs } from '@military-forge/bots';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Room, type ClientConn } from '../src/room';
import { RoomRegistry } from '../src/rooms';
import { createServer, type RunningServer } from '../src/server';
import { TICKET_AUDIENCE, TICKET_ISSUER, TicketVerifier } from '../src/tickets';

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
  /** the newest ROSTER's looks, by player id */
  looks(): Map<number, CosmeticLoadout | null> {
    const roster = this.all(MsgType.Roster).at(-1)!;
    return new Map(roster.entries.map((e) => [e.id, e.look ? cosmeticLoadoutFromWireIds(e.look) : null]));
  }
}

const look = (items: Partial<CosmeticLoadout['items']>, dyes: Partial<CosmeticLoadout['dyes']> = {}): CosmeticLoadout => ({
  items: { ...DEFAULT_COSMETIC_LOADOUT.items, ...items },
  dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes, ...dyes },
});
const ids = (l: CosmeticLoadout) => cosmeticLoadoutWireIds(l);
const HERS = look({ bodyType: 'body_female', hair: 'hair_braids', headgear: 'headgear_bandana' }, { primary: 'dye_khaki', accent: 'dye_terracotta' });

const keys = generateKeyPairSync('ed25519');
const nowS = 1_760_000_000;
const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
let jti = 0;
function ticket(over: Record<string, unknown> = {}, room = 'AAAAAA', iat = nowS) {
  const claims = { iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, sub: `u_${jti}`, iat, exp: iat + 30, nick: `P${jti}`, room, jti: `t${++jti}`, ...over };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`;
}

function join(room: Room, name: string, wear: CosmeticLoadout | null = null) {
  const conn = new FakeConn();
  const client = room.connect(conn);
  room.receive(client, encodeHello(name, '', '', wear ? ids(wear) : null));
  const id = conn.all(MsgType.Welcome).at(-1)!.playerId;
  return { conn, client, id };
}

describe('looks in a room (v19)', () => {
  it('everyone gets everyone\'s look in the ROSTER; the newcomer is drawn in the look its page sent', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade', HERS);
    const b = join(room, 'Kemi', look({ boots: 'boots_jungle' }, { secondary: 'dye_forest' }));
    expect(a.conn.looks().get(b.id)).toEqual(look({ boots: 'boots_jungle' }, { secondary: 'dye_forest' }));
    expect(b.conn.looks().get(a.id)).toEqual(HERS);
    expect(room.lookOf(a.id)).toEqual(ids(HERS));
  });

  it('holds a look to what the player owns and to the body\'s fit: no ticket = starter items only', () => {
    const room = new Room({ dummies: false });
    const greedy = look({ headgear: 'headgear_combat_helmet', legs: 'legs_cargo_shorts', bodyType: 'body_stocky', hair: 'hair_bun' }, { primary: 'dye_gold' });
    const p = join(room, 'Tunde', greedy);
    const got = p.conn.looks().get(p.id)!;
    expect(got.items.headgear).toBe(DEFAULT_COSMETIC_LOADOUT.items.headgear); // store
    expect(got.items.legs).toBe(DEFAULT_COSMETIC_LOADOUT.items.legs); // level 15
    expect(got.items.bodyType).toBe('body_stocky'); // starter
    expect(got.items.hair).toBe('hair_body'); // her hairstyles fit the female body only
    expect(got.dyes.primary).toBe(DEFAULT_COSMETIC_LOADOUT.dyes.primary); // battle pass
  });

  it('a page that sends no look (v17/v18) has none on the wire: everyone draws its placeholder; it still plays', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade', HERS);
    // a v17 page's HELLO, byte for byte as it shipped
    const old = new BitWriter(256).u8(MsgType.Hello).u16(17).u32(CONTENT_HASH).string('Old').string('').finish().slice();
    const conn = new FakeConn();
    const client = room.connect(conn);
    room.receive(client, old);
    expect(conn.closed).toBeNull();
    const oldId = conn.all(MsgType.Welcome).at(-1)!.playerId;
    expect(a.conn.looks().get(oldId)).toBeNull();
    expect(client.protocolVersion).toBe(17);
    // and v16 is refused
    const older = new FakeConn();
    room.receive(room.connect(older), new BitWriter(256).u8(MsgType.Hello).u16(16).u32(CONTENT_HASH).string('Older').string('').finish().slice());
    expect(older.closed?.reason).toMatch(/version mismatch/);
  });

  it('SetLook changes it for everyone, batched to one ROSTER per half second; junk is a strike, not a look', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade');
    const b = join(room, 'Kemi');
    const rostersBefore = b.conn.all(MsgType.Roster).length;
    room.receive(a.client, encodeLookCmd(ids(look({ eyewear: 'eyewear_aviators' }))));
    room.receive(a.client, encodeLookCmd(ids(HERS))); // the latest wins
    room.tick();
    expect(b.conn.all(MsgType.Roster).length).toBe(rostersBefore + 1);
    expect(b.conn.looks().get(a.id)).toEqual(HERS);
    // again at once: it waits out the half second, then goes
    room.receive(a.client, encodeLookCmd(ids(look({ gloves: 'gloves_tactical' }))));
    room.tick();
    expect(b.conn.all(MsgType.Roster).length).toBe(rostersBefore + 1);
    for (let i = 0; i < 30; i++) room.tick();
    expect(b.conn.all(MsgType.Roster).length).toBe(rostersBefore + 2);
    expect(b.conn.looks().get(a.id)!.items.gloves).toBe('gloves_tactical');
    // the same look again: nothing to say
    room.receive(a.client, encodeLookCmd(ids(look({ gloves: 'gloves_tactical' }))));
    for (let i = 0; i < 40; i++) room.tick();
    expect(b.conn.all(MsgType.Roster).length).toBe(rostersBefore + 2);
    const strikes = a.client.strikes;
    room.receive(a.client, encodeCmd(CmdKind.SetLook, '{"not":"a look"}'));
    expect(a.client.strikes).toBe(strikes + 1);
  });

  it('a reconnect keeps the look, and a HELLO with a new one changes it', () => {
    const room = new Room({ dummies: false });
    const a = join(room, 'Ade', HERS);
    const b = join(room, 'Kemi');
    const token = a.conn.all(MsgType.Welcome).at(-1)!.sessionToken;
    room.disconnect(a.client);
    const again = new FakeConn();
    room.receive(room.connect(again), encodeHello('Ade', token));
    expect(again.looks().get(a.id)).toEqual(HERS);
    const third = new FakeConn();
    const token2 = again.all(MsgType.Welcome).at(-1)!.sessionToken;
    room.receive(room.connect(third), encodeHello('Ade', token2, '', ids(look({ boots: 'boots_jungle' }))));
    for (let i = 0; i < 31; i++) room.tick();
    expect(b.conn.looks().get(a.id)).toEqual(look({ boots: 'boots_jungle' }));
  });

  it('bots wear seeded looks: both bodies, the same for a bot all room long, the same on every server', () => {
    warmNavGraphs([maps['movement-test']!]); // bots come in once the map's nav graph is built
    const room = new Room({ dummies: false, seed: 77, fillBots: { target: 12, level: 'easy' } });
    const p = join(room, 'Ade');
    room.tick();
    expect(room.bots.length).toBe(11);
    const looks = p.conn.looks();
    const bodies = new Set<string>();
    for (const bot of room.bots) {
      const got = looks.get(bot.id)!;
      expect(got).toEqual(botLook(lookSeed(77, bot.name)));
      bodies.add(loadoutBody(got));
    }
    expect(bodies).toEqual(new Set(['male', 'female']));
    expect(new Set(room.bots.map((b) => JSON.stringify(looks.get(b.id)))).size).toBeGreaterThan(8);
  });
});

describe('looks and join tickets (v19)', () => {
  const rooms = () => new RoomRegistry({ defaultRoom: null, tickets: new TicketVerifier(keys.publicKey, () => nowS) });
  const conn = () => new FakeConn();

  it('the ticket\'s level lets a player wear what they unlocked; the ticket\'s look is worn until the page sends one', () => {
    const reg = rooms();
    const levelled = look({ legs: 'legs_cargo_shorts', headgear: 'headgear_beret' }); // levels 15 and 10
    const c1 = conn();
    reg.open('/ws/AAAAAA', c1, null)!.receive(encodeHello('x', '', ticket({ lvl: 15 }), ids(levelled)));
    const c2 = conn();
    reg.open('/ws/AAAAAA', c2, null)!.receive(encodeHello('x', '', ticket({ lvl: 9 }), ids(levelled)));
    // a page that sends no look (v18): the API's saved look from the ticket
    const c3 = conn();
    reg.open('/ws/AAAAAA', c3, null)!.receive(encodeHello('x', '', ticket({ look: ids(HERS), lvl: 1 })));
    const looks = c3.looks();
    const [id1, id2, id3] = [c1, c2, c3].map((c) => c.all(MsgType.Welcome).at(-1)!.playerId);
    expect(looks.get(id1!)).toEqual(levelled);
    expect(looks.get(id2!)!.items.legs).toBe(DEFAULT_COSMETIC_LOADOUT.items.legs);
    expect(looks.get(id2!)!.items.headgear).toBe(DEFAULT_COSMETIC_LOADOUT.items.headgear);
    expect(looks.get(id3!)).toEqual(HERS);
  });

  it('an item the API vouched for (in the ticket\'s look) may be worn whatever the level; a junk ticket look is ignored', () => {
    const reg = rooms();
    const vouched = look({ legs: 'legs_cargo_shorts' });
    const c1 = conn();
    reg.open('/ws/AAAAAA', c1, null)!.receive(encodeHello('x', '', ticket({ look: ids(vouched), lvl: 1 }), ids(vouched)));
    const c2 = conn();
    reg.open('/ws/AAAAAA', c2, null)!.receive(encodeHello('x', '', ticket({ look: ['a', -1], lvl: 'high' })));
    const looks = c2.looks();
    expect(looks.get(c1.all(MsgType.Welcome).at(-1)!.playerId)).toEqual(vouched);
    expect(looks.get(c2.all(MsgType.Welcome).at(-1)!.playerId)).toBeNull();
  });

  it('a ticketed join keeps the page\'s own protocol version (its HELLO is re-encoded under the API\'s name)', () => {
    const reg = rooms();
    const old = new BitWriter(2048).u8(MsgType.Hello).u16(18).u32(CONTENT_HASH).string('x').string('').string(ticket(), 16).finish().slice();
    const c = conn();
    reg.open('/ws/AAAAAA', c, null)!.receive(old);
    expect(c.closed).toBeNull();
    const room = reg.rooms.get('AAAAAA')!;
    expect([...room.clients][0]!.protocolVersion).toBe(18);
  });
});

describe('end to end: B sees A\'s look (two NetClients, real sockets)', () => {
  let server: RunningServer;
  beforeAll(async () => {
    server = await createServer(0, {}, () => {}, 'ws', undefined, { host: '127.0.0.1', defaultRoom: false, tickets: new TicketVerifier(keys.publicKey) });
  });
  afterAll(() => server?.close());

  function player(name: string, wear: CosmeticLoadout | null, t: string) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws/KMNPQR`);
    ws.binaryType = 'arraybuffer';
    const net = new NetClient({ name, ticket: t, ...(wear ? { look: ids(wear) } : {}), send: (b) => ws.send(b), now: () => performance.now() });
    ws.onopen = () => net.onOpen();
    ws.onmessage = (ev) => net.receive(new Uint8Array(ev.data as ArrayBuffer));
    return { ws, net };
  }
  const until = async (ok: () => boolean, what: string) => {
    for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
    if (!ok()) throw new Error(`timed out: ${what}`);
  };

  it('A joins in her female soldier\'s look; B joins and draws A in it; A changes and B sees the change', async () => {
    const now = Math.floor(Date.now() / 1000);
    const a = player('Ade', HERS, ticket({ lvl: 1 }, 'KMNPQR', now));
    await until(() => a.net.joined, 'A joined');
    const b = player('Kemi', null, ticket({ look: ids(look({ boots: 'boots_jungle' })), lvl: 1 }, 'KMNPQR', now));
    await until(() => b.net.joined && b.net.looks.has(a.net.myId), 'B has A\'s look');
    const seen = cosmeticLoadoutFromWireIds(b.net.looks.get(a.net.myId)!);
    expect(seen).toEqual(HERS);
    expect(loadoutBody(seen)).toBe('female');
    // B sent no look: everyone sees the look the API saved for B (the ticket's)
    await until(() => a.net.looks.has(b.net.myId), 'A has B\'s look');
    expect(cosmeticLoadoutFromWireIds(a.net.looks.get(b.net.myId)!).items.boots).toBe('boots_jungle');

    // A changes her look (the Locker, mid-room): B sees it
    const next = look({ bodyType: 'body_female', hair: 'hair_bun' }, { primary: 'dye_charcoal' });
    a.net.setLook(ids(next));
    await until(() => JSON.stringify(b.net.looks.get(a.net.myId)) === JSON.stringify(ids(next)), 'B sees A\'s new look');
    a.ws.close();
    b.ws.close();
  });
});
