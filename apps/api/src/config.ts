/**
 * Environment config, parsed and validated once at start-up (docs/10 §2.7: secrets come from the
 * environment, never the bundle).
 *
 * Production refuses to start without its real dependencies. Development and tests fall back to
 * embedded Postgres (PGlite), an in-memory KV and a dev signing key, so `pnpm dev` and `pnpm test`
 * work without Docker. The full list with examples is in `.env.example`.
 */
import { getCosmetic } from '@military-forge/content';
import { normalizeRoomCode } from '@military-forge/shared';
import { z } from 'zod';
/** Resend's endpoint (auth/email.ts has the sender); a plain constant, so config stays free of app imports */
const RESEND_API_URL = 'https://api.resend.com/emails';
const FLUTTERWAVE_API_URL = 'https://api.flutterwave.com';

export type NodeEnv = 'development' | 'test' | 'production';
export type TrustProxy = 'none' | 'cloudflare' | 'xff';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface Config {
  env: NodeEnv;
  host: string;
  port: number;
  /** Postgres via `DATABASE_URL`, else PGlite in `dataDir` (`memory://` = throwaway) */
  db: { kind: 'postgres'; url: string } | { kind: 'pglite'; dataDir: string };
  /** null = in-memory KV (single process only) */
  redisUrl: string | null;
  accessToken: {
    /** Ed25519 PKCS#8 PEM; null outside production = dev key (generated, see auth/keys.ts) */
    privateKeyPem: string | null;
    ttlSeconds: number;
  };
  refreshTokenTtlDays: number;
  /** exact origins, or 'localhost' = any http(s)://localhost|127.0.0.1 origin (dev default) */
  corsOrigins: string[] | 'localhost';
  cookie: { secure: boolean; sameSite: 'Lax' | 'Strict' | 'None'; domain: string | null };
  /** where the client IP for rate limits comes from */
  trustProxy: TrustProxy;
  /** with `xff`: how many trusted proxies append to X-Forwarded-For (the client IP is this many entries from the right) */
  trustProxyHops: number;
  logLevel: LogLevel;
  /** extra impersonation-protected names (staff), on top of the built-in list */
  reservedNicknames: string[];
  /** GET /version: the oldest web client build that may still play (older ones must reload), and the newest; null = not set */
  client: { minVersion: string | null; latestVersion: string | null };
  /** public WebSocket base of the game server (rooms join at `<it>/ws/<code>`); null = the site's own origin */
  gameServerUrl: string | null;
  /**
   * Join tickets (docs/06 §6): an Ed25519 key of their own (PKCS#8 PEM) that signs a short-lived
   * ticket per room join; the game server holds the public half. null = no tickets (dev: the game
   * server's rooms are open then); production requires it.
   */
  joinTicket: { privateKeyPem: string | null; ttlSeconds: number };
  /**
   * Room codes to hold open from start-up (KEEP_ROOMS): a restarted API with an in-memory KV keeps
   * the links it handed out (pnpm playtest passes the rooms in play when it restarts the API).
   */
  keepRooms: string[];
  /**
   * Match results from the game server (POST /internal/matches, docs/07 §12): the public half of
   * the game server's own Ed25519 results key (PEM). null = the route is off (no results recorded).
   */
  resultsPublicKeyPem: string | null;
  /**
   * The owner's admin token (ADMIN_TOKEN, the same secret as the game server's admin page): reads
   * the problem reports players send (GET /v1/admin/reports). null = those routes are off.
   */
  adminToken: string | null;
  /**
   * Cosmetics the owner has granted accounts (COSMETIC_GRANTS="<accountId>:<itemId>,..."): owned like items bought
   * in the store or granted from the admin page (the inventory table; store/wallet.ts owned() reads both). The
   * loadout check, the join ticket's vouched look and GET /me read it. Empty = none.
   */
  cosmeticGrants: ReadonlyMap<string, readonly string[]>;
  /**
   * The game's public address (APP_URL; default: the first CORS origin, or Vite's dev address):
   * the links in account emails open it.
   */
  appUrl: string;
  /**
   * Account emails (auth/email.ts): forgot password and confirming a saved account's email.
   * null = off (EMAIL_PROVIDER unset): "Forgot password?" is hidden and a saved email links at once.
   */
  email: { provider: 'resend'; apiUrl: string; apiKey: string; from: string } | { provider: 'log' } | null;
  /**
   * Cloudflare Turnstile's secret (TURNSTILE_SECRET): the bot check on saving an account and
   * "Forgot password?" (auth/botCheck.ts). null = off (dev, tests). The web build's
   * VITE_TURNSTILE_SITEKEY shows the widget; set both together.
   */
  turnstileSecret: string | null;
  /** play stats (docs/16-player-metrics.md) */
  analytics: AnalyticsConfig;
  /**
   * Flutterwave's keys (FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_PUBLIC_KEY, FLUTTERWAVE_WEBHOOK_HASH; the dashboard →
   * Settings → API keys and Webhooks). null = all unset: the whole store is off (GET /store says so). Test keys
   * (…_TEST-…) take no real money. The money path is store/payments.ts.
   */
  flutterwave: { secretKey: string; publicKey: string; webhookHash: string; apiUrl: string } | null;
}

export interface AnalyticsConfig {
  /** days the raw events are kept (ANALYTICS_RAW_DAYS, default 90); the rollups outlive them */
  rawDays: number;
  /** the "Help improve the game" default outside Europe (ANALYTICS_CONSENT); Europe is always opt-in */
  consentDefault: 'opt-in' | 'opt-out';
  /** house-ad rotation may weight on the player's segments (ANALYTICS_AD_SEGMENTS; off by default) */
  adSegments: boolean;
  /** an IP-range → country CSV (ANALYTICS_GEOIP_CSV); none = country from the device's time zone */
  geoipCsv: string | null;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigError';
  }
}

const list = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_HOST: z.string().min(1).default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// URL' }).optional(),
  PGLITE_DIR: z.string().min(1).default('.data/pglite'),
  REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' }).optional(),
  ACCESS_TOKEN_PRIVATE_KEY: z.string().min(1).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(60),
  CORS_ORIGINS: list.pipe(z.array(z.url())).optional(),
  COOKIE_SECURE: bool.optional(),
  COOKIE_SAMESITE: z.enum(['Lax', 'Strict', 'None']).default('Lax'),
  COOKIE_DOMAIN: z.string().min(1).optional(),
  TRUST_PROXY: z.enum(['none', 'cloudflare', 'xff']).default('none'),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  RESERVED_NICKNAMES: list.default([]),
  MIN_CLIENT_VERSION: z.string().max(64).optional(),
  LATEST_CLIENT_VERSION: z.string().max(64).optional(),
  GAME_SERVER_URL: z.url({ protocol: /^wss?$/, error: 'must be a ws:// or wss:// URL' }).optional(),
  JOIN_TICKET_PRIVATE_KEY: z.string().min(1).optional(),
  JOIN_TICKET_TTL_SECONDS: z.coerce.number().int().min(5).max(120).default(30),
  KEEP_ROOMS: list.default([]),
  RESULTS_PUBLIC_KEY: z.string().min(1).optional(),
  ADMIN_TOKEN: z.string().min(16).optional(),
  COSMETIC_GRANTS: list.default([]),
  APP_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
  EMAIL_PROVIDER: z.enum(['resend', 'log']).optional(),
  EMAIL_API_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
  EMAIL_API_KEY: z.string().min(8).optional(),
  EMAIL_FROM: z.string().min(3).max(200).optional(),
  TURNSTILE_SECRET: z.string().min(8).max(200).optional(),
  ANALYTICS_RAW_DAYS: z.coerce.number().int().min(7).max(400).default(90),
  ANALYTICS_CONSENT: z.enum(['opt-in', 'opt-out']).default('opt-in'),
  ANALYTICS_AD_SEGMENTS: bool.default(false),
  ANALYTICS_GEOIP_CSV: z.string().min(1).optional(),
  FLUTTERWAVE_SECRET_KEY: z.string().regex(/^FLWSECK(_TEST)?-[A-Za-z0-9-]{8,}$/, 'must be a Flutterwave secret key (FLWSECK-… or FLWSECK_TEST-…)').optional(),
  FLUTTERWAVE_PUBLIC_KEY: z.string().regex(/^FLWPUBK(_TEST)?-[A-Za-z0-9-]{8,}$/, 'must be a Flutterwave public key (FLWPUBK-… or FLWPUBK_TEST-…)').optional(),
  FLUTTERWAVE_WEBHOOK_HASH: z.string().min(16, 'at least 16 characters (a long random string)').max(200).optional(),
  FLUTTERWAVE_API_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s):// URL' }).optional(),
});

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // `FOO=` in a .env file means "unset", not "empty string"
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || 'env'}: ${i.message}`));
  }
  const e = parsed.data;
  const production = e.NODE_ENV === 'production';
  const secure = e.COOKIE_SECURE ?? production;

  const issues: string[] = [];
  if (production) {
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'ACCESS_TOKEN_PRIVATE_KEY', 'JOIN_TICKET_PRIVATE_KEY', 'CORS_ORIGINS'] as const) {
      if (!e[key]) issues.push(`${key}: required in production`);
    }
  }
  if (e.COOKIE_SAMESITE === 'None' && !secure) issues.push('COOKIE_SAMESITE: None requires COOKIE_SECURE=true');
  const keepRooms: string[] = [];
  for (const raw of e.KEEP_ROOMS) {
    const code = normalizeRoomCode(raw);
    if (code) keepRooms.push(code);
    else issues.push(`KEEP_ROOMS: "${raw}" is not a room code`);
  }
  const cosmeticGrants = new Map<string, string[]>();
  for (const raw of e.COSMETIC_GRANTS) {
    const [user, item, ...rest] = raw.split(':').map((x) => x.trim());
    if (!user || !item || rest.length) issues.push(`COSMETIC_GRANTS: "${raw}" is not <accountId>:<itemId>`);
    else if (!getCosmetic(item)) issues.push(`COSMETIC_GRANTS: "${item}" is not a cosmetic item`);
    else cosmeticGrants.set(user, [...(cosmeticGrants.get(user) ?? []), item]);
  }
  if (e.EMAIL_PROVIDER === 'resend') {
    if (!e.EMAIL_API_KEY) issues.push('EMAIL_API_KEY: required with EMAIL_PROVIDER=resend');
    if (!e.EMAIL_FROM) issues.push('EMAIL_FROM: required with EMAIL_PROVIDER=resend (e.g. "Military Forge <no-reply@example.com>")');
  }
  if (e.EMAIL_PROVIDER === 'log' && production) issues.push('EMAIL_PROVIDER: log writes reset links to the log; not in production');
  if (e.EMAIL_PROVIDER === 'resend' && production && e.EMAIL_API_URL && !e.EMAIL_API_URL.startsWith('https://')) issues.push('EMAIL_API_URL: must be https:// in production');
  const appUrl = (e.APP_URL ?? e.CORS_ORIGINS?.[0] ?? 'http://localhost:5173').replace(/\/+$/, '');
  if (production && e.EMAIL_PROVIDER && !appUrl.startsWith('https://')) issues.push('APP_URL: the links in emails must be https:// in production (set APP_URL or CORS_ORIGINS)');
  const flw = [e.FLUTTERWAVE_SECRET_KEY, e.FLUTTERWAVE_PUBLIC_KEY, e.FLUTTERWAVE_WEBHOOK_HASH];
  if (flw.some(Boolean) && !flw.every(Boolean)) issues.push('FLUTTERWAVE_*: set FLUTTERWAVE_SECRET_KEY, FLUTTERWAVE_PUBLIC_KEY and FLUTTERWAVE_WEBHOOK_HASH together (or none: the store is off)');
  if (e.FLUTTERWAVE_SECRET_KEY && e.FLUTTERWAVE_PUBLIC_KEY && e.FLUTTERWAVE_SECRET_KEY.includes('_TEST-') !== e.FLUTTERWAVE_PUBLIC_KEY.includes('_TEST-')) issues.push('FLUTTERWAVE_*: the secret and public keys must both be test keys or both live keys');
  if (production && e.FLUTTERWAVE_API_URL && !e.FLUTTERWAVE_API_URL.startsWith('https://')) issues.push('FLUTTERWAVE_API_URL: must be https:// in production');
  if (issues.length) throw new ConfigError(issues);

  return {
    env: e.NODE_ENV,
    host: e.API_HOST,
    port: e.API_PORT,
    db: e.DATABASE_URL ? { kind: 'postgres', url: e.DATABASE_URL } : { kind: 'pglite', dataDir: e.PGLITE_DIR },
    redisUrl: e.REDIS_URL ?? null,
    accessToken: {
      // keys pasted into a single-line env var usually arrive with literal "\n"
      privateKeyPem: e.ACCESS_TOKEN_PRIVATE_KEY?.replaceAll('\\n', '\n') ?? null,
      ttlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
    },
    refreshTokenTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    corsOrigins: e.CORS_ORIGINS ?? 'localhost',
    cookie: { secure, sameSite: e.COOKIE_SAMESITE, domain: e.COOKIE_DOMAIN ?? null },
    trustProxy: e.TRUST_PROXY,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    logLevel: e.LOG_LEVEL ?? (e.NODE_ENV === 'test' ? 'silent' : 'info'),
    reservedNicknames: e.RESERVED_NICKNAMES,
    client: { minVersion: e.MIN_CLIENT_VERSION ?? null, latestVersion: e.LATEST_CLIENT_VERSION ?? null },
    gameServerUrl: e.GAME_SERVER_URL?.replace(/\/+$/, '') ?? null,
    joinTicket: { privateKeyPem: e.JOIN_TICKET_PRIVATE_KEY?.replaceAll('\\n', '\n') ?? null, ttlSeconds: e.JOIN_TICKET_TTL_SECONDS },
    keepRooms: [...new Set(keepRooms)],
    resultsPublicKeyPem: e.RESULTS_PUBLIC_KEY?.replaceAll('\\n', '\n') ?? null,
    adminToken: e.ADMIN_TOKEN ?? null,
    cosmeticGrants,
    appUrl,
    email:
      e.EMAIL_PROVIDER === 'resend'
        ? { provider: 'resend', apiUrl: e.EMAIL_API_URL ?? RESEND_API_URL, apiKey: e.EMAIL_API_KEY!, from: e.EMAIL_FROM! }
        : e.EMAIL_PROVIDER === 'log'
          ? { provider: 'log' }
          : null,
    turnstileSecret: e.TURNSTILE_SECRET ?? null,
    analytics: { rawDays: e.ANALYTICS_RAW_DAYS, consentDefault: e.ANALYTICS_CONSENT, adSegments: e.ANALYTICS_AD_SEGMENTS, geoipCsv: e.ANALYTICS_GEOIP_CSV ?? null },
    flutterwave:
      e.FLUTTERWAVE_SECRET_KEY && e.FLUTTERWAVE_PUBLIC_KEY && e.FLUTTERWAVE_WEBHOOK_HASH
        ? { secretKey: e.FLUTTERWAVE_SECRET_KEY, publicKey: e.FLUTTERWAVE_PUBLIC_KEY, webhookHash: e.FLUTTERWAVE_WEBHOOK_HASH, apiUrl: (e.FLUTTERWAVE_API_URL ?? FLUTTERWAVE_API_URL).replace(/\/+$/, '') }
        : null,
  };
}
