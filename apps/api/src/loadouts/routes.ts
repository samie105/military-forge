/**
 * /me/loadout/:slot: the signed-in player's saved loadouts (docs/04 §6, docs/06 §7), so a look
 * and a gun pair follow the player to every device. The web client keeps a copy on the device as
 * an offline cache and syncs it at sign-in (apps/web/src/locker/accountSync.ts).
 *
 *   GET /me/loadout/0 → { slot, look, guns, updatedAt }   (204, no body: nothing saved yet)
 *   PUT /me/loadout/0 { look, guns } → the same           (400 invalid_loadout names each bad field)
 */
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Db } from '../db/client';
import { LOADOUT_SLOT_COUNT, loadouts, profiles, type LoadoutData } from '../db/schema';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import { LoadoutBody, loadoutIssues, toLoadoutData } from './validate';

export interface SavedLoadout extends LoadoutData {
  slot: number;
  updatedAt: string;
}

function slotParam(raw: string): number {
  const slot = /^\d$/.test(raw) ? Number(raw) : -1;
  if (slot < 0 || slot >= LOADOUT_SLOT_COUNT) throw new ApiError(404, 'not_found', `No loadout slot ${raw} (0–${LOADOUT_SLOT_COUNT - 1})`);
  return slot;
}

export function loadoutRoutes(deps: { db: Db; kv: Kv; auth: AuthService; now: () => number; grants?: (userId: string) => Promise<readonly string[]> }): Hono<AppEnv> {
  const { db, kv, auth, now, grants = async () => [] } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireAuth(auth));

  app.get('/:slot', async (c) => {
    const slot = slotParam(c.req.param('slot'));
    const [row] = await db
      .select()
      .from(loadouts)
      .where(and(eq(loadouts.userId, c.get('auth')!.userId), eq(loadouts.slot, slot)));
    // nothing saved yet is an expected answer, not an error (a 404 filled every new player's console:
    // audit 28 Oct); pages from before read the empty answer as "nothing saved" too
    if (!row) return c.body(null, 204);
    return c.json({ slot, ...row.data, updatedAt: row.updatedAt.toISOString() } satisfies SavedLoadout);
  });

  app.put('/:slot', async (c) => {
    const { userId } = c.get('auth')!;
    const slot = slotParam(c.req.param('slot'));
    await enforceRateLimit(kv, LIMITS.loadoutSave, userId);
    const body = await readJson(c, LoadoutBody);
    const [profile] = await db.select({ level: profiles.level }).from(profiles).where(eq(profiles.userId, userId));
    if (!profile) throw new ApiError(404, 'not_found', 'Account not found');
    const issues = loadoutIssues(body, profile.level, await grants(userId));
    if (issues.length) throw new ApiError(400, 'invalid_loadout', 'The loadout has items that are unknown, misplaced or locked', { issues });
    const data = toLoadoutData(body);
    const updatedAt = new Date(now());
    await db
      .insert(loadouts)
      .values({ userId, slot, data, updatedAt })
      .onConflictDoUpdate({ target: [loadouts.userId, loadouts.slot], set: { data, updatedAt } });
    return c.json({ slot, ...data, updatedAt: updatedAt.toISOString() } satisfies SavedLoadout);
  });

  return app;
}
