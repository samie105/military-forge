/**
 * Moves a PGlite directory's rows into the Postgres at DATABASE_URL (both migrated first), for a
 * box that ran on PGlite and now has real Postgres (scripts/net-trial/cloud-init.sh does this once).
 * Rows the target already has are skipped, so a second run adds nothing. The API must be stopped:
 * PGlite has one writer.
 *   DATABASE_URL=postgres://… pnpm --filter @military-forge/api exec tsx scripts/import-pglite.ts <pglite dir>
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db/client';
import { copyAllTables } from '../src/db/copy';

const dir = process.argv[2];
if (!dir || !existsSync(resolve(dir, 'PG_VERSION'))) {
  console.error('usage: import-pglite.ts <pglite dir> (with DATABASE_URL set); no PGlite data there');
  process.exit(2);
}
const config = loadConfig();
if (config.db.kind !== 'postgres') {
  console.error('import-pglite: DATABASE_URL is not set');
  process.exit(2);
}
const target = await openDatabase(config);
const source = await openDatabase({ db: { kind: 'pglite', dataDir: resolve(dir) } });
try {
  const counts = await copyAllTables(source.db, target.db);
  console.log(`[api] PGlite → Postgres: ${Object.entries(counts).map(([t, c]) => `${t} ${c.added}/${c.read}`).join(', ')}`);
} finally {
  await Promise.all([source.close(), target.close()]);
}
