/**
 * Reporting a player (audit-2 L-01): the Report sheet the web opens from every place players meet (the
 * scoreboard, the lobby, results, the death cam, the friends panel, request and invite toasts, the comms
 * sheet). Kept apart from the automatic connection reports (routes.ts, the KV): a row in Postgres the
 * owner reads on the admin page (moderation.ts), kept 180 days.
 *
 *   POST /reports/player { id } | { name }, reason, note?, room?, place?
 *        Bearer; 10 an hour per reporter → 201 { id } (a new report), or 200 { id, already: true }
 *        (the same reporter about the same player within a day: one report, the first one kept)
 *
 * The reported player is never told who reported them. Bots have no account, so they can't be reported.
 */
import { normalizeRoomCode } from '@military-forge/shared';
import { and, eq, gt } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Db } from '../db/client';
import { REPORT_REASONS, playerReports, profiles, users } from '../db/schema';
import { USER_ID } from '../friends/service';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import { skeleton } from '../nickname/normalize';

/** how long a player report is kept (the retention sweep) */
export const PLAYER_REPORT_TTL_MS = 180 * 86_400_000;
/** one report per reporter and player in this window: a second tap changes nothing */
export const REPORT_DEDUPE_MS = 86_400_000;
export const REPORT_NOTE_MAX = 300;
/** where the sheet can be opened (free text would be a second note) */
export const REPORT_PLACES = ['scoreboard', 'lobby', 'results', 'deathcam', 'friends', 'search', 'recent', 'request', 'invite', 'comms', 'other'] as const;

/** who: `id` (the friends panel's rows) or `name` (a room's rows), exactly one */
const ReportBody = z
  .strictObject({
    id: z.string().regex(USER_ID).optional(),
    name: z.string().min(1).max(64).optional(),
    reason: z.enum(REPORT_REASONS),
    note: z.string().max(REPORT_NOTE_MAX).optional(),
    room: z.string().max(16).optional(),
    place: z.enum(REPORT_PLACES).optional(),
  })
  .refine((b) => (b.id === undefined) !== (b.name === undefined), 'Say who: an id or a name');

export function playerReportRoutes(deps: { db: Db; kv: Kv; auth: AuthService; now: () => number }): Hono<AppEnv> {
  const { db, kv, auth, now } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireAuth(auth));

  app.post('/', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.playerReport, userId);
    const body = await readJson(c, ReportBody);
    // any account that exists (a suspended one too: the owner wants to know), by id or by its exact name
    const where = body.id !== undefined ? eq(profiles.userId, body.id) : eq(profiles.nicknameNorm, skeleton(body.name ?? '')); // '' matches nobody
    const [target] = await db.select({ id: profiles.userId, nickname: profiles.nickname }).from(profiles).innerJoin(users, eq(users.id, profiles.userId)).where(where);
    if (!target) throw new ApiError(404, 'player_not_found', 'No player has that name');
    if (target.id === userId) throw new ApiError(400, 'cannot_report_self', "That's you");

    const at = now();
    const [already] = await db
      .select({ id: playerReports.id })
      .from(playerReports)
      .where(and(eq(playerReports.reporterId, userId), eq(playerReports.targetId, target.id), gt(playerReports.createdAt, new Date(at - REPORT_DEDUPE_MS))));
    if (already) return c.json({ id: already.id, already: true });

    const note = body.note?.trim();
    const room = body.room ? normalizeRoomCode(body.room) : null;
    const [row] = await db
      .insert(playerReports)
      .values({
        reporterId: userId,
        targetId: target.id,
        targetName: target.nickname,
        reason: body.reason,
        note: note ? note : null,
        room: room || null,
        place: body.place ?? null,
        createdAt: new Date(at),
      })
      .returning({ id: playerReports.id });
    c.get('log').info({ userId, reason: body.reason, place: body.place ?? null }, 'player reported');
    return c.json({ id: row!.id }, 201);
  });

  return app;
}
