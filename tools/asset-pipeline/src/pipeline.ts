/**
 * Runtime export stage of the asset pipeline (docs/11 §4): source glTF from Blender → web GLB.
 * dedup → prune → resample → weld → meshopt (reorder + quantise + EXT_meshopt_compression), then
 * the budget checks from docs/11 §3 and docs/04 §5. KTX2 textures need `toktx` (KTX-Software, a
 * user install) and are not produced yet: textures pass through unchanged and the report says so.
 */
import type { Document } from '@gltf-transform/core';
import { dedup, meshopt, prune, resample, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

export type AssetKind = 'character' | 'part' | 'weapon' | 'kit';
export type Lod = 0 | 1;

interface Budget {
  /** triangles per LOD */
  tris: [number, number];
  /** largest texture edge per LOD (px) */
  texture: [number, number];
  /** skin joints (bones + sockets); 0 = must not be skinned */
  joints: number;
}

/** docs/11 §3 (characters), w8-art-assets slot budgets (parts: the jetpack is the largest), weapons ≤ 1k. */
export const BUDGETS: Record<AssetKind, Budget> = {
  character: { tris: [4000, 1800], texture: [1024, 512], joints: 40 },
  part: { tris: [550, 250], texture: [512, 256], joints: 40 },
  weapon: { tris: [1000, 500], texture: [512, 256], joints: 0 },
  kit: { tris: [20000, 20000], texture: [1024, 1024], joints: 0 },
};

export interface AssetStats {
  tris: number;
  maxTexture: number;
  joints: number;
  meshes: number;
  materials: number;
  animations: number;
}

export interface CheckResult {
  stats: AssetStats;
  failures: string[];
  warnings: string[];
}

export function measure(doc: Document): AssetStats {
  const root = doc.getRoot();
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4) continue; // TRIANGLES
      const count = prim.getIndices()?.getCount() ?? prim.getAttribute('POSITION')?.getCount() ?? 0;
      tris += Math.floor(count / 3);
    }
  }
  let maxTexture = 0;
  for (const tex of root.listTextures()) {
    const size = tex.getSize();
    if (size) maxTexture = Math.max(maxTexture, size[0], size[1]);
  }
  const joints = root.listSkins().reduce((n, s) => Math.max(n, s.listJoints().length), 0);
  return {
    tris,
    maxTexture,
    joints,
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    animations: root.listAnimations().length,
  };
}

export function checkBudgets(doc: Document, kind: AssetKind, lod: Lod): CheckResult {
  const stats = measure(doc);
  const budget = BUDGETS[kind];
  const failures: string[] = [];
  const warnings: string[] = [];
  if (stats.tris > budget.tris[lod]) failures.push(`${stats.tris} triangles > ${budget.tris[lod]} (${kind} LOD${lod})`);
  if (stats.maxTexture > budget.texture[lod]) failures.push(`${stats.maxTexture}px texture > ${budget.texture[lod]}px (${kind} LOD${lod})`);
  if (budget.joints === 0 && stats.joints > 0) failures.push(`${kind} must not be skinned (${stats.joints} joints)`);
  if (stats.joints > budget.joints && budget.joints > 0) failures.push(`${stats.joints} joints > ${budget.joints}`);
  if (stats.materials > 1 && kind !== 'kit') warnings.push(`${stats.materials} materials: more than one draw call`);
  for (const tex of doc.getRoot().listTextures()) {
    const size = tex.getSize();
    if (size && (!isPow2(size[0]) || !isPow2(size[1]))) failures.push(`texture ${tex.getName() || tex.getURI()} is ${size[0]}×${size[1]}, not a power of two`);
    if (tex.getMimeType() !== 'image/ktx2') warnings.push(`texture ${tex.getName() || '(unnamed)'} is ${tex.getMimeType()}, not KTX2 (toktx not installed)`);
  }
  return { stats, failures, warnings };
}

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Optimises `doc` in place for the web runtime. */
export async function optimise(doc: Document): Promise<void> {
  await MeshoptEncoder.ready;
  await doc.transform(dedup(), prune(), resample(), weld(), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
}
