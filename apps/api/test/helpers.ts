/**
 * In-process API for tests: PGlite in memory, the in-memory KV and a clock the test moves.
 * Point TEST_DATABASE_URL / TEST_REDIS_URL at the docker-compose services to run the same suite
 * against real Postgres and Valkey (the database's tables are emptied first).
 */
import { sql } from 'drizzle-orm';
import { createApp } from '../src/app';
import { generateSigningKey, type SigningKey } from '../src/auth/keys';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db/client';
import { MemoryKv, type Kv } from '../src/kv/kv';
import { RedisKv } from '../src/kv/redis';
import { createLogger } from '../src/log';

export const START = Date.parse('2026-10-17T12:00:00Z');

export async function createTestApi(env: Record<string, string> = {}, options: { ticketKey?: SigningKey } = {}) {
  const clock = {
    t: START,
    now: () => clock.t,
    advance(ms: number) {
      clock.t += ms;
    },
  };
  const config = loadConfig({
    NODE_ENV: 'test',
    PGLITE_DIR: 'memory://',
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    TRUST_PROXY: 'xff',
    ...env,
  });
  const database = await openDatabase(config);
  if (database.kind === 'postgres') await database.db.execute(sql`truncate table users cascade`);
  const kv: Kv = process.env.TEST_REDIS_URL ? await new RedisKv(process.env.TEST_REDIS_URL).connect() : new MemoryKv(clock.now);
  const app = createApp({ config, database, kv, signingKey: generateSigningKey(), ticketKey: options.ticketKey ?? null, log: createLogger(config), now: clock.now });
  let ipCounter = 0;

  return {
    app,
    clock,
    config,
    database,
    kv,
    /** a fresh client IP, so tests don't share rate-limit buckets */
    ip: () => `203.0.113.${++ipCounter % 250}`,
    async close() {
      await Promise.all([database.close(), kv.close()]);
    },
  };
}

export type TestApi = Awaited<ReturnType<typeof createTestApi>>;

export interface SessionBody {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  user: { id: string; nickname: string; isGuest: boolean; createdAt: string; nicknameChangeableAt: string | null; level: number; xp: number };
}

export function json(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) };
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The refresh cookie's value from a response, or null when it was cleared. */
export function refreshCookie(res: Response): { value: string; attributes: string } | null {
  const header = res.headers.getSetCookie().find((c) => c.startsWith('refresh_token='));
  if (!header) return null;
  const [pair = '', ...attrs] = header.split('; ');
  return { value: pair.slice('refresh_token='.length), attributes: attrs.join('; ') };
}

export async function createGuest(api: TestApi, body: Record<string, unknown> = {}): Promise<SessionBody> {
  const res = await api.app.request('/auth/guest', json(body, { 'x-forwarded-for': api.ip() }));
  if (res.status !== 201) throw new Error(`guest create failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as SessionBody;
}
