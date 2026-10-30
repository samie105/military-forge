/** API process: config → logger → Postgres/PGlite + Redis/memory KV → HTTP server. */
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { AnalyticsService } from './analytics/service';
import { createApp } from './app';
import { loadOrCreateDevKey, signingKeyFromPem } from './auth/keys';
import { startRetentionSweep } from './auth/retention';
import { ConfigError, loadConfig, type Config } from './config';
import { openDatabase } from './db/client';
import { MemoryKv, type Kv } from './kv/kv';
import { RedisKv } from './kv/redis';
import { MemoryBus, RedisBus, type EventBus } from './events/bus';
import { createLogger } from './log';
import { keepRooms } from './rooms/routes';
import { SWEEP_EVERY_MS, createStore } from './store';

/** apps/api: relative paths (PGlite data, dev keys) resolve from here, whatever the cwd */
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`[api] ${err.message}`);
  process.exit(1);
}

const log = createLogger(config);
const database = await openDatabase(config, { baseDir: PACKAGE_DIR });
const kv: Kv = config.redisUrl ? await new RedisKv(config.redisUrl).connect() : new MemoryKv();
// the social push channel's fan-out: Valkey pub/sub (any API process delivers), else this process alone
const bus: EventBus = config.redisUrl ? await new RedisBus(config.redisUrl).connect() : new MemoryBus();
// KEEP_ROOMS: the codes a previous run handed out stay joinable (pnpm playtest's restarts)
if (config.keepRooms.length) log.info({ rooms: config.keepRooms, added: await keepRooms(kv, config.keepRooms) }, 'holding room codes from KEEP_ROOMS');
const signingKey = config.accessToken.privateKeyPem
  ? signingKeyFromPem(config.accessToken.privateKeyPem)
  : loadOrCreateDevKey(fileURLToPath(new URL('../.data/dev-keys.json', import.meta.url)));
// join tickets for the game server (docs/06 §6): none without a key (dev: its rooms are open)
const ticketKey = config.joinTicket.privateKeyPem ? signingKeyFromPem(config.joinTicket.privateKeyPem) : null;

// play stats (docs/16): batched writes, day partitions, rollups, deletions; its timers run here
const analytics = new AnalyticsService(database.db, kv, config.analytics, log);
analytics.start();
// the store (docs/17): the sweep credits payments that were paid but never confirmed (≤ 15 min, §2.5's make-good)
const store = createStore(config, database.db, Date.now, log);
if (store.payments) {
  log.info({ mode: store.flutterwave!.mode }, `store on: Flutterwave ${store.flutterwave!.mode} keys`);
  const payments = store.payments;
  setInterval(() => {
    void payments.sweep().then(
      (r) => r.looked && log.info({ store: 'sweep', ...r }, 'payments swept'),
      (err: unknown) => log.error({ err }, 'payments sweep failed'),
    );
  }, SWEEP_EVERY_MS).unref();
} else log.info('store off: no FLUTTERWAVE_* keys');
// sessions and emailed links that ended over 7 days ago are deleted, hourly (auth/retention.ts)
startRetentionSweep(database.db, log);
const app = createApp({ config, database, kv, signingKey, ticketKey, log, bus, analytics, store });
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  log.info(
    { port: info.port, db: database.kind, kv: kv.kind, env: config.env },
    `api listening on http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${info.port} · db ${database.kind} · kv ${kv.kind}`,
  );
  if (database.kind === 'pglite' || kv.kind === 'memory') {
    log.info('no DATABASE_URL/REDIS_URL: embedded PGlite + in-memory KV (docker compose up -d for the production-like stack, see apps/api/README.md)');
  }
});

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    log.info({ signal }, 'shutting down');
    server.close(async () => {
      // what's queued is written before the database closes
      await analytics.stop().catch(() => {});
      await Promise.allSettled([database.close(), kv.close(), bus.close()]);
      process.exit(0);
    });
    // don't hang on keep-alive connections
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
