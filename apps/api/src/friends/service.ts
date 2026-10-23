/**
 * Friends (the owner's 23 Oct ask): add by exact name or friend code, requests with accept and
 * decline, remove, block. Every account is a guest today (docs/07 §3), with a stable user id that
 * lasts as long as its session does, so friendships hang on user ids: a guest who clears their
 * browser starts a new account with no friends, and account linking (later) keeps them.
 *
 * Privacy: presence (online, in a match and which room) is shown to friends only. A block is never
 * revealed: requests from a player you blocked are kept out of your list (not refused), so the
 * sender sees what any unanswered request looks like.
 */
import { and, asc, count, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { isUniqueViolation } from '../db/client';
import { blocks, friendRequests, friendships, profiles, users } from '../db/schema';
import { ApiError } from '../http/errors';
import { skeleton } from '../nickname/normalize';
import type { PresenceService, PresenceStatus } from '../presence/presence';
import { formatFriendCode, newFriendCode, normalizeFriendCode } from './code';

/** Most friends one account may have (both sides are checked when a request is accepted). */
export const MAX_FRIENDS = 200;
/** Most requests one player may have waiting for an answer. */
export const MAX_OUTGOING_REQUESTS = 50;
const CODE_ATTEMPTS = 6;

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
}

/** Someone in a request or on the block list. */
export interface PersonView {
  id: string;
  nickname: string;
  /** when the request was made, or the block */
  at: string;
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
  ) {}

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
      .where(and(where, eq(users.status, 'active')));
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
    const [code, friendRows, incoming, outgoing, blocked] = await Promise.all([
      this.codeOf(userId),
      this.db
        .select({ id: friendships.friendId, since: friendships.createdAt, nickname: profiles.nickname, lastSeenAt: users.lastSeenAt })
        .from(friendships)
        .innerJoin(profiles, eq(profiles.userId, friendships.friendId))
        .innerJoin(users, eq(users.id, friendships.friendId))
        .where(eq(friendships.userId, userId)),
      this.db
        .select({ id: friendRequests.fromId, at: friendRequests.createdAt, nickname: profiles.nickname })
        .from(friendRequests)
        .innerJoin(profiles, eq(profiles.userId, friendRequests.fromId))
        .where(eq(friendRequests.toId, userId))
        .orderBy(asc(friendRequests.createdAt)),
      this.db
        .select({ id: friendRequests.toId, at: friendRequests.createdAt, nickname: profiles.nickname })
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
    ]);
    const presence = await this.presence.getMany(friendRows.map((f) => f.id));
    const friends = friendRows.map((f, i): FriendView => {
      const p = presence[i]!;
      return { id: f.id, nickname: f.nickname, status: p.status, room: p.room, lastSeenAt: p.lastSeenAt ?? f.lastSeenAt.toISOString(), since: f.since.toISOString() };
    });
    friends.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.nickname.localeCompare(b.nickname));
    const blockedIds = new Set(blocked.map((b) => b.id));
    const person = (r: { id: string; at: Date; nickname: string }): PersonView => ({ id: r.id, nickname: r.nickname, at: r.at.toISOString() });
    return {
      code: formatFriendCode(code),
      friends,
      incoming: incoming
        .filter((r) => !blockedIds.has(r.id))
        .map(person)
        .reverse(),
      outgoing: outgoing.map(person).reverse(),
      blocked: blocked.map(person),
      max: MAX_FRIENDS,
    };
  }

  /** One friend's view (after an accept), or null when they aren't a friend. */
  async friend(userId: string, friendId: string): Promise<FriendView | null> {
    const [row] = await this.db
      .select({ id: friendships.friendId, since: friendships.createdAt, nickname: profiles.nickname, lastSeenAt: users.lastSeenAt })
      .from(friendships)
      .innerJoin(profiles, eq(profiles.userId, friendships.friendId))
      .innerJoin(users, eq(users.id, friendships.friendId))
      .where(and(eq(friendships.userId, userId), eq(friendships.friendId, friendId)));
    if (!row) return null;
    const p = await this.presence.get(friendId);
    return { id: row.id, nickname: row.nickname, status: p.status, room: p.room, lastSeenAt: p.lastSeenAt ?? row.lastSeenAt.toISOString(), since: row.since.toISOString() };
  }

  /**
   * Ask `target` to be friends. Asking someone who already asked you makes you friends at once;
   * asking a friend or asking twice changes nothing. Asking someone who blocked you looks like any
   * other request (it waits, unseen).
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
    await this.db.transaction(async (tx) => {
      const [mine] = await tx.select({ n: count() }).from(friendRequests).where(eq(friendRequests.fromId, userId));
      const [already] = await tx
        .select({ at: friendRequests.createdAt })
        .from(friendRequests)
        .where(and(eq(friendRequests.fromId, userId), eq(friendRequests.toId, other.id)));
      if (already) return;
      if ((mine?.n ?? 0) >= MAX_OUTGOING_REQUESTS) throw new ApiError(409, 'too_many_requests', `You have ${MAX_OUTGOING_REQUESTS} requests waiting: cancel some first`);
      await this.requireRoom(tx, userId, 'you');
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

  /** Say no to `fromId`'s request (they aren't told; their request just goes). */
  async decline(userId: string, fromId: string): Promise<void> {
    await this.db.delete(friendRequests).where(and(eq(friendRequests.fromId, fromId), eq(friendRequests.toId, userId)));
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
}
