/** /rooms: minting codes, joining by code, the miss limit and the game-server address. */
import { DEFAULT_COSMETIC_LOADOUT, cosmeticLoadoutFromWireIds } from '@military-forge/content';
import { isRoomCode } from '@military-forge/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '../src/auth/keys';
import { verifyJwt } from '../src/auth/tokens';
import { loadouts } from '../src/db/schema';
import { LIMITS } from '../src/http/rateLimit';
import { ROOM_TTL_MS, TICKET_AUDIENCE, TICKET_ISSUER, keepRooms, type JoinTicketClaims, type RoomJoin } from '../src/rooms/routes';
import { bearer, createGuest, createTestApi, json, type TestApi } from './helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(() => api.close());

const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; [k: string]: unknown } }).error;

async function create(token: string, ip = api.ip()) {
  return api.app.request('/rooms', json({}, { ...bearer(token), 'x-forwarded-for': ip }));
}
async function joinRoom(token: string, code: string, ip = api.ip()) {
  return api.app.request(`/rooms/${encodeURIComponent(code)}/join`, json({}, { ...bearer(token), 'x-forwarded-for': ip }));
}

describe('POST /rooms', () => {
  it('needs a session and mints a fresh 6-letter code; the room is joinable by that code', async () => {
    expect((await api.app.request('/rooms', json({}))).status).toBe(401);
    const host = await createGuest(api);
    const res = await create(host.accessToken);
    expect(res.status).toBe(201);
    const room = (await res.json()) as RoomJoin;
    expect(isRoomCode(room.code)).toBe(true);
    expect(room).toEqual({ code: room.code, roomId: room.code, gsUrl: null, ticket: null });

    const friend = await createGuest(api);
    const joined = await joinRoom(friend.accessToken, room.code.toLowerCase());
    expect(joined.status).toBe(200);
    expect((await joined.json()) as RoomJoin).toEqual(room);
  });

  it('codes are unique and stay joinable for a while after their last join', async () => {
    const host = await createGuest(api);
    const codes = new Set<string>();
    for (let i = 0; i < 10; i++) codes.add(((await (await create(host.accessToken)).json()) as RoomJoin).code);
    expect(codes.size).toBe(10);
    const code = [...codes][0]!;
    if (api.kv.kind !== 'memory') return; // a real Valkey's TTLs can't be fast-forwarded
    // (access tokens last 15 min: a fresh guest for each join after the clock moves)
    api.clock.advance(ROOM_TTL_MS - 60_000);
    expect((await joinRoom((await createGuest(api)).accessToken, code)).status).toBe(200); // slides the expiry
    api.clock.advance(ROOM_TTL_MS - 60_000);
    expect((await joinRoom((await createGuest(api)).accessToken, code)).status).toBe(200);
    api.clock.advance(ROOM_TTL_MS + 1);
    expect((await joinRoom((await createGuest(api)).accessToken, code)).status).toBe(404);
  });

  it('is rate limited per player', async () => {
    const host = await createGuest(api);
    for (let i = 0; i < LIMITS.roomCreate.limit; i++) expect((await create(host.accessToken)).status).toBe(201);
    const res = await create(host.accessToken);
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
  });
});

describe('POST /rooms/:code/join', () => {
  it('unknown and malformed codes are 404 / 400, and 5 misses a minute per IP lock that IP out', async () => {
    const s = await createGuest(api);
    const ip = api.ip();
    expect(await errorOf(await joinRoom(s.accessToken, 'ZZZZZZ', ip))).toMatchObject({ code: 'room_not_found' });
    expect(await errorOf(await joinRoom(s.accessToken, 'nope!', ip))).toMatchObject({ code: 'invalid_room_code' });
    for (let i = 0; i < 3; i++) expect((await joinRoom(s.accessToken, 'YYYYYY', ip)).status).toBe(404);
    const host = await createGuest(api);
    const real = ((await (await create(host.accessToken)).json()) as RoomJoin).code;
    const locked = await joinRoom(s.accessToken, real, ip);
    expect(locked.status).toBe(429); // even a right code, once locked out
    expect((await joinRoom(s.accessToken, real, api.ip())).status).toBe(200); // other networks are unaffected
    if (api.kv.kind !== 'memory') return; // a real Valkey's window can't be fast-forwarded
    api.clock.advance(LIMITS.roomJoinMiss.windowMs);
    expect((await joinRoom(s.accessToken, real, ip)).status).toBe(200);
  });

  it('points at GAME_SERVER_URL when the game server lives elsewhere', async () => {
    const other = await createTestApi({ GAME_SERVER_URL: 'wss://gs.example.com/' });
    try {
      const s = await createGuest(other);
      const room = (await (await other.app.request('/rooms', json({}, { ...bearer(s.accessToken), 'x-forwarded-for': other.ip() }))).json()) as RoomJoin;
      expect(room.gsUrl).toBe(`wss://gs.example.com/ws/${room.code}`);
    } finally {
      await other.close();
    }
  });
});

describe('join tickets (docs/06 §6)', () => {
  it('create and join hand out a one-use ticket for the game server: who, under which name, which room, ~30 s', async () => {
    const ticketKey = generateSigningKey();
    const signed = await createTestApi({}, { ticketKey });
    try {
      const host = await createGuest(signed, { nickname: 'Ade' });
      const created = (await (await signed.app.request('/rooms', json({}, { ...bearer(host.accessToken), 'x-forwarded-for': signed.ip() }))).json()) as RoomJoin;
      const friend = await createGuest(signed, { nickname: 'Kemi' });
      const joined = (await (await signed.app.request(`/rooms/${created.code}/join`, json({}, { ...bearer(friend.accessToken), 'x-forwarded-for': signed.ip() }))).json()) as RoomJoin;
      const nowSeconds = Math.floor(signed.clock.now() / 1000);
      const check = (ticket: string | null) => {
        const v = verifyJwt<JoinTicketClaims>(ticket!, ticketKey.publicKey, { iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, nowSeconds });
        if (!v.ok) throw new Error(v.reason);
        return v.claims;
      };
      const a = check(created.ticket);
      const b = check(joined.ticket);
      expect(a).toMatchObject({ sub: host.user.id, nick: 'Ade', room: created.code, exp: a.iat + 30 });
      expect(b).toMatchObject({ sub: friend.user.id, nick: 'Kemi', room: created.code });
      expect(a.jti).not.toBe(b.jti);
      // a ticket is not an access token, and the access token key doesn't sign tickets
      expect(verifyJwt(created.ticket!, ticketKey.publicKey, { iss: 'api', aud: 'api', nowSeconds })).toEqual({ ok: false, reason: 'wrong_audience' });
      expect((await signed.app.request('/me', { headers: bearer(created.ticket!) })).status).toBe(401);
      expect(a.guns).toBeUndefined(); // nothing saved: the game server gives the default pair
    } finally {
      await signed.close();
    }
  });

  it("carries the player's saved gun pair, checked against the game's content again", async () => {
    const ticketKey = generateSigningKey();
    const signed = await createTestApi({}, { ticketKey });
    try {
      const s = await createGuest(signed);
      const put = await signed.app.request('/me/loadout/0', {
        method: 'PUT',
        headers: { ...bearer(s.accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ look: DEFAULT_COSMETIC_LOADOUT, guns: ['widow', 'k47'] }),
      });
      expect(put.status).toBe(200);
      const room = async () => (await (await signed.app.request('/rooms', json({}, { ...bearer(s.accessToken), 'x-forwarded-for': signed.ip() }))).json()) as RoomJoin;
      const claims = (r: RoomJoin) => {
        const v = verifyJwt<JoinTicketClaims>(r.ticket!, ticketKey.publicKey, { iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, nowSeconds: Math.floor(signed.clock.now() / 1000) });
        if (!v.ok) throw new Error(v.reason);
        return v.claims;
      };
      expect(claims(await room()).guns).toEqual(['widow', 'k47']);
      // a row that no longer fits the content (written before a change) is left out, not passed on
      await signed.database.db.update(loadouts).set({ data: { look: DEFAULT_COSMETIC_LOADOUT, guns: ['widow', 'machete'] } }).where(eq(loadouts.userId, s.user.id));
      expect(claims(await room()).guns).toBeUndefined();
    } finally {
      await signed.close();
    }
  });

  it("carries the player's saved look (v19) as wire ids, held to what they own now, and their level", async () => {
    const ticketKey = generateSigningKey();
    const signed = await createTestApi({}, { ticketKey });
    try {
      const s = await createGuest(signed);
      const room = async () => (await (await signed.app.request('/rooms', json({}, { ...bearer(s.accessToken), 'x-forwarded-for': signed.ip() }))).json()) as RoomJoin;
      const claims = (r: RoomJoin) => {
        const v = verifyJwt<JoinTicketClaims>(r.ticket!, ticketKey.publicKey, { iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, nowSeconds: Math.floor(signed.clock.now() / 1000) });
        if (!v.ok) throw new Error(v.reason);
        return v.claims;
      };
      // nothing saved: no look (the client's own look, or a placeholder), and the level
      const before = claims(await room());
      expect(before.look).toBeUndefined();
      expect(before.lvl).toBe(1);

      const hers = { ...DEFAULT_COSMETIC_LOADOUT, items: { ...DEFAULT_COSMETIC_LOADOUT.items, bodyType: 'body_female', hair: 'hair_braids' }, dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes, primary: 'dye_khaki' } };
      const put = await signed.app.request('/me/loadout/0', {
        method: 'PUT',
        headers: { ...bearer(s.accessToken), 'content-type': 'application/json' },
        body: JSON.stringify({ look: hers, guns: ['widow', 'k47'] }),
      });
      expect(put.status).toBe(200);
      const look = claims(await room()).look!;
      expect(cosmeticLoadoutFromWireIds(look)).toEqual(hers);

      // a row with an item the player doesn't own (a store helmet, written around the API's check): that slot falls back
      await signed.database.db
        .update(loadouts)
        .set({ data: { look: { ...hers, items: { ...hers.items, headgear: 'headgear_combat_helmet' } }, guns: ['widow', 'k47'] } })
        .where(eq(loadouts.userId, s.user.id));
      expect(cosmeticLoadoutFromWireIds(claims(await room()).look!)).toEqual(hers);

      // a granted skin (COSMETIC_GRANTS) rides the ticket, so the game server admits it as vouched and every
      // client in the room draws it; without the grant the ticket carries the K-47 as it ships
      const skinned = { ...hers, items: { ...hers.items, skin_k47: 'skin_k47_galaxy_relic_fx' } };
      await signed.database.db.update(loadouts).set({ data: { look: skinned, guns: ['widow', 'k47'] } }).where(eq(loadouts.userId, s.user.id));
      expect(cosmeticLoadoutFromWireIds(claims(await room()).look!).items.skin_k47).toBe('skin_k47_standard');
      (signed.config.cosmeticGrants as Map<string, string[]>).set(s.user.id, ['skin_k47_galaxy_relic_fx']);
      expect(cosmeticLoadoutFromWireIds(claims(await room()).look!)).toEqual(skinned);
    } finally {
      await signed.close();
    }
  });
});

describe('KEEP_ROOMS', () => {
  it('a restarted API holds the codes it is given: joinable at once, a code in use left as it is', async () => {
    const guest = await createGuest(api);
    expect((await joinRoom(guest.accessToken, 'KQXMZP')).status).toBe(404);
    const host = await createGuest(api);
    const made = (await (await create(host.accessToken)).json()) as RoomJoin;
    expect(await keepRooms(api.kv, ['kqx-mzp', made.code, 'NOPE0'], api.clock.now)).toBe(1); // only the new one
    const joined = await joinRoom(guest.accessToken, 'KQXMZP');
    expect(joined.status).toBe(200);
    expect(((await joined.json()) as RoomJoin).code).toBe('KQXMZP');
    expect(JSON.parse((await api.kv.get(`room:${made.code}`))!)).toMatchObject({ host: expect.not.stringMatching(/^kept$/) });
  });
});

describe('GET /rooms/:code (the invite link, mobile audit P1-3)', () => {
  it("says whose room a code is, with no session; a wrong code is a miss", async () => {
    const host = await createGuest(api);
    const room = (await (await create(host.accessToken)).json()) as RoomJoin;
    const res = await api.app.request(`/rooms/${room.code.toLowerCase()}`, { headers: { 'x-forwarded-for': api.ip() } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string; host: string | null };
    expect(body.code).toBe(room.code);
    expect(typeof body.host).toBe('string');
    expect(body.host!.length).toBeGreaterThan(2);
    expect((await api.app.request('/rooms/QQQQQQ', { headers: { 'x-forwarded-for': api.ip() } })).status).toBe(404);
    expect((await api.app.request('/rooms/x', { headers: { 'x-forwarded-for': api.ip() } })).status).toBe(400);
  });
});
