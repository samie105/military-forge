/**
 * In-process API for tests: PGlite in memory, the in-memory KV and a clock the test moves.
 * Point TEST_DATABASE_URL / TEST_REDIS_URL at the docker-compose services to run the same suite
 * against real Postgres and Valkey (the database's tables are emptied first).
 */
import { sql } from 'drizzle-orm';
import type { IngestOptions } from '../src/analytics/ingest';
import { AnalyticsService } from '../src/analytics/service';
import { createApp } from '../src/app';
import { generateSigningKey, type SigningKey } from '../src/auth/keys';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db/client';
import { MemoryBus, RedisBus, type EventBus } from '../src/events/bus';
import { MemoryKv, type Kv } from '../src/kv/kv';
import { RedisKv } from '../src/kv/redis';
import { randomUUID } from 'node:crypto';
import type { EmailMessage, EmailSender } from '../src/auth/email';
import { createLogger, type Logger } from '../src/log';

export const START = Date.parse('2026-10-17T12:00:00Z');

export interface TestApiOptions {
  ticketKey?: SigningKey;
  /** account emails: a FakeEmail's sender (fakeEmail()), or null/undefined for none */
  email?: EmailSender | null;
  /** a logger of the test's own (to read the audit trail) */
  log?: Logger;
  /** play stats' ingest queue (back-pressure tests) */
  ingest?: IngestOptions;
}

export async function createTestApi(env: Record<string, string> = {}, options: TestApiOptions = {}) {
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
  if (database.kind === 'postgres') {
    await database.db.execute(sql`truncate table users cascade`);
    await database.db.execute(sql`truncate table analytics_events, analytics_daily, analytics_hourly, analytics_player_days, analytics_players, analytics_forget`);
  }
  // on a shared Valkey each test API gets keys of its own, so runs and files don't share rate-limit buckets
  const keyPrefix = `test:${randomUUID()}:`;
  const kv: Kv = process.env.TEST_REDIS_URL ? await new RedisKv(process.env.TEST_REDIS_URL, { keyPrefix }).connect() : new MemoryKv(clock.now);
  const bus: EventBus = process.env.TEST_REDIS_URL ? await new RedisBus(process.env.TEST_REDIS_URL, keyPrefix).connect() : new MemoryBus();
  const log = options.log ?? createLogger(config);
  // play stats: the tests drive its queue and maintenance by hand (no timers)
  const analytics = new AnalyticsService(database.db, kv, config.analytics, log, clock.now, options.ingest);
  // work the API does after answering (account emails): collected, so a test can wait for it
  const deferred: Promise<void>[] = [];
  const defer = (task: () => Promise<void>) => void deferred.push(task());
  const deps = {
    config,
    database,
    kv,
    bus,
    signingKey: generateSigningKey(),
    ticketKey: options.ticketKey ?? null,
    log,
    now: clock.now,
    analytics,
    email: options.email ?? null,
    defer,
  };
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
    /** play stats (analytics/service.ts) */
    analytics,
    database,
    kv,
    /** the push channel's fan-out (events/bus.ts) */
    bus,
    /** waits for the work the API deferred until after its answers (account emails) */
    async settle() {
      while (deferred.length) await deferred.shift();
    },
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

/** An email "provider" that keeps what it was given. */
export function fakeEmail() {
  const sent: EmailMessage[] = [];
  return {
    sender: { send: async (m: EmailMessage) => void sent.push(m) } satisfies EmailSender,
    sent,
    /** the token in a message's link (#reset=… or #confirm=…), or null */
    token(m: EmailMessage | undefined, kind: 'reset' | 'confirm'): string | null {
      return (m && new RegExp(`#${kind}=([A-Za-z0-9_.-]+)`).exec(m.text)?.[1]) ?? null;
    },
  };
}
