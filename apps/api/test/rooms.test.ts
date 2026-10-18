/** /rooms: minting codes, joining by code, the miss limit and the game-server address. */
import { isRoomCode } from '@military-forge/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '../src/auth/keys';
import { verifyJwt } from '../src/auth/tokens';
import { LIMITS } from '../src/http/rateLimit';
import { ROOM_TTL_MS, TICKET_AUDIENCE, TICKET_ISSUER, type JoinTicketClaims, type RoomJoin } from '../src/rooms/routes';
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
    } finally {
      await signed.close();
    }
  });
});
