/**
 * pnpm --filter @military-forge/asset-pipeline export <in.glb> <out.glb> [--kind character|part|weapon|kit] [--lod 0|1]
 *
 * Exports one source GLB for the web runtime (apps/web/public/assets/**) and prints its budget
 * report. Exits 1 when the asset is over budget (the output is not written).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { BUDGETS, checkBudgets, optimise, type AssetKind, type Lod } from './pipeline';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const [input, output] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
const kind = arg('kind', 'character') as AssetKind;
const lod = Number(arg('lod', '0')) as Lod;
if (!input || !output || !(kind in BUDGETS) || (lod !== 0 && lod !== 1)) {
  console.error('usage: export <in.glb> <out.glb> [--kind character|part|weapon|kit] [--lod 0|1]');
  process.exit(2);
}

await MeshoptDecoder.ready;
const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });

const before = readFileSync(resolve(input)).byteLength;
const doc = await io.read(resolve(input));
await optimise(doc);
const report = checkBudgets(doc, kind, lod);
const bytes = await io.writeBinary(doc);

const s = report.stats;
console.log(`${input} → ${output}`);
console.log(`  ${s.tris} tris · ${s.meshes} mesh · ${s.materials} material · ${s.joints} joints · ${s.animations} clips · max texture ${s.maxTexture}px`);
console.log(`  ${(before / 1024).toFixed(0)} KB → ${(bytes.byteLength / 1024).toFixed(0)} KB · sha256 ${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}`);
for (const w of report.warnings) console.log(`  WARN ${w}`);
for (const f of report.failures) console.log(`  FAIL ${f}`);
if (report.failures.length) process.exit(1);
mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), bytes);
