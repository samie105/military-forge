/**
 * Online now (/online): the counts (people only, never bots), Appear offline, Recent players online
 * (opt-in), and Looking for a match (15 minutes, then off; invites from people who aren't friends).
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { LFG_TTL_MS, type OnlineCounts } from '@military-forge/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MatchReportBody } from '../src/matches/report';
import { RESULTS_AUDIENCE, RESULTS_ISSUER } from '../src/matches/report';
import type { OnlinePlayer } from '../src/online/service';
import { ONLINE_KEY, PLAYED_KEY } from '../src/presence/presence';
import type { RoomJoin } from '../src/rooms/routes';
import { ROOM_STATE_SUBJECT } from '../src/rooms/state';
import { befriend, bearer, createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';

const keys = generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi({ RESULTS_PUBLIC_KEY: pem.replaceAll('\n', '\\n'), ACCESS_TOKEN_TTL_SECONDS: '86400' });
});
afterAll(() => api.close());

function signed(path: string, body: string, sub: string) {
  const now = Math.floor(api.clock.now() / 1000);
  const claims = { iss: RESULTS_ISSUER, aud: RESULTS_AUDIENCE, sub, iat: now, exp: now + 60, jti: randomUUID(), bodySha256: createHash('sha256').update(body).digest('base64url') };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const t = `${HEADER}.${payload}.${sign(null, Buffer.from(`${HEADER}.${payload}`), keys.privateKey).toString('base64url')}`;
  return api.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `GameServer ${t}` }, body });
}

const put = (p: SessionBody, path: string, body: unknown) => api.app.request(path, { method: 'PUT', headers: { 'content-type': 'application/json', ...bearer(p.accessToken) }, body: JSON.stringify(body) });
const get = async <T>(p: SessionBody, path: string) => {
  const res = await api.app.request(path, { headers: bearer(p.accessToken) });
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};
const counts = async (p: SessionBody) => (await get<{ counts: OnlineCounts }>(p, '/online')).counts;
const beatPresence = (p: SessionBody, room: string | null = null, playing?: boolean) => put(p, '/me/presence', { room, ...(playing !== undefined ? { playing } : {}) });
async function create(p: SessionBody): Promise<string> {
  return ((await (await api.app.request('/rooms', json({}, { ...bearer(p.accessToken), 'x-forwarded-for': api.ip() }))).json()) as RoomJoin).code;
}
/** the same player a while later (their access token renewed, as the page does) */
async function later(p: SessionBody): Promise<SessionBody> {
  const res = await api.app.request('/auth/refresh', json({ refreshToken: p.refreshToken }, { 'x-forwarded-for': api.ip() }));
  expect(res.status).toBe(200);
  return (await res.json()) as SessionBody;
}
/** a fresh count: everyone from earlier tests has gone quiet */
async function quiet() {
  await api.kv.del(ONLINE_KEY);
  await api.kv.del(PLAYED_KEY);
}

describe('the counts (GET /online)', () => {
  it('counts people on and people in a match; bots never, whatever the rooms hold', async () => {
    await quiet();
    const a = await createGuest(api);
    const b = await createGuest(api);
    const code = await create(a);
    await beatPresence(a, code, true);
    await beatPresence(b);
    // the game server says the room has 1 person and 7 bots: still 1 in a match
    const body = JSON.stringify({ at: api.clock.now(), rooms: [{ code, phase: 'playing', teams: 0, map: 'street-market', people: 1, bots: 7, seats: 7, timeLeftS: 200, hostId: a.user.id, ids: [a.user.id] }] });
    expect((await signed('/internal/rooms/state', body, ROOM_STATE_SUBJECT)).status).toBe(204);
    expect(await counts(b)).toEqual({ online: 2, inMatches: 1, playedToday: 1 });
    // a minute of silence: offline, but they played today
    api.clock.advance(61_000);
    expect(await counts(b)).toEqual({ online: 0, inMatches: 0, playedToday: 1 });
    api.clock.advance(24 * 3600_000);
    expect((await counts(await createGuest(api))).playedToday).toBe(0);
  });

  it('is for adults only', async () => {
    const minor = await createGuest(api, { minor: true });
    expect((await api.app.request('/online', { headers: bearer(minor.accessToken) })).status).toBe(403);
  });
});

describe('Appear offline', () => {
  it('friends see the player offline with no last-seen time; the count leaves them out; they still play', async () => {
    await quiet();
    const me = await createGuest(api);
    const pal = await createGuest(api);
    await befriend(api.app, me, pal);
    await beatPresence(me);
    await beatPresence(pal);
    expect((await counts(pal)).online).toBe(2);
    const set = await put(me, '/online/settings', { appearOffline: true });
    expect(await set.json()).toEqual({ appearOffline: true, showToRecent: false });
    const friends = await get<{ friends: { id: string; status: string; lastSeenAt: string | null }[] }>(pal, '/friends');
    expect(friends.friends.find((f) => f.id === me.user.id)).toMatchObject({ status: 'offline', lastSeenAt: null });
    expect(await get(pal, `/players/${me.user.id}/presence`)).toMatchObject({ status: 'offline', room: null, lastSeenAt: null });
    await beatPresence(me);
    expect((await counts(pal)).online).toBe(1);
    // their own view still says where they are
    expect(await get(me, '/players/me/presence')).toMatchObject({ status: 'online' });
    // Looking for a match would list them: not while hidden
    expect((await put(me, '/online/lfg', { mode: 'any' })).status).toBe(409);
    await put(me, '/online/settings', { appearOffline: false });
    const back = await get<{ friends: { id: string; status: string }[] }>(pal, '/friends');
    expect(back.friends.find((f) => f.id === me.user.id)?.status).toBe('online');
  });
});

describe('Recent players online (GET /online/recent)', () => {
  it('lists people from your last 7 days who are on and chose to be shown; nobody else', async () => {
    const me = await createGuest(api, { nickname: 'Recent Me' });
    const shown = await createGuest(api, { nickname: 'Shown Sam' });
    const hidden = await createGuest(api, { nickname: 'Quiet Kay' });
    const line = (userId: string, nickname: string, placement: number) => ({ userId, nickname, placement, score: 0, kills: 0, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0, headshots: 0, bestStreak: 0, left: false, mvp: false, killsBy: {} });
    const report: MatchReportBody = {
      matchId: randomUUID(),
      room: 'AAAAAA',
      mode: 'deathmatch',
      map: 'street-market',
      startedAt: new Date(api.clock.now() - 300_000).toISOString(),
      endedAt: new Date(api.clock.now()).toISOString(),
      durationS: 300,
      reason: 'time_limit',
      playerCount: 5,
      botCount: 2,
      serverBuild: 'test',
      players: [line(me.user.id, 'Recent Me', 1), line(shown.user.id, 'Shown Sam', 2), line(hidden.user.id, 'Quiet Kay', 3)],
    };
    const body = JSON.stringify(report);
    const rec = await signed('/internal/matches', body, report.matchId);
    expect(rec.status, await rec.clone().text()).toBe(201);
    await beatPresence(shown);
    await beatPresence(hidden);
    expect((await get<{ players: OnlinePlayer[] }>(me, '/online/recent')).players).toEqual([]); // nobody opted in: presence stays private
    await put(shown, '/online/settings', { showToRecent: true });
    const seen = (await get<{ players: OnlinePlayer[] }>(me, '/online/recent')).players;
    expect(seen.map((p) => p.nickname)).toEqual(['Shown Sam']);
    expect(seen[0]).toMatchObject({ where: null, room: null, friend: false });
    expect(seen[0]).not.toHaveProperty('lastSeenAt');
    // in a private room: they show as in a lobby, never with its code
    const code = await create(shown);
    await beatPresence(shown, code, false);
    expect((await get<{ players: OnlinePlayer[] }>(me, '/online/recent')).players[0]).toMatchObject({ where: 'lobby', room: null });
    // 8 days on: not recent any more
    api.clock.advance(8 * 86_400_000);
    await beatPresence(await later(shown));
    expect((await get<{ players: OnlinePlayer[] }>(await later(me), '/online/recent')).players).toEqual([]);
  });
});

describe('Looking for a match (/online/lfg)', () => {
  it('lists you for 15 minutes, then turns itself off; never to someone blocked either way', async () => {
    const me = await createGuest(api);
    const other = await createGuest(api);
    const rude = await createGuest(api);
    await beatPresence(me);
    const on = await put(me, '/online/lfg', { mode: 'teams' });
    expect(on.status).toBe(200);
    expect(await on.json()).toEqual({ mode: 'teams', until: new Date(api.clock.now() + LFG_TTL_MS).toISOString() });
    const seen = (await get<{ players: OnlinePlayer[] }>(other, '/online/lfg')).players;
    expect(seen.find((p) => p.id === me.user.id)).toMatchObject({ mode: 'teams', friend: false, room: null });
    // not to yourself
    expect((await get<{ players: OnlinePlayer[] }>(me, '/online/lfg')).players.map((p) => p.id)).not.toContain(me.user.id);
    await api.app.request('/friends/blocks', json({ id: me.user.id }, { ...bearer(rude.accessToken), 'x-forwarded-for': api.ip() }));
    expect((await get<{ players: OnlinePlayer[] }>(rude, '/online/lfg')).players.map((p) => p.id)).not.toContain(me.user.id);
    expect((await get<{ lfg: unknown }>(me, '/online')).lfg).toMatchObject({ mode: 'teams' });
    // 15 minutes on (still on the menus): off by itself
    api.clock.advance(LFG_TTL_MS - 30_000);
    await beatPresence(me);
    api.clock.advance(30_001);
    await beatPresence(me);
    expect((await get<{ players: OnlinePlayer[] }>(other, '/online/lfg')).players.map((p) => p.id)).not.toContain(me.user.id);
    expect((await get<{ lfg: unknown }>(me, '/online')).lfg).toBeNull();
  });

  it('turned off by hand, gone at once', async () => {
    const me = await createGuest(api);
    const other = await createGuest(api);
    await beatPresence(me);
    await put(me, '/online/lfg', { mode: 'any' });
    expect((await api.app.request('/online/lfg', { method: 'DELETE', headers: bearer(me.accessToken) })).status).toBe(204);
    expect((await get<{ players: OnlinePlayer[] }>(other, '/online/lfg')).players.map((p) => p.id)).not.toContain(me.user.id);
  });

  it('anyone not blocked may invite a player who is looking (no party); once they stop, friends only again', async () => {
    const looking = await createGuest(api);
    const host = await createGuest(api);
    await beatPresence(looking);
    const code = await create(host);
    const invite = () => api.app.request('/invites', json({ to: looking.user.id, room: code }, bearer(host.accessToken)));
    expect((await invite()).status).toBe(403); // not friends, not looking
    await put(looking, '/online/lfg', { mode: 'any' });
    const sent = await invite();
    expect(sent.status).toBe(201);
    const { invite: inv } = (await sent.json()) as { invite: { id: string; stranger?: boolean } };
    expect(inv.stranger).toBe(true);
    const accepted = await api.app.request(`/invites/${inv.id}/accept`, json({}, bearer(looking.accessToken)));
    expect(await accepted.json()).toMatchObject({ room: code, party: false });
    await api.app.request('/online/lfg', { method: 'DELETE', headers: bearer(looking.accessToken) });
    api.clock.advance(61_000); // past the same-friend wait
    expect((await invite()).status).toBe(403);
  });
});
