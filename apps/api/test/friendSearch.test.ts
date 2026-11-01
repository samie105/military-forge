/**
 * Finding players (friends/, 31 Oct): name search as you type (prefix, closest first, at most 8),
 * its rate limits, the "Let players find me by name" switch, blocks either way, the prefix index,
 * Played with recently (from match lines), and the soldiers' looks for the avatars.
 */
import { DEFAULT_COSMETIC_LOADOUT, cosmeticLoadoutWireIds, cosmetics } from '@military-forge/content';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadouts, matchPlayers, matches } from '../src/db/schema';
import type { FoundPlayer, FriendsList } from '../src/friends/service';
import { LIMITS } from '../src/http/rateLimit';
import { befriend, bearer, createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(() => api.close());

const search = (s: SessionBody, q: string, ip = api.ip()) => api.app.request(`/friends/search?q=${encodeURIComponent(q)}`, { headers: { ...bearer(s.accessToken), 'x-forwarded-for': ip } });
const found = async (s: SessionBody, q: string) => {
  const res = await search(s, q);
  expect(res.status).toBe(200);
  return ((await res.json()) as { players: FoundPlayer[] }).players;
};
const names = async (s: SessionBody, q: string) => (await found(s, q)).map((p) => p.nickname);
const recent = async (s: SessionBody) => ((await (await api.app.request('/friends/recent', { headers: bearer(s.accessToken) })).json()) as { players: FoundPlayer[] }).players;
const list = async (s: SessionBody) => (await (await api.app.request('/friends', { headers: bearer(s.accessToken) })).json()) as FriendsList;
const put = (s: SessionBody, path: string, body: unknown) => api.app.request(path, { method: 'PUT', headers: { ...bearer(s.accessToken), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const post = (s: SessionBody, path: string, body: unknown = {}) => api.app.request(path, json(body, { ...bearer(s.accessToken), 'x-forwarded-for': api.ip() }));
/** a fresh search window for this player (the tests search a lot) */
const freshLimits = (s: SessionBody) => Promise.all([api.kv.del(`rl:${LIMITS.friendSearch.name}:${s.user.id}`), api.kv.del(`rl:${LIMITS.friendSearchHour.name}:${s.user.id}`)]);

describe('name search', () => {
  it('matches the start of a name in any case, closest first, at most 8, never yourself', async () => {
    const me = await createGuest(api, { nickname: 'Volta' });
    for (const n of ['Volkov', 'Volk', 'VOLK_ONE', 'volk.two', 'Volkmar', 'Volker', 'Volksy', 'Volkan_99', 'Volkman']) await createGuest(api, { nickname: n });
    await createGuest(api, { nickname: 'Avolk' });
    expect(await names(me, 'volk')).toEqual(['Volk', 'Volker', 'Volkov', 'Volksy', 'Volkman', 'Volkmar', 'VOLK_ONE', 'volk.two']);
    // separators and case don't matter; you never find yourself
    expect(await names(me, 'VOLK ON')).toEqual(['VOLK_ONE']);
    expect(await names(me, 'volta')).toEqual([]);
    // the exact name comes first even when longer names share its start
    expect((await names(me, 'Volkman'))[0]).toBe('Volkman');
  });

  it('folds lookalikes as names are kept unique, so a half-typed `rn` still finds the name', async () => {
    const me = await createGuest(api, { nickname: 'Seeker' });
    await createGuest(api, { nickname: 'Marnie' });
    await createGuest(api, { nickname: 'B0lt' });
    expect(await names(me, 'Mar')).toContain('Marnie');
    expect(await names(me, 'Marn')).toEqual(['Marnie']);
    expect(await names(me, 'bol')).toEqual(['B0lt']);
  });

  it('under 2 letters is no search (and costs nothing); over 32 is refused', async () => {
    const me = await createGuest(api, { nickname: 'Shorty' });
    await freshLimits(me);
    expect(await found(me, 'a')).toEqual([]);
    expect(await found(me, ' - ')).toEqual([]);
    expect(await api.kv.get(`rl:${LIMITS.friendSearch.name}:${me.user.id}`)).toBeNull();
    expect((await search(me, 'x'.repeat(33))).status).toBe(400);
  });

  it('leaves out players who never chose a name, and blocked players either way', async () => {
    const me = await createGuest(api, { nickname: 'Hunter' });
    const blockedByMe = await createGuest(api, { nickname: 'Hush_One' });
    const blocksMe = await createGuest(api, { nickname: 'Hush_Two' });
    await createGuest(api, { nickname: 'Hush_Three' });
    const unnamed = await createGuest(api);
    expect((await post(me, '/friends/blocks', { id: blockedByMe.user.id })).status).toBe(204);
    expect((await post(blocksMe, '/friends/blocks', { id: me.user.id })).status).toBe(204);
    expect(await names(me, 'hush')).toEqual(['Hush_Three']);
    // a generated guest name isn't searchable (nobody knows it to type it)
    expect(await names(me, unnamed.user.nickname.slice(0, 4))).not.toContain(unnamed.user.nickname);
  });

  it('says where you stand with each: none, sent, incoming, friends', async () => {
    const me = await createGuest(api, { nickname: 'Rally' });
    const [none, sent, incoming, friend] = await Promise.all(['Rook_A', 'Rook_B', 'Rook_C', 'Rook_D'].map((nickname) => createGuest(api, { nickname })));
    expect((await post(me, '/friends/requests', { name: 'Rook_B' })).status).toBe(200);
    expect((await post(incoming!, '/friends/requests', { name: 'Rally' })).status).toBe(200);
    await befriend(api.app, me, friend!);
    const rel = Object.fromEntries((await found(me, 'rook')).map((p) => [p.id, p.relation]));
    expect(rel).toEqual({ [none!.user.id]: 'none', [sent!.user.id]: 'sent', [incoming!.user.id]: 'incoming', [friend!.user.id]: 'friends' });
  });

  it('is rate limited per player: comfortable for typing, not for sweeping', async () => {
    const me = await createGuest(api, { nickname: 'Typist' });
    await freshLimits(me);
    const ip = api.ip();
    let last = 0;
    for (let i = 0; i < LIMITS.friendSearch.limit; i++) last = (await search(me, `ty${i}`, ip)).status;
    expect(last).toBe(200);
    const over = await search(me, 'tyz', ip);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    // a minute on, typing works again, and the hour's budget still counts
    api.clock.advance(61_000);
    expect((await search(me, 'tya', ip)).status).toBe(200);
    expect(Number(await api.kv.get(`rl:${LIMITS.friendSearchHour.name}:${me.user.id}`))).toBe(LIMITS.friendSearch.limit + 1);
    expect(LIMITS.friendSearchHour.limit).toBeLessThan(LIMITS.friendSearch.limit * 60);
    expect(LIMITS.friendSearchIp.limit).toBeGreaterThan(LIMITS.friendSearchHour.limit);
  });

  it('needs a session', async () => {
    expect((await api.app.request('/friends/search?q=abc')).status).toBe(401);
    expect((await api.app.request('/friends/recent')).status).toBe(401);
  });
});

describe('"Let players find me by name"', () => {
  it('is on by default; off hides you from search, while your exact name and code still work', async () => {
    const me = await createGuest(api, { nickname: 'Quiet_Kay' });
    const other = await createGuest(api, { nickname: 'Asker' });
    expect((await list(me)).findable).toBe(true);
    expect(await names(other, 'quiet')).toEqual(['Quiet_Kay']);
    const off = await put(me, '/friends/settings', { findable: false });
    expect(await off.json()).toEqual({ findable: false });
    expect((await list(me)).findable).toBe(false);
    expect(await names(other, 'quiet')).toEqual([]);
    expect(await (await post(other, '/friends/requests', { name: 'Quiet_Kay' })).json()).toMatchObject({ status: 'requested' });
    expect((await put(me, '/friends/settings', { findable: true })).status).toBe(200);
    expect(await names(other, 'quiet')).toEqual(['Quiet_Kay']);
    expect((await put(me, '/friends/settings', { findable: 'yes' })).status).toBe(400);
  });
});

/** A raw query's rows: PGlite answers `{ rows }`, postgres.js the array itself. */
const rowsOf = (res: unknown) => (Array.isArray(res) ? res : (res as { rows: unknown[] }).rows) as Record<string, string>[];

describe('the prefix index', () => {
  it('serves `like prefix%` on the skeleton (text_pattern_ops), whatever the collation', async () => {
    const db = api.database.db;
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`set local enable_seqscan = off`);
      const rows = rowsOf(await tx.execute(sql.raw(`explain select user_id from profiles where nickname_norm like 'volk%'`)));
      return rows.map((r) => Object.values(r)[0]).join('\n');
    });
    // a C-collation database may serve it from the unique index as well: either way, no sequential scan
    expect(plan).toMatch(/Index/);
    expect(plan).not.toMatch(/Seq Scan/);
    const [idx] = rowsOf(await db.execute(sql`select indexdef from pg_indexes where indexname = 'profiles_nickname_norm_prefix_idx'`));
    expect(idx?.indexdef).toContain('text_pattern_ops');
  });
});

describe('played with recently', () => {
  let n = 0;
  const match = async (players: SessionBody[], endedAt: number) => {
    const id = `m-${++n}-${randomUUID()}`;
    const db = api.database.db;
    await db.insert(matches).values({ id, mode: 'deathmatch', map: 'street-market', room: 'AAAAAA', startedAt: new Date(endedAt - 300_000), endedAt: new Date(endedAt), durationS: 300, serverBuild: 't', result: {}, recordedAt: new Date(endedAt) });
    await db.insert(matchPlayers).values(players.map((p, i) => ({ matchId: id, userId: p.user.id, placement: i + 1, score: 0, kills: 0, deaths: 0, assists: 0, damage: 0, damageTaken: 0, headshots: 0, bestStreak: 0, left: false, mvp: false, xpGained: 0 })));
  };

  it('lists the people from your last matches, newest first: not you, not friends, not blocked either way', async () => {
    const [me, a, b, c, friend, blocked, blocker, stranger] = await Promise.all(['Rec_Me', 'Rec_A', 'Rec_B', 'Rec_C', 'Rec_Friend', 'Rec_Blocked', 'Rec_Blocker', 'Rec_Stranger'].map((nickname) => createGuest(api, { nickname })));
    const t = api.clock.now();
    await match([me!, a!, b!], t - 3 * 3600_000);
    await match([me!, c!, friend!, blocked!, blocker!], t - 3600_000);
    await match([me!, a!], t - 60_000);
    await match([stranger!, b!], t - 30_000); // not mine
    await befriend(api.app, me!, friend!);
    await post(me!, '/friends/blocks', { id: blocked!.user.id });
    await post(blocker!, '/friends/blocks', { id: me!.user.id });
    await post(me!, '/friends/requests', { name: 'Rec_C' });
    const people = await recent(me!);
    expect(people.map((p) => p.nickname)).toEqual(['Rec_A', 'Rec_C', 'Rec_B']);
    expect(people[0]!.at).toBe(new Date(t - 60_000).toISOString());
    expect(people[1]!.relation).toBe('sent');
    expect(await recent(stranger!)).toMatchObject([{ nickname: 'Rec_B' }]);
  });

  it('forgets matches over 30 days old, and shows at most 10', async () => {
    const me = await createGuest(api, { nickname: 'Old_Timer' });
    const old = await createGuest(api, { nickname: 'Old_Pal' });
    await match([me, old], api.clock.now() - 31 * 86_400_000);
    expect(await recent(me)).toEqual([]);
    const crowd = await Promise.all(Array.from({ length: 12 }, (_, i) => createGuest(api, { nickname: `Crowd_${'abcdefghjkmp'[i]}` })));
    await match([me, ...crowd], api.clock.now() - 1000);
    expect(await recent(me)).toHaveLength(10);
  });
});

describe('avatars', () => {
  it("search, the list and Played with recently carry the player's look, held to what they own", async () => {
    const me = await createGuest(api, { nickname: 'Looker' });
    const styled = await createGuest(api, { nickname: 'Styled_One' });
    await createGuest(api, { nickname: 'Styled_Two' });
    // a store item they don't own falls back to the slot's default, as in the join ticket
    const storeTop = cosmetics.find((c) => c.slot === 'top' && c.source.kind === 'store');
    const look = { items: { ...DEFAULT_COSMETIC_LOADOUT.items, skinTone: 'skin_02', ...(storeTop ? { top: storeTop.id } : {}) }, dyes: DEFAULT_COSMETIC_LOADOUT.dyes };
    await api.database.db.insert(loadouts).values({ userId: styled.user.id, slot: 0, data: { look, guns: ['hammer', 'buzz'] }, updatedAt: new Date(api.clock.now()) });
    const want = cosmeticLoadoutWireIds({ items: { ...look.items, top: DEFAULT_COSMETIC_LOADOUT.items.top }, dyes: look.dyes });
    const hits = await found(me, 'styled');
    expect(hits.find((p) => p.nickname === 'Styled_One')!.look).toEqual(want);
    expect(hits.find((p) => p.nickname === 'Styled_Two')!.look).toBeNull();
    await befriend(api.app, me, styled);
    expect((await list(me)).friends[0]!.look).toEqual(want);
  });
});

describe('presence in a room (audit C-27)', () => {
  const beat = (s: SessionBody, room: string | null, playing?: boolean) => put(s, '/me/presence', { room, ...(playing !== undefined ? { playing } : {}) });

  it("tells a match from the lobby, so a host waiting for friends isn't shown in a match", async () => {
    const host = await createGuest(api, { nickname: 'Lobby_Host' });
    const pal = await createGuest(api, { nickname: 'Lobby_Pal' });
    await befriend(api.app, host, pal);
    await api.kv.set('room:KMTXRA', JSON.stringify({ host: host.user.id, createdAt: new Date(api.clock.now()).toISOString() }), { ttlMs: 3600_000 });
    expect((await beat(host, 'KMTXRA', false)).status).toBe(200);
    expect((await list(pal)).friends[0]).toMatchObject({ status: 'in_room', room: 'KMTXRA', playing: false });
    await beat(host, 'KMTXRA', true);
    expect((await list(pal)).friends[0]).toMatchObject({ status: 'in_room', playing: true });
    // a page from before says nothing: the room shows without either
    await beat(host, 'KMTXRA');
    expect((await list(pal)).friends[0]).not.toHaveProperty('playing');
    // out of a room, `playing` means nothing
    await beat(host, null, true);
    expect((await list(pal)).friends[0]).toMatchObject({ status: 'online' });
    expect((await list(pal)).friends[0]).not.toHaveProperty('playing');
  });
});
