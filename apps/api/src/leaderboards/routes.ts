/**
 * Player-facing stats (docs/07 §12), for signed-in players:
 *   GET /leaderboards/:board?period=all|week&limit=1..100  → { board, period, periodId, entries, me }
 *   GET /players/:userId/profile (or /players/me/profile)  → level and XP progress, lifetime stats, kills by weapon, recent matches
 */
import { levelProgress } from '@military-forge/shared';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Db } from '../db/client';
import { ALL_WEAPONS, matchPlayers, matches, profiles, statsLifetime, users } from '../db/schema';
import type { AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import { BOARDS, PERIODS, type Board, type Leaderboards, type Period } from './service';

const RECENT = 10;

export function leaderboardRoutes(deps: { auth: AuthService; leaderboards: Leaderboards }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use(requireAuth(deps.auth));
  app.get('/:board', async (c) => {
    const board = c.req.param('board') as Board;
    if (!BOARDS.includes(board)) throw new ApiError(404, 'not_found', `No leaderboard "${board}" (${BOARDS.join(', ')})`);
    const period = (c.req.query('period') ?? 'all') as Period;
    if (!PERIODS.includes(period)) throw new ApiError(400, 'invalid_request', `period: one of ${PERIODS.join(', ')}`);
    const limit = Number(c.req.query('limit') ?? 25);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'invalid_request', 'limit: 1 to 100');
    return c.json(await deps.leaderboards.top(board, period, limit, c.get('auth')!.userId));
  });
  return app;
}

export function profileRoutes(deps: { db: Db; auth: AuthService }): Hono<AppEnv> {
  const { db } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireAuth(deps.auth));
  app.get('/:userId/profile', async (c) => {
    const raw = c.req.param('userId');
    const userId = raw === 'me' ? c.get('auth')!.userId : raw;
    const [p] = await db
      .select({ nickname: profiles.nickname, xp: profiles.xp })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(and(eq(profiles.userId, userId), eq(users.status, 'active')));
    if (!p) throw new ApiError(404, 'not_found', 'No such player');
    const stats = await db.select().from(statsLifetime).where(eq(statsLifetime.userId, userId));
    const all = stats.find((s) => s.weaponId === ALL_WEAPONS);
    const recent = await db
      .select({
        matchId: matches.id,
        endedAt: matches.endedAt,
        map: matches.map,
        placement: matchPlayers.placement,
        kills: matchPlayers.kills,
        deaths: matchPlayers.deaths,
        assists: matchPlayers.assists,
        left: matchPlayers.left,
        xpGained: matchPlayers.xpGained,
      })
      .from(matchPlayers)
      .innerJoin(matches, eq(matches.id, matchPlayers.matchId))
      .where(eq(matchPlayers.userId, userId))
      .orderBy(desc(matches.endedAt))
      .limit(RECENT);
    return c.json({
      id: userId,
      nickname: p.nickname,
      xp: p.xp,
      ...levelProgress(p.xp),
      stats: {
        matches: all?.matches ?? 0,
        wins: all?.wins ?? 0,
        kills: all?.kills ?? 0,
        deaths: all?.deaths ?? 0,
        assists: all?.assists ?? 0,
        damage: all?.damage ?? 0,
        headshots: all?.headshots ?? 0,
        bestStreak: all?.bestStreak ?? 0,
        playtimeS: all?.playtimeS ?? 0,
      },
      killsBy: stats
        .filter((s) => s.weaponId !== ALL_WEAPONS && s.kills > 0)
        .sort((a, b) => b.kills - a.kills || a.weaponId.localeCompare(b.weaponId))
        .map((s) => ({ source: s.weaponId, kills: s.kills })),
      recent: recent.map((r) => ({ ...r, endedAt: r.endedAt.toISOString() })),
    });
  });
  return app;
}
