/**
 * Writes a registered map as JSON, for the art pipeline's kit check (art/pipeline/compile_map.py,
 * a layout with `collision`): pnpm --filter @military-forge/content export-map fog-stair ../../art/maps/fog_stair/fog_stair.map.json
 * (apps/web's fogStair.test.ts fails when the copy no longer matches the map).
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { maps } from '../src/index';

const [id, out] = process.argv.slice(2);
const map = id ? maps[id] : undefined;
if (!map || !out) {
  console.error(`usage: export-map <map id> <out.json> (maps: ${Object.keys(maps).join(', ')})`);
  process.exit(1);
}
writeFileSync(resolve(out), `${JSON.stringify(map, null, 1)}\n`);
console.log(`wrote ${resolve(out)}`);
