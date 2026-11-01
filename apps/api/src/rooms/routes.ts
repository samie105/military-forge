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
 * Play now (audit 2 P-07): POST /rooms/quick first joins an open Play now room (made by Play now in
 * the last QUICK_OPEN_MS, with people still in it and a seat for a person), else makes one as POST /
 * does. Rooms made by Create room are never offered, nor one with a player you blocked or who blocked
 * you (audit-2 L-02). The game server swaps a bot out for each person who joins, so nothing on the
 * wire changes.
 */
import { randomBytes } from 'node:crypto';
import { allowedLook, cosmeticLoadoutWireIds, cosmeticUnlocked, loadoutGunIndices, sanitizeCosmeticLoadout } from '@military-forge/content';
import { normalizeRoomCode, roomCodeFromBytes } from '@military-forge/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { SigningKey } from '../auth/keys';
import { adultsOnly, requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import { signJwt, type StandardClaims } from '../auth/tokens';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { blocks, loadouts } from '../db/schema';
import { clientRateLimitKey } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import type { ProfileService } from '../me/profiles';
import type { PartyService } from '../invites/party';
import type { PresenceService } from '../presence/presence';

/** A code stays joinable this long after its last join (docs/07 §5.4: rooms live ≤ 2 h idle-free; playtests run long). */
export const ROOM_TTL_MS = 6 * 3600_000;
const MINT_ATTEMPTS = 8;

interface RoomRecord {
  host: string;
  createdAt: string;
  /** made by Play now: open to other Play now players while it's young (audit 2 P-07) */
  quick?: true;
  /** Play now: the players given a ticket to it */
  players?: string[];
}

/** A Play now room takes other Play now players this long after it was made (its countdown and ~2 minutes of play). */
export const QUICK_OPEN_MS = 150_000;
/** at most this many people in a Play now room (the bots make up the rest: 3 bots fill to 4) */
export const QUICK_PEOPLE = 4;
/** the open Play now rooms, newest first (a sorted set: score = when made) */
export const QUICK_OPEN_KEY = 'rooms:quick';

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

export function roomRoutes(deps: {
  config: Config;
  db?: Db;
  kv: Kv;
  auth: AuthService;
  profiles: ProfileService;
  presence?: PresenceService;
  party?: PartyService;
  ticketKey: SigningKey | null;
  now: () => number;
}): Hono<AppEnv> {
  const { config, db, kv, auth, profiles, presence, party, ticketKey, now } = deps;
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

  /** A new room with this host (rate limited per player and per IP); its code. */
  async function mint(c: Context<AppEnv>, userId: string, quick: boolean): Promise<string> {
    await enforceRateLimit(kv, LIMITS.roomCreate, userId);
    await enforceRateLimit(kv, LIMITS.roomCreateIp, clientRateLimitKey(c, config));
    const record: RoomRecord = { host: userId, createdAt: new Date(now()).toISOString(), ...(quick ? { quick: true, players: [userId] } : {}) };
    for (let i = 0; i < MINT_ATTEMPTS; i++) {
      const code = roomCodeFromBytes(randomBytes(16));
      if (await kv.set(`room:${code}`, JSON.stringify(record), { ttlMs: ROOM_TTL_MS, onlyIfAbsent: true })) {
        c.get('log').info({ userId, code, quick }, 'room created');
        if (quick) await kv.zadd(QUICK_OPEN_KEY, [{ member: code, score: now() }]);
        return code;
      }
    }
    throw new ApiError(503, 'no_room_code', 'Could not find a free room code, try again');
  }

  app.post('/', async (c) => {
    const { userId } = c.get('auth')!;
    return c.json(await join(await mint(c, userId, false), userId), 201);
  });

  /**
   * People in a Play now room now: those given a ticket whose presence still says this room (the page
   * beats every 30 s, a closed one is gone within a minute). Without presence: everyone given one.
   */
  async function peopleIn(code: string, players: readonly string[]): Promise<number> {
    if (!presence) return players.length;
    return (await presence.getMany(players)).filter((p) => p.room === code).length;
  }

  /** Whether `userId` blocked any of `others`, or any of them blocked `userId`. */
  async function blockedWith(userId: string, others: readonly string[]): Promise<boolean> {
    if (!db || !others.length) return false;
    const [row] = await db
      .select({ userId: blocks.userId })
      .from(blocks)
      .where(or(and(eq(blocks.userId, userId), inArray(blocks.blockedId, [...others])), and(eq(blocks.blockedId, userId), inArray(blocks.userId, [...others]))))
      .limit(1);
    return !!row;
  }

  /** The youngest open Play now room with a seat for a person, not `userId`'s own; old ones leave the list. */
  async function openQuickRoom(userId: string): Promise<{ code: string; record: RoomRecord } | null> {
    const listed = await kv.ztop(QUICK_OPEN_KEY, 20);
    const stale: string[] = [];
    let found: { code: string; record: RoomRecord } | null = null;
    for (const { member: code, score } of listed) {
      if (now() - score > QUICK_OPEN_MS) {
        stale.push(code);
        continue;
      }
      if (found) continue;
      const raw = await kv.get(`room:${code}`);
      const record = raw ? (JSON.parse(raw) as RoomRecord) : null;
      if (!record?.quick) {
        stale.push(code);
        continue;
      }
      const players = record.players ?? [record.host];
      if (players.includes(userId)) continue; // your own (or one you left): a fresh room instead
      if (await blockedWith(userId, players)) continue; // a block either way keeps you apart (audit-2 L-02)
      const people = await peopleIn(code, players);
      if (people > 0 && people < QUICK_PEOPLE) found = { code, record };
    }
    if (stale.length) await kv.zrem(QUICK_OPEN_KEY, stale);
    return found;
  }

  /** Play now: an open Play now room with other people in it, else a new one (201). `joined` says which. */
  app.post('/quick', async (c) => {
    const { userId } = c.get('auth')!;
    const open = await openQuickRoom(userId);
    if (open) {
      const record: RoomRecord = { ...open.record, players: [...(open.record.players ?? [open.record.host]), userId] };
      await kv.set(`room:${open.code}`, JSON.stringify(record), { ttlMs: ROOM_TTL_MS });
      c.get('log').info({ userId, code: open.code }, 'play now: joined an open room');
      return c.json({ ...(await join(open.code, userId)), joined: true });
    }
    return c.json({ ...(await join(await mint(c, userId, true), userId)), joined: false }, 201);
  });

  /** Brute force gets nowhere: 5 misses a minute per IP (docs/07 §5.1), then 429 for the rest of it. */
  async function miss(c: Context<AppEnv>, message: string, status: 400 | 404, code: string): Promise<never> {
    await enforceRateLimit(kv, LIMITS.roomJoinMiss, clientRateLimitKey(c, config));
    throw new ApiError(status, code, message);
  }

  app.post('/:code/join', async (c) => {
    const ipKey = clientRateLimitKey(c, config);
    const misses = Number((await kv.get(`rl:${LIMITS.roomJoinMiss.name}:${ipKey}`)) ?? 0);
    if (misses >= LIMITS.roomJoinMiss.limit) {
      const retryAfter = Math.ceil(LIMITS.roomJoinMiss.windowMs / 1000);
      throw new ApiError(429, 'rate_limited', 'Too many wrong room codes, try again later', { retryAfter }, { 'Retry-After': String(retryAfter) });
    }
    const code = normalizeRoomCode(c.req.param('code'));
    if (!code) return miss(c, 'Room codes are 6 letters', 400, 'invalid_room_code');
    const record = await kv.get(`room:${code}`);
    if (!record) return miss(c, `No room ${code}: check the code, or ask for a new link`, 404, 'room_not_found');
    await kv.set(`room:${code}`, record, { ttlMs: ROOM_TTL_MS }); // sliding: a room in use stays joinable
    return c.json(await join(code, c.get('auth')!.userId));
  });

  return app;
}
