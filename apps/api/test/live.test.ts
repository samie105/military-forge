/**
 * Live data in Valkey (docs/06 §7): room codes, rate limits and presence outlive an API restart.
 * With TEST_REDIS_URL the "restart" is a new connection to the same Valkey; without it the
 * in-memory KV object stands in for Valkey (the in-memory fallback itself starts empty on a real
 * restart, which is what KEEP_ROOMS is for in dev).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '../src/http/rateLimit';
import { PRESENCE_TTL_MS } from '../src/presence/presence';
import type { RoomJoin } from '../src/rooms/routes';
import { befriend, bearer, createGuest, createTestApi, json, type TestApi } from './helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(() => api.close());

type App = TestApi['app'];
const joinOn = (app: App, token: string, code: string, ip = '203.0.113.200') => app.request(`/rooms/${code}/join`, json({}, { ...bearer(token), 'x-forwarded-for': ip }));
const presenceOf = async (app: App, token: string, who: string) => (await (await app.request(`/players/${who}/presence`, { headers: bearer(token) })).json()) as { status: string; room?: string | null; lastSeenAt: string | null };
const beat = (app: App, token: string, room: string | null = null) => app.request('/me/presence', { method: 'PUT', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify({ room }) });

describe('after an API restart', () => {
  it('a room made before it still takes players, without KEEP_ROOMS', async () => {
    const host = await createGuest(api);
    const made = (await (await api.app.request('/rooms', json({}, { ...bearer(host.accessToken), 'x-forwarded-for': api.ip() }))).json()) as RoomJoin;
    const after = await api.restart();
    expect((await joinOn(after, (await createGuest(api)).accessToken, made.code)).status).toBe(200);
  });

  it('a rate limit reached before it still holds', async () => {
    const s = await createGuest(api);
    const ip = '198.51.100.77';
    for (let i = 0; i < LIMITS.roomJoinMiss.limit; i++) expect((await joinOn(api.app, s.accessToken, 'ZZZZZZ', ip)).status).toBe(404);
    const after = await api.restart();
    expect((await joinOn(after, s.accessToken, 'ZZZZZZ', ip)).status).toBe(429);
  });

  it("a player's presence is still there", async () => {
    const s = await createGuest(api);
    expect((await beat(api.app, s.accessToken)).status).toBe(200);
    const after = await api.restart();
    expect(await presenceOf(after, s.accessToken, 'me')).toMatchObject({ status: 'online' });
  });
});

describe('presence', () => {
  it("online while the beats come, in a room once in one (friends see which), offline when they stop or it is cleared; strangers see nothing", async () => {
    const me = await createGuest(api);
    const other = await createGuest(api);
    const stranger = await createGuest(api);
    await befriend(api.app, me, other);
    expect(await presenceOf(api.app, other.accessToken, me.user.id)).toEqual({ status: 'offline', room: null, lastSeenAt: null });

    const res = await beat(api.app, me.accessToken);
    expect(await res.json()).toEqual({ status: 'online', room: null, lastSeenAt: new Date(api.clock.now()).toISOString() });
    expect(await presenceOf(api.app, other.accessToken, me.user.id)).toMatchObject({ status: 'online' });
    // presence is private: a stranger can't tell whether you're on (or exist)
    const peek = await api.app.request(`/players/${me.user.id}/presence`, { headers: bearer(stranger.accessToken) });
    expect(peek.status).toBe(403);
    expect(((await peek.json()) as { error: { code: string } }).error.code).toBe('not_friends');

    // joining a room marks it; friends see the code (a code is an invitation)
    const room = (await (await api.app.request('/rooms', json({}, { ...bearer(other.accessToken), 'x-forwarded-for': api.ip() }))).json()) as RoomJoin;
    expect((await joinOn(api.app, me.accessToken, room.code, api.ip())).status).toBe(200);
    expect(await presenceOf(api.app, me.accessToken, 'me')).toMatchObject({ status: 'in_room', room: room.code });
    expect(await presenceOf(api.app, other.accessToken, me.user.id)).toMatchObject({ status: 'in_room', room: room.code });
    // a beat naming a code that doesn't exist is just "online"
    expect(await (await beat(api.app, me.accessToken, 'QQQQQQ')).json()).toMatchObject({ status: 'online', room: null });

    expect((await api.app.request('/me/presence', { method: 'DELETE', headers: bearer(me.accessToken) })).status).toBe(204);
    expect(await presenceOf(api.app, other.accessToken, me.user.id)).toMatchObject({ status: 'offline' });

    if (api.kv.kind !== 'memory') return; // a real Valkey's TTL can't be fast-forwarded
    await beat(api.app, me.accessToken);
    api.clock.advance(PRESENCE_TTL_MS + 1);
    expect(await presenceOf(api.app, other.accessToken, me.user.id)).toMatchObject({ status: 'offline' });
  });

  it('needs a signed-in player, a well-formed body, and is rate limited', async () => {
    expect((await api.app.request('/me/presence', { method: 'PUT', body: '{}' })).status).toBe(401);
    expect((await api.app.request('/players/me/presence')).status).toBe(401);
    const s = await createGuest(api);
    expect((await api.app.request('/me/presence', { method: 'PUT', headers: { ...bearer(s.accessToken), 'content-type': 'application/json' }, body: '{"room":1}' })).status).toBe(400);
    let last = 200;
    for (let i = 0; i <= LIMITS.presence.limit; i++) last = (await beat(api.app, s.accessToken)).status;
    expect(last).toBe(429);
  });
});
