import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { describe, expect, it } from 'vitest';
import { checkBudgets, measure, optimise } from '../src/pipeline';

/** A strip of `quads` quads (2 triangles each) with duplicated vertices, plus an unused material. */
function stripDocument(quads: number): Document {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const positions: number[] = [];
  for (let i = 0; i < quads; i++) {
    // two triangles per quad, written as 6 separate vertices so weld has work to do
    positions.push(i, 0, 0, i + 1, 0, 0, i + 1, 1, 0, i, 0, 0, i + 1, 1, 0, i, 1, 0);
  }
  const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array(positions)).setBuffer(buffer);
  const prim = doc.createPrimitive().setAttribute('POSITION', pos).setMaterial(doc.createMaterial('used'));
  doc.createMaterial('unused');
  const mesh = doc.createMesh('strip').addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('strip').setMesh(mesh));
  return doc;
}

describe('asset pipeline', () => {
  it('counts triangles, materials and joints', () => {
    const stats = measure(stripDocument(10));
    expect(stats).toMatchObject({ tris: 20, meshes: 1, materials: 2, joints: 0, animations: 0 });
  });

  it('flags assets over the docs/11 §3 budgets', () => {
    expect(checkBudgets(stripDocument(1000), 'character', 0).failures).toEqual([]);
    const lod1 = checkBudgets(stripDocument(1000), 'character', 1);
    expect(lod1.failures).toEqual(['2000 triangles > 1800 (character LOD1)']);
    expect(checkBudgets(stripDocument(600), 'weapon', 0).failures[0]).toMatch(/1200 triangles > 1000/);
  });

  it('optimises losslessly: prunes, welds and meshopt-compresses, and the GLB reads back', async () => {
    const doc = stripDocument(50);
    await optimise(doc);
    const stats = measure(doc);
    expect(stats.tris).toBe(100);
    expect(stats.materials).toBe(1); // the unused material is pruned
    const prim = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    expect(prim.getAttribute('POSITION')!.getCount()).toBe(102); // welded: 51 × 2 shared vertices
    expect(doc.getRoot().listExtensionsUsed().map((e) => e.extensionName)).toContain('EXT_meshopt_compression');

    await MeshoptDecoder.ready;
    const io = new NodeIO()
      .registerExtensions(ALL_EXTENSIONS)
      .registerDependencies({ 'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder });
    const back = await io.readBinary(await io.writeBinary(doc));
    expect(measure(back).tris).toBe(100);
  });
});
