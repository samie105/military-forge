/**
 * Friends (friends/): codes, requests by exact name or code, accept/decline/cancel, remove, block,
 * the list's presence (friends only), limits, and the migration's cascades.
 */
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blocks, friendRequests, friendships, users } from '../src/db/schema';
import { FRIEND_CODE_ALPHABET, formatFriendCode, newFriendCode, normalizeFriendCode } from '../src/friends/code';
import { MAX_OUTGOING_REQUESTS, type FriendsList, type RequestResult } from '../src/friends/service';
import { LIMITS } from '../src/http/rateLimit';
import type { RoomJoin } from '../src/rooms/routes';
import { befriend, bearer, createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(() => api.close());

const list = async (s: SessionBody) => {
  const res = await api.app.request('/friends', { headers: bearer(s.accessToken) });
  expect(res.status).toBe(200);
  return (await res.json()) as FriendsList;
};
const ask = (s: SessionBody, body: Record<string, unknown>, ip = api.ip()) => api.app.request('/friends/requests', json(body, { ...bearer(s.accessToken), 'x-forwarded-for': ip }));
const post = (s: SessionBody, path: string, body: unknown = {}) => api.app.request(path, json(body, bearer(s.accessToken)));
const del = (s: SessionBody, path: string) => api.app.request(path, { method: 'DELETE', headers: bearer(s.accessToken) });
const errorCode = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;
const beat = (s: SessionBody, room: string | null = null) => api.app.request('/me/presence', { method: 'PUT', headers: { ...bearer(s.accessToken), 'content-type': 'application/json' }, body: JSON.stringify({ room }) });

describe('friend codes', () => {
  it('are 8 symbols from an alphabet without lookalikes, shown with a dash, read loosely', () => {
    expect(FRIEND_CODE_ALPHABET).not.toMatch(/[01OIUL]/);
    const code = newFriendCode();
    expect(code).toMatch(new RegExp(`^[${FRIEND_CODE_ALPHABET}]{8}$`));
    expect(formatFriendCode('7KQ4M9XP')).toBe('7KQ4-M9XP');
    expect(normalizeFriendCode(' 7kq4-m9xp ')).toBe('7KQ4M9XP');
    expect(normalizeFriendCode('7KQ4 M9XP')).toBe('7KQ4M9XP');
    expect(normalizeFriendCode('7KQ4-M9X')).toBeNull();
    expect(normalizeFriendCode('OKQ4M9XP')).toBeNull(); // O is never in a code
  });

  it('one per player, made on first use, the same every time, and a new one retires the old', async () => {
    const a = await createGuest(api);
    const b = await createGuest(api);
    const first = (await list(a)).code;
    expect(first).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect((await list(a)).code).toBe(first);
    expect((await list(b)).code).not.toBe(first);
    const rotated = (await (await post(a, '/friends/code')).json()) as { code: string };
    expect(rotated.code).not.toBe(first);
    expect((await list(a)).code).toBe(rotated.code);
    expect(await errorCode(await ask(b, { code: first }))).toBe('player_not_found');
    expect((await ask(b, { code: rotated.code })).status).toBe(200);
  });
});

describe('requests', () => {
  it('by exact name (any case, lookalikes find the one owner) or by code; unknown names and yourself are refused', async () => {
    const a = await createGuest(api, { nickname: 'Kemi_Ops' });
    const b = await createGuest(api);
    const c = await createGuest(api);
    const byName = (await (await ask(b, { name: 'kemi ops' })).json()) as RequestResult;
    expect(byName).toMatchObject({ status: 'requested', user: { id: a.user.id, nickname: 'Kemi_Ops' } });
    // a lookalike spelling (0 for O) is the same name, so it finds the same player
    expect(await (await ask(c, { name: 'KEMI_0PS' })).json()).toMatchObject({ status: 'requested', user: { id: a.user.id } });
    expect((await ask(b, { name: 'Nobody_Here_9' })).status).toBe(404);
    expect(await errorCode(await ask(b, { code: 'ZZZZ-ZZZZ' }))).toBe('player_not_found');
    expect(await errorCode(await ask(a, { name: 'Kemi_Ops' }))).toBe('cannot_add_self');
    expect((await ask(a, { name: 'x', code: 'y' })).status).toBe(400);
    expect((await ask(a, {})).status).toBe(400);
    // asking twice changes nothing
    expect((await ask(b, { name: 'Kemi_Ops' })).status).toBe(200);
    const mine = await list(b);
    expect(mine.outgoing.map((p) => p.id)).toEqual([a.user.id]);
    const theirs = await list(a);
    expect(theirs.incoming.map((p) => p.id).sort()).toEqual([b.user.id, c.user.id].sort());
  });

  it('accept makes friends both ways; decline and cancel just drop the request', async () => {
    const a = await createGuest(api);
    const b = await createGuest(api);
    const c = await createGuest(api);
    const d = await createGuest(api);
    await ask(b, { code: (await list(a)).code });
    await ask(c, { code: (await list(a)).code });
    await ask(d, { code: (await list(a)).code });

    const accepted = await post(a, `/friends/requests/${b.user.id}/accept`);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ friend: { id: b.user.id, status: 'offline' } });
    expect((await list(a)).friends.map((f) => f.id)).toEqual([b.user.id]);
    expect((await list(b)).friends.map((f) => f.id)).toEqual([a.user.id]);
    expect((await list(b)).outgoing).toEqual([]);
    // the same request again: gone
    expect(await errorCode(await post(a, `/friends/requests/${b.user.id}/accept`))).toBe('no_request');

    expect((await post(a, `/friends/requests/${c.user.id}/decline`)).status).toBe(204);
    expect((await list(c)).outgoing).toEqual([]);
    expect((await list(a)).friends).toHaveLength(1);

    expect((await del(d, `/friends/requests/${a.user.id}`)).status).toBe(204);
    expect((await list(a)).incoming).toEqual([]);
  });

  it('asking someone who already asked you makes you friends at once; asking a friend says so', async () => {
    const a = await createGuest(api);
    const b = await createGuest(api);
    await ask(a, { code: (await list(b)).code });
    expect(await (await ask(b, { code: (await list(a)).code })).json()).toMatchObject({ status: 'friends', friend: { id: a.user.id } });
    expect((await list(a)).friends.map((f) => f.id)).toEqual([b.user.id]);
    expect((await list(a)).outgoing).toEqual([]);
    expect(await (await ask(a, { code: (await list(b)).code })).json()).toMatchObject({ status: 'friends' });
  });

  it('each player may have a limited number waiting', async () => {
    const a = await createGuest(api);
    // the lookup rate limit would stop this first: start its window over as we go
    const fresh = () => api.kv.del(`rl:${LIMITS.friendLookup.name}:${a.user.id}`);
    for (let i = 0; i < MAX_OUTGOING_REQUESTS; i++) {
      if (i % 10 === 0) await fresh();
      const other = await createGuest(api);
      expect((await ask(a, { code: (await list(other)).code })).status).toBe(200);
    }
    await fresh();
    const one = await createGuest(api);
    const res = await ask(a, { code: (await list(one)).code });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('too_many_requests');
  });

  it('lookups are rate limited per player, hits and misses alike', async () => {
    const a = await createGuest(api);
    let last = 0;
    for (let i = 0; i <= LIMITS.friendLookup.limit; i++) last = (await ask(a, { name: `Nobody_${i}` })).status;
    expect(last).toBe(429);
  });

  it('need a session and well-formed ids', async () => {
    expect((await api.app.request('/friends')).status).toBe(401);
    expect((await api.app.request('/friends/requests', json({ name: 'x' }))).status).toBe(401);
    const a = await createGuest(api);
    expect(await errorCode(await post(a, '/friends/requests/not-an-id/accept'))).toBe('invalid_player_id');
    expect((await post(a, '/friends/blocks', { id: 'nope' })).status).toBe(400);
  });
});

describe('the friends list', () => {
  it("shows each friend's presence (with the room's code), in a match first, then online, then offline", async () => {
    const me = await createGuest(api, { nickname: 'Zed_Lead' });
    const inRoom = await createGuest(api, { nickname: 'Yemi_Room' });
    const online = await createGuest(api, { nickname: 'Bisi_On' });
    const offline = await createGuest(api, { nickname: 'Ade_Off' });
    for (const f of [inRoom, online, offline]) await befriend(api.app, f, me);
    const room = (await (await api.app.request('/rooms', json({}, { ...bearer(inRoom.accessToken), 'x-forwarded-for': api.ip() }))).json()) as RoomJoin;
    await beat(inRoom, room.code);
    await beat(online);
    const { friends } = await list(me);
    expect(friends.map((f) => [f.nickname, f.status, f.room])).toEqual([
      ['Yemi_Room', 'in_room', room.code],
      ['Bisi_On', 'online', null],
      ['Ade_Off', 'offline', null],
    ]);
    // offline friends show when they last signed in
    expect(friends[2]!.lastSeenAt).toBe(new Date(api.clock.now()).toISOString());
  });

  it('remove ends it for both, and presence stops being shared', async () => {
    const a = await createGuest(api);
    const b = await createGuest(api);
    await befriend(api.app, a, b);
    expect((await api.app.request(`/players/${b.user.id}/presence`, { headers: bearer(a.accessToken) })).status).toBe(200);
    expect((await del(a, `/friends/${b.user.id}`)).status).toBe(204);
    expect((await list(a)).friends).toEqual([]);
    expect((await list(b)).friends).toEqual([]);
    expect((await api.app.request(`/players/${b.user.id}/presence`, { headers: bearer(a.accessToken) })).status).toBe(403);
    expect((await del(a, `/friends/${b.user.id}`)).status).toBe(204); // again: nothing to do
  });
});

describe('blocks', () => {
  it('end the friendship and requests, hide the blocked player\'s new requests without telling them, and lift cleanly', async () => {
    const a = await createGuest(api);
    const b = await createGuest(api);
    await befriend(api.app, a, b);
    expect((await post(a, '/friends/blocks', { id: b.user.id })).status).toBe(204);
    expect((await list(a)).friends).toEqual([]);
    expect((await list(b)).friends).toEqual([]);
    expect((await list(a)).blocked.map((p) => p.id)).toEqual([b.user.id]);

    // b asks again: it looks like any request to b, but a never sees it
    expect(await (await ask(b, { code: (await list(a)).code })).json()).toMatchObject({ status: 'requested' });
    expect((await list(b)).outgoing.map((p) => p.id)).toEqual([a.user.id]);
    expect((await list(a)).incoming).toEqual([]);
    expect(await errorCode(await post(a, `/friends/requests/${b.user.id}/accept`))).toBe('no_request');
    // a can't ask b while b is blocked
    expect(await errorCode(await ask(a, { code: (await list(b)).code }))).toBe('blocked_by_you');

    expect((await del(a, `/friends/blocks/${b.user.id}`)).status).toBe(204);
    expect((await list(a)).blocked).toEqual([]);
    // what b sent during the block is gone, so nothing old pops up
    expect((await list(a)).incoming).toEqual([]);
    expect((await list(b)).outgoing).toEqual([]);
    expect(await (await ask(a, { code: (await list(b)).code })).json()).toMatchObject({ status: 'requested' });
  });

  it('refuse yourself and players that do not exist', async () => {
    const a = await createGuest(api);
    expect(await errorCode(await post(a, '/friends/blocks', { id: a.user.id }))).toBe('cannot_block_self');
    expect(await errorCode(await post(a, '/friends/blocks', { id: 'u_00000000000000000000000000' }))).toBe('player_not_found');
  });
});

describe('the migration', () => {
  it('deleting an account removes its friendships, requests and blocks on every side', async () => {
    const a = await createGuest(api);
    const b = await createGuest(api);
    const c = await createGuest(api);
    const d = await createGuest(api);
    await befriend(api.app, a, b);
    await ask(a, { code: (await list(c)).code });
    await post(d, '/friends/blocks', { id: a.user.id });
    expect((await api.app.request('/me', { method: 'DELETE', headers: bearer(a.accessToken) })).status).toBe(204);
    const db = api.database.db;
    expect(await db.select().from(friendships).where(eq(friendships.friendId, a.user.id))).toEqual([]);
    expect(await db.select().from(friendRequests).where(eq(friendRequests.fromId, a.user.id))).toEqual([]);
    expect(await db.select().from(blocks).where(eq(blocks.blockedId, a.user.id))).toEqual([]);
    expect(await db.select().from(users).where(eq(users.id, a.user.id))).toEqual([]);
    expect((await list(b)).friends).toEqual([]);
  });
});
