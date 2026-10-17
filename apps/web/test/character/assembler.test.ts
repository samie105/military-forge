import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Box3, Color, Vector3, type BufferAttribute } from 'three';
import { describe, expect, it } from 'vitest';
import { COSMETIC_ENVELOPE_MUL, DEFAULT_COSMETIC_LOADOUT, cosmeticsForSlot, getCosmetic, type CosmeticLoadout } from '@military-forge/content';
import { CharacterAssembler, DyeMaterial, selectLod } from '../../src/character';
import { widenPoint } from '../../src/character/assembler';
import { BUILT_IN, PLACEHOLDERS, Region, classifyRegion } from '../../src/character/rookiePhase0';
import { FAKE_URLS, JOINTS, TRIANGLES, fakeLoader } from './fakeRig';

const assembler = () => new CharacterAssembler({ loader: fakeLoader(), baseUrls: FAKE_URLS });
const wearing = (items: Partial<CosmeticLoadout['items']>, dyes: Partial<CosmeticLoadout['dyes']> = {}): CosmeticLoadout => ({
  items: { ...DEFAULT_COSMETIC_LOADOUT.items, ...items },
  dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes, ...dyes },
});
const triangles = (i: { meshes: readonly { geometry: { getIndex(): BufferAttribute | null } }[] }) => i.meshes[0]!.geometry.getIndex()!.count / 3;

describe('CharacterAssembler', () => {
  it('builds one skinned mesh with the dye material, its own bones and the shared clips', async () => {
    const a = assembler();
    const c = await a.create(null);
    expect(c.meshes).toHaveLength(1);
    expect(c.meshes[0]!.material).toBeInstanceOf(DyeMaterial);
    expect(c.bone('socket_jetpack')?.name).toBe('socket_jetpack');
    expect(c.bone('nope')).toBeNull();
    expect(c.clips.map((clip) => clip.name)).toEqual(['idle']);
    expect(triangles(c)).toBe(TRIANGLES.length); // default parts are built in: nothing hidden, nothing added
    const other = await a.create(null);
    expect(other.bone('head')).not.toBe(c.bone('head'));
  });

  it('merges placeholder parts, rigidly skinned to their bone, and hides the built-in part they replace', async () => {
    const c = await (assembler()).create(wearing({ eyewear: 'eyewear_aviators', boots: 'boots_jungle' }));
    const g = c.meshes[0]!.geometry;
    expect(triangles(c)).toBeGreaterThan(TRIANGLES.length);
    const layer = g.getAttribute('texLayer');
    const joint = g.getAttribute('skinIndex');
    const weight = g.getAttribute('skinWeight');
    const bones = new Set<string>();
    for (let v = 0; v < layer.count; v++) {
      if (layer.getX(v) >= 0) continue;
      bones.add(JOINTS[joint.getX(v)]!);
      expect(weight.getX(v)).toBe(1);
    }
    expect(bones).toEqual(new Set(['head', 'foot_L', 'foot_R']));
    // the baked boot triangle is gone from the index
    const index = g.getIndex()!;
    const pos = g.getAttribute('position');
    for (let i = 0; i < index.count; i++) if (layer.getX(index.getX(i)) >= 0) expect(pos.getY(index.getX(i))).toBeGreaterThan(0.1);
  });

  it('items without art keep the built-in default (a part never goes missing)', async () => {
    const c = await assembler().create(wearing({ headgear: 'headgear_crown', top: 'top_track_jacket' }));
    expect(triangles(c)).toBe(TRIANGLES.length);
  });

  it('caches merged geometry by parts; dyes and skin are uniforms', async () => {
    const a = assembler();
    const one = await a.create(wearing({ headgear: 'headgear_beret' }));
    const two = await a.create(wearing({ headgear: 'headgear_beret', skinTone: 'skin_11' }, { primary: 'dye_red' }));
    expect(two.meshes[0]!.geometry).toBe(one.meshes[0]!.geometry);
    expect(a.stats).toEqual({ builds: 1, hits: 1 });
    expect(two.material.dye.primary.equals(new Color(getCosmetic('dye_red')!.colour!))).toBe(true);
    expect(two.material.dye.skin.equals(new Color(getCosmetic('skin_11')!.colour!))).toBe(true);
    expect(two.loadoutHash).not.toBe(one.loadoutHash);

    const geometry = two.meshes[0]!.geometry;
    two.setLoadout(wearing({ headgear: 'headgear_beret' }, { accent: 'dye_gold' }));
    expect(two.meshes[0]!.geometry).toBe(geometry);
    two.setLoadout(wearing({ jetpack: 'jetpack_drum', exhaust: 'exhaust_plasma' }));
    expect(two.meshes[0]!.geometry).not.toBe(geometry);
    expect(two.exhaustColour.equals(new Color(getCosmetic('exhaust_plasma')!.colour!))).toBe(true);
    expect(a.stats.builds).toBe(2);
  });

  it('body types change width below the neck only', async () => {
    const a = assembler();
    const extent = async (bodyType: string) => {
      const g = (await a.create(wearing({ bodyType }))).meshes[0]!.geometry;
      const pos = g.getAttribute('position');
      const xs = (pred: (y: number) => boolean) => Math.max(...Array.from({ length: pos.count }, (_, i) => (pred(pos.getY(i)) ? Math.abs(pos.getX(i)) : 0)));
      return { body: xs((y) => y < 0.9), head: xs((y) => y > 1) };
    };
    const standard = await extent('body_standard');
    const stocky = await extent('body_stocky');
    expect(stocky.body).toBeCloseTo(standard.body * 1.08, 5);
    expect(stocky.head).toBe(standard.head);
  });

  it('switches LOD on the same skeleton, remapping joints to LOD0 order', async () => {
    const c = await assembler().create(wearing({ eyewear: 'eyewear_aviators' }));
    const bones = c.meshes[0]!.skeleton.bones;
    c.setLod(1);
    expect(c.lod).toBe(1);
    expect(c.meshes[0]!.skeleton.bones).toBe(bones);
    const g = c.meshes[0]!.geometry;
    const joint = g.getAttribute('skinIndex');
    const pos = g.getAttribute('position');
    for (let v = 0; v < joint.count; v++) if (pos.getY(v) > 1.3 && g.getAttribute('texLayer').getX(v) >= 0) expect(JOINTS[joint.getX(v)]).toBe('head');
  });

  it('keeps unused builds for re-use and frees them past the idle limit', async () => {
    const a = assembler();
    const c = await a.create(null);
    const first = c.meshes[0]!.geometry;
    c.dispose();
    expect((await a.create(null)).meshes[0]!.geometry).toBe(first);
    const skins = ['skin_01', 'skin_02', 'skin_03'];
    for (const [i, headgear] of ['headgear_field_cap', 'headgear_bandana', 'headgear_beret', 'headgear_combat_helmet'].entries()) {
      for (const eyewear of ['eyewear_aviators', 'eyewear_gas_mask', 'eyewear_none']) (await a.create(wearing({ headgear, eyewear, skinTone: skins[i % 3]! }))).dispose();
    }
    expect(a.stats.builds).toBe(13);
    (await a.create(wearing({ headgear: 'headgear_field_cap', eyewear: 'eyewear_aviators' }))).dispose();
    expect(a.stats.builds).toBe(14); // the oldest idle build was evicted
  });
});

describe('selectLod', () => {
  it('uses LOD1 only when small on screen, with hysteresis', () => {
    expect(selectLod(80, 0)).toBe(0);
    expect(selectLod(39, 0)).toBe(1);
    expect(selectLod(45, 1)).toBe(1);
    expect(selectLod(49, 1)).toBe(0);
  });
});

describe('Phase 0 Rookie parts', () => {
  // asset-check base bbox (art/character/rookie.check.txt), converted to glTF axes
  const base = new Box3().set({ x: -0.471, y: -0.003, z: -0.401 } as never, { x: 0.471, y: 1.502, z: 0.341 } as never);
  const envelope = base.clone().expandByVector(base.getSize(base.min.clone()).multiplyScalar((COSMETIC_ENVELOPE_MUL - 1) / 2));

  const bodyTypes = cosmeticsForSlot('bodyType').map((c) => c.id);

  it('every body type keeps the base body inside the envelope and never narrows it (docs/04 §1.2)', () => {
    for (const id of bodyTypes) {
      const widthMul = getCosmetic(id)!.widthMul!;
      expect(widthMul, id).toBeGreaterThanOrEqual(1);
      const corners = [base.min, base.max].flatMap((a) => [base.min, base.max].flatMap((b) => [base.min, base.max].map((c) => new Vector3(a.x, b.y, c.z))));
      for (const corner of corners) expect(envelope.containsPoint(widenPoint(corner.clone(), widthMul)), `${id} ${corner.toArray()}`).toBe(true);
    }
  });

  for (const [id, recipe] of Object.entries(PLACEHOLDERS)) {
    it(`${id}: real item, known bones, inside the cosmetic envelope on every body type (docs/04 §1.2)`, async () => {
      const item = getCosmetic(id)!;
      expect(BUILT_IN[item.slot as keyof typeof BUILT_IN]?.item).not.toBe(id);
      for (const p of recipe()) expect(JOINTS).toContain(p.bone);
      const a = assembler();
      for (const bodyType of bodyTypes) {
        // assembled, so the body type's fitting is included (a part's vertices have texLayer -1)
        const g = (await a.create(wearing({ bodyType, [item.slot]: id }))).meshes[0]!.geometry;
        const layer = g.getAttribute('texLayer');
        const pos = g.getAttribute('position');
        const bounds = new Box3();
        for (let v = 0; v < pos.count; v++) if (layer.getX(v) < 0) bounds.expandByPoint(new Vector3().fromBufferAttribute(pos, v));
        expect(bounds.isEmpty(), `${id} on ${bodyType}`).toBe(false);
        expect(envelope.containsBox(bounds), `${id} on ${bodyType}: ${bounds.min.toArray()} ${bounds.max.toArray()}`).toBe(true);
      }
    });
  }

  it('classifies baked regions', () => {
    expect(classifyRegion('head', 0, 1.4, 0, 0)).toBe(Region.Helmet);
    expect(classifyRegion('head', 0, 1.1, 0.2, 1)).toBe(Region.None); // face
    expect(classifyRegion('head', 0.27, 1.1, -0.07, 1)).toBe(Region.None); // ear
    expect(classifyRegion('head', 0.3, 1.12, 0, 0)).toBe(Region.Helmet); // brim
    expect(classifyRegion('foot_R', 0, 0.05, 0, 0)).toBe(Region.Boots);
    expect(classifyRegion('spine2', 0, 0.75, -0.3, 0)).toBe(Region.Jetpack);
    expect(classifyRegion('spine2', 0, 0.75, 0.1, 0)).toBe(Region.None);
  });

  it('both shipped LODs share the shared-v1 skeleton in one joint order', () => {
    const joints = (file: string) => {
      const buf = readFileSync(fileURLToPath(new URL(`../../../../art/character/${file}`, import.meta.url)));
      const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString()) as { nodes: { name: string }[]; skins: { joints: number[] }[] };
      return json.skins[0]!.joints.map((j) => json.nodes[j]!.name);
    };
    expect(joints('rookie.glb')).toEqual(JOINTS);
    expect(joints('rookie_lod1.glb')).toEqual(JOINTS);
  });
});
