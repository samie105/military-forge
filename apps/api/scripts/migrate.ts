/** Applies pending migrations (the API also does this on start): `pnpm --filter @military-forge/api db:migrate` */
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db/client';

const config = loadConfig();
const database = await openDatabase(config, { baseDir: fileURLToPath(new URL('..', import.meta.url)) });
console.log(`[api] migrations applied (${database.kind})`);
await database.close();
