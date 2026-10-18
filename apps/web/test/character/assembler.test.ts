import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Color, Vector3, type BufferAttribute, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { DEFAULT_COSMETIC_LOADOUT, cosmetics, getCosmetic, type CosmeticLoadout } from '@military-forge/content';
import { ART_SLOTS, CharacterAssembler, DyeMaterial, OutlineMaterial, ROOKIE_MANIFEST, selectLod } from '../../src/character';
import { BODY, BODY_DEFAULTS, JOINTS, PARTS, fakeSource, type FakeSource } from './fakeRig';

const assembler = (source: FakeSource = fakeSource()) => new CharacterAssembler({ source });
const wearing = (items: Partial<CosmeticLoadout['items']>, dyes: Partial<CosmeticLoadout['dyes']> = {}): CosmeticLoadout => ({
  items: { ...DEFAULT_COSMETIC_LOADOUT.items, ...items },
  dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes, ...dyes },
});
const geometryOf = (i: { meshes: readonly { geometry: BufferGeometry }[] }) => i.meshes[0]!.geometry;
const triangles = (i: { meshes: readonly { geometry: BufferGeometry }[] }) => geometryOf(i).getIndex()!.count / 3;
/** texture layer → the bones its vertices are skinned to */
function layerBones(g: BufferGeometry): Map<number, Set<string>> {
  const layer = g.getAttribute('texLayer');
  const joint = g.getAttribute('skinIndex');
  const out = new Map<number, Set<string>>();
  for (let v = 0; v < layer.count; v++) {
    const l = layer.getX(v);
    if (!out.has(l)) out.set(l, new Set());
    out.get(l)!.add(JOINTS[joint.getX(v)]!);
  }
  return out;
}
const layerOf = (slot: (typeof ART_SLOTS)[number]) => 1 + ART_SLOTS.indexOf(slot);
const colourAt = (m: DyeMaterial, layer: number, channel: number) => m.layerColours[layer * 3 + channel]!;

describe('CharacterAssembler (W8 rig)', () => {
  it('builds one skinned mesh: the body plus the default parts, each on its own texture layer and bone', async () => {
    const c = await assembler().create(null);
    expect(c.meshes).toHaveLength(1);
    expect(c.meshes[0]!.material).toBeInstanceOf(DyeMaterial);
    expect(c.bone('socket_jetpack')?.name).toBe('socket_jetpack');
    expect(c.bone('nope')).toBeNull();
    expect(c.clips.map((clip) => clip.name)).toEqual(['idle', 'walk']); // the shared clip library, not the body GLB's
    expect(triangles(c)).toBe(BODY.length + 3); // helmet, boots, jetpack
    const layers = layerBones(geometryOf(c));
    expect(layers.get(0)).toEqual(new Set(['spine2', 'head', 'hand_L']));
    expect(layers.get(layerOf('headgear'))).toEqual(new Set(['head']));
    expect(layers.get(layerOf('boots'))).toEqual(new Set(['foot_L']));
    expect(layers.get(layerOf('jetpack'))).toEqual(new Set(['spine2']));
    expect(layers.has(layerOf('eyewear'))).toBe(false);
    expect(c.material.layerAlbedo(layerOf('eyewear'))).toBeNull();
    expect(c.material.layerAlbedo(layerOf('headgear'))).not.toBeNull();
    expect(c.nozzles).toHaveLength(2);
  });

  it('gives every instance its own skeleton, and frees its bone texture on dispose', async () => {
    const a = assembler();
    const one = await a.create(null);
    const two = await a.create(null);
    expect(one.bone('head')).not.toBe(two.bone('head'));
    const skeleton = one.meshes[0]!.skeleton;
    skeleton.computeBoneTexture();
    let freed = false;
    skeleton.boneTexture!.addEventListener('dispose', () => (freed = true));
    one.dispose();
    expect(freed).toBe(true);
  });

  it('swaps parts by slot; "none" leaves the slot empty; an item without art keeps the slot default', async () => {
    const a = assembler();
    const c = await a.create(wearing({ eyewear: 'eyewear_aviators', gloves: 'gloves_tactical', boots: 'boots_jungle', jetpack: 'jetpack_drum' }));
    const layers = layerBones(geometryOf(c));
    expect(layers.get(layerOf('eyewear'))).toEqual(new Set(['head']));
    expect(layers.get(layerOf('gloves'))).toEqual(new Set(['hand_L']));
    expect(c.nozzles).toHaveLength(1); // the drum pack has one nozzle, the twin tank two
    const crown = await a.create(wearing({ headgear: 'headgear_crown' })); // no art yet
    expect(geometryOf(crown)).toBe(geometryOf(await a.create(null)));
  });

  it('falls back to the slot default when a part fails to load, and tries it again next time', async () => {
    const source = fakeSource();
    source.broken.add('headgear_field_cap');
    const a = assembler(source);
    const c = await a.create(wearing({ headgear: 'headgear_field_cap' }));
    expect(geometryOf(c)).toBe(geometryOf(await a.create(null)));
    source.broken.clear();
    const retried = await a.create(wearing({ headgear: 'headgear_field_cap' }));
    expect(geometryOf(retried)).not.toBe(geometryOf(c));
  });

  it('remaps LOD1 joints (listed in another order) to the LOD0 skeleton, keeping the bones on a LOD switch', async () => {
    const c = await assembler().create(wearing({ eyewear: 'eyewear_aviators' }));
    const bones = c.meshes[0]!.skeleton.bones;
    const lod0 = layerBones(geometryOf(c));
    c.setLod(1);
    expect(c.lod).toBe(1);
    expect(c.meshes[0]!.skeleton.bones).toBe(bones);
    expect(layerBones(geometryOf(c))).toEqual(lod0);
    expect(c.material.layerAlbedo(0)).not.toBeNull();
  });

  it('dyes: each part keeps its own default dye until the player picks one, then every part takes it', async () => {
    const a = assembler();
    const c = await a.create(null);
    const m = c.material;
    const helmet = layerOf('headgear');
    expect(colourAt(m, 0, 0).equals(new Color(BODY_DEFAULTS.primary))).toBe(true);
    expect(colourAt(m, helmet, 0).equals(new Color(PARTS.headgear_brim_helmet!.defaults.primary))).toBe(true);
    // a channel the part has no default for takes the player's dye
    expect(colourAt(m, helmet, 1).equals(new Color(getCosmetic(DEFAULT_COSMETIC_LOADOUT.dyes.secondary)!.colour!))).toBe(true);
    const red = new Color(getCosmetic('dye_red')!.colour!);
    await c.setLoadout(wearing({}, { primary: 'dye_red' }));
    for (let layer = 0; layer <= ART_SLOTS.length; layer++) expect(colourAt(m, layer, 0).equals(red)).toBe(true);
    expect(colourAt(m, 0, 1).equals(new Color(BODY_DEFAULTS.secondary))).toBe(true); // untouched channel keeps defaults
  });

  it('caches merged geometry by parts; dyes, skin and exhaust are uniforms', async () => {
    const a = assembler();
    const one = await a.create(wearing({ headgear: 'headgear_field_cap' }));
    const two = await a.create(wearing({ headgear: 'headgear_field_cap', skinTone: 'skin_11', exhaust: 'exhaust_plasma' }, { primary: 'dye_red' }));
    expect(geometryOf(two)).toBe(geometryOf(one));
    expect(a.stats).toEqual({ builds: 1, hits: 1 });
    expect(two.material.dye.skin.equals(new Color(getCosmetic('skin_11')!.colour!))).toBe(true);
    expect(two.exhaustColour.equals(new Color(getCosmetic('exhaust_plasma')!.colour!))).toBe(true);
    expect(two.loadoutHash).not.toBe(one.loadoutHash);
    const before = geometryOf(two);
    await two.setLoadout(wearing({ headgear: 'headgear_field_cap', skinTone: 'skin_02' }));
    expect(geometryOf(two)).toBe(before);
    await two.setLoadout(wearing({ jetpack: 'jetpack_drum' }));
    expect(geometryOf(two)).not.toBe(before);
    expect(a.stats.builds).toBe(2);
  });

  it('applies dyes at once and new parts once loaded; the newest setLoadout wins a race', async () => {
    const a = assembler();
    const c = await a.create(null);
    const base = geometryOf(c);
    const slow = c.setLoadout(wearing({ headgear: 'headgear_field_cap' }, { accent: 'dye_yellow' }));
    expect(c.material.dye.accent.equals(new Color(getCosmetic('dye_yellow')!.colour!))).toBe(true);
    const fast = c.setLoadout(wearing({}));
    await Promise.all([slow, fast]);
    expect(geometryOf(c)).toBe(base);
    expect(c.loadout.items.headgear).toBe('headgear_brim_helmet');
  });

  it('body types widen the body below the neck; parts move with it but keep their size', async () => {
    const a = assembler();
    const parts = { gloves: 'gloves_tactical' };
    const stocky = getCosmetic('body_stocky')!.widthMul!;
    const extents = async (bodyType: string) => {
      const g = geometryOf(await a.create(wearing({ ...parts, bodyType })));
      const pos = g.getAttribute('position') as BufferAttribute;
      const layer = g.getAttribute('texLayer');
      const of = (l: number) => {
        const pts: Vector3[] = [];
        for (let v = 0; v < pos.count; v++) if (layer.getX(v) === l) pts.push(new Vector3().fromBufferAttribute(pos, v));
        return pts;
      };
      return { body: of(0), gloves: of(layerOf('gloves')), jetpack: of(layerOf('jetpack')), helmet: of(layerOf('headgear')) };
    };
    const standard = await extents('body_standard');
    const wide = await extents('body_stocky');
    const width = (pts: Vector3[]) => Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x));
    // body vertices below the neck scale; the face doesn't
    const body = (pts: Vector3[]) => pts.filter((p) => p.y < 0.9);
    expect(Math.max(...body(wide.body).map((p) => Math.abs(p.x)))).toBeCloseTo(Math.max(...body(standard.body).map((p) => Math.abs(p.x))) * stocky, 5);
    expect(wide.helmet).toEqual(standard.helmet);
    // the glove follows the widened hand without growing; the jetpack moves back without growing
    expect(width(wide.gloves)).toBeCloseTo(width(standard.gloves), 6);
    expect(wide.gloves[0]!.x).toBeCloseTo(standard.gloves[0]!.x + 0.374 * (stocky - 1), 6);
    expect(width(wide.jetpack)).toBeCloseTo(width(standard.jetpack), 6);
    expect(wide.jetpack[0]!.z).toBeLessThan(standard.jetpack[0]!.z);
  });

  it('keeps unused builds for re-use and frees them past the idle limit', async () => {
    const a = assembler();
    const c = await a.create(null);
    const first = geometryOf(c);
    c.dispose();
    const again = await a.create(null);
    expect(geometryOf(again)).toBe(first);
    again.dispose();
    for (const gloves of ['gloves_none', 'gloves_tactical']) {
      for (const eyewear of ['eyewear_aviators', 'eyewear_none']) {
        for (const boots of ['boots_combat', 'boots_jungle']) {
          for (const jetpack of ['jetpack_twin_tank', 'jetpack_drum']) (await a.create(wearing({ headgear: 'headgear_field_cap', gloves, eyewear, boots, jetpack }))).dispose();
        }
      }
    }
    expect(a.stats.builds).toBe(17);
    // the default look was the oldest idle build, so it was evicted and builds again
    (await a.create(null)).dispose();
    expect(a.stats.builds).toBe(18);
  });

  it('draws an outline hull on the same skeleton that follows every part swap and LOD change', async () => {
    const outline = new OutlineMaterial();
    const c = await assembler().create(null);
    c.setOutline(outline);
    const hull = c.outline!;
    expect(hull.material).toBe(outline);
    expect(hull.skeleton).toBe(c.meshes[0]!.skeleton);
    expect(hull.geometry).toBe(geometryOf(c));
    expect(hull.castShadow).toBe(false);
    await c.setLoadout(wearing({ headgear: 'headgear_field_cap' }));
    expect(hull.geometry).toBe(geometryOf(c));
    c.setLod(1);
    expect(hull.geometry).toBe(geometryOf(c));
    c.setOutline(null);
    expect(c.outline).toBeNull();
    expect(hull.parent).toBeNull();
  });

  it('does not cache a failed base load: the next create() tries again', async () => {
    const source = fakeSource();
    source.failBase = 1;
    const a = assembler(source);
    await expect(a.create(null)).rejects.toThrow('network blip');
    const c = await a.create(null);
    expect(c.meshes).toHaveLength(1);
    expect(a.upperBodyBones).toContain('spine2');
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

describe('the shipped W8 character art (apps/web/public/assets)', () => {
  const assets = (path: string) => fileURLToPath(new URL(`../../public/assets/${path}`, import.meta.url));
  const glbJoints = (path: string) => {
    const buf = readFileSync(assets(path));
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString()) as { nodes: { name: string }[]; skins: { joints: number[] }[] };
    return json.skins[0]!.joints.map((j) => json.nodes[j]!.name);
  };
  const manifest = JSON.parse(readFileSync(assets(ROOKIE_MANIFEST), 'utf8')) as {
    lods: Record<string, string>;
    anims: string;
    defaultParts: Record<string, string>;
    dye: Record<string, { mask: string; albedo: string }>;
  };
  const joints = glbJoints(`characters/rookie/${manifest.lods.lod0}`);

  it('has every file the manifest names, and the default parts are content items', () => {
    for (const file of [...Object.values(manifest.lods), manifest.anims, ...Object.values(manifest.dye).flatMap((d) => [d.mask, d.albedo])]) {
      expect(existsSync(assets(`characters/rookie/${file}`)), file).toBe(true);
    }
    for (const [slot, id] of Object.entries(manifest.defaultParts)) {
      expect(getCosmetic(id)?.slot, id).toBe(slot);
      expect(DEFAULT_COSMETIC_LOADOUT.items[slot as keyof CosmeticLoadout['items']]).toBe(id);
    }
  });

  /** Sockets only the body carries (#95: the spare gun's sling and holster); older cosmetic parts predate them. */
  const BODY_ONLY_SOCKETS = new Set(['sling_back', 'holster_thigh']);

  it('every content item with art has its manifest, both LODs and dye textures, on the body skeleton', () => {
    const withArt = cosmetics.filter((c) => c.assets.manifest);
    expect(withArt.length).toBeGreaterThanOrEqual(14);
    for (const item of withArt) {
      expect((ART_SLOTS as readonly string[]).includes(item.slot), item.id).toBe(true);
      const path = item.assets.manifest!;
      const dir = path.slice(0, path.lastIndexOf('/') + 1);
      const m = JSON.parse(readFileSync(assets(path), 'utf8')) as { lods: Record<string, string>; dye: Record<string, { mask: string; albedo: string }> };
      for (const lod of ['lod0', 'lod1']) {
        // parts built before the body's sling_back and holster_thigh sockets (#95) don't carry them;
        // parts merge by their deform bones, so a part's skeleton is the body's without those two
        expect(glbJoints(dir + m.lods[lod]).filter((j) => !BODY_ONLY_SOCKETS.has(j)), `${item.id} ${lod}`).toEqual(joints.filter((j) => !BODY_ONLY_SOCKETS.has(j)));
        for (const file of [m.dye[lod]!.mask, m.dye[lod]!.albedo]) expect(existsSync(assets(dir + file)), file).toBe(true);
      }
    }
    expect(glbJoints(`characters/rookie/${manifest.lods.lod1}`)).toEqual(joints);
  });
});
