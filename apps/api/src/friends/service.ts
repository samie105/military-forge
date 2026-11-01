/**
 * Friends (the owner's 23 Oct ask): add by exact name or friend code, requests with accept and
 * decline, remove, block. Every account is a guest today (docs/07 §3), with a stable user id that
 * lasts as long as its session does, so friendships hang on user ids: a guest who clears their
 * browser starts a new account with no friends, and account linking (later) keeps them.
 *
 * Privacy: presence (online, in a match and which room) is shown to friends only. A block is never
 * revealed: requests from a player you blocked are kept out of your list (not refused), so the
 * sender sees what any unanswered request looks like.
 *
 * Finding players (31 Oct, "add a search friend feature, let's make it a bit social"): a prefix search
 * on names, and the people you played with recently. Search finds players who chose their name and
 * left "Let players find me by name" on; neither ever shows anyone blocked, either way.
 *
 * Safety (audit-2, 1 Nov): block anyone (by id or exact name), not only friends; a declined request
 * can't be sent again for 30 days (it looks sent, nothing is stored); at most 50 requests wait for one
 * player (the oldest go); a player chooses who may send them requests (anyone, people they played
 * with, or only with their friend code); an account whose device said under 18 is never found.
 */
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, like, max, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/client';
import { blocks, friendRequestDeclines, friendRequests, friendships, matchPlayers, matches, profiles, users, type RequestsFrom } from '../db/schema';
import { ApiError } from '../http/errors';
import { skeleton } from '../nickname/normalize';
import type { PresenceService, PresenceStatus } from '../presence/presence';
import { formatFriendCode, newFriendCode, normalizeFriendCode } from './code';
import { savedLooks, type LookIds } from './looks';

/** Most friends one account may have (both sides are checked when a request is accepted). */
export const MAX_FRIENDS = 200;
/** Most requests one player may have waiting for an answer. */
export const MAX_OUTGOING_REQUESTS = 50;
/** Most requests waiting for one player: a new one past this drops the oldest (audit-2 L-09). */
export const MAX_INCOMING_REQUESTS = 50;
/** A declined request can't be sent again for this long (audit-2 L-09). */
export const DECLINE_MEMORY_MS = 30 * 86_400_000;
/** "People I've played with" (requests_from 'played'): a match together this recently. */
export const PLAYED_WITH_DAYS = 30;
const CODE_ATTEMPTS = 6;

/** A name search needs this many letters (of the name's skeleton: case, separators and lookalikes folded). */
export const SEARCH_MIN_LETTERS = 2;
/** Most players one search shows, closest first. */
export const SEARCH_RESULTS = 8;
/** Prefix matches (in index order) the closest-first sort looks through: a 2-letter search stays cheap. */
const SEARCH_SCAN = 200;
/** Played with recently: your last matches looked at, how far back, and how many people shown. */
const RECENT_MATCHES = 20;
const RECENT_DAYS = 30;
export const RECENT_PLAYERS = 10;

export const USER_ID = /^u_[0-9a-hjkmnp-tv-z]{26}$/;

/** A friend as the friends list shows them. */
export interface FriendView {
  id: string;
  nickname: string;
  status: PresenceStatus;
  /** in_room: the room's code (friends see it: a code is an invitation) */
  room: string | null;
  /** online: the last presence beat; offline: the account's last sign-in (token refresh) */
  lastSeenAt: string | null;
  /** friends since */
  since: string;
  /** in_room: true in a match (countdown to the end), false in the lobby; absent when their page didn't say */
  playing?: boolean;
  /** their soldier (cosmetic wire ids) for the avatar; null: no saved look */
  look: LookIds;
}

/** Someone in a request or on the block list. */
export interface PersonView {
  id: string;
  nickname: string;
  /** when the request was made, or the block */
  at: string;
  /** requests: their soldier for the avatar (blocked players get none) */
  look?: LookIds;
}

/** Where you stand with a player a search or Played with recently shows. */
export type Relation = 'none' | 'sent' | 'incoming' | 'friends';

/** A player found by name, or met in a match. */
export interface FoundPlayer {
  id: string;
  nickname: string;
  level: number;
  look: LookIds;
  relation: Relation;
  /** Played with recently: when your last match together ended */
  at?: string;
}

export interface FriendsList {
  /** your friend code, as shown (`7KQ4-M9XP`) */
  code: string;
  friends: FriendView[];
  /** requests to you, newest first (none from players you blocked) */
  incoming: PersonView[];
  /** your requests waiting for an answer, newest first */
  outgoing: PersonView[];
  blocked: PersonView[];
  max: number;
  /** "Let players find me by name" (Settings → Privacy) */
  findable: boolean;
  /** who may send you friend requests (audit-2 L-09) */
  requestsFrom: RequestsFrom;
}

/** The friends panel's Privacy settings. */
export interface FriendSettings {
  findable: boolean;
  requestsFrom: RequestsFrom;
}

export type RequestResult = { status: 'requested'; user: PersonView } | { status: 'friends'; friend: FriendView };

/** Who a request is for: an exact name (the nickname's skeleton, so lookalikes find the one owner) or a friend code. */
export type FriendTarget = { name: string } | { code: string };

const STATUS_ORDER: Record<PresenceStatus, number> = { in_room: 0, online: 1, offline: 2 };

export class FriendsService {
  constructor(
    private readonly db: Db,
    private readonly presence: PresenceService,
    private readonly now: () => number,
    /** the push channel: these players' friends lists changed (app.ts wires it to the event bus) */
    private readonly touched: (userIds: readonly string[]) => void = () => {},
    /** the owner's COSMETIC_GRANTS (config): owned like bought items, for the avatars' looks */
    private readonly grants: ReadonlyMap<string, readonly string[]> = new Map(),
  ) {}

  private looks(players: readonly { id: string; level: number }[]): Promise<Map<string, LookIds>> {
    return savedLooks(this.db, this.grants, players);
  }

  /** The player's friend code (stored form), made on first use. */
  async codeOf(userId: string): Promise<string> {
    const [row] = await this.db.select({ code: profiles.friendCode }).from(profiles).where(eq(profiles.userId, userId));
    if (!row) throw new ApiError(404, 'not_found', 'No profile for this account');
    return row.code ?? this.assignCode(userId, false);
  }

  /** A new code (the old one stops working): for a code shared too widely. */
  rotateCode(userId: string): Promise<string> {
    return this.assignCode(userId, true);
  }

  private async assignCode(userId: string, replace: boolean): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const code = newFriendCode();
      try {
        const where = replace ? eq(profiles.userId, userId) : and(eq(profiles.userId, userId), isNull(profiles.friendCode));
        const [set] = await this.db.update(profiles).set({ friendCode: code }).where(where).returning({ code: profiles.friendCode });
        if (set?.code) return set.code;
        // another request gave this player a code first: use that one
        const [row] = await this.db.select({ code: profiles.friendCode }).from(profiles).where(eq(profiles.userId, userId));
        if (row?.code) return row.code;
        throw new ApiError(404, 'not_found', 'No profile for this account');
      } catch (err) {
        if (!isUniqueViolation(err) || attempt >= CODE_ATTEMPTS) throw err;
      }
    }
  }

  /** The active account a name or code belongs to, or null. */
  async find(target: FriendTarget): Promise<{ id: string; nickname: string } | null> {
    let where;
    if ('code' in target) {
      const code = normalizeFriendCode(target.code);
      if (!code) return null;
      where = eq(profiles.friendCode, code);
    } else {
      const norm = skeleton(target.name);
      if (!norm) return null;
      where = eq(profiles.nicknameNorm, norm);
    }
    const [row] = await this.db
      .select({ id: profiles.userId, nickname: profiles.nickname })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(and(where, eq(users.status, 'active'), eq(users.minor, false)));
    return row ?? null;
  }

  async areFriends(a: string, b: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: friendships.friendId })
      .from(friendships)
      .where(and(eq(friendships.userId, a), eq(friendships.friendId, b)));
    return !!row;
  }

  async friendIds(userId: string): Promise<string[]> {
    const rows = await this.db.select({ id: friendships.friendId }).from(friendships).where(eq(friendships.userId, userId));
    return rows.map((r) => r.id);
  }

  /** Whether `userId` has blocked `otherId`. */
  async hasBlocked(userId: string, otherId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: blocks.blockedId })
      .from(blocks)
      .where(and(eq(blocks.userId, userId), eq(blocks.blockedId, otherId)));
    return !!row;
  }

  async list(userId: string): Promise<FriendsList> {
    const [code, friendRows, incoming, outgoing, blocked, mine] = await Promise.all([
      this.codeOf(userId),
      this.db
        .select({ id: friendships.friendId, since: friendships.createdAt, nickname: profiles.nickname, level: profiles.level, lastSeenAt: users.lastSeenAt, hidden: profiles.appearOffline })
        .from(friendships)
        .innerJoin(profiles, eq(profiles.userId, friendships.friendId))
        .innerJoin(users, eq(users.id, friendships.friendId))
        .where(eq(friendships.userId, userId)),
      this.db
        .select({ id: friendRequests.fromId, at: friendRequests.createdAt, nickname: profiles.nickname, level: profiles.level })
        .from(friendRequests)
        .innerJoin(profiles, eq(profiles.userId, friendRequests.fromId))
        .where(eq(friendRequests.toId, userId))
        .orderBy(asc(friendRequests.createdAt)),
      this.db
        .select({ id: friendRequests.toId, at: friendRequests.createdAt, nickname: profiles.nickname, level: profiles.level })
        .from(friendRequests)
        .innerJoin(profiles, eq(profiles.userId, friendRequests.toId))
        .where(eq(friendRequests.fromId, userId))
        .orderBy(asc(friendRequests.createdAt)),
      this.db
        .select({ id: blocks.blockedId, at: blocks.createdAt, nickname: profiles.nickname })
        .from(blocks)
        .innerJoin(profiles, eq(profiles.userId, blocks.blockedId))
        .where(eq(blocks.userId, userId))
        .orderBy(asc(blocks.createdAt)),
      this.db.select({ findable: profiles.findable, requestsFrom: profiles.requestsFrom }).from(profiles).where(eq(profiles.userId, userId)),
    ]);
    const blockedIds = new Set(blocked.map((b) => b.id));
    const [presence, looks] = await Promise.all([
      // as friends see it: Appear offline shows offline (presence.ts)
      this.presence.getManyVisible(friendRows.map((f) => f.id)),
      this.looks([...friendRows, ...incoming.filter((r) => !blockedIds.has(r.id)), ...outgoing]),
    ]);
    const friends = friendRows.map((f, i): FriendView => {
      const p = presence[i]!;
      return {
        id: f.id,
        nickname: f.nickname,
        status: p.status,
        room: p.room,
        // Appear offline: no last-seen time either (it would say "just now")
        lastSeenAt: f.hidden ? null : (p.lastSeenAt ?? f.lastSeenAt.toISOString()),
        since: f.since.toISOString(),
        ...(p.playing !== undefined ? { playing: p.playing } : {}),
        look: looks.get(f.id) ?? null,
      };
    });
    friends.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.nickname.localeCompare(b.nickname));
    const person = (r: { id: string; at: Date; nickname: string }): PersonView => ({ id: r.id, nickname: r.nickname, at: r.at.toISOString(), look: looks.get(r.id) ?? null });
    return {
      code: formatFriendCode(code),
      friends,
      incoming: incoming
        .filter((r) => !blockedIds.has(r.id))
        .map(person)
        .reverse(),
      outgoing: outgoing.map(person).reverse(),
      blocked: blocked.map((r) => ({ id: r.id, nickname: r.nickname, at: r.at.toISOString() })),
      max: MAX_FRIENDS,
      findable: mine[0]?.findable ?? true,
      requestsFrom: mine[0]?.requestsFrom ?? 'anyone',
    };
  }

  /** One friend's view (after an accept), or null when they aren't a friend. */
  async friend(userId: string, friendId: string): Promise<FriendView | null> {
    const [row] = await this.db
      .select({ id: friendships.friendId, since: friendships.createdAt, nickname: profiles.nickname, level: profiles.level, lastSeenAt: users.lastSeenAt, hidden: profiles.appearOffline })
      .from(friendships)
      .innerJoin(profiles, eq(profiles.userId, friendships.friendId))
      .innerJoin(users, eq(users.id, friendships.friendId))
      .where(and(eq(friendships.userId, userId), eq(friendships.friendId, friendId)));
    if (!row) return null;
    const [p, looks] = await Promise.all([this.presence.visible(friendId), this.looks([row])]);
    return {
      id: row.id,
      nickname: row.nickname,
      status: p.status,
      room: p.room,
      lastSeenAt: row.hidden ? null : (p.lastSeenAt ?? row.lastSeenAt.toISOString()),
      since: row.since.toISOString(),
      ...(p.playing !== undefined ? { playing: p.playing } : {}),
      look: looks.get(row.id) ?? null,
    };
  }

  /**
   * Ask `target` to be friends. Asking someone who already asked you makes you friends at once;
   * asking a friend or asking twice changes nothing. Asking someone who blocked you, or who declined
   * you in the last 30 days, looks like any other request (it waits unseen, or nothing is stored).
   * Asking by name someone who takes requests only by friend code, or only from people they played
   * with, is refused with `requests_closed` (a setting, not a secret).
   */
  async request(userId: string, target: FriendTarget): Promise<RequestResult> {
    const other = await this.find(target);
    if (!other) {
      throw new ApiError(404, 'player_not_found', 'code' in target ? 'No player has that friend code' : 'No player has that name: check the spelling');
    }
    if (other.id === userId) throw new ApiError(400, 'cannot_add_self', "That's you");
    if (await this.hasBlocked(userId, other.id)) throw new ApiError(409, 'blocked_by_you', 'You blocked this player: unblock them first');
    if (await this.areFriends(userId, other.id)) return { status: 'friends', friend: (await this.friend(userId, other.id))! };
    const [theirs] = await this.db
      .select({ at: friendRequests.createdAt })
      .from(friendRequests)
      .where(and(eq(friendRequests.fromId, other.id), eq(friendRequests.toId, userId)));
    if (theirs) return { status: 'friends', friend: await this.accept(userId, other.id) };

    const at = new Date(this.now());
    // a friend code is handed out on purpose: it always gets through their setting
    if (!('code' in target)) await this.requireOpen(userId, other.id);
    // they said no lately: it looks sent, and nothing reaches them (audit-2 L-09)
    if (await this.declinedLately(userId, other.id)) return { status: 'requested', user: { id: other.id, nickname: other.nickname, at: at.toISOString() } };
    await this.db.transaction(async (tx) => {
      const [mine] = await tx.select({ n: count() }).from(friendRequests).where(eq(friendRequests.fromId, userId));
      const [already] = await tx
        .select({ at: friendRequests.createdAt })
        .from(friendRequests)
        .where(and(eq(friendRequests.fromId, userId), eq(friendRequests.toId, other.id)));
      if (already) return;
      if ((mine?.n ?? 0) >= MAX_OUTGOING_REQUESTS) throw new ApiError(409, 'too_many_requests', `You have ${MAX_OUTGOING_REQUESTS} requests waiting: cancel some first`);
      await this.requireRoom(tx, userId, 'you');
      // at most MAX_INCOMING_REQUESTS wait for one player: the oldest make room
      const waiting = await tx
        .select({ from: friendRequests.fromId })
        .from(friendRequests)
        .where(eq(friendRequests.toId, other.id))
        .orderBy(desc(friendRequests.createdAt))
        .offset(MAX_INCOMING_REQUESTS - 1);
      if (waiting.length) await tx.delete(friendRequests).where(and(eq(friendRequests.toId, other.id), inArray(friendRequests.fromId, waiting.map((w) => w.from))));
      await tx.insert(friendRequests).values({ fromId: userId, toId: other.id, createdAt: at }).onConflictDoNothing();
    });
    // their badge lights up at once (unless they blocked you: then nothing reaches them)
    if (!(await this.hasBlocked(other.id, userId))) this.touched([other.id]);
    const [row] = await this.db
      .select({ at: friendRequests.createdAt })
      .from(friendRequests)
      .where(and(eq(friendRequests.fromId, userId), eq(friendRequests.toId, other.id)));
    return { status: 'requested', user: { id: other.id, nickname: other.nickname, at: (row?.at ?? at).toISOString() } };
  }

  /** `toId` declined a request from `fromId` in the last {@link DECLINE_MEMORY_MS}. */
  async declinedLately(fromId: string, toId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ at: friendRequestDeclines.at })
      .from(friendRequestDeclines)
      .where(and(eq(friendRequestDeclines.fromId, fromId), eq(friendRequestDeclines.toId, toId), gt(friendRequestDeclines.at, new Date(this.now() - DECLINE_MEMORY_MS))));
    return !!row;
  }

  /** 403 `requests_closed` unless `toId` takes requests by name from `fromId` (their requests_from). */
  private async requireOpen(fromId: string, toId: string): Promise<void> {
    const [row] = await this.db.select({ from: profiles.requestsFrom }).from(profiles).where(eq(profiles.userId, toId));
    const setting = row?.from ?? 'anyone';
    if (setting === 'anyone') return;
    if (setting === 'played' && (await this.playedTogether(fromId, toId))) return;
    throw new ApiError(
      403,
      'requests_closed',
      setting === 'code' ? 'They take friend requests by friend code only: ask them for theirs' : 'They take friend requests only from people they have played with',
      { requestsFrom: setting },
    );
  }

  /** The two shared a match that ended in the last {@link PLAYED_WITH_DAYS} days. */
  async playedTogether(a: string, b: string): Promise<boolean> {
    const mine = alias(matchPlayers, 'mine');
    const them = alias(matchPlayers, 'them');
    const [row] = await this.db
      .select({ id: mine.matchId })
      .from(mine)
      .innerJoin(them, and(eq(them.matchId, mine.matchId), eq(them.userId, b)))
      .innerJoin(matches, eq(matches.id, mine.matchId))
      .where(and(eq(mine.userId, a), gt(matches.endedAt, new Date(this.now() - PLAYED_WITH_DAYS * 86_400_000))))
      .limit(1);
    return !!row;
  }

  private async requireRoom(db: Pick<Db, 'select'>, userId: string, who: 'you' | 'they'): Promise<void> {
    const [row] = await db.select({ n: count() }).from(friendships).where(eq(friendships.userId, userId));
    if ((row?.n ?? 0) >= MAX_FRIENDS) {
      throw new ApiError(409, 'friends_full', who === 'you' ? `You have ${MAX_FRIENDS} friends: remove one first` : `They have ${MAX_FRIENDS} friends already`);
    }
  }

  /** Accept `fromId`'s request: friends both ways, the request (and any the other way) gone. */
  async accept(userId: string, fromId: string): Promise<FriendView> {
    const at = new Date(this.now());
    await this.db.transaction(async (tx) => {
      const gone = await tx
        .delete(friendRequests)
        .where(and(eq(friendRequests.fromId, fromId), eq(friendRequests.toId, userId)))
        .returning({ from: friendRequests.fromId });
      if (!gone.length) throw new ApiError(404, 'no_request', 'That request is gone (cancelled, or answered on another device)');
      if (await this.hasBlockedIn(tx, userId, fromId)) throw new ApiError(404, 'no_request', 'That request is gone');
      await this.requireRoom(tx, userId, 'you');
      await this.requireRoom(tx, fromId, 'they');
      await tx.delete(friendRequests).where(and(eq(friendRequests.fromId, userId), eq(friendRequests.toId, fromId)));
      await tx
        .delete(friendRequestDeclines)
        .where(or(and(eq(friendRequestDeclines.fromId, userId), eq(friendRequestDeclines.toId, fromId)), and(eq(friendRequestDeclines.fromId, fromId), eq(friendRequestDeclines.toId, userId))));
      await tx
        .insert(friendships)
        .values([
          { userId, friendId: fromId, createdAt: at },
          { userId: fromId, friendId: userId, createdAt: at },
        ])
        .onConflictDoNothing();
    });
    this.touched([userId, fromId]);
    return (await this.friend(userId, fromId))!;
  }

  private async hasBlockedIn(db: Pick<Db, 'select'>, userId: string, otherId: string): Promise<boolean> {
    const [row] = await db
      .select({ id: blocks.blockedId })
      .from(blocks)
      .where(and(eq(blocks.userId, userId), eq(blocks.blockedId, otherId)));
    return !!row;
  }

  /**
   * Say no to `fromId`'s request (they aren't told; their request just goes). They can't ask again for
   * {@link DECLINE_MEMORY_MS}: a new request looks sent and reaches nobody.
   */
  async decline(userId: string, fromId: string): Promise<void> {
    const gone = await this.db
      .delete(friendRequests)
      .where(and(eq(friendRequests.fromId, fromId), eq(friendRequests.toId, userId)))
      .returning({ from: friendRequests.fromId });
    if (!gone.length) return;
    const at = new Date(this.now());
    await this.db
      .insert(friendRequestDeclines)
      .values({ fromId, toId: userId, at })
      .onConflictDoUpdate({ target: [friendRequestDeclines.fromId, friendRequestDeclines.toId], set: { at } });
  }

  /** Take back your request to `toId`. */
  async cancel(userId: string, toId: string): Promise<void> {
    await this.db.delete(friendRequests).where(and(eq(friendRequests.fromId, userId), eq(friendRequests.toId, toId)));
  }

  /** Unfriend: both sides' rows go. */
  async remove(userId: string, friendId: string): Promise<boolean> {
    const gone = await this.db
      .delete(friendships)
      .where(
        or(and(eq(friendships.userId, userId), eq(friendships.friendId, friendId)), and(eq(friendships.userId, friendId), eq(friendships.friendId, userId))),
      )
      .returning({ id: friendships.userId });
    if (gone.length) this.touched([userId, friendId]);
    return gone.length > 0;
  }

  /** Block: ends the friendship and every request between the two, and hides future ones. */
  async block(userId: string, targetId: string): Promise<{ wereFriends: boolean }> {
    if (targetId === userId) throw new ApiError(400, 'cannot_block_self', "You can't block yourself");
    const [exists] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, targetId));
    if (!exists) throw new ApiError(404, 'player_not_found', 'No such player');
    const at = new Date(this.now());
    return this.db.transaction(async (tx) => {
      await tx.insert(blocks).values({ userId, blockedId: targetId, createdAt: at }).onConflictDoNothing();
      const ended = await tx
        .delete(friendships)
        .where(
          or(and(eq(friendships.userId, userId), eq(friendships.friendId, targetId)), and(eq(friendships.userId, targetId), eq(friendships.friendId, userId))),
        )
        .returning({ id: friendships.userId });
      await tx
        .delete(friendRequests)
        .where(or(and(eq(friendRequests.fromId, userId), eq(friendRequests.toId, targetId)), and(eq(friendRequests.fromId, targetId), eq(friendRequests.toId, userId))));
      return { wereFriends: ended.length > 0 };
    }).then((r) => {
      // to them it looks like an unfriend, nothing more
      this.touched(r.wereFriends ? [userId, targetId] : [userId]);
      return r;
    });
  }

  /** Unblock: requests they sent while blocked are dropped, so nothing old pops up. */
  async unblock(userId: string, targetId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(blocks).where(and(eq(blocks.userId, userId), eq(blocks.blockedId, targetId)));
      await tx.delete(friendRequests).where(and(eq(friendRequests.fromId, targetId), eq(friendRequests.toId, userId)));
    });
  }

  /** Of `ids`, the ones who are `userId`'s friends. */
  async friendsAmong(userId: string, ids: readonly string[]): Promise<Set<string>> {
    if (!ids.length) return new Set();
    const rows = await this.db
      .select({ id: friendships.friendId })
      .from(friendships)
      .where(and(eq(friendships.userId, userId), inArray(friendships.friendId, [...ids])));
    return new Set(rows.map((r) => r.id));
  }

  /** "Let players find me by name" on or off. */
  async setFindable(userId: string, findable: boolean): Promise<boolean> {
    return (await this.setSettings(userId, { findable })).findable;
  }

  /** The friends panel's Privacy: "Let players find me by name", who may send requests. */
  async setSettings(userId: string, change: Partial<FriendSettings>): Promise<FriendSettings> {
    const set = { ...(change.findable !== undefined ? { findable: change.findable } : {}), ...(change.requestsFrom !== undefined ? { requestsFrom: change.requestsFrom } : {}) };
    const [row] = Object.keys(set).length
      ? await this.db.update(profiles).set(set).where(eq(profiles.userId, userId)).returning({ findable: profiles.findable, requestsFrom: profiles.requestsFrom })
      : await this.db.select({ findable: profiles.findable, requestsFrom: profiles.requestsFrom }).from(profiles).where(eq(profiles.userId, userId));
    if (!row) throw new ApiError(404, 'not_found', 'No profile for this account');
    return row;
  }

  /**
   * The device said under 18 (audit-2 L-03): nobody finds the account, and every friendship and request
   * it had ends (both sides' lists change).
   */
  async forgetSocial(userId: string): Promise<void> {
    const ended = await this.db.transaction(async (tx) => {
      await tx.update(profiles).set({ findable: false }).where(eq(profiles.userId, userId));
      const gone = await tx
        .delete(friendships)
        .where(or(eq(friendships.userId, userId), eq(friendships.friendId, userId)))
        .returning({ a: friendships.userId, b: friendships.friendId });
      const requests = await tx
        .delete(friendRequests)
        .where(or(eq(friendRequests.fromId, userId), eq(friendRequests.toId, userId)))
        .returning({ a: friendRequests.fromId, b: friendRequests.toId });
      return [...gone, ...requests].flatMap((r) => [r.a, r.b]);
    });
    this.touched([...new Set([userId, ...ended])]);
  }

  /**
   * Players whose name starts with `query` (case, separators and lookalikes folded, as names are kept
   * unique), closest first: the exact name, then the shortest. Only players who chose their name and
   * let themselves be found; never you, nor anyone blocked either way. An empty list for a query under
   * {@link SEARCH_MIN_LETTERS} letters.
   */
  async search(userId: string, query: string): Promise<FoundPlayer[]> {
    const key = searchKey(query);
    if (!key) return [];
    // the skeleton folds `rn` to `m` and `vv` to `w`, so "Mar" must also find "Marnie" (`mamle`)
    const prefixes = [key, ...(key.endsWith('r') ? [`${key.slice(0, -1)}m`] : []), ...(key.endsWith('v') ? [`${key.slice(0, -1)}w`] : [])];
    const rows = await this.db
      .select({ id: profiles.userId, nickname: profiles.nickname, norm: profiles.nicknameNorm, level: profiles.level })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          or(...prefixes.map((p) => like(profiles.nicknameNorm, `${escapeLike(p)}%`))),
          eq(profiles.findable, true),
          isNotNull(profiles.nicknameChangedAt),
          eq(users.status, 'active'),
          eq(users.minor, false),
          ne(profiles.userId, userId),
          sql`not exists (select 1 from ${blocks} where (${blocks.userId} = ${userId} and ${blocks.blockedId} = ${profiles.userId}) or (${blocks.userId} = ${profiles.userId} and ${blocks.blockedId} = ${userId}))`,
        ),
      )
      .orderBy(asc(profiles.nicknameNorm))
      .limit(SEARCH_SCAN);
    rows.sort((a, b) => Number(b.norm === key) - Number(a.norm === key) || a.norm.length - b.norm.length || (a.norm < b.norm ? -1 : a.norm > b.norm ? 1 : 0));
    return this.found(userId, rows.slice(0, SEARCH_RESULTS));
  }

  /**
   * People you played a match with lately (your last {@link RECENT_MATCHES} matches, {@link RECENT_DAYS}
   * days), the most recent first: not friends already, never anyone blocked either way. Bots never
   * have match lines, so they never show.
   */
  async recent(userId: string, opts: { days?: number; limit?: number } = {}): Promise<FoundPlayer[]> {
    const mine = alias(matchPlayers, 'mine');
    const them = alias(matchPlayers, 'them');
    const limit = opts.limit ?? RECENT_PLAYERS;
    const since = new Date(this.now() - (opts.days ?? RECENT_DAYS) * 86_400_000);
    const lastMatches = this.db
      .select({ id: mine.matchId })
      .from(mine)
      .innerJoin(matches, eq(matches.id, mine.matchId))
      .where(and(eq(mine.userId, userId), gt(matches.endedAt, since)))
      .orderBy(desc(matches.endedAt))
      .limit(RECENT_MATCHES);
    const lastSeen = max(matches.endedAt);
    const met = await this.db
      .select({ id: them.userId, at: lastSeen })
      .from(them)
      .innerJoin(matches, eq(matches.id, them.matchId))
      .where(and(inArray(them.matchId, lastMatches), ne(them.userId, userId)))
      .groupBy(them.userId)
      .orderBy(desc(lastSeen))
      .limit(limit * 5);
    if (!met.length) return [];
    const ids = met.map((m) => m.id);
    const [friends, blocked, people] = await Promise.all([
      this.friendsAmong(userId, ids),
      this.db
        .select({ a: blocks.userId, b: blocks.blockedId })
        .from(blocks)
        .where(or(and(eq(blocks.userId, userId), inArray(blocks.blockedId, ids)), and(inArray(blocks.userId, ids), eq(blocks.blockedId, userId)))),
      this.db
        .select({ id: profiles.userId, nickname: profiles.nickname, level: profiles.level })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .where(and(inArray(profiles.userId, ids), eq(users.status, 'active'), eq(users.minor, false))),
    ]);
    const hidden = new Set([...friends, ...blocked.map((r) => (r.a === userId ? r.b : r.a))]);
    const byId = new Map(people.map((p) => [p.id, p]));
    const rows = met.flatMap((m) => {
      const p = byId.get(m.id);
      return p && !hidden.has(m.id) && m.at ? [{ ...p, at: new Date(m.at).toISOString() }] : [];
    });
    return this.found(userId, rows.slice(0, limit));
  }

  /** Players with their look and where you stand with each. */
  private async found(userId: string, rows: readonly { id: string; nickname: string; level: number; at?: string }[]): Promise<FoundPlayer[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [friends, requests, looks] = await Promise.all([
      this.friendsAmong(userId, ids),
      this.db
        .select({ from: friendRequests.fromId, to: friendRequests.toId })
        .from(friendRequests)
        .where(or(and(eq(friendRequests.fromId, userId), inArray(friendRequests.toId, ids)), and(inArray(friendRequests.fromId, ids), eq(friendRequests.toId, userId)))),
      this.looks(rows),
    ]);
    const sent = new Set(requests.filter((r) => r.from === userId).map((r) => r.to));
    const incoming = new Set(requests.filter((r) => r.to === userId).map((r) => r.from));
    return rows.map((r) => ({
      id: r.id,
      nickname: r.nickname,
      level: r.level,
      look: looks.get(r.id) ?? null,
      relation: friends.has(r.id) ? 'friends' : incoming.has(r.id) ? 'incoming' : sent.has(r.id) ? 'sent' : 'none',
      ...(r.at ? { at: r.at } : {}),
    }));
  }
}

/** A search's key: the query's skeleton, or '' when it's under {@link SEARCH_MIN_LETTERS} letters. */
export function searchKey(query: string): string {
  const key = skeleton(query.slice(0, 32));
  return [...key].length >= SEARCH_MIN_LETTERS ? key : '';
}

/** A LIKE pattern matching `text` itself (`%`, `_` and the backslash escaped). */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}
