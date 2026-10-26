/**
 * Play stats over HTTP (docs/16-player-metrics.md §3):
 *
 *   GET    /analytics/config             what this page should ask: opt-in or opt-out here, segments on?
 *   POST   /analytics/batch              a page's events (fetch keepalive or sendBeacon); 204, 429 when too many
 *   GET    /analytics/segments/me        the signed-in player's segments for the house ads (off unless ANALYTICS_AD_SEGMENTS)
 *   DELETE /analytics/me                 Delete my data: the player's play stats, now and from the raw events shortly
 *   GET    /analytics/admin/dashboard    the owner (ADMIN_TOKEN): every panel, ?days=1…90
 *   GET    /analytics/admin/export/:p    the owner: one panel as CSV
 *   POST   /analytics/admin/rollup       the owner: write the queue and recompute today's rollups now
 *   POST   /internal/analytics/match     the game server's match stats, signed like its results (matches/report.ts)
 */
import type { KeyObject } from 'node:crypto';
import { Hono } from 'hono';
import { requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Config } from '../config';
import { clientIp, clientRateLimitKey } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import { checkReportAuth } from '../matches/report';
import { ownerOnly } from '../reports/routes';
import { resolveCountry } from './country';
import { PANELS, toCsv, type Panel } from './dashboard';
import type { AnalyticsService } from './service';
import { ClientBatchSchema, MatchStatsReportSchema, validEvents } from './validate';

export function analyticsRoutes(deps: { config: Config; kv: Kv; auth: AuthService; analytics: AnalyticsService }): Hono<AppEnv> {
  const { config, kv, auth, analytics } = deps;
  const app = new Hono<AppEnv>();

  /** The request's country; the address itself goes no further. */
  const country = (c: Parameters<typeof clientIp>[0], tz?: string) =>
    resolveCountry({ trustProxy: config.trustProxy, cfCountry: c.req.header('cf-ipcountry'), ip: clientIp(c, config), tz, geoip: analytics.geoip });

  app.get('/config', (c) => {
    const tz = c.req.query('tz');
    const where = country(c, tz && tz.length <= 64 ? tz : undefined);
    c.header('Cache-Control', 'private, max-age=3600');
    return c.json({ v: 1, consent: analytics.consentMode(where), segments: config.analytics.adSegments, rawDays: config.analytics.rawDays });
  });

  app.post('/batch', async (c) => {
    await enforceRateLimit(kv, LIMITS.analytics, clientRateLimitKey(c, config));
    // sendBeacon posts text/plain: read the body as text whatever its type
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON');
    }
    const frame = ClientBatchSchema.safeParse(raw);
    if (!frame.success) throw new ApiError(400, 'invalid_request', 'Not a stats batch');
    const b = frame.data;
    const { ok, invalid } = validEvents(b.events);
    // a token is optional (a beacon can't send one); a bad or expired one is simply not used
    const token = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const claims = token ? auth.verifyAccessToken(token) : null;
    const { kept, refused } = await analytics.acceptClient(ok, {
      consent: b.consent,
      sid: b.consent === 'analytics' ? b.sid : null,
      uid: claims?.sub ?? null,
      country: country(c, b.tz),
      gpc: c.req.header('sec-gpc') === '1',
      build: b.build,
    });
    if (invalid) c.get('log').debug({ invalid, kept, refused }, 'analytics batch had events outside the vocabulary');
    return c.body(null, 204);
  });

  app.get('/segments/me', requireAuth(auth), async (c) => {
    if (!config.analytics.adSegments) return c.json({ enabled: false, segments: null });
    return c.json({ enabled: true, segments: await analytics.segments(c.get('auth')!.userId) });
  });

  app.delete('/me', requireAuth(auth), async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.profileUpdate, userId);
    await analytics.forget(userId);
    c.get('log').info({ userId }, 'play stats deletion requested');
    return c.json({ deleted: true, rawWithinMinutes: 5 }, 202);
  });

  const days = (q: string | undefined) => {
    const n = Number(q ?? 30);
    return Number.isInteger(n) && n >= 1 && n <= Math.max(90, config.analytics.rawDays) ? n : 30;
  };

  app.get('/admin/dashboard', async (c) => {
    ownerOnly(c, config.adminToken);
    c.header('Cache-Control', 'no-store');
    return c.json({ ...(await analytics.dashboard(days(c.req.query('days')))), ingest: analytics.ingest.stats() });
  });

  app.get('/admin/export/:panel', async (c) => {
    ownerOnly(c, config.adminToken);
    const panel = c.req.param('panel').replace(/\.csv$/, '') as Panel;
    if (!PANELS.includes(panel)) throw new ApiError(404, 'not_found', `No panel "${panel}" (${PANELS.join(', ')})`);
    const d = await analytics.dashboard(days(c.req.query('days')));
    return c.body(toCsv(d.tables[panel]), 200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="military-forge-${panel}-${d.range.from}-to-${d.range.to}.csv"`,
      'Cache-Control': 'no-store',
    });
  });

  app.post('/admin/rollup', async (c) => {
    ownerOnly(c, config.adminToken);
    await analytics.rollupNow();
    return c.json({ ok: true, ingest: analytics.ingest.stats() });
  });

  return app;
}

/** POST /internal/analytics/match: the game server's per-match stats, signed with its results key. */
export function internalAnalyticsRoutes(deps: { key: KeyObject; analytics: AnalyticsService; now: () => number }): Hono<AppEnv> {
  const { key, analytics, now } = deps;
  const app = new Hono<AppEnv>();
  app.post('/match', async (c) => {
    const raw = await c.req.text();
    const verdict = checkReportAuth(c.req.header('authorization'), raw, key, Math.floor(now() / 1000));
    if (!verdict.ok) throw new ApiError(401, 'invalid_report_signature', `Match stats refused: ${verdict.reason}`);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON');
    }
    const parsed = MatchStatsReportSchema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(400, 'invalid_request', 'Match stats failed validation', { issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (parsed.data.matchId !== verdict.matchId) throw new ApiError(401, 'invalid_report_signature', 'Match stats refused: the token names another match');
    // match events are never dropped: a full queue answers 503 and the game server tries again
    if (!analytics.acceptMatch(parsed.data)) throw new ApiError(503, 'busy', 'Stats queue full; try again', {}, { 'Retry-After': '30' });
    return c.json({ queued: true }, 202);
  });
  return app;
}
