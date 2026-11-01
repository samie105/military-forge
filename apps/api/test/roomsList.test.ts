/**
 * The Rooms list end to end: the game server's signed heartbeat (POST /internal/rooms/state), the
 * host's listing (PATCH, Post to Lobby), GET /rooms, and joining from the list (visibility, blocks,
 * a free seat checked again).
 */
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { LOBBY_FEED_TOPIC, ROOM_POST_COOLDOWN_MS, ROOM_STATE_TTL_MS, type LobbyFeedEvent, type RoomRow, type RoomStateEntry } from '@military-forge/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RESULTS_AUDIENCE, RESULTS_ISSUER } from '../src/matches/report';
import { LISTED_KEY, type RoomJoin } from '../src/rooms/routes';
import { ROOM_STATE_SUBJECT } from '../src/rooms/state';
import { befriend, bearer, createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi({ RESULTS_PUBLIC_KEY: pem.replaceAll('\n', '\\n') });
});
afterAll(() => api.close());
// each test starts with an empty list
beforeEach(async () => {
  await api.kv.del(LISTED_KEY);
});

/** As the game server signs (apps/game-server/src/results.ts signReport). */
function token(body: string, sub: string, key: KeyObject = keys.privateKey, over: Record<string, unknown> = {}) {
  const now = Math.floor(api.clock.now() / 1000);
  const claims = { iss: RESULTS_ISSUER, aud: RESULTS_AUDIENCE, sub, iat: now, exp: now + 60, jti: randomUUID(), bodySha256: createHash('sha256').update(body).digest('base64url'), ...over };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${HEADER}.${payload}.${sign(null, Buffer.from(`${HEADER}.${payload}`), key).toString('base64url')}`;
}

async function beat(rooms: RoomStateEntry[], opts: { sub?: string; key?: KeyObject; at?: number; body?: string } = {}) {
  const body = JSON.stringify({ at: opts.at ?? api.clock.now(), rooms });
  return api.app.request('/internal/rooms/state', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `GameServer ${token(opts.body ?? body, opts.sub ?? ROOM_STATE_SUBJECT, opts.key)}` },
    body,
  });
}

const entry = (code: string, over: Partial<RoomStateEntry> = {}): RoomStateEntry => ({ code, phase: 'lobby', teams: 0, map: 'street-market', people: 1, bots: 5, seats: 7, timeLeftS: null, hostId: null, ids: [], ...over });

async function create(p: SessionBody): Promise<string> {
  const res = await api.app.request('/rooms', json({}, { ...bearer(p.accessToken), 'x-forwarded-for': api.ip() }));
  return ((await res.json()) as RoomJoin).code;
}
const patch = (p: SessionBody, code: string, body: unknown) => api.app.request(`/rooms/${code}`, { method: 'PATCH', headers: { 'content-type': 'application/json', ...bearer(p.accessToken) }, body: JSON.stringify(body) });
async function list(p: SessionBody): Promise<RoomRow[]> {
  const res = await api.app.request('/rooms', { headers: bearer(p.accessToken) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { rooms: RoomRow[] }).rooms;
}
const joinFromList = (p: SessionBody, code: string) => api.app.request(`/rooms/${code}/join`, json({ from: 'list' }, { ...bearer(p.accessToken), 'x-forwarded-for': api.ip() }));
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

describe('the heartbeat (POST /internal/rooms/state)', () => {
  it("is taken only with the game server's signature, over this body, as a room-state token", async () => {
    const host = await createGuest(api);
    const code = await create(host);
    const rooms = [entry(code, { hostId: host.user.id, ids: [host.user.id] })];
    expect((await beat(rooms, { key: otherKeys.privateKey })).status).toBe(401);
    expect((await beat(rooms, { body: '{"at":0,"rooms":[]}' })).status).toBe(401); // the token is for another body
    expect((await beat(rooms, { sub: randomUUID() })).status).toBe(401); // a match report's token
    const ok = await beat(rooms);
    expect(ok.status).toBe(204);
    expect(JSON.parse((await api.kv.get(`roomstate:${code}`))!)).toMatchObject({ code, people: 1, bots: 5, seats: 7 });
  });

  it('keeps a room 30 s; an older report never replaces a newer one', async () => {
    const host = await createGuest(api);
    const code = await create(host);
    expect((await beat([entry(code, { people: 3 })])).status).toBe(204);
    expect((await beat([entry(code, { people: 1 })], { at: api.clock.now() - 5_000 })).status).toBe(204);
    expect(JSON.parse((await api.kv.get(`roomstate:${code}`))!).people).toBe(3);
    api.clock.advance(ROOM_STATE_TTL_MS + 1);
    expect(await api.kv.get(`roomstate:${code}`)).toBeNull();
  });

  it('refuses rooms that make no sense (more people than slots, not a code)', async () => {
    expect((await beat([entry('AAAAAA', { people: 9 })])).status).toBe(400);
    expect((await beat([entry('nope')])).status).toBe(400);
  });
});

describe('the Rooms list (GET /rooms)', () => {
  it('a Create room room is private until its host says; Public shows to anyone, with people and bots apart', async () => {
    const host = await createGuest(api);
    const other = await createGuest(api);
    const code = await create(host);
    await beat([entry(code, { hostId: host.user.id, ids: [host.user.id], people: 1, bots: 3, seats: 7 })]);
    expect((await list(other)).map((r) => r.code)).not.toContain(code);
    const res = await patch(host, code, { visibility: 'public', tag: 'chill', lang: 'en' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ visibility: 'public', tag: 'chill', lang: 'en', host: true });
    const row = (await list(other)).find((r) => r.code === code);
    expect(row).toMatchObject({ visibility: 'public', people: 1, bots: 3, seats: 7, tag: 'chill', lang: 'en', phase: 'lobby', host: { name: host.user.nickname, friend: false } });
    // back to private: gone
    await patch(host, code, { visibility: 'private' });
    expect((await list(other)).map((r) => r.code)).not.toContain(code);
  });

  it("a code that doesn't exist is a miss, as on join (settings and the host's routes can't sweep codes)", async () => {
    const me = await createGuest(api);
    const ip = api.ip();
    for (let i = 0; i < 5; i++) expect((await api.app.request('/rooms/ZZZZZZ/settings', { headers: { ...bearer(me.accessToken), 'x-forwarded-for': ip } })).status).toBe(404);
    expect((await api.app.request('/rooms/ZZZZZZ/settings', { headers: { ...bearer(me.accessToken), 'x-forwarded-for': ip } })).status).toBe(429);
  });

  it('only the host changes the listing; a Play now room stays open', async () => {
    const host = await createGuest(api);
    const other = await createGuest(api);
    const code = await create(host);
    expect(await errorOf(await patch(other, code, { visibility: 'public' }))).toBe('not_host');
    expect((await patch(host, code, {})).status).toBe(400);
    const quick = await api.app.request('/rooms/quick', json({}, { ...bearer(other.accessToken), 'x-forwarded-for': api.ip() }));
    const qcode = ((await quick.json()) as RoomJoin).code;
    expect(await errorOf(await patch(other, qcode, { visibility: 'private' }))).toBe('quick_room');
    expect((await patch(other, qcode, { tag: 'new' })).status).toBe(200);
  });

  it('Friends rooms show to the host\'s friends only; a friend inside is marked and comes first', async () => {
    const host = await createGuest(api);
    const pal = await createGuest(api);
    const stranger = await createGuest(api);
    await befriend(api.app, host, pal);
    const code = await create(host);
    await patch(host, code, { visibility: 'friends' });
    const other = await createGuest(api);
    const pub = await create(other);
    await patch(other, pub, { visibility: 'public' });
    await beat([entry(code, { hostId: host.user.id, ids: [host.user.id], people: 1 }), entry(pub, { hostId: other.user.id, ids: [other.user.id], people: 4, seats: 4 })]);
    const seen = await list(pal);
    expect(seen.map((r) => r.code)).toEqual([code, pub]);
    expect(seen[0]).toMatchObject({ host: { friend: true }, friendInside: true });
    expect((await list(stranger)).map((r) => r.code)).toEqual([pub]);
  });

  it('hides a room with a block either way, with the host or anyone playing in it', async () => {
    const host = await createGuest(api);
    const rude = await createGuest(api);
    const me = await createGuest(api);
    const code = await create(host);
    await patch(host, code, { visibility: 'public' });
    await beat([entry(code, { hostId: host.user.id, ids: [host.user.id, rude.user.id], people: 2 })]);
    expect((await list(me)).map((r) => r.code)).toContain(code);
    const blocked = await api.app.request('/friends/blocks', json({ id: me.user.id }, { ...bearer(rude.accessToken), 'x-forwarded-for': api.ip() }));
    expect(blocked.status).toBe(204);
    expect((await list(me)).map((r) => r.code)).not.toContain(code);
    expect(await errorOf(await joinFromList(me, code))).toBe('room_taken');
  });
});

describe('joining from the list (POST /rooms/:code/join { from: "list" })', () => {
  it('checks again: a room that went private or filled is "taken"; one with a seat lets you in', async () => {
    const host = await createGuest(api);
    const me = await createGuest(api);
    const code = await create(host);
    await patch(host, code, { visibility: 'public' });
    await beat([entry(code, { hostId: host.user.id, ids: [host.user.id], people: 8, seats: 0, bots: 0 })]);
    const full = await joinFromList(me, code);
    expect(full.status).toBe(409);
    expect(await errorOf(full)).toBe('room_taken');
    await beat([entry(code, { hostId: host.user.id, ids: [host.user.id], people: 7, seats: 1, bots: 0 })]);
    expect((await joinFromList(me, code)).status).toBe(200);
    await patch(host, code, { visibility: 'private' });
    expect(await errorOf(await joinFromList(await createGuest(api), code))).toBe('room_taken');
    // by code, a private room still lets anyone with the code in (the code is the invitation)
    const byCode = await api.app.request(`/rooms/${code}/join`, json({}, { ...bearer((await createGuest(api)).accessToken), 'x-forwarded-for': api.ip() }));
    expect(byCode.status).toBe(200);
  });

  it('is for adults only, as every online room', async () => {
    const minor = await createGuest(api, { minor: true });
    const res = await api.app.request('/rooms', { headers: bearer(minor.accessToken) });
    expect(res.status).toBe(403);
  });
});

describe('Post to Lobby (POST /rooms/:code/post)', () => {
  it('the host only, once per room every 5 minutes; a private room becomes public; the feed gets a card', async () => {
    const host = await createGuest(api);
    const other = await createGuest(api);
    const code = await create(host);
    await patch(host, code, { tag: 'new' });
    await beat([entry(code, { hostId: host.user.id, ids: [host.user.id], people: 2, bots: 2, seats: 6, teams: 2 })]);
    const heard: LobbyFeedEvent[] = [];
    const stop = api.bus.subscribeTopic(LOBBY_FEED_TOPIC, (e) => {
      if (e.type === 'entry' && e.entry.kind === 'room_posted') {
        const { id: _id, at, ...card } = e.entry;
        heard.push({ ...card, at: Date.parse(at) });
      }
    });
    const post = (p: SessionBody) => api.app.request(`/rooms/${code}/post`, json({}, bearer(p.accessToken)));
    expect(await errorOf(await post(other))).toBe('not_host');
    const res = await post(host);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ posted: true, visibility: 'public' });
    await new Promise((r) => setTimeout(r, 20)); // a shared Valkey's pub/sub is a hop away
    stop();
    expect(heard).toEqual([{ kind: 'room_posted', code, hostName: host.user.nickname, hostId: host.user.id, mode: 2, map: 'street-market', people: 2, bots: 2, seats: 6, tag: 'new', lang: null, at: api.clock.now() }]);
    const again = await post(host);
    expect(again.status).toBe(429);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
    api.clock.advance(ROOM_POST_COOLDOWN_MS + 1);
    expect((await post(host)).status).toBe(201);
    await beat([entry(code, { hostId: host.user.id, ids: [host.user.id], people: 2 })]);
    expect((await list(other)).map((r) => r.code)).toContain(code);
  });
});
