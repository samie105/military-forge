/**
 * /rooms: custom rooms by code (docs/07 §5.1, §11). The API mints the code and remembers it in the
 * KV (`room:{code}`, sliding TTL), so a mistyped code is caught before anyone connects; the game
 * server opens the room when its first player arrives (apps/game-server rooms.ts).
 *
 * Each create or join also returns a join ticket (docs/06 §6): an Ed25519 JWT with its own key and
 * audience, good for ~30 s and one HELLO, naming the player (`sub`), the name they play under
 * (`nick`: their nickname, which passed the nickname rules) and the room. The game server checks it
 * with the public key alone (apps/game-server tickets.ts). Without a ticket key (dev) it's null.
 */
import { randomBytes } from 'node:crypto';
import { allowedLook, cosmeticLoadoutWireIds, cosmeticUnlocked, loadoutGunIndices, sanitizeCosmeticLoadout } from '@military-forge/content';
import { normalizeRoomCode, roomCodeFromBytes } from '@military-forge/shared';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import type { SigningKey } from '../auth/keys';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import { signJwt, type StandardClaims } from '../auth/tokens';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { loadouts } from '../db/schema';
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
}

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
 * choose now, and the look held to content and to what a player at `level` owns.
 */
async function savedLoadout(db: Db, userId: string, level: number): Promise<{ guns: [string, string] | null; look: number[] | null }> {
  const [row] = await db
    .select({ data: loadouts.data })
    .from(loadouts)
    .where(and(eq(loadouts.userId, userId), eq(loadouts.slot, 0)));
  const guns = row?.data.guns;
  const look = row?.data.look;
  // content can change after a save (a gun renamed or made melee, an item moved to the store): check again, never trust the row
  return {
    guns: guns && loadoutGunIndices(guns) ? [guns[0], guns[1]] : null,
    look: look ? cosmeticLoadoutWireIds(allowedLook(sanitizeCosmeticLoadout(look), (def) => cosmeticUnlocked(def, level))) : null,
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
  app.use(requireAuth(auth));

  async function ticketFor(userId: string, code: string): Promise<string | null> {
    if (!ticketKey) return null;
    const me = await profiles.me(userId);
    if (!me) throw new ApiError(401, 'no_session', 'Sign in again');
    const iat = Math.floor(now() / 1000);
    const { guns, look } = db ? await savedLoadout(db, userId, me.level) : { guns: null, look: null };
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

  app.post('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.roomCreate, userId);
    await enforceRateLimit(kv, LIMITS.roomCreateIp, clientRateLimitKey(c, config));
    const record: RoomRecord = { host: userId, createdAt: new Date(now()).toISOString() };
    for (let i = 0; i < MINT_ATTEMPTS; i++) {
      const code = roomCodeFromBytes(randomBytes(16));
      if (await kv.set(`room:${code}`, JSON.stringify(record), { ttlMs: ROOM_TTL_MS, onlyIfAbsent: true })) {
        c.get('log').info({ userId, code }, 'room created');
        return c.json(await join(code, userId), 201);
      }
    }
    throw new ApiError(503, 'no_room_code', 'Could not find a free room code, try again');
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
