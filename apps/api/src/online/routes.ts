/**
 * /online: Online now (service.ts says what each part shows and keeps private). 18+ and signed in.
 *
 *   GET    /online           → { counts: { online, inMatches, playedToday }, settings: { appearOffline, showToRecent }, lfg: { mode, until } | null }
 *   GET    /online/recent    → { players: OnlinePlayer[] }   people you played with in 7 days who are on and chose to be shown
 *   GET    /online/lfg       → { players: OnlinePlayer[] }   people looking for a match (Invite or Join)
 *   PUT    /online/lfg { mode } → { mode, until }           on for 15 minutes (409 appear_offline while hidden)
 *   DELETE /online/lfg       → 204
 *   PUT    /online/settings { appearOffline?, showToRecent? } → { appearOffline, showToRecent }
 */
import { LFG_MODES } from '@military-forge/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { adultsOnly, requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Db } from '../db/client';
import type { AppEnv } from '../http/context';
import { readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import type { OnlineService } from './service';

const LfgBody = z.strictObject({ mode: z.enum(LFG_MODES) });
const SettingsBody = z
  .strictObject({ appearOffline: z.boolean().optional(), showToRecent: z.boolean().optional() })
  .refine((b) => b.appearOffline !== undefined || b.showToRecent !== undefined, 'Nothing to change');

export function onlineRoutes(deps: { db: Db; kv: Kv; auth: AuthService; online: OnlineService }): Hono<AppEnv> {
  const { db, kv, auth, online } = deps;
  const app = new Hono<AppEnv>();
  app.use(requireAuth(auth));
  app.use(adultsOnly(db));
  const read = (userId: string) => enforceRateLimit(kv, LIMITS.onlineRead, userId);
  const write = (userId: string) => enforceRateLimit(kv, LIMITS.onlineWrite, userId);

  app.get('/', async (c) => {
    const { userId } = c.get('auth')!;
    await read(userId);
    const [counts, settings, lfg] = await Promise.all([online.counts(), online.settings(userId), online.lfgOf(userId)]);
    return c.json({ counts, settings, lfg });
  });

  app.get('/recent', async (c) => {
    const { userId } = c.get('auth')!;
    await read(userId);
    return c.json({ players: await online.recentOnline(userId) });
  });

  app.get('/lfg', async (c) => {
    const { userId } = c.get('auth')!;
    await read(userId);
    return c.json({ players: await online.looking(userId) });
  });

  app.put('/lfg', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    const { mode } = await readJson(c, LfgBody);
    return c.json(await online.startLooking(userId, mode));
  });

  app.delete('/lfg', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    await online.stopLooking(userId);
    return c.body(null, 204);
  });

  app.put('/settings', async (c) => {
    const { userId } = c.get('auth')!;
    await write(userId);
    return c.json(await online.setSettings(userId, await readJson(c, SettingsBody)));
  });

  return app;
}
