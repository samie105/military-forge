/**
 * Leaderboards (docs/06 §7, docs/07 §12): Valkey sorted sets `lb:{board}:{period}`, one member per
 * player, scored by an absolute total read from Postgres (never incremented), so writing the same
 * score twice is harmless. Postgres is the record: a board that's empty in Valkey (a flush, a fresh
 * box, the in-memory KV after a restart) is rebuilt from it on the next read.
 *
 *   boards:  xp (all time: the profile's XP; weekly: XP gained) · kills · wins (1st place, played to the end)
 *   periods: all · the ISO week (e.g. 2026-W43, UTC), kept 15 days
 */
import { and, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { ALL_WEAPONS, matchPlayers, matches, profiles, statsLifetime, users } from '../db/schema';
import type { Kv, ZEntry } from '../kv/kv';

export const BOARDS = ['xp', 'kills', 'wins'] as const;
export type Board = (typeof BOARDS)[number];
export const PERIODS = ['all', 'week'] as const;
export type Period = (typeof PERIODS)[number];

const WEEK_TTL_MS = 15 * 86_400_000;
/** a rebuild reads at most this many players per board */
const REBUILD_LIMIT = 10_000;

/** The ISO week of `t` (UTC), as `YYYY-Www`, and its bounds. */
export function isoWeek(t: number): { id: string; start: Date; end: Date } {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Monday 0
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  const thursday = new Date(start.getTime() + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * 86_400_000)) + 1;
  return { id: `${year}-W${String(week).padStart(2, '0')}`, start, end: new Date(start.getTime() + 7 * 86_400_000) };
}

export interface LeaderboardEntry {
  rank: number;
  userId: string;
  nickname: string;
  level: number;
  score: number;
}

export class Leaderboards {
  constructor(
    private readonly db: Db,
    private readonly kv: Kv,
    private readonly now: () => number,
  ) {}

  key(board: Board, periodId: string): string {
    return `lb:${board}:${periodId}`;
  }

  periodId(period: Period, t = this.now()): string {
    return period === 'all' ? 'all' : isoWeek(t).id;
  }

  /** The top `limit`, and the asking player's own place when given (null = not on the board). */
  async top(board: Board, period: Period, limit: number, me?: string) {
    const periodId = this.periodId(period);
    const key = this.key(board, periodId);
    if ((await this.kv.zcard(key)) === 0) await this.rebuild(board, period, periodId);
    // a few extra, in case some members are accounts deleted or banned since (dropped here, and from the set)
    const top = await this.kv.ztop(key, limit + 10);
    const ids = top.map((e) => e.member);
    if (me && !ids.includes(me)) ids.push(me);
    const names = ids.length
      ? new Map(
          (
            await this.db
              .select({ id: profiles.userId, nickname: profiles.nickname, level: profiles.level })
              .from(profiles)
              .innerJoin(users, eq(users.id, profiles.userId))
              .where(and(inArray(profiles.userId, ids), eq(users.status, 'active')))
          ).map((r) => [r.id, r]),
        )
      : new Map<string, { nickname: string; level: number }>();
    const gone = top.filter((e) => !names.has(e.member)).map((e) => e.member);
    if (gone.length) await this.kv.zrem(key, gone);
    const entries: LeaderboardEntry[] = top
      .filter((e) => names.has(e.member))
      .slice(0, limit)
      .map((e, i) => ({ rank: i + 1, userId: e.member, nickname: names.get(e.member)!.nickname, level: names.get(e.member)!.level, score: e.score }));
    let mine: LeaderboardEntry | null = null;
    if (me && names.has(me)) {
      const r = await this.kv.zrank(key, me);
      const p = names.get(me)!;
      if (r) mine = { rank: r.rank + 1, userId: me, nickname: p.nickname, level: p.level, score: r.score };
    }
    return { board, period, periodId, entries, me: mine };
  }

  /** After a match: these players' totals on every board, all time and for the match's week. */
  async onMatchRecorded(userIds: readonly string[], endedAt: number): Promise<void> {
    if (!userIds.length) return;
    const week = isoWeek(endedAt);
    for (const board of BOARDS) {
      await this.write(this.key(board, 'all'), await this.scores(board, 'all', null, userIds), null);
      await this.write(this.key(board, week.id), await this.scores(board, 'week', week, userIds), WEEK_TTL_MS);
    }
  }

  private async rebuild(board: Board, period: Period, periodId: string): Promise<void> {
    const week = period === 'week' ? isoWeek(this.now()) : null;
    if (week && week.id !== periodId) return;
    await this.write(this.key(board, periodId), await this.scores(board, period, week, null), week ? WEEK_TTL_MS : null);
  }

  private async write(key: string, entries: ZEntry[], ttlMs: number | null): Promise<void> {
    if (!entries.length) return;
    await this.kv.zadd(key, entries);
    if (ttlMs !== null) await this.kv.expire(key, ttlMs);
  }

  /** Totals from Postgres: for `only` these players, else the top REBUILD_LIMIT. Zero scores are left off. */
  private async scores(board: Board, period: Period, week: { start: Date; end: Date } | null, only: readonly string[] | null): Promise<ZEntry[]> {
    let rows: { member: string; score: number }[];
    if (period === 'all') {
      if (board === 'xp') {
        const q = this.db.select({ member: profiles.userId, score: profiles.xp }).from(profiles);
        rows = await (only ? q.where(inArray(profiles.userId, [...only])) : q.orderBy(desc(profiles.xp)).limit(REBUILD_LIMIT));
      } else {
        const col = board === 'kills' ? statsLifetime.kills : statsLifetime.wins;
        const where = only ? and(eq(statsLifetime.weaponId, ALL_WEAPONS), inArray(statsLifetime.userId, [...only])) : eq(statsLifetime.weaponId, ALL_WEAPONS);
        const q = this.db.select({ member: statsLifetime.userId, score: col }).from(statsLifetime).where(where);
        rows = await (only ? q : q.orderBy(desc(col)).limit(REBUILD_LIMIT));
      }
    } else {
      const mp = matchPlayers;
      const expr =
        board === 'xp' ? sql<number>`sum(${mp.xpGained})::int` : board === 'kills' ? sql<number>`sum(${mp.kills})::int` : sql<number>`count(*) filter (where ${mp.placement} = 1 and not ${mp.left})::int`;
      const inWeek = and(gte(matches.endedAt, week!.start), lt(matches.endedAt, week!.end));
      const q = this.db
        .select({ member: mp.userId, score: expr })
        .from(mp)
        .innerJoin(matches, eq(matches.id, mp.matchId))
        .where(only ? and(inWeek, inArray(mp.userId, [...only])) : inWeek)
        .groupBy(mp.userId);
      rows = await (only ? q : q.orderBy(desc(expr)).limit(REBUILD_LIMIT));
    }
    return rows.filter((r) => Number(r.score) > 0).map((r) => ({ member: r.member, score: Number(r.score) }));
  }
}
