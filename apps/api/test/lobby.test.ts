/**
 * The Lobby feed (src/lobby/): quick chat and its limits, cards from matches and from Rooms, blocks
 * hiding lines, under-18 accounts seeing nothing, reports with snapshots and the auto-hide, the
 * owner's chat mute and delete (with the moderation log), Delete my data, the 30-day sweep, the quiet
 * feed's facts, the live topic, and free text staying off unless CHAT_FREE_TEXT is set.
 */
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { LOBBY_CHANNEL, type LobbyChat, type LobbyEntry, type LobbyStreamEvent } from '@military-forge/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sweepEndedSignIns } from '../src/auth/retention';
import { chatMessages, matches, moderationAudit, playerReports, users } from '../src/db/schema';
import { CHAT_TTL_MS, FEED_KEY, LobbyFeed } from '../src/lobby/feed';
import { checkChatText } from '../src/lobby/filter';
import { RESULTS_AUDIENCE, RESULTS_ISSUER, type MatchReportBody } from '../src/matches/report';
import { bearer, createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';

const ADMIN = 'owner-token-for-tests-0123456789';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const keys = generateKeyPairSync('ed25519');
const pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi({ ADMIN_TOKEN: ADMIN, RESULTS_PUBLIC_KEY: pem.replaceAll('\n', '\\n') });
});
afterAll(() => api.close());

interface Feed {
  entries: LobbyEntry[];
  now: string;
  lastMatchAt: string | null;
  fightNight: { startsAt: string; endsAt: string; live: boolean };
  me: { mute: { until: string; reason: string } | null; freeText: { on: boolean; allowed: boolean; needs: string[] } };
}

const say = (s: SessionBody, body: Record<string, unknown>, ip = api.ip()) => api.app.request('/lobby/messages', json(body, { ...bearer(s.accessToken), 'x-forwarded-for': ip }));
const feedOf = async (s: SessionBody) => {
  const res = await api.app.request('/lobby', { headers: bearer(s.accessToken) });
  expect(res.status).toBe(200);
  return (await res.json()) as Feed;
};
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; until?: string; reason?: string; needs?: string[] } }).error;
const owner = (path: string, body?: unknown) => api.app.request(path, body === undefined ? { headers: bearer(ADMIN) } : json(body, bearer(ADMIN)));
const chats = (f: Feed) => f.entries.filter((e): e is LobbyChat => e.kind === 'chat');
/** past the 3 s gap */
const gap = () => api.clock.advance(3_100);
let nameNo = 0;
const guest = (stem: string) => createGuest(api, { nickname: `${stem}${++nameNo}` });
/** a sent message's entry */
async function sent(s: SessionBody, body: Record<string, unknown>): Promise<LobbyChat> {
  gap();
  const res = await say(s, body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { entry: LobbyChat }).entry;
}

describe('quick chat', () => {
  it('a guest sends a phrase by its id; everyone reads the words the server renders, with a reply link', async () => {
    const tobi = await guest('Tobi');
    const kemi = await guest('Kemi');
    const hi = await sent(tobi, { quick: 'how_far' });
    expect(hi).toMatchObject({ kind: 'chat', from: { id: tobi.user.id, name: tobi.user.nickname }, quick: 'how_far', text: 'How far?', replyTo: null });
    const back = await sent(kemi, { quick: 'make_we_play', replyTo: hi.id });
    expect(back.replyTo).toBe(hi.id);
    const feed = await feedOf(kemi);
    expect(chats(feed).slice(-2).map((e) => e.text)).toEqual(['How far?', 'Make we play']);
    // stored as the id, never the words
    const [row] = await api.database.db.select().from(chatMessages).where(eq(chatMessages.id, Number(hi.id)));
    expect(row).toMatchObject({ kind: 'chat', quick: 'how_far', body: null });
  });

  it('refuses anything that is not a phrase, and free text while CHAT_FREE_TEXT is off (the default)', async () => {
    const p = await guest('Plain');
    gap();
    expect((await errorOf(await say(p, { quick: 'not_a_phrase' }))).code).toBe('unknown_phrase');
    gap();
    expect((await errorOf(await say(p, { text: 'hello all' }))).code).toBe('free_text_off');
    expect((await feedOf(p)).me.freeText).toEqual({ on: false, allowed: false, needs: [] });
    expect((await api.app.request('/lobby/rules', json({}, bearer(p.accessToken)))).status).toBe(403);
  });
});

describe('rate limits', () => {
  it('one message every 3 s, 10 a minute, 100 an hour; the same phrase again within a minute is dropped', async () => {
    const p = await guest('Fast');
    gap();
    expect((await say(p, { quick: 'gg' })).status).toBe(201);
    const tooSoon = await say(p, { quick: 'nice_shot' });
    expect(tooSoon.status).toBe(429);
    expect((await errorOf(tooSoon)).code).toBe('slow_down');
    expect(tooSoon.headers.get('retry-after')).toBe('3');

    // a repeat goes nowhere and costs nothing
    gap();
    const again = await say(p, { quick: 'gg' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ dropped: 'repeat' });
    api.clock.advance(60_000);

    // 10 a minute (the minute's window started with the first message)
    const phrases = ['hi', 'whos_on', 'need_one', 'need_two', 'im_in', 'on_my_way', 'one_more', 'rematch', 'thanks'];
    const q = await guest('Burst');
    let ok = 0;
    let last: Response | null = null;
    for (const quick of [...phrases, 'sorry', 'back_soon']) {
      api.clock.advance(3_100);
      last = await say(q, { quick });
      if (last.status === 201) ok++;
    }
    expect(ok).toBe(10);
    expect(last!.status).toBe(429);
    expect((await errorOf(last!)).code).toBe('rate_limited');
  });

  it('100 an hour per account', async () => {
    const p = await guest('Hour');
    const ids = ['hi', 'how_far', 'whos_on', 'make_we_play', 'need_one', 'need_two', 'join_my_room', 'im_in', 'on_my_way', 'one_more'];
    let ok = 0;
    for (let minute = 0; minute < 11; minute++) {
      for (const quick of ids) {
        api.clock.advance(3_100);
        // a fresh IP each time: only the account's limits count here
        if ((await say(p, { quick }, `198.18.${minute}.${ids.indexOf(quick) + 1}`)).status === 201) ok++;
      }
      api.clock.advance(61_000 - 31_000);
    }
    expect(ok).toBe(100);
  });
});

describe('who sees what', () => {
  it('blocks hide lines both ways; an under-18 account sees nothing at all', async () => {
    const a = await guest('Blocker');
    const b = await guest('Blocked');
    const c = await guest('Bystander');
    const fromB = await sent(b, { quick: 'hi' });
    const fromA = await sent(a, { quick: 'welcome' });
    gap();
    expect((await api.app.request('/friends/blocks', json({ id: b.user.id }, bearer(a.accessToken)))).status).toBeLessThan(300);
    const ids = (f: Feed) => f.entries.map((e) => e.id);
    expect(ids(await feedOf(a))).not.toContain(fromB.id);
    expect(ids(await feedOf(b))).not.toContain(fromA.id);
    expect(ids(await feedOf(c))).toEqual(expect.arrayContaining([fromA.id, fromB.id]));

    const kid = await guest('Kid');
    await api.app.request('/me/age', { method: 'PUT', headers: { ...bearer(kid.accessToken), 'content-type': 'application/json' }, body: JSON.stringify({ minor: true }) });
    for (const path of ['/lobby', '/lobby/head', '/lobby/events']) {
      const res = await api.app.request(path, { headers: bearer(kid.accessToken) });
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('adults_only');
    }
    gap();
    expect((await say(kid, { quick: 'hi' })).status).toBe(403);
  });

  it('the live topic carries new lines and removals, filtered for blocks', async () => {
    const seen: LobbyStreamEvent[] = [];
    const stop = api.bus.subscribeTopic(LOBBY_CHANNEL, (e) => seen.push(e));
    const p = await guest('Live');
    const entry = await sent(p, { quick: 'e_fire' });
    stop();
    expect(seen).toContainEqual({ type: 'entry', entry });
    expect(entry.text).toBe('🔥');
    expect(LobbyFeed.visibleTo(entry, new Set([p.user.id]))).toBe(false);
    expect(LobbyFeed.visibleTo(entry, new Set())).toBe(true);
  });
});

describe('the quiet feed and cards', () => {
  it('never blank: Fight night is pinned with its times, and the last match time is real (null before any)', async () => {
    const fresh = await createTestApi();
    try {
      const s = await createGuest(fresh);
      const res = await fresh.app.request('/lobby', { headers: bearer(s.accessToken) });
      const feed = (await res.json()) as Feed;
      expect(feed.entries).toEqual([]);
      expect(feed.lastMatchAt).toBeNull();
      // START is 12:00 UTC (13:00 WAT): tonight 20:00–22:00 WAT
      expect(feed.fightNight).toMatchObject({ startsAt: '2026-10-17T19:00:00.000Z', endsAt: '2026-10-17T21:00:00.000Z', live: false });
      expect((await (await fresh.app.request('/lobby/head', { headers: bearer(s.accessToken) })).json())).toEqual({ id: null, at: null });
      const ended = new Date(fresh.clock.now() - 3 * HOUR);
      await fresh.database.db.insert(matches).values({ id: randomUUID(), mode: 'deathmatch', map: 'street-market', room: 'AAAAAA', startedAt: new Date(ended.getTime() - 300_000), endedAt: ended, durationS: 300, serverBuild: 't', result: {}, recordedAt: ended });
      const later = (await (await fresh.app.request('/lobby', { headers: bearer(s.accessToken) })).json()) as Feed;
      expect(later.lastMatchAt).toBe(ended.toISOString());
    } finally {
      await fresh.close();
    }
  });

  it('a recorded match posts its result (no bot named as a winner), a newcomer welcome and level milestones', async () => {
    const tobi = await guest('Newbie');
    const kemi = await guest('Winner');
    const body = (players: MatchReportBody['players'], botWon = false): MatchReportBody => ({
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
      serverBuild: 't',
      players: botWon ? players.map((p) => ({ ...p, placement: p.placement + 1 })) : players,
    });
    const line = (userId: string, nickname: string, placement: number, kills = 0) => ({ userId, nickname, placement, score: kills, kills, deaths: 0, assists: 0, damageDealt: 0, damageTaken: 0, headshots: 0, bestStreak: 0, left: false, mvp: false, killsBy: {} });
    const send = async (r: MatchReportBody) => {
      const raw = JSON.stringify(r);
      const now = Math.floor(api.clock.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
      const claims = { iss: RESULTS_ISSUER, aud: RESULTS_AUDIENCE, sub: r.matchId, iat: now, exp: now + 60, jti: randomUUID(), bodySha256: createHash('sha256').update(raw).digest('base64url') };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const tok = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), keys.privateKey).toString('base64url')}`;
      const res = await api.app.request('/internal/matches', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `GameServer ${tok}` }, body: raw });
      expect(res.status).toBe(201);
      // the game server's answer is as it was
      for (const p of ((await res.json()) as { players: Record<string, unknown>[] }).players) expect(Object.keys(p).sort()).toEqual(['level', 'userId', 'xp', 'xpGained']);
    };
    await send(body([line(kemi.user.id, kemi.user.nickname, 1, 30), line(tobi.user.id, tobi.user.nickname, 2)]));
    let feed = await feedOf(kemi);
    const result = feed.entries.filter((e) => e.kind === 'match_result').at(-1);
    expect(result).toMatchObject({ kind: 'match_result', winnerId: kemi.user.id, winnerName: kemi.user.nickname, map: 'street-market', people: 2, bots: 2 });
    const welcomes = feed.entries.filter((e) => e.kind === 'welcome').map((e) => (e.kind === 'welcome' ? e.name : ''));
    expect(welcomes).toEqual(expect.arrayContaining([tobi.user.nickname, kemi.user.nickname]));
    // a second match: no second welcome; a bot won, so nobody is named
    await send(body([line(kemi.user.id, kemi.user.nickname, 1), line(tobi.user.id, tobi.user.nickname, 2)], true));
    feed = await feedOf(kemi);
    expect(feed.entries.filter((e) => e.kind === 'welcome' && e.playerId === tobi.user.id)).toHaveLength(1);
    expect(feed.entries.filter((e) => e.kind === 'match_result').at(-1)).toMatchObject({ winnerId: null, winnerName: null, people: 2, bots: 2 });
    expect(feed.lastMatchAt).not.toBeNull();
  });

  it("Rooms' Post to Lobby lands as a room_posted card: clamped, presets only, hidden from a host's blockers", async () => {
    const host = await guest('Host');
    const viewer = await guest('Viewer');
    const feed = new LobbyFeed(api.database.db, api.kv, api.bus, api.clock.now, { warn: () => {}, info: () => {} } as never);
    const heard: unknown[] = [];
    const stop = feed.subscribe((e) => heard.push(e));
    await feed.publish({ kind: 'room_posted', code: 'abcdef', hostName: host.user.nickname, hostId: host.user.id, mode: 2, map: 'street-market', people: 2, bots: 900, seats: 6, tag: 'chill', lang: 'xx' as never, at: 0 });
    stop();
    const card = (await feedOf(viewer)).entries.filter((e) => e.kind === 'room_posted').at(-1)!;
    expect(card).toMatchObject({ kind: 'room_posted', code: 'ABCDEF', hostId: host.user.id, mode: 2, bots: 64, tag: 'chill', lang: null, at: new Date(api.clock.now()).toISOString() });
    expect(heard).toEqual([expect.objectContaining({ code: 'ABCDEF', at: api.clock.now() })]);
    expect((await feed.recent()).map((e) => e.code)).toContain('ABCDEF');
    gap();
    await api.app.request('/friends/blocks', json({ id: host.user.id }, bearer(viewer.accessToken)));
    expect((await feedOf(viewer)).entries.map((e) => e.id)).not.toContain(card.id);
  });
});

describe('reports and moderation', () => {
  it('a report on a message keeps its snapshot; three from day-old accounts hide it; fresh accounts do not count', async () => {
    const author = await guest('Spammer');
    const msg = await sent(author, { quick: 'join_my_room' });
    const reporters = await Promise.all([guest('RepA'), guest('RepB'), guest('RepC'), guest('RepNew')]);
    // three of them have been around a day
    for (const r of reporters.slice(0, 3)) await api.database.db.update(users).set({ createdAt: new Date(api.clock.now() - 2 * DAY) }).where(eq(users.id, r.user.id));
    const report = (r: SessionBody) => api.app.request('/reports/player', json({ id: author.user.id, reason: 'spam', place: 'chat', message: msg.id }, bearer(r.accessToken)));
    const first = await report(reporters[0]!);
    expect(first.status).toBe(201);
    const { id } = (await first.json()) as { id: number };
    const [row] = await api.database.db.select().from(playerReports).where(eq(playerReports.id, id));
    expect(row).toMatchObject({ place: 'chat', messageId: Number(msg.id), snapshot: { messageId: Number(msg.id), name: author.user.nickname, quick: 'join_my_room', text: 'Join my room' } });
    // the same reporter again: one report
    expect(await (await report(reporters[0]!)).json()).toMatchObject({ id, already: true });
    // a message that isn't theirs
    const other = await sent(reporters[3]!, { quick: 'hi' });
    expect((await api.app.request('/reports/player', json({ id: author.user.id, reason: 'spam', place: 'chat', message: other.id }, bearer(reporters[0]!.accessToken)))).status).toBe(404);

    await report(reporters[3]!); // a new account: doesn't count
    await report(reporters[1]!);
    expect((await feedOf(reporters[3]!)).entries.map((e) => e.id)).toContain(msg.id);
    await report(reporters[2]!);
    expect((await feedOf(reporters[3]!)).entries.map((e) => e.id)).not.toContain(msg.id);
    // the owner sees the snapshot in the queue
    const queue = (await (await owner('/admin/moderation/reports?open=1')).json()) as { reports: { message: { id: string; snapshot: { text: string } } | null }[] };
    expect(queue.reports.find((r) => r.message?.id === msg.id)?.message?.snapshot.text).toBe('Join my room');
  });

  it("the owner's chat mute: the player sees why and until when, can't post, then can again; logged", async () => {
    const p = await guest('Loud');
    const res = await owner(`/admin/moderation/players/${p.user.id}`, { action: 'chat_mute', reason: 'Spamming the Lobby', hours: 2 });
    expect(res.status).toBe(200);
    const until = new Date(api.clock.now() + 2 * HOUR).toISOString();
    expect((await feedOf(p)).me.mute).toEqual({ until, reason: 'Spamming the Lobby' });
    gap();
    const refused = await say(p, { quick: 'hi' });
    expect(refused.status).toBe(403);
    expect(await errorOf(refused)).toMatchObject({ code: 'chat_muted', until, reason: 'Spamming the Lobby' });
    const [log] = await api.database.db.select().from(moderationAudit).where(eq(moderationAudit.userId, p.user.id));
    expect(log).toMatchObject({ action: 'chat_mute', reason: 'Spamming the Lobby', detail: { hours: 2, until } });
    api.clock.advance(2 * HOUR + 1000);
    // the token ran out meanwhile
    const refreshed = await api.app.request('/auth/refresh', json({ refreshToken: p.refreshToken }, { 'x-forwarded-for': api.ip() }));
    Object.assign(p, await refreshed.json());
    expect((await feedOf(p)).me.mute).toBeNull();
    expect((await say(p, { quick: 'sorry' })).status).toBe(201);
  });

  it("the owner's delete: gone for everyone, its words kept in the log; only that player's own message", async () => {
    const p = await guest('Rude');
    const q = await guest('Other');
    const msg = await sent(p, { quick: 'got_to_go' });
    const notTheirs = await sent(q, { quick: 'hi' });
    const removed: LobbyStreamEvent[] = [];
    const stop = api.bus.subscribeTopic(LOBBY_CHANNEL, (e) => removed.push(e));
    expect((await owner(`/admin/moderation/players/${p.user.id}`, { action: 'delete_message', reason: 'Abuse', message: notTheirs.id })).status).toBe(404);
    expect((await owner(`/admin/moderation/players/${p.user.id}`, { action: 'delete_message', reason: 'Abuse', message: msg.id })).status).toBe(200);
    stop();
    expect(removed).toContainEqual({ type: 'remove', id: msg.id });
    expect((await feedOf(q)).entries.map((e) => e.id)).not.toContain(msg.id);
    expect(await api.database.db.select().from(chatMessages).where(eq(chatMessages.id, Number(msg.id)))).toEqual([]);
    const logs = await api.database.db.select().from(moderationAudit).where(eq(moderationAudit.userId, p.user.id));
    expect(logs.find((l) => l.action === 'delete_message')?.detail).toMatchObject({ message: { id: msg.id, quick: 'got_to_go', text: 'Got to go' } });
  });
});

describe('data', () => {
  it('Delete my data takes their messages and the cards about them, from the feed and from Postgres', async () => {
    const p = await guest('Leaver');
    const q = await guest('Stayer');
    const msg = await sent(p, { quick: 'hi' });
    const feed = new LobbyFeed(api.database.db, api.kv, api.bus, api.clock.now, { warn: () => {}, info: () => {} } as never);
    const card = await feed.post({ kind: 'welcome', playerId: p.user.id, name: p.user.nickname, at: new Date(api.clock.now()).toISOString() });
    expect((await feedOf(q)).entries.map((e) => e.id)).toEqual(expect.arrayContaining([msg.id, card!.id]));
    expect((await api.app.request('/me', { method: 'DELETE', headers: bearer(p.accessToken) })).status).toBe(204);
    const after = (await feedOf(q)).entries.map((e) => e.id);
    expect(after).not.toContain(msg.id);
    expect(after).not.toContain(card!.id);
    expect(await api.database.db.select().from(chatMessages).where(eq(chatMessages.authorId, p.user.id))).toEqual([]);
    // the live stream may still hold the JSON, but every read checks Postgres
    expect((await api.kv.xrevrange(FEED_KEY, 500)).some((e) => e.value.includes(msg.id))).toBe(true);
  });

  it('lines older than 30 days go in the retention sweep', async () => {
    const p = await guest('Old');
    const msg = await sent(p, { quick: 'back_soon' });
    await sweepEndedSignIns(api.database.db, api.clock.now());
    expect(await api.database.db.select().from(chatMessages).where(eq(chatMessages.id, Number(msg.id)))).toHaveLength(1);
    const swept = await sweepEndedSignIns(api.database.db, api.clock.now() + CHAT_TTL_MS + 1000);
    expect(swept.chatMessages).toBeGreaterThan(0);
    expect(await api.database.db.select().from(chatMessages).where(eq(chatMessages.id, Number(msg.id)))).toEqual([]);
  });
});

describe('free text (CHAT_FREE_TEXT)', () => {
  it('the filter: 200 characters, no links, no long numbers, slurs refused, swears masked', () => {
    expect(checkChatText('  good   game  ')).toEqual({ ok: true, text: 'good game', masked: false });
    expect(checkChatText('x'.repeat(201))).toMatchObject({ ok: false, code: 'too_long' });
    for (const link of ['see https://x.example', 'go to www.site.ng', 'mysite.com now', 'mysite dot com', 't.me/group']) expect(checkChatText(link)).toMatchObject({ ok: false, code: 'link' });
    for (const num of ['call 08031234567', 'call 0803 123 4567', 'acct 012-345-6789']) expect(checkChatText(num)).toMatchObject({ ok: false, code: 'digits' });
    expect(checkChatText('I scored 100 and 2000')).toMatchObject({ ok: true });
    expect(checkChatText('you are a n1gg3r')).toMatchObject({ ok: false, code: 'refused' });
    expect(checkChatText('what the fuck man')).toEqual({ ok: true, text: 'what the ••• man', masked: true });
    expect(checkChatText('f u c k you')).toMatchObject({ ok: false, code: 'refused' });
    expect(checkChatText('my pen is broken, pass the class')).toMatchObject({ ok: true, masked: false });
  });

  it('on: locked until the account is seasoned (or saved) and the rules are accepted', async () => {
    const on = await createTestApi({ CHAT_FREE_TEXT: 'true' });
    try {
      const p = await createGuest(on);
      const sayOn = (text: string) => on.app.request('/lobby/messages', json({ text }, { ...bearer(p.accessToken), 'x-forwarded-for': on.ip() }));
      const gate = async () => ((await (await on.app.request('/lobby', { headers: bearer(p.accessToken) })).json()) as Feed).me.freeText;
      expect(await gate()).toEqual({ on: true, allowed: false, needs: ['account', 'rules'] });
      const locked = await sayOn('hello');
      expect(locked.status).toBe(403);
      expect(await errorOf(locked)).toMatchObject({ code: 'free_text_locked', needs: ['account', 'rules'] });
      expect((await on.app.request('/lobby/rules', json({}, bearer(p.accessToken)))).status).toBe(200);
      // a day old and 3 matches
      await on.database.db.update(users).set({ createdAt: new Date(on.clock.now() - 2 * DAY) }).where(eq(users.id, p.user.id));
      const { statsLifetime } = await import('../src/db/schema');
      await on.database.db.insert(statsLifetime).values({ userId: p.user.id, weaponId: '*', matches: 3 });
      expect(await gate()).toEqual({ on: true, allowed: true, needs: [] });
      const res = await sayOn('what the fuck, good game');
      expect(res.status).toBe(201);
      expect(((await res.json()) as { entry: LobbyChat }).entry).toMatchObject({ quick: null, text: 'what the ••• good game' });
      on.clock.advance(3_100);
      expect(await errorOf(await sayOn('call me 08031234567'))).toMatchObject({ code: 'digits' });
    } finally {
      await on.close();
    }
  });
});
