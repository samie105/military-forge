/**
 * Player safety for launch (audit-2, 1 Nov): reporting a player (reports/player.ts) and the owner's
 * moderation (reports/moderation.ts: the list, rename, suspend, ban, dismiss, clear_minor, close, and
 * its log), blocking anyone by id or name, under-18 accounts (training only), declined requests kept
 * 30 days, the inbound request cap, "who can send me requests", the per-friend invite limits, the
 * reserved brand names, and the retention sweep for reports and declines.
 */
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '../src/auth/keys';
import { sweepEndedSignIns } from '../src/auth/retention';
import { friendRequestDeclines, matchPlayers, matches, moderationAudit, playerReports, profiles, users } from '../src/db/schema';
import { DECLINE_MEMORY_MS, MAX_INCOMING_REQUESTS, type FriendsList } from '../src/friends/service';
import { LIMITS } from '../src/http/rateLimit';
import { DECLINED_QUIET_MS, REINVITE_MS } from '../src/invites/service';
import { NicknamePolicy } from '../src/nickname/rules';
import { PLAYER_REPORT_TTL_MS, REPORT_DEDUPE_MS } from '../src/reports/player';
import type { RoomJoin } from '../src/rooms/routes';
import { befriend, bearer, createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';

const ADMIN = 'owner-token-for-tests-0123456789';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi({ ADMIN_TOKEN: ADMIN }, { ticketKey: generateSigningKey() });
});
afterAll(() => api.close());

const post = (s: SessionBody, path: string, body: unknown = {}) => api.app.request(path, json(body, { ...bearer(s.accessToken), 'x-forwarded-for': api.ip() }));
const put = (s: SessionBody, path: string, body: unknown) => api.app.request(path, { method: 'PUT', headers: { ...bearer(s.accessToken), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (s: SessionBody, path: string) => api.app.request(path, { headers: bearer(s.accessToken) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; until?: string | null } }).error;
const list = async (s: SessionBody) => (await (await get(s, '/friends')).json()) as FriendsList;
const owner = (path: string, body?: unknown) =>
  api.app.request(path, body === undefined ? { headers: bearer(ADMIN) } : json(body, bearer(ADMIN)));
const report = (s: SessionBody, body: Record<string, unknown>) => post(s, '/reports/player', body);
const beat = (s: SessionBody, room: string | null = null) => put(s, '/me/presence', { room });
const makeRoom = async (s: SessionBody) => (await (await post(s, '/rooms')).json()) as RoomJoin;
const refresh = (s: SessionBody) => api.app.request('/auth/refresh', json({ refreshToken: s.refreshToken }, { 'x-forwarded-for': api.ip() }));
/** the same players after the clock moved past their access tokens (15 minutes) */
async function renew(...players: SessionBody[]): Promise<void> {
  for (const p of players) {
    const res = await refresh(p);
    if (res.status !== 200) throw new Error(`refresh failed: ${res.status}`);
    Object.assign(p, (await res.json()) as SessionBody);
  }
}

let n = 0;
async function matchTogether(players: SessionBody[], endedAt: number) {
  const id = `m-${++n}-${randomUUID()}`;
  const db = api.database.db;
  await db.insert(matches).values({ id, mode: 'deathmatch', map: 'street-market', room: 'AAAAAA', startedAt: new Date(endedAt - 300_000), endedAt: new Date(endedAt), durationS: 300, serverBuild: 't', result: {}, recordedAt: new Date(endedAt) });
  await db.insert(matchPlayers).values(players.map((p, i) => ({ matchId: id, userId: p.user.id, placement: i + 1, score: 0, kills: 0, deaths: 0, assists: 0, damage: 0, damageTaken: 0, headshots: 0, bestStreak: 0, left: false, mvp: false, xpGained: 0 })));
}

interface AdminReport {
  id: number;
  at: string;
  reason: string;
  note: string | null;
  room: string | null;
  place: string | null;
  handledAt: string | null;
  action: string | null;
  reporter: { id: string; nickname: string | null };
  target: { id: string; name: string; nickname: string | null; standing: string; until: string | null; minor: boolean; open: number };
}

describe('reporting a player', () => {
  it('by name (a room) or by id (the friends panel), with the reason, the note and where; one a day per player', async () => {
    const me = await createGuest(api, { nickname: 'Rep_Me' });
    const them = await createGuest(api, { nickname: 'Rep_Them' });
    const byName = await report(me, { name: 'rep them', reason: 'voice', note: '  shouting slurs  ', room: 'abc-def', place: 'scoreboard' });
    expect(byName.status).toBe(201);
    const { id } = (await byName.json()) as { id: number };
    const [row] = await api.database.db.select().from(playerReports).where(eq(playerReports.id, id));
    expect(row).toMatchObject({ reporterId: me.user.id, targetId: them.user.id, targetName: 'Rep_Them', reason: 'voice', note: 'shouting slurs', room: 'ABCDEF', place: 'scoreboard', handledAt: null });

    // the same reporter about the same player within a day: the first report stands
    const again = await report(me, { id: them.user.id, reason: 'cheating' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ id, already: true });
    api.clock.advance(REPORT_DEDUPE_MS + 1);
    await renew(me);
    expect((await report(me, { id: them.user.id, reason: 'cheating' })).status).toBe(201);
  });

  it('refuses yourself, nobody, a bad reason, a long note, both or neither of id and name, and no session', async () => {
    const me = await createGuest(api, { nickname: 'Rep_Self' });
    const other = await createGuest(api);
    expect((await errorOf(await report(me, { id: me.user.id, reason: 'other' }))).code).toBe('cannot_report_self');
    expect((await errorOf(await report(me, { name: 'Nobody_Here_77', reason: 'other' }))).code).toBe('player_not_found');
    expect((await report(me, { id: other.user.id, reason: 'rude' })).status).toBe(400);
    expect((await report(me, { id: other.user.id, reason: 'other', note: 'x'.repeat(301) })).status).toBe(400);
    expect((await report(me, { id: other.user.id, name: other.user.nickname, reason: 'other' })).status).toBe(400);
    expect((await report(me, { reason: 'other' })).status).toBe(400);
    expect((await api.app.request('/reports/player', json({ id: other.user.id, reason: 'other' }))).status).toBe(401);
  });

  it(`at most ${LIMITS.playerReport.limit} an hour per reporter`, async () => {
    const me = await createGuest(api);
    const targets = await Promise.all(Array.from({ length: LIMITS.playerReport.limit + 1 }, () => createGuest(api)));
    for (const t of targets.slice(0, -1)) expect((await report(me, { id: t.user.id, reason: 'spam' })).status).toBe(201);
    expect((await report(me, { id: targets.at(-1)!.user.id, reason: 'spam' })).status).toBe(429);
  });
});

describe("the owner's moderation", () => {
  it('needs the admin token', async () => {
    expect((await api.app.request('/admin/moderation/reports')).status).toBe(401);
    expect((await api.app.request('/admin/moderation/reports', { headers: bearer('wrong-token-wrong-token-1234') })).status).toBe(401);
    const someone = await createGuest(api);
    expect((await api.app.request(`/admin/moderation/players/${someone.user.id}`, json({ action: 'ban', reason: 'x' }))).status).toBe(401);
  });

  it('lists reports newest first with who, about whom, when, where and why, and counts the open ones', async () => {
    const a = await createGuest(api, { nickname: 'Rpt_A' });
    const b = await createGuest(api, { nickname: 'Rpt_B' });
    const target = await createGuest(api, { nickname: 'Rpt_Target' });
    await report(a, { id: target.user.id, reason: 'name', place: 'lobby', room: 'QWERTY' });
    api.clock.advance(1000);
    await report(b, { name: 'Rpt_Target', reason: 'voice', note: 'loud', place: 'comms' });
    const res = await owner('/admin/moderation/reports?open=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { open: number; last24h: number; reports: AdminReport[] };
    const mine = body.reports.filter((r) => r.target.id === target.user.id);
    expect(mine.map((r) => r.reporter.nickname)).toEqual(['Rpt_B', 'Rpt_A']);
    expect(mine[0]).toMatchObject({ reason: 'voice', note: 'loud', place: 'comms', room: null, target: { name: 'Rpt_Target', nickname: 'Rpt_Target', standing: 'active', open: 2, minor: false } });
    expect(mine[1]).toMatchObject({ reason: 'name', place: 'lobby', room: 'QWERTY' });
    expect(body.open).toBeGreaterThanOrEqual(2);
    expect(body.last24h).toBeGreaterThanOrEqual(2);
  });

  it('suspend: no online play until it ends, the session kept; then it works again', async () => {
    const target = await createGuest(api, { nickname: 'Rpt_Susp' });
    const res = await owner(`/admin/moderation/players/${target.user.id}`, { action: 'suspend', hours: 24, reason: 'abusive voice' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { player: { standing: string } }).player.standing).toBe('suspended');
    // every request checks the session: refused at once
    expect((await get(target, '/me')).status).toBe(401);
    const refused = await refresh(target);
    expect(refused.status).toBe(403);
    const err = await errorOf(refused);
    expect(err.code).toBe('account_disabled');
    expect(Date.parse(err.until!)).toBe(api.clock.now() + 24 * HOUR);
    // the refresh token still works once the suspension is over (a guest can't sign in again)
    api.clock.advance(24 * HOUR + 1);
    const back = await refresh(target);
    expect(back.status).toBe(200);
    const fresh = (await back.json()) as SessionBody;
    expect((await get(fresh, '/me')).status).toBe(200);
  });

  it('ban is for good (until unban); unban brings the account back; every action is logged', async () => {
    const target = await createGuest(api, { nickname: 'Rpt_Ban' });
    await owner(`/admin/moderation/players/${target.user.id}`, { action: 'ban', reason: 'cheating' });
    api.clock.advance(3 * DAY);
    const refused = await refresh(target);
    expect(refused.status).toBe(403);
    expect((await errorOf(refused)).until).toBeNull();
    await owner(`/admin/moderation/players/${target.user.id}`, { action: 'unban', reason: 'appeal accepted' });
    expect((await refresh(target)).status).toBe(200);
    const log = await api.database.db.select().from(moderationAudit).where(eq(moderationAudit.userId, target.user.id));
    expect(log.map((l) => [l.action, l.reason, l.actor])).toEqual([
      ['ban', 'cheating', 'owner'],
      ['unban', 'appeal accepted', 'owner'],
    ]);
  });

  it('rename gives a generated name they may change at once, and closes the open reports', async () => {
    const reporter = await createGuest(api);
    const target = await createGuest(api, { nickname: 'Rpt_Rude' });
    await report(reporter, { id: target.user.id, reason: 'name' });
    const res = await owner(`/admin/moderation/players/${target.user.id}`, { action: 'rename', reason: 'offensive name' });
    const body = (await res.json()) as { player: { nickname: string }; reports: AdminReport[]; audit: { action: string; detail: { nickname: string } }[] };
    expect(body.player.nickname).not.toBe('Rpt_Rude');
    expect(body.audit[0]).toMatchObject({ action: 'rename', detail: { nickname: body.player.nickname } });
    expect(body.reports[0]).toMatchObject({ action: 'rename', target: { name: 'Rpt_Rude', nickname: body.player.nickname, open: 0 } });
    expect(body.reports[0]!.handledAt).not.toBeNull();
    const me = (await (await get(target, '/me')).json()) as { nickname: string; nicknameChangeableAt: string | null };
    expect(me).toMatchObject({ nickname: body.player.nickname, nicknameChangeableAt: null });
  });

  it('dismiss closes reports and changes nothing else; a bad action, reason or id is refused', async () => {
    const reporter = await createGuest(api);
    const target = await createGuest(api);
    await report(reporter, { id: target.user.id, reason: 'other' });
    const body = (await (await owner(`/admin/moderation/players/${target.user.id}`, { action: 'dismiss', reason: 'nothing wrong' })).json()) as { player: { standing: string }; reports: AdminReport[] };
    expect(body.player.standing).toBe('active');
    expect(body.reports[0]!.action).toBe('dismiss');
    expect((await owner(`/admin/moderation/players/${target.user.id}`, { action: 'nuke', reason: 'x' })).status).toBe(400);
    expect((await owner(`/admin/moderation/players/${target.user.id}`, { action: 'ban', reason: '  ' })).status).toBe(400);
    expect((await owner(`/admin/moderation/players/${target.user.id}`, { action: 'suspend', reason: 'x', hours: 721 })).status).toBe(400);
    expect((await owner('/admin/moderation/players/not-an-id', { action: 'ban', reason: 'x' })).status).toBe(400);
    expect((await owner('/admin/moderation/players/u_00000000000000000000000000', { action: 'ban', reason: 'x' })).status).toBe(404);
  });

  it('close deletes the account; its reports and the log stay', async () => {
    const reporter = await createGuest(api);
    const target = await createGuest(api, { nickname: 'Rpt_Kid' });
    await report(reporter, { id: target.user.id, reason: 'underage' });
    const res = await owner(`/admin/moderation/players/${target.user.id}`, { action: 'close', reason: 'under 18' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { player: unknown; reports: AdminReport[]; audit: unknown[] };
    expect(body.player).toBeNull();
    expect(body.reports[0]).toMatchObject({ action: 'close', target: { name: 'Rpt_Kid', nickname: null, standing: 'deleted' } });
    expect(body.audit).toHaveLength(1);
    expect(await api.database.db.select().from(users).where(eq(users.id, target.user.id))).toEqual([]);
    expect((await owner(`/admin/moderation/players/${target.user.id}`)).status).toBe(200);
  });

  it('finds an account by name', async () => {
    const target = await createGuest(api, { nickname: 'Findme_Rpt' });
    const body = (await (await owner('/admin/moderation/players?q=findme')).json()) as { players: { id: string }[] };
    expect(body.players.map((p) => p.id)).toContain(target.user.id);
  });
});

describe('blocking anyone', () => {
  it("blocks a stranger whose request is waiting, by name or by id: the request goes and they're never told", async () => {
    const me = await createGuest(api, { nickname: 'Blk_Me' });
    const pest = await createGuest(api, { nickname: 'Blk_Pest' });
    const other = await createGuest(api);
    expect((await post(pest, '/friends/requests', { name: 'Blk_Me' })).status).toBe(200);
    expect((await list(me)).incoming.map((r) => r.id)).toEqual([pest.user.id]);
    expect((await post(me, '/friends/blocks', { name: 'blk pest' })).status).toBe(204);
    const mine = await list(me);
    expect(mine.incoming).toEqual([]);
    expect(mine.blocked.map((b) => b.id)).toEqual([pest.user.id]);
    // a new request from them waits unseen
    expect((await post(pest, '/friends/requests', { name: 'Blk_Me' })).status).toBe(200);
    expect((await list(me)).incoming).toEqual([]);
    // by id, someone you never met
    expect((await post(me, '/friends/blocks', { id: other.user.id })).status).toBe(204);
    expect((await errorOf(await post(me, '/friends/blocks', { name: 'Nobody_At_All' }))).code).toBe('player_not_found');
    expect((await post(me, '/friends/blocks', { id: other.user.id, name: 'x' })).status).toBe(400);
  });
});

describe('under 18: training only', () => {
  it('a guest made with minor: true can train, but gets 403 adults_only from friends, invites, the party and online rooms', async () => {
    const kid = await createGuest(api, { nickname: 'Kid_One', minor: true });
    const me = (await (await get(kid, '/me')).json()) as { minor?: boolean };
    expect(me.minor).toBe(true);
    for (const res of [
      await get(kid, '/friends'),
      await get(kid, '/friends/search?q=ab'),
      await post(kid, '/friends/requests', { name: 'Someone' }),
      await get(kid, '/invites'),
      await get(kid, '/party'),
      await post(kid, '/rooms'),
      await post(kid, '/rooms/ABCDEF/join'),
    ]) {
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('adults_only');
    }
    // the loadout (training's guns and look) still works
    expect([200, 204]).toContain((await get(kid, '/me/loadout/0')).status);
  });

  it('nobody finds an under-18 account: not by search, not by exact name', async () => {
    const adult = await createGuest(api);
    await createGuest(api, { nickname: 'Kid_Hidden', minor: true });
    expect(((await (await get(adult, '/friends/search?q=kid_hid')).json()) as { players: unknown[] }).players).toEqual([]);
    expect((await errorOf(await post(adult, '/friends/requests', { name: 'Kid_Hidden' }))).code).toBe('player_not_found');
  });

  it('an existing guest whose device says under 18 (PUT /me/age): friends and requests end, nobody finds it, and only the owner clears it', async () => {
    const kid = await createGuest(api, { nickname: 'Kid_Later' });
    const friend = await createGuest(api);
    const asker = await createGuest(api);
    await befriend(api.app, kid, friend);
    await post(asker, '/friends/requests', { name: 'Kid_Later' });
    const res = await put(kid, '/me/age', { minor: true });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { minor?: boolean }).minor).toBe(true);
    expect((await list(friend)).friends).toEqual([]);
    expect((await list(asker)).outgoing).toEqual([]);
    const [p] = await api.database.db.select({ findable: profiles.findable }).from(profiles).where(eq(profiles.userId, kid.user.id));
    expect(p!.findable).toBe(false);
    expect((await put(kid, '/me/age', { minor: false })).status).toBe(400);
    // the owner corrects a wrong answer
    await owner(`/admin/moderation/players/${kid.user.id}`, { action: 'clear_minor', reason: 'parent confirmed adult' });
    expect((await get(kid, '/friends')).status).toBe(200);
  });
});

describe('friend requests: declines, the cap, who may ask', () => {
  it('a declined request looks sent but reaches nobody for 30 days; accepting their request later clears it', async () => {
    const me = await createGuest(api, { nickname: 'Dec_Me' });
    const pest = await createGuest(api, { nickname: 'Dec_Pest' });
    await post(pest, '/friends/requests', { name: 'Dec_Me' });
    expect((await post(me, `/friends/requests/${pest.user.id}/decline`)).status).toBe(204);
    const again = await post(pest, '/friends/requests', { name: 'Dec_Me' });
    expect(again.status).toBe(200);
    expect(((await again.json()) as { status: string }).status).toBe('requested');
    expect((await list(me)).incoming).toEqual([]);
    api.clock.advance(DECLINE_MEMORY_MS + 1);
    await renew(me, pest);
    await post(pest, '/friends/requests', { name: 'Dec_Me' });
    expect((await list(me)).incoming.map((r) => r.id)).toEqual([pest.user.id]);
    expect((await post(me, `/friends/requests/${pest.user.id}/accept`)).status).toBe(200);
    expect(await api.database.db.select().from(friendRequestDeclines).where(eq(friendRequestDeclines.toId, me.user.id))).toEqual([]);
  });

  it(`at most ${MAX_INCOMING_REQUESTS} requests wait for one player: the oldest make room`, async () => {
    const popular = await createGuest(api, { nickname: 'Cap_Pop' });
    const askers: SessionBody[] = [];
    for (let i = 0; i <= MAX_INCOMING_REQUESTS; i++) {
      const a = await createGuest(api);
      askers.push(a);
      expect((await post(a, '/friends/requests', { name: 'Cap_Pop' })).status).toBe(200);
      api.clock.advance(1000);
    }
    const waiting = (await list(popular)).incoming.map((r) => r.id);
    expect(waiting).toHaveLength(MAX_INCOMING_REQUESTS);
    expect(waiting).not.toContain(askers[0]!.user.id);
    expect(waiting[0]).toBe(askers.at(-1)!.user.id);
  });

  it("'code': requests by name are refused, the friend code still works; 'played': only people they shared a match with", async () => {
    const me = await createGuest(api, { nickname: 'Who_Me' });
    const met = await createGuest(api, { nickname: 'Who_Met' });
    const stranger = await createGuest(api, { nickname: 'Who_Stranger' });
    const set = await put(me, '/friends/settings', { requestsFrom: 'code' });
    expect(await set.json()).toEqual({ findable: true, requestsFrom: 'code' });
    expect((await list(me)).requestsFrom).toBe('code');
    const byName = await post(stranger, '/friends/requests', { name: 'Who_Me' });
    expect(byName.status).toBe(403);
    expect((await errorOf(byName)).code).toBe('requests_closed');
    const byCode = await post(stranger, '/friends/requests', { code: (await list(me)).code });
    expect(((await byCode.json()) as { status: string }).status).toBe('requested');

    await put(me, '/friends/settings', { requestsFrom: 'played' });
    await matchTogether([me, met], api.clock.now() - HOUR);
    expect((await post(met, '/friends/requests', { name: 'Who_Me' })).status).toBe(200);
    await post(me, `/friends/requests/${stranger.user.id}/decline`);
    api.clock.advance(DECLINE_MEMORY_MS + 1);
    await renew(me, stranger);
    expect((await errorOf(await post(stranger, '/friends/requests', { name: 'Who_Me' }))).code).toBe('requests_closed');
    // validation
    expect((await put(me, '/friends/settings', { requestsFrom: 'nobody-at-all' })).status).toBe(400);
    expect((await put(me, '/friends/settings', {})).status).toBe(400);
  });
});

describe('invites: per friend', () => {
  it(`one a minute and at most ${LIMITS.invitePair.limit} in 10 minutes to the same friend; none for 5 minutes after they decline`, async () => {
    const host = await createGuest(api);
    const friend = await createGuest(api);
    const other = await createGuest(api);
    await befriend(api.app, host, friend);
    await befriend(api.app, host, other);
    const room = await makeRoom(host);
    const send = (to: SessionBody) => post(host, '/invites', { to: to.user.id, room: room.code });
    expect((await send(friend)).status).toBe(201);
    expect((await send(friend)).status).toBe(429); // a double tap (it counts)
    for (let i = 2; i < LIMITS.invitePair.limit; i++) {
      api.clock.advance(REINVITE_MS);
      expect((await send(friend)).status).toBe(201);
    }
    api.clock.advance(REINVITE_MS);
    const capped = await send(friend);
    expect(capped.status).toBe(429);
    expect((await errorOf(capped)).code).toBe('rate_limited');
    // another friend isn't held up
    expect((await send(other)).status).toBe(201);

    const inv = ((await (await get(other, '/invites')).json()) as { incoming: { id: string }[] }).incoming[0]!;
    expect((await post(other, `/invites/${inv.id}/decline`)).status).toBe(204);
    api.clock.advance(REINVITE_MS);
    await beat(host, room.code);
    const quiet = await send(other);
    expect(quiet.status).toBe(429);
    expect((await errorOf(quiet)).code).toBe('invite_declined');
    if (api.kv.kind !== 'memory') return; // a real Valkey's TTL can't be fast-forwarded
    api.clock.advance(DECLINED_QUIET_MS);
    expect((await send(other)).status).toBe(201);
  });
});

describe('reserved names', () => {
  it("the studio's and the game's names are reserved in code, whatever the env says", () => {
    const policy = new NicknamePolicy();
    for (const name of ['Deet', 'Deet_7', 'DeetStudio', 'DeetStudios', 'WorldStreet', 'Forge', 'F0rge_99', 'MilitaryForge', 'ForgeAdmin', 'AntiCheat', 'TheCEO']) {
      expect(policy.check(name), name).toEqual({ ok: false, reason: 'reserved' });
    }
    for (const name of ['IronForge', 'Forger', 'Deeta', 'Swedeet']) expect(policy.check(name).ok, name).toBe(true);
    // and the env's list still adds the owner's and staff handles
    expect(new NicknamePolicy(['Ojay']).check('Ojay_1')).toEqual({ ok: false, reason: 'reserved' });
  });
});

describe('the retention sweep', () => {
  it('deletes player reports after 180 days and remembered declines after 30', async () => {
    const a = await createGuest(api);
    const b = await createGuest(api);
    const db = api.database.db;
    const now = api.clock.now();
    await db.insert(playerReports).values([
      { reporterId: a.user.id, targetId: b.user.id, targetName: 'x', reason: 'other', createdAt: new Date(now - PLAYER_REPORT_TTL_MS - DAY) },
      { reporterId: a.user.id, targetId: b.user.id, targetName: 'y', reason: 'other', createdAt: new Date(now - PLAYER_REPORT_TTL_MS + DAY) },
    ]);
    await db.insert(friendRequestDeclines).values({ fromId: a.user.id, toId: b.user.id, at: new Date(now - DECLINE_MEMORY_MS - DAY) });
    const result = await sweepEndedSignIns(db, now);
    expect(result.playerReports).toBeGreaterThanOrEqual(1);
    expect(result.declines).toBeGreaterThanOrEqual(1);
    const left = await db.select({ name: playerReports.targetName }).from(playerReports).where(eq(playerReports.reporterId, a.user.id));
    expect(left).toEqual([{ name: 'y' }]);
  });
});
