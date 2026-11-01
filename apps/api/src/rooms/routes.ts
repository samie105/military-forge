/**
 * /rooms: custom rooms by code (docs/07 §5.1, §11). The API mints the code and remembers it in the
 * KV (`room:{code}`, sliding TTL), so a mistyped code is caught before anyone connects; the game
 * server opens the room when its first player arrives (apps/game-server rooms.ts).
 *
 * Each create or join also returns a join ticket (docs/06 §6): an Ed25519 JWT with its own key and
 * audience, good for ~30 s and one HELLO, naming the player (`sub`), the name they play under
 * (`nick`: their nickname, which passed the nickname rules) and the room. The game server checks it
 * with the public key alone (apps/game-server tickets.ts). Without a ticket key (dev) it's null.
 *
 * Play now (audit 2 P-07): POST /rooms/quick takes the Rooms list's top row it may join (listing.ts:
 * one ranking for both), else makes a new Play now room, which is listed as Open. A private room is
 * never offered, nor one with a player you blocked or who blocked you (audit-2 L-02). The game server
 * swaps a bot out for each person who joins, so nothing on the wire changes.
 *
 * The Rooms list (1 Nov 2026, the owner: "a session where people can enter like the room and all post
 * it, or find anyone online"):
 *   GET   /rooms                    → { rooms: RoomRow[] }: the rooms you may see, ranked (listing.ts)
 *   GET   /rooms/:code/settings     → { visibility, tag, lang, host, nextPostAt }
 *   PATCH /rooms/:code { visibility?, tag?, lang? }: the host only
 *   POST  /rooms/:code/post         → Post to Lobby (the host; one per room every 5 min; a private room becomes public)
 *   POST  /rooms/:code/join { from: 'list' }: joining from the list checks again that you may see the
 *         room, that no block stands either way and that a seat is free; else 409 `room_taken` (the
 *         page then plays Play now: "Taken. Joining the next best room"). A block is never named.
 * A room's state (phase, people, bots, seats) comes from the game server's heartbeat (state.ts).
 */
import { randomBytes } from 'node:crypto';
import { allowedLook, cosmeticLoadoutWireIds, cosmeticUnlocked, loadoutGunIndices, sanitizeCosmeticLoadout } from '@military-forge/content';
import { ROOM_LANGS, ROOM_POST_COOLDOWN_MS, ROOM_TAGS, ROOM_VISIBILITIES, normalizeRoomCode, roomCodeFromBytes, type RoomRow } from '@military-forge/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { SigningKey } from '../auth/keys';
import { adultsOnly, requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import { signJwt, type StandardClaims } from '../auth/tokens';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { blocks, friendships, loadouts, profiles as profileRows } from '../db/schema';
import { clientRateLimitKey } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import type { LobbyFeed } from '../lobby/feed';
import type { ProfileService } from '../me/profiles';
import type { PartyService } from '../invites/party';
import type { PresenceService } from '../presence/presence';
import { QUICK_OPEN_MS, ROOM_PLAYERS_KEPT, listed, playNowPick, rankRooms, rowOf, visibilityOf, visibleTo, type Candidate, type RankedRow, type RoomRecord, type Viewer } from './listing';
import { readRoomStates } from './state';

export { QUICK_MIN_LEFT_S, QUICK_OPEN_MS, QUICK_PEOPLE, type RoomRecord } from './listing';

/** A code stays joinable this long after its last join (docs/07 §5.4: rooms live ≤ 2 h idle-free; playtests run long). */
export const ROOM_TTL_MS = 6 * 3600_000;
const MINT_ATTEMPTS = 8;

/** the rooms in the Rooms list (Play now's, and those whose host made them Friends or Public): a sorted set, score = when made */
export const LISTED_KEY = 'rooms:listed';
/** most listed rooms one list looks at */
const LIST_SCAN = 200;
/** most rows one list returns */
export const LIST_MAX = 60;

/**
 * Holds room codes open (config.keepRooms, at start-up): a code already known stays as it is; a new
 * one is recorded as if just made, with the usual sliding TTL. pnpm playtest restarts its API with
 * the rooms in play, so their links keep working after the in-memory KV starts over.
 */
export async function keepRooms(kv: Kv, codes: readonly string[], now: () => number = Date.now): Promise<number> {
  let added = 0;
  for (const raw of codes) {
    const code = normalizeRoomCode(raw);
    if (!code) continue;
    const record: RoomRecord = { host: 'kept', createdAt: new Date(now()).toISOString() };
    if (await kv.set(`room:${code}`, JSON.stringify(record), { ttlMs: ROOM_TTL_MS, onlyIfAbsent: true })) added++;
  }
  return added;
}

/** What a client needs to connect: the code, where the game server is, and its join ticket. */
export interface RoomJoin {
  code: string;
  roomId: string;
  /** WebSocket URL of the room; null = this site's own `/ws/<code>` (one origin behind a proxy) */
  gsUrl: string | null;
  /** present it in HELLO (one use, ~30 s); null = this API mints none (dev: the game server's rooms are open) */
  ticket: string | null;
}

export const TICKET_ISSUER = 'api';
/** not the access tokens' audience: neither kind of token passes for the other */
export const TICKET_AUDIENCE = 'game-server';

export interface JoinTicketClaims extends StandardClaims {
  /** the name to play under: the player's nickname (nickname rules and reserved names already applied) */
  nick: string;
  /** the room code */
  room: string;
  /** single use: the game server remembers it until it expires */
  jti: string;
  /** the two guns the player spawns with (their saved loadout, weapon ids); absent = the default pair */
  guns?: [string, string];
  /** the player's party (invites/party.ts): party voice reaches party mates anywhere in the room; absent = none */
  party?: string;
  /**
   * protocol v19: the player's saved look (slot 0) as cosmetic wire ids, held to content and to what
   * they own when minted; the room draws them in it until their client sends its own. Absent: none saved.
   */
  look?: number[];
  /** the player's level: the room lets them wear what they've unlocked (content `cosmeticUnlocked`) */
  lvl?: number;
}

/**
 * The player's saved loadout (slot 0) as a ticket carries it: the guns when they're a pair a player may
 * choose now, and the look held to content and to what a player at `level` with the owner's `grants` owns.
 * The game server admits the ticket's look as vouched, so a granted skin reaches everyone in the room.
 */
async function savedLoadout(db: Db, userId: string, level: number, grants: readonly string[]): Promise<{ guns: [string, string] | null; look: number[] | null }> {
  const [row] = await db
    .select({ data: loadouts.data })
    .from(loadouts)
    .where(and(eq(loadouts.userId, userId), eq(loadouts.slot, 0)));
  const guns = row?.data.guns;
  const look = row?.data.look;
  // content can change after a save (a gun renamed or made melee, an item moved to the store): check again, never trust the row
  return {
    guns: guns && loadoutGunIndices(guns) ? [guns[0], guns[1]] : null,
    look: look ? cosmeticLoadoutWireIds(allowedLook(sanitizeCosmeticLoadout(look), (def) => cosmeticUnlocked(def, level, grants))) : null,
  };
}

/** A room's listing settings, as its lobby shows them. */
export interface RoomSettings {
  visibility: RoomRow['visibility'];
  tag: RoomRow['tag'];
  lang: RoomRow['lang'];
  /** you are its host (you may change these and post it) */
  host: boolean;
  /** a Play now room: listed as Open, its listing isn't the host's to change */
  quick: boolean;
  /** when Post to Lobby may be used again (ISO); null: now */
  nextPostAt: string | null;
}

const RoomChange = z
  .strictObject({
    visibility: z.enum(ROOM_VISIBILITIES).optional(),
    tag: z.enum(ROOM_TAGS).nullable().optional(),
    lang: z.enum(ROOM_LANGS).nullable().optional(),
  })
  .refine((b) => b.visibility !== undefined || b.tag !== undefined || b.lang !== undefined, 'Nothing to change');

const JoinBody = z.strictObject({ from: z.enum(['code', 'list']).optional() });

const postedKey = (code: string) => `roompost:${code}`;

export function roomRoutes(deps: {
  config: Config;
  db?: Db;
  kv: Kv;
  auth: AuthService;
  profiles: ProfileService;
  presence?: PresenceService;
  party?: PartyService;
  /** the Lobby feed (Post to Lobby); absent: posting is off */
  feed?: LobbyFeed;
  ticketKey: SigningKey | null;
  now: () => number;
}): Hono<AppEnv> {
  const { config, db, kv, auth, profiles, presence, party, feed, ticketKey, now } = deps;
  const app = new Hono<AppEnv>();

  /** The room's host's nickname from its record (null: unreadable, or the host is gone). */
  async function hostName(raw: string): Promise<string | null> {
    try {
      return (await profiles.me((JSON.parse(raw) as RoomRecord).host))?.nickname ?? null;
    } catch {
      return null;
    }
  }

  /**
   * A room by its code, for the invite link's name screen (mobile audit P1-3): whose room it is. No
   * session needed (a new player has none yet); only the host's nickname, which everyone in the room
   * sees anyway. A miss counts toward the same per-IP limit as a wrong code on join.
   */
  app.get('/:code', async (c) => {
    const code = normalizeRoomCode(c.req.param('code'));
    if (!code) return miss(c, 'Room codes are 6 letters', 400, 'invalid_room_code');
    const raw = await kv.get(`room:${code}`);
    if (!raw) return miss(c, `No room ${code}: check the code, or ask for a new link`, 404, 'room_not_found');
    return c.json({ code, host: await hostName(raw) });
  });

  app.use(requireAuth(auth));
  // online rooms are 18+ (audit-2 L-03): an account whose device said under 18 trains only
  if (db) app.use(adultsOnly(db));

  async function ticketFor(userId: string, code: string): Promise<string | null> {
    if (!ticketKey) return null;
    const me = await profiles.me(userId);
    if (!me) throw new ApiError(401, 'no_session', 'Sign in again');
    const iat = Math.floor(now() / 1000);
    const { guns, look } = db ? await savedLoadout(db, userId, me.level, await profiles.ownedOf(userId)) : { guns: null, look: null };
    const partyId = party ? await party.partyOf(userId) : null;
    const claims: JoinTicketClaims = {
      iss: TICKET_ISSUER,
      aud: TICKET_AUDIENCE,
      sub: userId,
      iat,
      exp: iat + config.joinTicket.ttlSeconds,
      nick: me.nickname,
      room: code,
      jti: randomBytes(16).toString('base64url'),
      ...(guns ? { guns } : {}),
      ...(partyId ? { party: partyId } : {}),
      ...(look ? { look } : {}),
      lvl: me.level,
    };
    return signJwt(claims, ticketKey.privateKey);
  }

  const join = async (code: string, userId: string): Promise<RoomJoin> => {
    await presence?.beat(userId, code); // in a room now (presence.ts)
    return {
      code,
      roomId: code,
      gsUrl: config.gameServerUrl ? `${config.gameServerUrl}/ws/${code}` : null,
      ticket: await ticketFor(userId, code),
    };
  };

  function parseRecord(raw: string | null): RoomRecord | null {
    if (!raw) return null;
    try {
      return JSON.parse(raw) as RoomRecord;
    } catch {
      return null;
    }
  }

  /** The record again with `userId` among its players (the list's "who's inside" before the game server says). */
  async function addPlayer(code: string, record: RoomRecord, userId: string): Promise<RoomRecord> {
    const players = [...(record.players ?? [record.host]).filter((p) => p !== userId), userId].slice(-ROOM_PLAYERS_KEPT);
    const next: RoomRecord = { ...record, players };
    await kv.set(`room:${code}`, JSON.stringify(next), { ttlMs: ROOM_TTL_MS });
    if (listed(next)) await kv.zadd(LISTED_KEY, [{ member: code, score: Date.parse(next.createdAt) || now() }]);
    return next;
  }

  /** A new room with this host (rate limited per player and per IP); its code. */
  async function mint(c: Context<AppEnv>, userId: string, quick: boolean): Promise<string> {
    await enforceRateLimit(kv, LIMITS.roomCreate, userId);
    await enforceRateLimit(kv, LIMITS.roomCreateIp, clientRateLimitKey(c, config));
    const at = now();
    const record: RoomRecord = { host: userId, createdAt: new Date(at).toISOString(), players: [userId], ...(quick ? { quick: true } : {}) };
    for (let i = 0; i < MINT_ATTEMPTS; i++) {
      const code = roomCodeFromBytes(randomBytes(16));
      if (await kv.set(`room:${code}`, JSON.stringify(record), { ttlMs: ROOM_TTL_MS, onlyIfAbsent: true })) {
        c.get('log').info({ userId, code, quick }, 'room created');
        // a Play now room is listed as Open at once; a Create room room is private until its host says
        if (quick) await kv.zadd(LISTED_KEY, [{ member: code, score: at }]);
        return code;
      }
    }
    throw new ApiError(503, 'no_room_code', 'Could not find a free room code, try again');
  }

  app.post('/', async (c) => {
    const { userId } = c.get('auth')!;
    return c.json(await join(await mint(c, userId, false), userId), 201);
  });

  /** Who is looking: their friends, party mates, and everyone blocked either way. */
  async function viewerOf(userId: string): Promise<Viewer> {
    if (!db) return { id: userId, friends: new Set(), party: new Set(), blocked: new Set() };
    const [friendRows, blockRows, partyIds] = await Promise.all([
      db.select({ id: friendships.friendId }).from(friendships).where(eq(friendships.userId, userId)),
      db
        .select({ a: blocks.userId, b: blocks.blockedId })
        .from(blocks)
        .where(or(eq(blocks.userId, userId), eq(blocks.blockedId, userId))),
      party ? party.memberIds(userId) : Promise.resolve([]),
    ]);
    return {
      id: userId,
      friends: new Set(friendRows.map((r) => r.id)),
      party: new Set(partyIds.filter((id) => id !== userId)),
      blocked: new Set(blockRows.map((r) => (r.a === userId ? r.b : r.a))),
    };
  }

  /** Nicknames by id, in one query (or one by one without a database). */
  async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    if (db) {
      const rows = await db.select({ id: profileRows.userId, nickname: profileRows.nickname }).from(profileRows).where(inArray(profileRows.userId, unique));
      return new Map(rows.map((r) => [r.id, r.nickname]));
    }
    const out = new Map<string, string>();
    for (const id of unique) {
      const me = await profiles.me(id);
      if (me) out.set(id, me.nickname);
    }
    return out;
  }

  /**
   * Every listed room with what's known of it now. A room whose record is gone leaves the list; so does
   * one the game server hasn't spoken of and nobody's presence says they're in, once it's no longer young.
   */
  async function candidates(): Promise<Candidate[]> {
    const listedNow = await kv.ztop(LISTED_KEY, LIST_SCAN);
    const codes = listedNow.map((e) => e.member);
    if (!codes.length) return [];
    const [raws, states] = await Promise.all([kv.mget(codes.map((code) => `room:${code}`)), readRoomStates(kv, codes)]);
    const stale: string[] = [];
    const pending: { code: string; record: RoomRecord; state: Candidate['state'] }[] = [];
    for (const [i, code] of codes.entries()) {
      const record = parseRecord(raws[i] ?? null);
      if (!record || !listed(record)) {
        stale.push(code);
        continue;
      }
      pending.push({ code, record, state: states[i] ?? null });
    }
    // before the game server says (a room just made, or a server without the heartbeat): the people whose presence says this room
    const unknown = pending.filter((p) => !p.state);
    const askIds = [...new Set(unknown.flatMap((p) => p.record.players ?? [p.record.host]))];
    const seen = presence && askIds.length ? await presence.getMany(askIds) : [];
    const roomOf = new Map(askIds.map((id, i) => [id, seen[i]?.room ?? null]));
    const out: Omit<Candidate, 'hostName'>[] = [];
    for (const p of pending) {
      let ids: string[];
      let people: number;
      if (p.state) {
        ids = p.state.ids;
        people = p.state.people;
      } else {
        const players = p.record.players ?? [p.record.host];
        ids = presence ? players.filter((id) => roomOf.get(id) === p.code) : players;
        people = ids.length;
        if (people === 0 && now() - Date.parse(p.record.createdAt) > QUICK_OPEN_MS) {
          stale.push(p.code);
          continue;
        }
      }
      out.push({ code: p.code, record: p.record, state: p.state, hostId: p.state?.hostId ?? p.record.host, ids, people });
    }
    if (stale.length) await kv.zrem(LISTED_KEY, stale);
    const names = await namesOf(out.map((c) => c.hostId));
    return out.map((c) => ({ ...c, hostName: names.get(c.hostId) ?? 'A player' }));
  }

  /** The rooms `viewer` may see, ranked, with their records (Play now picks from these). */
  async function rankedFor(viewer: Viewer): Promise<(RankedRow & { record: RoomRecord })[]> {
    const rows = (await candidates()).filter((c) => people(c) > 0 && visibleTo(c, viewer)).map((c) => ({ ...rowOf(c, viewer), record: c.record }));
    return rankRooms(rows);
  }
  const people = (c: Candidate) => (c.state ? c.state.people : c.people);

  /** The Rooms list: the rooms you may see, ranked; full ones too (the page hides them unless asked). */
  app.get('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.roomsRead, userId);
    const ranked = await rankedFor(await viewerOf(userId));
    const rooms: RoomRow[] = ranked.slice(0, LIST_MAX).map(({ hostId: _h, ids: _i, record: _r, ...row }) => row);
    return c.json({ rooms });
  });

  /** Play now: the list's top row you may join, else a new Play now room (201). `joined` says which. */
  app.post('/quick', async (c) => {
    const { userId } = c.get('auth')!;
    const pick = playNowPick(await rankedFor(await viewerOf(userId)), userId, now());
    if (pick) {
      await addPlayer(pick.code, pick.record, userId);
      c.get('log').info({ userId, code: pick.code }, 'play now: joined an open room');
      return c.json({ ...(await join(pick.code, userId)), joined: true });
    }
    return c.json({ ...(await join(await mint(c, userId, true), userId)), joined: false }, 201);
  });

  /** Brute force gets nowhere: 5 misses a minute per IP (docs/07 §5.1), then 429 for the rest of it. */
  async function miss(c: Context<AppEnv>, message: string, status: 400 | 404, code: string): Promise<never> {
    await enforceRateLimit(kv, LIMITS.roomJoinMiss, clientRateLimitKey(c, config));
    throw new ApiError(status, code, message);
  }

  /** The room's host now: the game server's when it has said (the host can change), else its maker. */
  async function hostOf(code: string, record: RoomRecord): Promise<string> {
    const [state] = await readRoomStates(kv, [code]);
    return state?.hostId ?? record.host;
  }

  /** A room by code (a miss counts toward the wrong-code limit, as on join: codes can't be swept here either). */
  async function roomByCode(c: Context<AppEnv>): Promise<{ code: string; record: RoomRecord }> {
    const code = normalizeRoomCode(c.req.param('code') ?? '');
    const record = code ? parseRecord(await kv.get(`room:${code}`)) : null;
    if (!code || !record) return miss(c, 'That room is gone', 404, 'room_not_found');
    return { code, record };
  }

  /** A room by code for its host's changes: 404 when it's gone, 403 when you aren't its host. */
  async function hostedRoom(c: Context<AppEnv>): Promise<{ code: string; record: RoomRecord }> {
    const { code, record } = await roomByCode(c);
    if ((await hostOf(code, record)) !== c.get('auth')!.userId) throw new ApiError(403, 'not_host', 'Only the host changes this');
    return { code, record };
  }

  async function settingsOf(code: string, record: RoomRecord, userId: string): Promise<RoomSettings> {
    const posted = Number((await kv.get(postedKey(code))) ?? 0);
    const next = posted + ROOM_POST_COOLDOWN_MS;
    return {
      visibility: visibilityOf(record),
      tag: record.tag ?? null,
      lang: record.lang ?? null,
      host: (await hostOf(code, record)) === userId,
      quick: record.quick === true,
      nextPostAt: posted && next > now() ? new Date(next).toISOString() : null,
    };
  }

  /** What the lobby shows of the room's listing (anyone in it may ask; only the host changes it). */
  app.get('/:code/settings', async (c) => {
    const { code, record } = await roomByCode(c);
    return c.json(await settingsOf(code, record, c.get('auth')!.userId));
  });

  /** The host's listing: who sees the room, its tag and its language. A Play now room stays Open. */
  app.patch('/:code', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.roomEdit, userId);
    const { code, record } = await hostedRoom(c);
    const change = await readJson(c, RoomChange);
    if (record.quick && change.visibility !== undefined && change.visibility !== 'public') throw new ApiError(409, 'quick_room', 'A Play now room is always open');
    const next: RoomRecord = { ...record };
    if (change.visibility !== undefined && !record.quick) next.visibility = change.visibility;
    if (change.tag !== undefined) {
      if (change.tag === null) delete next.tag;
      else next.tag = change.tag;
    }
    if (change.lang !== undefined) {
      if (change.lang === null) delete next.lang;
      else next.lang = change.lang;
    }
    await kv.set(`room:${code}`, JSON.stringify(next), { ttlMs: ROOM_TTL_MS });
    if (listed(next)) await kv.zadd(LISTED_KEY, [{ member: code, score: Date.parse(next.createdAt) || now() }]);
    else await kv.zrem(LISTED_KEY, [code]);
    c.get('log').info({ userId, code, visibility: visibilityOf(next) }, 'room listing changed');
    return c.json(await settingsOf(code, next, userId));
  });

  /**
   * Post to Lobby: the room as a card in the Lobby feed (lobby/feed.ts). The host only, once per room
   * every 5 minutes (429 with Retry-After). Posting is public: a Private room becomes Public.
   */
  app.post('/:code/post', async (c) => {
    if (!feed) throw new ApiError(404, 'not_found', 'Posting is off on this server');
    const { userId } = c.get('auth')!;
    const { code, record } = await hostedRoom(c);
    const at = now();
    const last = Number((await kv.get(postedKey(code))) ?? 0);
    if (last && at - last < ROOM_POST_COOLDOWN_MS) {
      const retryAfter = Math.max(1, Math.ceil((last + ROOM_POST_COOLDOWN_MS - at) / 1000));
      throw new ApiError(429, 'rate_limited', 'Posted already: once every 5 minutes', { retryAfter }, { 'Retry-After': String(retryAfter) });
    }
    if (!(await kv.set(postedKey(code), String(at), { ttlMs: ROOM_POST_COOLDOWN_MS, onlyIfAbsent: true }))) {
      throw new ApiError(429, 'rate_limited', 'Posted already: once every 5 minutes', { retryAfter: 1 }, { 'Retry-After': '1' });
    }
    const next: RoomRecord = record.quick || record.visibility === 'public' || record.visibility === 'friends' ? record : { ...record, visibility: 'public' };
    if (next !== record) await kv.set(`room:${code}`, JSON.stringify(next), { ttlMs: ROOM_TTL_MS });
    await kv.zadd(LISTED_KEY, [{ member: code, score: Date.parse(next.createdAt) || at }]);
    const [state] = await readRoomStates(kv, [code]);
    const name = (await namesOf([userId])).get(userId) ?? 'A player';
    const people = state?.people ?? 1;
    await feed.publish({
      kind: 'room_posted',
      code,
      hostName: name,
      hostId: userId,
      mode: state?.teams ?? null,
      map: state?.map ?? null,
      people,
      bots: state?.bots ?? null,
      seats: state?.seats ?? Math.max(0, 8 - people),
      tag: next.tag ?? null,
      lang: next.lang ?? null,
      at,
    });
    c.get('log').info({ userId, code }, 'room posted to the lobby');
    return c.json({ posted: true, ...(await settingsOf(code, next, userId)) }, 201);
  });

  app.post('/:code/join', async (c) => {
    const ipKey = clientRateLimitKey(c, config);
    const misses = Number((await kv.get(`rl:${LIMITS.roomJoinMiss.name}:${ipKey}`)) ?? 0);
    if (misses >= LIMITS.roomJoinMiss.limit) {
      const retryAfter = Math.ceil(LIMITS.roomJoinMiss.windowMs / 1000);
      throw new ApiError(429, 'rate_limited', 'Too many wrong room codes, try again later', { retryAfter }, { 'Retry-After': String(retryAfter) });
    }
    const code = normalizeRoomCode(c.req.param('code'));
    if (!code) return miss(c, 'Room codes are 6 letters', 400, 'invalid_room_code');
    const { from } = await readJson(c, JoinBody);
    const raw = await kv.get(`room:${code}`);
    const record = parseRecord(raw);
    if (!raw || !record) return miss(c, `No room ${code}: check the code, or ask for a new link`, 404, 'room_not_found');
    const { userId } = c.get('auth')!;
    // from the list: may you see it still, does a block stand either way, is a seat free? One answer for all three
    if (from === 'list') {
      const row = (await rankedFor(await viewerOf(userId))).find((r) => r.code === code);
      if (!row || (row.seats <= 0 && !row.ids.includes(userId))) throw new ApiError(409, 'room_taken', 'Taken. Joining the next best room');
    }
    await addPlayer(code, record, userId); // sliding: a room in use stays joinable
    return c.json(await join(code, userId));
  });

  return app;
}
