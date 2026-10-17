/**
 * Writes packages/content/schema/map.schema.json from the zone and event catalogue (mapJsonSchema).
 * Run after changing ZONE_KINDS, EVENT_KINDS or MODIFIER_FIELDS: pnpm --filter @military-forge/content schema
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapJsonSchema } from '../src/maps/mapJson';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'schema', 'map.schema.json');
writeFileSync(out, `${JSON.stringify(mapJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
