/** Match results from the game server (POST /internal/matches), XP, profiles and leaderboards. */
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { xpForLevel } from '@military-forge/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isoWeek } from '../src/leaderboards/service';
import { RESULTS_AUDIENCE, RESULTS_ISSUER, type MatchReportBody } from '../src/matches/report';
import { bearer, createGuest, createTestApi, type SessionBody, type TestApi } from './helpers';

const keys = generateKeyPairSync('ed25519');
const otherKeys = generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');

let api: TestApi;
let ade: SessionBody;
let kemi: SessionBody;
beforeAll(async () => {
  api = await createTestApi({ RESULTS_PUBLIC_KEY: pem.replaceAll('\n', '\\n') });
  // a shared Valkey (TEST_REDIS_URL) keeps boards from earlier runs: start these empty
  for (const board of ['xp', 'kills', 'wins']) for (const period of ['all', isoWeek(api.clock.now()).id, isoWeek(api.clock.now() + 8 * 86_400_000).id]) await api.kv.del(`lb:${board}:${period}`);
  ade = await createGuest(api, { nickname: 'Ade' });
  kemi = await createGuest(api, { nickname: 'Kemi' });
});
afterAll(() => api.close());

/** As the game server signs (apps/game-server/src/results.ts signReport). */
function token(body: string, matchId: string, over: Record<string, unknown> = {}, key: KeyObject = keys.privateKey) {
  const now = Math.floor(api.clock.now() / 1000);
  const claims = { iss: RESULTS_ISSUER, aud: RESULTS_AUDIENCE, sub: matchId, iat: now, exp: now + 60, jti: randomUUID(), bodySha256: createHash('sha256').update(body).digest('base64url'), ...over };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${HEADER}.${payload}.${sign(null, Buffer.from(`${HEADER}.${payload}`), key).toString('base64url')}`;
}

type Line = MatchReportBody['players'][number];
const line = (userId: string, nickname: string, over: Partial<Line> = {}): Line => ({
  userId,
  nickname,
  placement: 1,
  score: 0,
  kills: 0,
  deaths: 0,
  assists: 0,
  damageDealt: 0,
  damageTaken: 0,
  headshots: 0,
  bestStreak: 0,
  left: false,
  mvp: false,
  killsBy: {},
  ...over,
});
const report = (players: Line[], over: Partial<MatchReportBody> = {}): MatchReportBody => ({
  matchId: randomUUID(),
  room: 'AAAAAA',
  mode: 'deathmatch',
  map: 'street-market',
  startedAt: new Date(api.clock.now() - 300_000).toISOString(),
  endedAt: new Date(api.clock.now()).toISOString(),
  durationS: 300,
  reason: 'time_limit',
  playerCount: players.length + 2,
  botCount: 2,
  serverBuild: 'p13-test',
  players,
  ...over,
});
const post = (r: MatchReportBody, auth?: string, body = JSON.stringify(r)) =>
  api.app.request('/internal/matches', { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth ?? `GameServer ${token(body, r.matchId)}` }, body });
const getJson = async <T>(path: string, s: SessionBody) => (await (await api.app.request(path, { headers: bearer(s.accessToken) })).json()) as T;

describe('POST /internal/matches', () => {
  it('records a match once: lines, lifetime stats and XP for people with accounts only', async () => {
    const r = report([
      line(ade.user.id, 'Ade', { placement: 1, score: 7, kills: 7, deaths: 2, assists: 1, damageDealt: 900, headshots: 3, bestStreak: 4, mvp: true, killsBy: { k47: 5, grenade: 2 } }),
      line(kemi.user.id, 'Kemi', { placement: 3, score: 2, kills: 2, deaths: 6, killsBy: { widow: 2 } }),
      line('u_not_an_account', 'Ghost', { placement: 2 }),
    ]);
    const res = await post(r);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { recorded: boolean; players: { userId: string; xpGained: number; xp: number; level: number }[] };
    expect(body.recorded).toBe(true);
    expect(body.players).toEqual([
      { userId: ade.user.id, xpGained: 100 + 70 + 5 + 50, xp: 225, level: 2 },
      { userId: kemi.user.id, xpGained: 100 + 20 + 25, xp: 145, level: 2 },
    ]);

    const again = await post(r);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ recorded: false });

    const me = await getJson<{ level: number; xp: number }>('/me', ade);
    expect(me).toMatchObject({ level: 2, xp: 225 });
    const profile = await getJson<Record<string, unknown>>('/players/me/profile', ade);
    expect(profile).toMatchObject({
      nickname: 'Ade',
      xp: 225,
      level: 2,
      xpIntoLevel: 125,
      xpForNextLevel: xpForLevel(3) - xpForLevel(2),
      stats: { matches: 1, wins: 1, kills: 7, deaths: 2, assists: 1, damage: 900, headshots: 3, bestStreak: 4, playtimeS: 300 },
      killsBy: [
        { source: 'k47', kills: 5 },
        { source: 'grenade', kills: 2 },
      ],
    });
    expect((profile.recent as unknown[])[0]).toMatchObject({ matchId: r.matchId, placement: 1, kills: 7, xpGained: 225, map: 'street-market' });
    // another player's profile, by id
    expect(await getJson<Record<string, unknown>>(`/players/${kemi.user.id}/profile`, ade)).toMatchObject({ nickname: 'Kemi', stats: { matches: 1, wins: 0 } });
    expect((await api.app.request('/players/u_not_an_account/profile', { headers: bearer(ade.accessToken) })).status).toBe(404);
  });

  it('a leaver keeps kills and assists XP, no win and no playtime', async () => {
    const s = await createGuest(api);
    const res = await post(report([line(s.user.id, 'Leaver', { placement: 1, kills: 3, left: true })]));
    expect(((await res.json()) as { players: { xpGained: number }[] }).players[0]!.xpGained).toBe(30);
    expect(await getJson<Record<string, unknown>>('/players/me/profile', s)).toMatchObject({ stats: { matches: 1, wins: 0, playtimeS: 0 } });
  });

  it('refuses reports not signed by the game server for exactly this body and match', async () => {
    const r = report([line(kemi.user.id, 'Kemi', { kills: 50 })]);
    const body = JSON.stringify(r);
    const refused = async (auth: string | undefined, sent = body) => {
      const res = await api.app.request('/internal/matches', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: sent });
      return res.status;
    };
    expect(await refused(undefined)).toBe(401);
    expect(await refused(`Bearer ${kemi.accessToken}`)).toBe(401); // a player's token is no use
    expect(await refused(`GameServer ${token(body, r.matchId, {}, otherKeys.privateKey)}`)).toBe(401);
    expect(await refused(`GameServer ${token(body, r.matchId, { aud: 'api' })}`)).toBe(401);
    const now = Math.floor(api.clock.now() / 1000);
    expect(await refused(`GameServer ${token(body, r.matchId, { iat: now - 120, exp: now - 60 })}`)).toBe(401);
    expect(await refused(`GameServer ${token(body, r.matchId, { exp: now + 3600 })}`)).toBe(401);
    expect(await refused(`GameServer ${token(body, randomUUID())}`)).toBe(401); // names another match
    const tampered = JSON.stringify({ ...r, players: [line(kemi.user.id, 'Kemi', { kills: 500 })] });
    expect(await refused(`GameServer ${token(body, r.matchId)}`, tampered)).toBe(401); // the signed body was another
    expect(await getJson<{ stats: { kills: number } }>('/players/me/profile', kemi)).toMatchObject({ stats: { kills: 2 } });

    const bad = { ...r, players: [{ ...line(kemi.user.id, 'Kemi'), kills: -1 }] };
    expect((await post(bad as MatchReportBody)).status).toBe(400);
  });

  it('is off without RESULTS_PUBLIC_KEY', async () => {
    const plain = await createTestApi({ DATABASE_URL: '' }); // its own database: a shared Postgres would be emptied under the other tests
    const r = report([]);
    const body = JSON.stringify(r);
    expect((await plain.app.request('/internal/matches', { method: 'POST', headers: { authorization: `GameServer ${token(body, r.matchId)}` }, body })).status).toBe(404);
    await plain.close();
  });
});

describe('leaderboards', () => {
  let reader: SessionBody;
  type Board = { periodId: string; entries: { rank: number; userId: string; nickname: string; score: number }[]; me: { rank: number; score: number } | null };

  it('rank by XP, kills and wins, all time and this week; rebuilt from Postgres when Valkey is empty', async () => {
    const all = await getJson<Board>('/leaderboards/xp?period=all&limit=2', kemi);
    expect(all.entries.map((e) => [e.rank, e.nickname, e.score])).toEqual([
      [1, 'Ade', 225],
      [2, 'Kemi', 145],
    ]);
    expect(all.me).toMatchObject({ rank: 2, score: 145 });
    const week = await getJson<Board>('/leaderboards/kills?period=week', ade);
    expect(week.periodId).toBe(isoWeek(api.clock.now()).id);
    expect(week.entries[0]).toMatchObject({ nickname: 'Ade', score: 7 });
    expect((await getJson<Board>('/leaderboards/wins', ade)).entries.map((e) => e.nickname)).toEqual(['Ade']);

    // Valkey loses everything (a flush, a new box): the next read rebuilds from Postgres
    for (const k of ['lb:xp:all', `lb:kills:${week.periodId}`]) await api.kv.del(k);
    expect(await api.kv.zcard('lb:xp:all')).toBe(0);
    expect((await getJson<Board>('/leaderboards/xp', kemi)).entries.slice(0, 2).map((e) => e.score)).toEqual([225, 145]);
    expect(await api.kv.zcard('lb:xp:all')).toBeGreaterThan(0);
    expect((await getJson<Board>('/leaderboards/kills?period=week', kemi)).entries[0]).toMatchObject({ nickname: 'Ade', score: 7 });

    // last week's matches aren't this week's
    api.clock.advance(8 * 86_400_000);
    reader = await createGuest(api); // the others' access tokens ran out meanwhile
    expect((await getJson<Board>('/leaderboards/kills?period=week', reader)).entries).toEqual([]);
  });

  it('a deleted account leaves the boards; bad boards and periods are refused', async () => {
    const s = await createGuest(api, { nickname: 'Brief' });
    await post(report([line(s.user.id, 'Brief', { kills: 40 })]));
    expect((await getJson<Board>('/leaderboards/xp', reader)).entries[0]!.nickname).toBe('Brief');
    await api.app.request('/me', { method: 'DELETE', headers: bearer(s.accessToken) });
    expect((await getJson<Board>('/leaderboards/xp', reader)).entries.map((e) => e.nickname)).not.toContain('Brief');
    expect((await api.app.request('/leaderboards/deaths', { headers: bearer(reader.accessToken) })).status).toBe(404);
    expect((await api.app.request('/leaderboards/xp?period=year', { headers: bearer(reader.accessToken) })).status).toBe(400);
    expect((await api.app.request('/leaderboards/xp?limit=500', { headers: bearer(reader.accessToken) })).status).toBe(400);
    expect((await api.app.request('/leaderboards/xp')).status).toBe(401);
  });
});

describe('isoWeek', () => {
  it('weeks start on Monday (UTC); the week belongs to the year of its Thursday', () => {
    expect(isoWeek(Date.parse('2026-10-19T12:00:00Z')).id).toBe('2026-W43');
    expect(isoWeek(Date.parse('2026-10-25T23:59:59Z')).id).toBe('2026-W43');
    expect(isoWeek(Date.parse('2026-10-26T00:00:00Z')).id).toBe('2026-W44');
    expect(isoWeek(Date.parse('2027-01-01T00:00:00Z')).id).toBe('2026-W53');
    expect(isoWeek(Date.parse('2025-12-29T00:00:00Z')).id).toBe('2026-W01');
  });
});
