/** Play stats (docs/16): batches and consent, match stats, rollups and the dashboard, deletion, retention, back-pressure. */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { ClientEvent, MatchPlayerStats, MatchStatsReport } from '@military-forge/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GeoIpTable, countryFromZone, ipToBig, resolveCountry } from '../src/analytics/country';
import { toCsv } from '../src/analytics/dashboard';
import { keepShare } from '../src/analytics/ingest';
import { rowsOf, utcDay } from '../src/analytics/partitions';
import { segmentsFrom } from '../src/analytics/segments';
import { RESULTS_AUDIENCE, RESULTS_ISSUER } from '../src/matches/report';
import { bearer, createGuest, createTestApi, type SessionBody, type TestApi } from './helpers';

const keys = generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const HEADER = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
const ADMIN = 'owner-token-0123456789abcdef';
const owner = { authorization: `Bearer ${ADMIN}` };

let api: TestApi;
let ade: SessionBody;
let kemi: SessionBody;
beforeAll(async () => {
  api = await createTestApi({ RESULTS_PUBLIC_KEY: pem.replaceAll('\n', '\\n'), ADMIN_TOKEN: ADMIN, ANALYTICS_AD_SEGMENTS: 'true' });
  ade = await createGuest(api, { nickname: 'Ade' });
  kemi = await createGuest(api, { nickname: 'Kemi' });
});
afterAll(() => api.close());

const sid = () => randomUUID().replaceAll('-', '').slice(0, 24);

async function post(events: ClientEvent[], o: { consent?: 'analytics' | 'none'; sid?: string | null; token?: string; tz?: string; headers?: Record<string, string> } = {}) {
  const consent = o.consent ?? 'analytics';
  const body = { v: 1, consent, sid: o.sid === undefined ? (consent === 'analytics' ? sid() : null) : o.sid, build: 'test', ...(o.tz ? { tz: o.tz } : {}), events };
  return api.app.request('/analytics/batch', {
    method: 'POST',
    // a beacon's type
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-forwarded-for': api.ip(), ...(o.token ? bearer(o.token) : {}), ...o.headers },
    body: JSON.stringify(body),
  });
}

const now = () => api.clock.now();
const start = (over: Partial<Extract<ClientEvent, { k: 'session.start' }>> = {}): ClientEvent => ({ k: 'session.start', t: now(), n: 1, days: 0, input: 'touch', form: 'phone', tier: 'medium', installed: false, arrival: 'direct', tzo: 60, ...over });

async function raw(where = sql`true`) {
  await api.analytics.ingest.flush();
  return rowsOf<{ kind: string; uid: string | null; sid: string | null; country: string; props: Record<string, unknown> }>(await api.database.db.execute(sql`select kind, uid, sid, country, props from analytics_events where ${where} order by at`));
}

function signed(body: string, matchId: string) {
  const t = Math.floor(now() / 1000);
  const claims = { iss: RESULTS_ISSUER, aud: RESULTS_AUDIENCE, sub: matchId, iat: t, exp: t + 60, jti: randomUUID(), bodySha256: createHash('sha256').update(body).digest('base64url') };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `GameServer ${HEADER}.${payload}.${sign(null, Buffer.from(`${HEADER}.${payload}`), keys.privateKey).toString('base64url')}`;
}

const player = (over: Partial<MatchPlayerStats> = {}): MatchPlayerStats => ({
  uid: null,
  bot: false,
  placement: 1,
  won: false,
  kills: 0,
  deaths: 0,
  assists: 0,
  damage: 0,
  damageTaken: 0,
  headshots: 0,
  bestStreak: 0,
  guns: null,
  killsBy: {},
  deathsBy: {},
  botKills: 0,
  botDeaths: 0,
  playedS: 300,
  lifeS: 60,
  left: false,
  leftAtS: null,
  leftPhase: null,
  rage: false,
  ping: '60-120',
  reconnects: 0,
  transport: 'ws',
  ...over,
});

async function postMatch(players: MatchPlayerStats[], over: Partial<MatchStatsReport> = {}) {
  const r: MatchStatsReport = {
    v: 1,
    matchId: randomUUID(),
    mode: 'ffa',
    map: 'street-market',
    room: 'code',
    startedAt: new Date(now() - 300_000).toISOString(),
    endedAt: new Date(now()).toISOString(),
    durationS: 300,
    reason: 'time_limit',
    humans: players.filter((p) => !p.bot).length,
    bots: players.filter((p) => p.bot).length,
    players,
    ...over,
  };
  const body = JSON.stringify(r);
  return api.app.request('/internal/analytics/match', { method: 'POST', headers: { 'content-type': 'application/json', authorization: signed(body, r.matchId) }, body });
}

describe('batches and consent', () => {
  it('keeps only the anonymous kinds, with no ids, when the player said no', async () => {
    const res = await post(
      [start(), { k: 'error', t: now(), e: 'route-failed', where: 'locker' }, { k: 'ad.view', t: now(), c: 'house:deet-a', adv: 'deet', ms: 4000, share: 40 }],
      { consent: 'none', token: ade.accessToken, tz: 'Africa/Lagos' },
    );
    expect(res.status).toBe(204);
    const rows = await raw(sql`kind in ('error', 'ad.view', 'session.start') and country = 'NG'`);
    expect(rows.map((r) => r.kind).sort()).toEqual(['ad.view', 'error']);
    expect(rows.every((r) => r.uid === null && r.sid === null)).toBe(true);
  });

  it('tags a yes with the player and the session, and a later beacon without a token still counts as theirs', async () => {
    const s = sid();
    expect((await post([start({ tzo: 120 })], { sid: s, token: kemi.accessToken })).status).toBe(204);
    expect((await post([{ k: 'session.end', t: now(), last: 'home' }], { sid: s })).status).toBe(204);
    const rows = await raw(sql`sid = ${s}`);
    expect(rows.map((r) => [r.kind, r.uid])).toEqual([
      ['session.start', kemi.user.id],
      ['session.end', kemi.user.id],
    ]);
    expect(rows[0]!.props).toMatchObject({ input: 'touch', build: 'test' });
  });

  it('never ties ad rows to the player, even with a yes', async () => {
    const s = sid();
    await post([{ k: 'ad.save', t: now(), c: 'house:ws-1', adv: 'worldstreet' }], { sid: s, token: ade.accessToken });
    const rows = await raw(sql`kind = 'ad.save'`);
    expect(rows.at(-1)).toMatchObject({ uid: null, sid: null });
  });

  it('drops ad counts from Europe without a yes, and everything without a yes under Global Privacy Control', async () => {
    const before = (await raw(sql`kind in ('ad.view', 'error')`)).length;
    await post([{ k: 'ad.view', t: now(), c: 'house:deet-b', adv: 'deet', ms: 1000, share: 10 }], { consent: 'none', tz: 'Europe/Berlin' });
    await post([{ k: 'error', t: now(), e: 'script', where: 'home' }], { consent: 'none', headers: { 'sec-gpc': '1' } });
    expect((await raw(sql`kind in ('ad.view', 'error')`)).length).toBe(before);
  });

  it('drops events outside the vocabulary and refuses what isn’t a batch', async () => {
    const before = (await raw()).length;
    const res = await post([{ k: 'session.end', t: now(), last: 'nowhere' } as unknown as ClientEvent, { k: 'chat', t: now(), text: 'hi' } as unknown as ClientEvent], {});
    expect(res.status).toBe(204);
    expect((await raw()).length).toBe(before);
    const bad = await api.app.request('/analytics/batch', { method: 'POST', headers: { 'x-forwarded-for': api.ip() }, body: '{"v":2}' });
    expect(bad.status).toBe(400);
  });

  it('tells the page which consent to ask for', async () => {
    const eu = (await (await api.app.request('/analytics/config?tz=Europe/Paris', { headers: { 'x-forwarded-for': api.ip() } })).json()) as { consent: string; segments: boolean };
    expect(eu).toMatchObject({ consent: 'opt-in', segments: true });
    const opt = await createTestApi({ ANALYTICS_CONSENT: 'opt-out' });
    const ng = (await (await opt.app.request('/analytics/config?tz=Africa/Lagos')).json()) as { consent: string };
    const fr = (await (await opt.app.request('/analytics/config?tz=Europe/Paris')).json()) as { consent: string };
    expect([ng.consent, fr.consent]).toEqual(['opt-out', 'opt-in']);
    await opt.close();
  });
});

describe('match stats from the game server', () => {
  it('needs the game server’s signature', async () => {
    const res = await api.app.request('/internal/analytics/match', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
  });

  it('stores the match and each player, bots without an id', async () => {
    const res = await postMatch([player({ uid: ade.user.id, won: true, kills: 5, guns: ['k47', 'buzz'], killsBy: { k47: 4, grenade: 1 }, botKills: 2 }), player({ uid: 'whoever', bot: true, placement: 2, deaths: 5 })]);
    expect(res.status).toBe(202);
    const rows = await raw(sql`kind like 'match.%'`);
    expect(rows.filter((r) => r.kind === 'match.end')).toHaveLength(1);
    const players = rows.filter((r) => r.kind === 'match.player');
    expect(players.map((p) => p.uid)).toEqual([ade.user.id, null]);
    expect(players[0]!.props).toMatchObject({ mode: 'ffa', map: 'street-market', guns: ['k47', 'buzz'] });
  });
});

describe('rollups and the dashboard', () => {
  it('counts players, the funnel, weapons, quits and ads, and exports CSV', async () => {
    const t = await createTestApi({ RESULTS_PUBLIC_KEY: pem.replaceAll('\n', '\\n'), ADMIN_TOKEN: ADMIN });
    const prev = api;
    api = t;
    try {
      const a = await createGuest(api, { nickname: 'Tunde' });
      const b = await createGuest(api, { nickname: 'Zola' });
      // day 0: both new; Tunde consents and walks the funnel
      const s = sid();
      await post([start(), { k: 'funnel', t: now(), step: 'landing' }, { k: 'funnel', t: now(), step: 'title' }, { k: 'funnel', t: now(), step: 'home' }, { k: 'session.active', t: now(), s: 420 }, { k: 'feature', t: now(), f: 'locker' }], { sid: s, token: a.accessToken });
      await post([{ k: 'ad.view', t: now(), c: 'house:deet-a', adv: 'deet', ms: 6000, share: 40 }, { k: 'ad.view', t: now(), c: 'house:deet-a', adv: 'deet', ms: 2000, share: 40 }, { k: 'ad.save', t: now(), c: 'house:deet-a', adv: 'deet' }], { consent: 'none' });
      await postMatch([
        player({ uid: a.user.id, won: true, kills: 3, guns: ['k47', 'buzz'], killsBy: { k47: 3 } }),
        player({ uid: b.user.id, placement: 2, deaths: 3, guns: ['widow', 'buzz'], deathsBy: { k47: 3 }, left: true, leftAtS: 130, leftPhase: 'playing', rage: true }),
        player({ bot: true, placement: 3 }),
      ]);
      expect((await api.app.request('/analytics/admin/rollup', { method: 'POST', headers: owner })).status).toBe(200);
      // day 1: Tunde is back
      api.clock.advance(86_400_000);
      await postMatch([player({ uid: a.user.id, won: true, guns: ['k47', 'buzz'] })]);
      await api.analytics.rollupNow();

      const res = await api.app.request('/analytics/admin/dashboard?days=7', { headers: owner });
      expect(res.status).toBe(200);
      const d = (await res.json()) as Awaited<ReturnType<TestApi['analytics']['dashboard']>>;
      expect(d.kpis).toMatchObject({ dau: 1, wau: 2, players: 2, matches: 2, d1: 50 });
      expect(d.tables.active.rows).toEqual([
        [utcDay(now() - 86_400_000), 2, 2, 0],
        [utcDay(now()), 1, 0, 1],
      ]);
      expect(d.tables.funnel.rows.slice(0, 3).map((r) => r[1])).toEqual([1, 1, 0]);
      const k47 = d.tables.weapons.rows.find((r) => r[0] === 'k47')!;
      expect(k47.slice(0, 6)).toEqual(['k47', 2, 2, 100, 3, 3]);
      expect(d.tables.quits.rows[2]).toEqual(['2', 1, 1, 100]);
      expect(d.tables.ads.rows[0]).toEqual(['house:deet-a', 'deet', 2, 8, 4, 1, 50, 0, 0]);
      expect(d.tables.sessions.rows.find((r) => r[0] === '5-15m')?.[1]).toBe(1);
      expect(d.tables['vs-bots'].rows[0]).toEqual(['people: kills', 3]);

      const csv = await api.app.request('/analytics/admin/export/weapons.csv?days=7', { headers: owner });
      expect(csv.headers.get('content-type')).toContain('text/csv');
      expect((await csv.text()).split('\r\n')[0]).toBe('weapon,picks,wins,win %,kills,deaths by');
      expect((await api.app.request('/analytics/admin/dashboard')).status).toBe(401);
    } finally {
      api = prev;
      await t.close();
    }
  });

  it('quotes CSV cells and defuses formulas', () => {
    expect(toCsv({ title: '', note: '', columns: ['a', 'b'], rows: [['=1+1', 'x,y']] })).toBe('a,b\r\n\'=1+1,"x,y"\r\n');
  });
});

describe('delete my data and retention', () => {
  it('deletes a player’s stats on request, and when the account goes', async () => {
    const t = await createTestApi({ RESULTS_PUBLIC_KEY: pem.replaceAll('\n', '\\n') });
    try {
      const a = await createGuest(t, { nickname: 'Femi' });
      const b = await createGuest(t, { nickname: 'Lindi' });
      for (const p of [a, b]) {
        const body = JSON.stringify({ v: 1, consent: 'analytics', sid: sid(), build: 'x', events: [start()] });
        await t.app.request('/analytics/batch', { method: 'POST', headers: { ...bearer(p.accessToken), 'x-forwarded-for': t.ip() }, body });
      }
      await t.analytics.rollupNow();
      const count = async (uid: string) =>
        rowsOf<{ n: number }>(await t.database.db.execute(sql`select (select count(*) from analytics_events where uid = ${uid}) + (select count(*) from analytics_player_days where uid = ${uid}) + (select count(*) from analytics_players where uid = ${uid}) as n`))[0]!.n;
      expect(Number(await count(a.user.id))).toBe(3);

      const del = await t.app.request('/analytics/me', { method: 'DELETE', headers: bearer(a.accessToken) });
      expect(del.status).toBe(202);
      // a recount before the purge doesn't bring the day rows back
      await t.analytics.ingest.flush();
      await t.database.db.execute(sql`delete from analytics_forget`);
      await t.analytics.forget(a.user.id);
      const { rollupDay } = await import('../src/analytics/rollup');
      await rollupDay(t.database.db, utcDay(t.clock.now()));
      expect(rowsOf<{ n: number }>(await t.database.db.execute(sql`select count(*)::int as n from analytics_player_days where uid = ${a.user.id}`))[0]!.n).toBe(0);
      await t.analytics.maintain();
      expect(Number(await count(a.user.id))).toBe(0);

      // the account deleted: the trigger queues its stats
      expect((await t.app.request('/me', { method: 'DELETE', headers: bearer(b.accessToken) })).status).toBe(204);
      await t.analytics.processForget();
      expect(Number(await count(b.user.id))).toBe(0);
    } finally {
      await t.close();
    }
  });

  it('drops raw days past the window and keeps the rollups', async () => {
    const t = await createTestApi({ ANALYTICS_RAW_DAYS: '7' });
    try {
      await t.app.request('/analytics/batch', { method: 'POST', headers: { 'x-forwarded-for': t.ip() }, body: JSON.stringify({ v: 1, consent: 'none', sid: null, build: 'x', events: [{ k: 'error', t: t.clock.now(), e: 'chunk-missing', where: 'armory' }] }) });
      await t.analytics.rollupNow();
      const day = utcDay(t.clock.now());
      t.clock.advance(8 * 86_400_000);
      await t.analytics.maintain();
      const parts = await t.analytics.partitions.list();
      expect(parts[0]! > day).toBe(true);
      expect(parts).toContain(utcDay(t.clock.now() + 2 * 86_400_000));
      const kept = rowsOf<{ n: number }>(await t.database.db.execute(sql`select count(*)::int as n from analytics_daily where day = ${day}::date and metric = 'error'`))[0]!.n;
      expect(kept).toBe(1);
    } finally {
      await t.close();
    }
  });
});

describe('segments', () => {
  it('reads the consented days in plain words', () => {
    const evening = (1 << 19) | (1 << 20);
    const s = segmentsFrom(
      [
        { sessions: 2, activeS: 3000, input: 'touch', hours: evening, modes: { ffa: 1, team2: 3 } },
        { sessions: 1, activeS: 600, input: 'touch', hours: 1 << 8, modes: { local: 1 } },
      ],
      '2026-10-01',
      '2026-10-26',
    );
    expect(s).toEqual({ device: 'touch', sessionBand: 'medium', timeOfDay: 'evening', modePref: 'team', tenure: 'returning' });
    expect(segmentsFrom([], null, '2026-10-26')).toBeNull();
  });

  it('answers the signed-in player, behind the flag', async () => {
    await post([start({ tzo: 0 })], { token: ade.accessToken });
    await api.analytics.rollupNow();
    const res = await api.app.request('/analytics/segments/me', { headers: bearer(ade.accessToken) });
    const body = (await res.json()) as { enabled: boolean; segments: { device: string; tenure: string } };
    expect(body.enabled).toBe(true);
    expect(body.segments).toMatchObject({ device: 'touch', tenure: 'new' });
    const off = await createTestApi();
    const g = await createGuest(off);
    expect(await (await off.app.request('/analytics/segments/me', { headers: bearer(g.accessToken) })).json()).toEqual({ enabled: false, segments: null });
    await off.close();
  });
});

describe('back-pressure', () => {
  it('sheds the sampled kinds first, weights the ones kept, and never drops match rows', async () => {
    expect(keepShare('ad.view', 0.1)).toBe(1);
    expect(keepShare('ad.view', 0.5)).toBeCloseTo(0.5);
    expect(keepShare('funnel', 0.5)).toBe(1);
    expect(keepShare('funnel', 0.9)).toBeCloseTo(0.4);
    expect(keepShare('funnel', 1.2)).toBe(0);

    let lag = 0;
    const t = await createTestApi({ RESULTS_PUBLIC_KEY: pem.replaceAll('\n', '\\n') }, { ingest: { lagMs: () => lag, lagLimitMs: 100, maxServer: 3, random: () => 0.3 } });
    try {
      lag = 50; // pressure 0.5: ad views kept at half, weighted ×2; the funnel untouched
      const body = JSON.stringify({ v: 1, consent: 'none', sid: null, build: 'x', events: [{ k: 'ad.view', t: t.clock.now(), c: 'house:a', adv: 'deet', ms: 1000, share: 5 }] });
      await t.app.request('/analytics/batch', { method: 'POST', headers: { 'x-forwarded-for': t.ip() }, body });
      await t.analytics.ingest.flush();
      const rows = rowsOf<{ w: string }>(await t.database.db.execute(sql`select props->>'w' as w from analytics_events where kind = 'ad.view'`));
      expect(rows.map((r) => Number(r.w))).toEqual([2]);
      lag = 200; // full pressure: client rows dropped and counted
      await t.app.request('/analytics/batch', { method: 'POST', headers: { 'x-forwarded-for': t.ip() }, body });
      expect(t.analytics.ingest.stats().dropped).toBe(1);
      // match rows: a full queue is a 503 (the game server retries), never a drop
      const r: MatchStatsReport = { v: 1, matchId: randomUUID(), mode: 'ffa', map: 'fog-stair', room: 'code', startedAt: new Date(t.clock.now()).toISOString(), endedAt: new Date(t.clock.now()).toISOString(), durationS: 1, reason: 'other', humans: 3, bots: 0, players: [player(), player(), player()] };
      const text = JSON.stringify(r);
      const t0 = Math.floor(t.clock.now() / 1000);
      const claims = Buffer.from(JSON.stringify({ iss: RESULTS_ISSUER, aud: RESULTS_AUDIENCE, sub: r.matchId, iat: t0, exp: t0 + 60, jti: randomUUID(), bodySha256: createHash('sha256').update(text).digest('base64url') })).toString('base64url');
      const auth = `GameServer ${HEADER}.${claims}.${sign(null, Buffer.from(`${HEADER}.${claims}`), keys.privateKey).toString('base64url')}`;
      const full = await t.app.request('/internal/analytics/match', { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: text });
      expect(full.status).toBe(503);
    } finally {
      await t.close();
    }
  });
});

describe('country', () => {
  it('comes from a trusted header, a range table or the time zone, never kept as an address', () => {
    const table = GeoIpTable.parse('1.0.0.0,1.0.0.255,AU\n102.88.0.0,102.88.255.255,NG\n2c0f:f000::,2c0f:ffff:ffff:ffff:ffff:ffff:ffff:ffff,ZA\n');
    expect(table.lookup('102.88.4.5')).toBe('NG');
    expect(table.lookup('2c0f:f4c0::1')).toBe('ZA');
    expect(table.lookup('8.8.8.8')).toBeNull();
    expect(ipToBig('::ffff:1.2.3.4')).toBe(ipToBig('1.2.3.4'));
    expect(resolveCountry({ trustProxy: 'cloudflare', cfCountry: 'GH', ip: '1.1.1.1', geoip: null })).toBe('GH');
    expect(resolveCountry({ trustProxy: 'xff', cfCountry: 'GH', ip: '102.88.1.1', geoip: table })).toBe('NG');
    expect(countryFromZone('Africa/Johannesburg')).toBe('ZA');
    expect(countryFromZone('Europe/Vilnius')).toBe('EU');
    expect(countryFromZone('America/Chicago')).toBe('??');
  });
});
