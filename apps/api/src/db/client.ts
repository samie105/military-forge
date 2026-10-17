/**
 * Opens the database: real Postgres when `DATABASE_URL` is set (docker-compose, production),
 * otherwise PGlite, Postgres compiled to WASM and embedded in the process (dev and tests, no
 * Docker). Both run the same SQL migrations from drizzle/ and expose the same Drizzle API.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { drizzle as drizzlePostgres } from 'drizzle-orm/postgres-js';
import { migrate as migratePostgres } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import type { Config } from '../config';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface Database {
  readonly kind: 'pglite' | 'postgres';
  readonly db: Db;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const MIGRATIONS_DIR = fileURLToPath(new URL('../../drizzle', import.meta.url));
/** pg_advisory_lock key so several API instances starting together migrate one at a time */
const MIGRATION_LOCK = 0x6d696772;

/**
 * @param baseDir resolves a relative PGlite directory (the package root when run via pnpm)
 */
export async function openDatabase(config: Pick<Config, 'db'>, opts: { migrate?: boolean; baseDir?: string } = {}): Promise<Database> {
  const migrate = opts.migrate ?? true;
  if (config.db.kind === 'pglite') {
    const { dataDir } = config.db;
    const inMemory = dataDir === 'memory://';
    const dir = inMemory ? undefined : resolve(opts.baseDir ?? process.cwd(), dataDir);
    if (dir) mkdirSync(dir, { recursive: true });
    const client = new PGlite(dir);
    const db = drizzlePglite({ client, schema });
    if (migrate) await migratePglite(db, { migrationsFolder: MIGRATIONS_DIR });
    return {
      kind: 'pglite',
      db: db as unknown as Db,
      async ping() {
        return client
          .query('select 1')
          .then(() => true)
          .catch(() => false);
      },
      close: () => client.close(),
    };
  }

  const { url } = config.db;
  if (migrate) await migrateWithLock(url);
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return {
    kind: 'postgres',
    db: drizzlePostgres({ client, schema }) as unknown as Db,
    async ping() {
      return client`select 1`.then(() => true).catch(() => false);
    },
    close: () => client.end({ timeout: 5 }),
  };
}

async function migrateWithLock(url: string): Promise<void> {
  const conn = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await conn`select pg_advisory_lock(${MIGRATION_LOCK})`;
    await migratePostgres(drizzlePostgres({ client: conn }), { migrationsFolder: MIGRATIONS_DIR });
    await conn`select pg_advisory_unlock(${MIGRATION_LOCK})`;
  } finally {
    await conn.end({ timeout: 5 });
  }
}

/** True for a Postgres unique-constraint violation (both drivers; Drizzle may wrap it in `cause`). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { code?: unknown }).code === '23505') return true;
  }
  return false;
}
