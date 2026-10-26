/**
 * Problem reports (the owner, 24 Oct: "check the logs if you're logging anything"): a player's
 * Send a report, or the one a failed room connection sends by itself, carries the device's own event
 * log (a local room's steps and errors, WebRTC states, the transport's drops and reconnects, the
 * tour, the last script errors), the device, the browser and the build. Local rooms run between the
 * players' phones, so this is the only way to see what happened on one.
 *
 *   POST /reports           anyone, 6 per 10 minutes per address; kept 7 days in the KV
 *   GET  /reports           the owner (Authorization: Bearer ADMIN_TOKEN): the newest 200, summarised
 *   GET  /reports/:id       the owner: one report, whole
 *
 * Nothing personal beyond the in-game name the player chose: no account id, no address is stored.
 */
import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Config } from '../config';
import { clientRateLimitKey } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';

/** how long a report is kept */
export const REPORT_TTL_MS = 7 * 24 * 60 * 60_000;
/** the most reports kept at once (the oldest go first) */
export const MAX_REPORTS = 500;
const INDEX = 'reports';
const key = (id: string) => `report:${id}`;

const Event = z.object({ t: z.number().finite(), k: z.string().max(24), m: z.string().max(240) });
export const ReportBody = z.object({
  reason: z.enum(['manual', 'auto']),
  /** where it was sent from: "settings", "pause", "local room: unreachable"… */
  context: z.string().max(80),
  nickname: z.string().max(32).optional(),
  build: z.string().max(40),
  device: z.object({
    ua: z.string().max(400),
    w: z.number().finite(),
    h: z.number().finite(),
    dpr: z.number().finite(),
    standalone: z.boolean(),
    touch: z.boolean(),
    lang: z.string().max(20).optional(),
  }),
  events: z.array(Event).max(300),
  errors: z.array(z.string().max(400)).max(20),
  tour: z.array(z.string().max(160)).max(40).optional(),
  note: z.string().max(500).optional(),
});
export type ReportBody = z.infer<typeof ReportBody>;

export interface StoredReport extends ReportBody {
  id: string;
  at: number;
}

const ID_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newId(): string {
  let id = '';
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  for (const b of bytes) id += ID_LETTERS[b % ID_LETTERS.length];
  return id;
}

/** 401 unless the request carries the owner's admin token (also the play-stats dashboard's guard). */
export function ownerOnly(c: Context<AppEnv>, token: string | null): void {
  const got = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '';
  const a = Buffer.from(got);
  const b = Buffer.from(token ?? '');
  if (!token || a.length !== b.length || !timingSafeEqual(a, b)) throw new ApiError(401, 'unauthorized', 'The admin token is missing or wrong');
}

export function reportRoutes(deps: { config: Config; kv: Kv; now: () => number }): Hono<AppEnv> {
  const { config, kv, now } = deps;
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    await enforceRateLimit(kv, LIMITS.report, clientRateLimitKey(c, config));
    const parsed = ReportBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ApiError(400, 'invalid_request', 'Not a report');
    const report: StoredReport = { ...parsed.data, id: newId(), at: now() };
    await kv.set(key(report.id), JSON.stringify(report), { ttlMs: REPORT_TTL_MS });
    await kv.zadd(INDEX, [{ member: report.id, score: report.at }]);
    await kv.expire(INDEX, REPORT_TTL_MS);
    // the index keeps the last week, at most MAX_REPORTS
    const all = await kv.ztop(INDEX, MAX_REPORTS + 50);
    const old = all.filter((e, i) => i >= MAX_REPORTS || e.score < report.at - REPORT_TTL_MS).map((e) => e.member);
    if (old.length) await kv.zrem(INDEX, old);
    return c.json({ id: report.id }, 201);
  });

  app.get('/', async (c) => {
    ownerOnly(c, config.adminToken);
    const top = await kv.ztop(INDEX, 200);
    const raw = await kv.mget(top.map((e) => key(e.member)));
    const reports = raw.flatMap((r) => {
      if (!r) return [];
      const v = JSON.parse(r) as StoredReport;
      const problem = [...v.events].reverse().find((e) => /error|fail|lost|closed|timeout/i.test(`${e.k} ${e.m}`));
      return [{ id: v.id, at: v.at, reason: v.reason, context: v.context, nickname: v.nickname ?? '', build: v.build, ua: v.device.ua, events: v.events.length, errors: v.errors.length, problem: problem ? `${problem.k}: ${problem.m}` : (v.errors[0] ?? '') }];
    });
    return c.json({ reports });
  });

  app.get('/:id', async (c) => {
    ownerOnly(c, config.adminToken);
    const r = await kv.get(key(c.req.param('id').toUpperCase()));
    if (!r) throw new ApiError(404, 'not_found', 'No report with that id (reports are kept 7 days)');
    return c.json(JSON.parse(r) as StoredReport);
  });

  return app;
}
