/**
 * Online now (1 Nov 2026): how many people are on, the people you played with lately who are on (only
 * those who chose to be shown), and Looking for a match.
 *
 * Privacy (the rules): presence stays private by default. The counts are numbers only, people only
 * (bots never beat presence). Recent players online shows only players who turned on "Show me to people
 * I played with". Appear offline takes a player out of all of it. Strangers never see a private room's
 * code or anyone's last-seen time: a room's code is shown only when that room is in the viewer's Rooms list.
 *
 * Looking for a match lives in Valkey: `lfg:{userId}` (what they want, until when) and the sorted set
 * LFG_KEY (score: when it ends). It turns itself off after 15 minutes.
 */
import { LFG_TTL_MS, RECENT_ONLINE_DAYS, type LfgMode, type OnlineCounts } from '@military-forge/shared';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { blocks, friendships, profiles, users } from '../db/schema';
import { savedLooks, type LookIds } from '../friends/looks';
import type { FriendsService } from '../friends/service';
import { ApiError } from '../http/errors';
import type { Kv } from '../kv/kv';
import { liveMembers, type PresenceService } from '../presence/presence';
import { visibilityOf, type RoomRecord } from '../rooms/listing';

export const LFG_KEY = 'lfg:list';
const lfgKey = (userId: string) => `lfg:${userId}`;
/** most people one list shows */
export const ONLINE_LIST_MAX = 20;

export interface OnlineSettings {
  appearOffline: boolean;
  showToRecent: boolean;
}

export interface LfgState {
  mode: LfgMode;
  /** when it turns itself off (ISO) */
  until: string;
}

/** Someone on: a recent player, or one looking for a match. */
export interface OnlinePlayer {
  id: string;
  nickname: string;
  level: number;
  look: LookIds;
  /** one of your friends */
  friend: boolean;
  /** in a room's lobby or match; null: on the menus */
  where: 'lobby' | 'match' | null;
  /** their room's code, only when it's in your Rooms list (Join); null otherwise */
  room: string | null;
  /** Looking for a match: what they want */
  mode?: LfgMode;
}

/** Whether the player chose Appear offline (presence.ts asks on every beat). */
export async function appearsOffline(db: Db, userId: string): Promise<boolean> {
  const [row] = await db.select({ hidden: profiles.appearOffline }).from(profiles).where(eq(profiles.userId, userId));
  return row?.hidden ?? false;
}

export class OnlineService {
  constructor(
    private readonly db: Db,
    private readonly kv: Kv,
    private readonly presence: PresenceService,
    private readonly friends: FriendsService,
    private readonly grants: ReadonlyMap<string, readonly string[]>,
    private readonly now: () => number,
  ) {}

  /** People on now, those in a match, and those who played today: numbers only, never who. */
  async counts(): Promise<OnlineCounts> {
    const ids = await this.presence.onlineIds();
    const seen = await this.presence.getMany(ids);
    return {
      online: ids.length,
      inMatches: seen.filter((p) => p.status === 'in_room' && p.playing === true).length,
      playedToday: await this.presence.playedToday(),
    };
  }

  async settings(userId: string): Promise<OnlineSettings> {
    const [row] = await this.db.select({ appearOffline: profiles.appearOffline, showToRecent: profiles.onlineToRecent }).from(profiles).where(eq(profiles.userId, userId));
    return row ?? { appearOffline: false, showToRecent: false };
  }

  async setSettings(userId: string, change: Partial<OnlineSettings>): Promise<OnlineSettings> {
    const set = {
      ...(change.appearOffline !== undefined ? { appearOffline: change.appearOffline } : {}),
      ...(change.showToRecent !== undefined ? { onlineToRecent: change.showToRecent } : {}),
    };
    if (Object.keys(set).length) await this.db.update(profiles).set(set).where(eq(profiles.userId, userId));
    const now = await this.settings(userId);
    if (change.appearOffline !== undefined) {
      // friends see the change at once; Looking for a match ends with it (it would list you)
      if (now.appearOffline) await this.stopLooking(userId);
      await this.presence.refreshHidden(userId);
    }
    return now;
  }

  async lfgOf(userId: string): Promise<LfgState | null> {
    const raw = await this.kv.get(lfgKey(userId));
    if (!raw) return null;
    try {
      const r = JSON.parse(raw) as LfgState;
      return Date.parse(r.until) > this.now() ? r : null;
    } catch {
      return null;
    }
  }

  /** Whether the player is looking for a match now (strangers may invite them: invites/service.ts). */
  async isLooking(userId: string): Promise<boolean> {
    return (await this.lfgOf(userId)) !== null;
  }

  /** Looking for a match on, for 15 minutes from now (on again: 15 minutes from now again). */
  async startLooking(userId: string, mode: LfgMode): Promise<LfgState> {
    if ((await this.settings(userId)).appearOffline) throw new ApiError(409, 'appear_offline', 'Turn off Appear offline first: looking for a match shows you to others');
    const until = this.now() + LFG_TTL_MS;
    const state: LfgState = { mode, until: new Date(until).toISOString() };
    await this.kv.set(lfgKey(userId), JSON.stringify(state), { ttlMs: LFG_TTL_MS });
    await this.kv.zadd(LFG_KEY, [{ member: userId, score: until }]);
    return state;
  }

  async stopLooking(userId: string): Promise<void> {
    await this.kv.del(lfgKey(userId));
    await this.kv.zrem(LFG_KEY, [userId]);
  }

  /** The people looking for a match now, as `viewerId` may see them: not you, no block either way, on, not hidden. */
  async looking(viewerId: string): Promise<OnlinePlayer[]> {
    const ids = (await liveMembers(this.kv, LFG_KEY, this.now())).filter((id) => id !== viewerId);
    if (!ids.length) return [];
    const states = await this.kv.mget(ids.map(lfgKey));
    const modes = new Map<string, LfgMode>();
    for (const [i, raw] of states.entries()) {
      try {
        const s = raw ? (JSON.parse(raw) as LfgState) : null;
        if (s && Date.parse(s.until) > this.now()) modes.set(ids[i]!, s.mode);
      } catch {
        /* gone */
      }
    }
    const players = await this.people(
      viewerId,
      ids.filter((id) => modes.has(id)),
    );
    return players.map((p) => ({ ...p, mode: modes.get(p.id)! }));
  }

  /** People you played with in the last 7 days who are on now and chose to be shown (not friends: they have their own list). */
  async recentOnline(viewerId: string): Promise<OnlinePlayer[]> {
    const recent = await this.friends.recent(viewerId, { days: RECENT_ONLINE_DAYS, limit: 40 });
    if (!recent.length) return [];
    const ids = recent.map((r) => r.id);
    const shown = await this.db
      .select({ id: profiles.userId })
      .from(profiles)
      .where(and(inArray(profiles.userId, ids), eq(profiles.onlineToRecent, true)));
    const allowed = new Set(shown.map((r) => r.id));
    return this.people(
      viewerId,
      ids.filter((id) => allowed.has(id)),
    );
  }

  /**
   * Of `ids`, the people on now as `viewerId` may see them (in order): active adults, not hidden, no
   * block either way, with a room code only when that room is in the viewer's list.
   */
  private async people(viewerId: string, ids: readonly string[]): Promise<OnlinePlayer[]> {
    if (!ids.length) return [];
    const [rows, blockRows, friendRows, seen] = await Promise.all([
      this.db
        .select({ id: profiles.userId, nickname: profiles.nickname, level: profiles.level, hidden: profiles.appearOffline })
        .from(profiles)
        .innerJoin(users, eq(users.id, profiles.userId))
        .where(and(inArray(profiles.userId, [...ids]), eq(users.status, 'active'), eq(users.minor, false))),
      this.db
        .select({ a: blocks.userId, b: blocks.blockedId })
        .from(blocks)
        .where(or(and(eq(blocks.userId, viewerId), inArray(blocks.blockedId, [...ids])), and(inArray(blocks.userId, [...ids]), eq(blocks.blockedId, viewerId)))),
      this.db
        .select({ id: friendships.friendId })
        .from(friendships)
        .where(and(eq(friendships.userId, viewerId), inArray(friendships.friendId, [...ids]))),
      this.presence.getManyVisible(ids),
    ]);
    const blocked = new Set(blockRows.map((r) => (r.a === viewerId ? r.b : r.a)));
    const friends = new Set(friendRows.map((r) => r.id));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const on = ids
      .map((id, i) => ({ id, p: seen[i]!, row: byId.get(id) }))
      .filter((x) => x.row && !x.row.hidden && !blocked.has(x.id) && x.p.status !== 'offline')
      .slice(0, ONLINE_LIST_MAX);
    const looks = await savedLooks(
      this.db,
      this.grants,
      on.map((x) => ({ id: x.id, level: x.row!.level })),
    );
    const out: OnlinePlayer[] = [];
    for (const x of on) {
      out.push({
        id: x.id,
        nickname: x.row!.nickname,
        level: x.row!.level,
        look: looks.get(x.id) ?? null,
        friend: friends.has(x.id),
        where: x.p.status === 'in_room' ? (x.p.playing ? 'match' : 'lobby') : null,
        room: x.p.room ? await this.roomShownTo(x.p.room, viewerId, friends) : null,
      });
    }
    return out;
  }

  /** The room's code when it's in the viewer's Rooms list (Play now's and Public rooms; Friends rooms of a friend), else null. */
  private async roomShownTo(code: string, viewerId: string, viewerFriends: ReadonlySet<string>): Promise<string | null> {
    const raw = await this.kv.get(`room:${code}`);
    if (!raw) return null;
    let record: RoomRecord;
    try {
      record = JSON.parse(raw) as RoomRecord;
    } catch {
      return null;
    }
    const v = visibilityOf(record);
    if (v === 'public') return code;
    if (v === 'friends' && (record.host === viewerId || viewerFriends.has(record.host) || (await this.friends.areFriends(viewerId, record.host)))) return code;
    return null;
  }
}
