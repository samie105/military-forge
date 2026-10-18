/** API process: config → logger → Postgres/PGlite + Redis/memory KV → HTTP server. */
import { serve } from '@hono/node-server';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { loadOrCreateDevKey, signingKeyFromPem } from './auth/keys';
import { ConfigError, loadConfig, type Config } from './config';
import { openDatabase } from './db/client';
import { MemoryKv, type Kv } from './kv/kv';
import { RedisKv } from './kv/redis';
import { createLogger } from './log';

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
const signingKey = config.accessToken.privateKeyPem
  ? signingKeyFromPem(config.accessToken.privateKeyPem)
  : loadOrCreateDevKey(fileURLToPath(new URL('../.data/dev-keys.json', import.meta.url)));
// join tickets for the game server (docs/06 §6): none without a key (dev: its rooms are open)
const ticketKey = config.joinTicket.privateKeyPem ? signingKeyFromPem(config.joinTicket.privateKeyPem) : null;

const app = createApp({ config, database, kv, signingKey, ticketKey, log });
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
      await Promise.allSettled([database.close(), kv.close()]);
      process.exit(0);
    });
    // don't hang on keep-alive connections
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}
