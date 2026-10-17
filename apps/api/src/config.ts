/**
 * Environment config, parsed and validated once at start-up (docs/10 §2.7: secrets come from the
 * environment, never the bundle).
 *
 * Production refuses to start without its real dependencies. Development and tests fall back to
 * embedded Postgres (PGlite), an in-memory KV and a dev signing key, so `pnpm dev` and `pnpm test`
 * work without Docker. The full list with examples is in `.env.example`.
 */
import { z } from 'zod';

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
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'ACCESS_TOKEN_PRIVATE_KEY', 'CORS_ORIGINS'] as const) {
      if (!e[key]) issues.push(`${key}: required in production`);
    }
  }
  if (e.COOKIE_SAMESITE === 'None' && !secure) issues.push('COOKIE_SAMESITE: None requires COOKIE_SECURE=true');
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
  };
}
