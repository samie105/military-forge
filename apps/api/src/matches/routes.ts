/**
 * POST /internal/matches: the game server's match results (report.ts says how they're signed).
 *   201 { recorded: true, players: [{ userId, xpGained, xp, level }] }  ·  200 { recorded: false } (already recorded)
 *   401 bad_signature … (the token)  ·  400 invalid_request (the body)  ·  404 when RESULTS_PUBLIC_KEY isn't set
 */
import type { KeyObject } from 'node:crypto';
import { Hono } from 'hono';
import type { Db } from '../db/client';
import type { AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import type { Leaderboards } from '../leaderboards/service';
import { MatchReportBody, checkReportAuth } from './report';
import { recordMatch } from './service';

export function matchRoutes(deps: { db: Db; key: KeyObject; leaderboards: Leaderboards; now: () => number }): Hono<AppEnv> {
  const { db, key, leaderboards, now } = deps;
  const app = new Hono<AppEnv>();

  app.post('/matches', async (c) => {
    const raw = await c.req.text();
    const auth = checkReportAuth(c.req.header('authorization'), raw, key, Math.floor(now() / 1000));
    if (!auth.ok) {
      c.get('log').warn({ reason: auth.reason }, 'match report refused');
      throw new ApiError(401, 'invalid_report_signature', `Match report refused: ${auth.reason}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON');
    }
    const parsed = MatchReportBody.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_request', 'Request body failed validation', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const report = parsed.data;
    if (report.matchId !== auth.matchId) throw new ApiError(401, 'invalid_report_signature', 'Match report refused: the token names another match');

    const result = await recordMatch(db, report, now);
    if (!result.recorded) return c.json({ recorded: false }, 200);
    c.get('log').info({ matchId: report.matchId, players: result.players.length }, 'match recorded');
    // Postgres has it; the boards follow (a failure here is fixed by the next rebuild or match)
    await leaderboards.onMatchRecorded(
      result.players.map((p) => p.userId),
      Date.parse(report.endedAt),
    ).catch((err: unknown) => c.get('log').error({ err }, 'leaderboard update failed'));
    return c.json(result, 201);
  });

  return app;
}
