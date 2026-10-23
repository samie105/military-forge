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
import { MemoryBus, RedisBus, type EventBus } from '../src/events/bus';
import { MemoryKv, type Kv } from '../src/kv/kv';
import { RedisKv } from '../src/kv/redis';
import { randomUUID } from 'node:crypto';
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
  // on a shared Valkey each test API gets keys of its own, so runs and files don't share rate-limit buckets
  const keyPrefix = `test:${randomUUID()}:`;
  const kv: Kv = process.env.TEST_REDIS_URL ? await new RedisKv(process.env.TEST_REDIS_URL, { keyPrefix }).connect() : new MemoryKv(clock.now);
  const bus: EventBus = process.env.TEST_REDIS_URL ? await new RedisBus(process.env.TEST_REDIS_URL, keyPrefix).connect() : new MemoryBus();
  const deps = { config, database, kv, bus, signingKey: generateSigningKey(), ticketKey: options.ticketKey ?? null, log: createLogger(config), now: clock.now };
  const app = createApp(deps);
  let ipCounter = 0;
  const reconnected: Kv[] = [];

  return {
    app,
    /**
     * The API process restarting: a new app on the same database and the same Valkey (a new
     * connection to it when TEST_REDIS_URL is set; with the in-memory KV, the same object stands in
     * for Valkey). Its own state in memory starts over.
     */
    async restart() {
      const kv2 = process.env.TEST_REDIS_URL ? await new RedisKv(process.env.TEST_REDIS_URL, { keyPrefix }).connect() : kv;
      if (kv2 !== kv) reconnected.push(kv2);
      return createApp({ ...deps, kv: kv2 });
    },
    clock,
    config,
    database,
    kv,
    /** the push channel's fan-out (events/bus.ts) */
    bus,
    /** a fresh client IP, so tests don't share rate-limit buckets */
    ip: () => `203.0.113.${++ipCounter % 250}`,
    async close() {
      await Promise.all([database.close(), kv.close(), bus.close(), ...reconnected.map((k) => k.close())]);
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

let befriendIp = 0;

/** Makes two players friends through the API (a request by friend code, then accept). */
export async function befriend(app: TestApi['app'], a: SessionBody, b: SessionBody): Promise<void> {
  const list = (await (await app.request('/friends', { headers: bearer(b.accessToken) })).json()) as { code: string };
  const asked = await app.request('/friends/requests', json({ code: list.code }, { ...bearer(a.accessToken), 'x-forwarded-for': `198.51.100.${++befriendIp % 250}` }));
  if (asked.status !== 200) throw new Error(`friend request failed: ${asked.status} ${await asked.text()}`);
  const accepted = await app.request(`/friends/requests/${a.user.id}/accept`, json({}, bearer(b.accessToken)));
  if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${await accepted.text()}`);
}
