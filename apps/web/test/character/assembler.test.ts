import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Color, Vector3, type BufferAttribute, type BufferGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { BODIES, DEFAULT_COSMETIC_LOADOUT, cosmetics, getCosmetic, type CosmeticLoadout } from '@military-forge/content';
import { ART_SLOTS, BODY_MANIFESTS, CharacterAssembler, DyeMaterial, OutlineMaterial, ROOKIE_MANIFEST, selectLod } from '../../src/character';
import { BODY, BODY_DEFAULTS, JOINTS, PARTS, REGIONS, fakeSource, type FakeSource } from './fakeRig';

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
    // the body and parts, then the garments: two materials sharing the dyes, one geometry group each
    expect(c.meshes[0]!.material).toEqual([c.material, c.material.garments]);
    expect(c.material.garments).toBeInstanceOf(DyeMaterial);
    expect(c.bone('socket_jetpack')?.name).toBe('socket_jetpack');
    expect(c.bone('nope')).toBeNull();
    expect(c.clips.map((clip) => clip.name)).toEqual(['idle', 'walk']); // the shared clip library, not the body GLB's
    expect(triangles(c)).toBe(BODY.length + 3); // helmet, boots, jetpack
    const layers = layerBones(geometryOf(c));
    expect(layers.get(0)).toEqual(new Set(['spine2', 'head', 'hand_L', 'thigh_L']));
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

  it('close-up textures (the creator stage): none listed, setHero keeps the body as it is', async () => {
    const c = await assembler().create(null);
    const material = c.material;
    const body = material.map;
    await expect(c.setHero(true)).resolves.toBe(false);
    expect(material.map).toBe(body);
    await expect(c.setHero(false)).resolves.toBe(false);
    expect(material.map).toBe(body);
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

describe('CharacterAssembler: the garments (hair, top, legs) and "None"', () => {
  const female = (items: Partial<CosmeticLoadout['items']> = {}) => wearing({ bodyType: 'body_female', ...items });
  /** the body's triangles still drawn, by region code */
  const bodyRegions = (c: { meshes: readonly { geometry: BufferGeometry }[] }) => {
    const g = geometryOf(c);
    const layer = g.getAttribute('texLayer');
    const pos = g.getAttribute('position');
    const index = g.getIndex()!;
    const out: number[] = [];
    for (let t = 0; t < index.count; t += 3) {
      const v = index.getX(t);
      if (layer.getX(v) !== 0) continue;
      // the fake body's triangles in order: find which one by its first corner
      const i = BODY.findIndex(([, x, y, z]) => Math.abs(pos.getX(v) - (x - 0.02)) < 1e-6 && Math.abs(pos.getY(v) - (y - 0.02)) < 1e-6 && Math.abs(pos.getZ(v) - z) < 1e-6);
      out.push(BODY[i]?.[4] ?? 0);
    }
    return out.sort();
  };

  it('draws a top and trousers on the garment material, in place of the body regions they replace', async () => {
    const c = await assembler().create(wearing({ top: 'top_bomber', legs: 'legs_joggers' }));
    const layers = layerBones(geometryOf(c));
    expect(layers.get(layerOf('top'))).toEqual(new Set(['spine2']));
    expect(layers.get(layerOf('legs'))).toEqual(new Set(['thigh_L']));
    expect(bodyRegions(c)).toEqual([0, 0, REGIONS.hair]); // the torso and the leg are the garments'
    // group 0 (body and parts) on the main material, group 1 (the garments) on the garments'
    const groups = geometryOf(c).groups;
    expect(groups.map((g) => g.materialIndex)).toEqual([0, 1]);
    expect(groups[1]!.count).toBe(6); // two garment triangles
    expect(c.material.layerAlbedo(layerOf('top'))).not.toBeNull();
    expect(c.material.garments!.layerAlbedo(layerOf('top'))).toBe(c.material.layerAlbedo(layerOf('top')));
    // the garments share every dye uniform with the main material
    expect(c.material.garments!.layerColours).toBe(c.material.layerColours);
    expect(c.material.garments!.dissolve).toBe(c.material.dissolve);
    expect(c.material.garments!.rim).toBe(c.material.rim);
    expect(colourAt(c.material, layerOf('top'), 0).equals(new Color(PARTS.top_bomber!.defaults.primary))).toBe(true);
    // the body's own fatigues come back with them off
    await c.setLoadout(wearing({}));
    expect(bodyRegions(c)).toEqual([0, 0, REGIONS.hair, REGIONS.top, REGIONS.top, REGIONS.legs]);
    expect(geometryOf(c).groups.map((g) => g.materialIndex)).toEqual([0]); // no garments: one draw call
  });

  it('a hairstyle replaces her own hair; a helmet that covers the hair hides the style, and "None" is no hat at all', async () => {
    const a = assembler(fakeSource({}));
    const c = await a.create(female({ hair: 'hair_bun', headgear: 'headgear_none' }));
    expect(c.body).toBe('female');
    expect(layerBones(geometryOf(c)).get(layerOf('hair'))).toEqual(new Set(['head']));
    expect(layerBones(geometryOf(c)).has(layerOf('headgear'))).toBe(false); // None: not the default helmet
    expect(bodyRegions(c)).not.toContain(REGIONS.hair);
    await c.setLoadout(female({ hair: 'hair_bun', headgear: 'headgear_beanie' }));
    expect(layerBones(geometryOf(c)).has(layerOf('hair'))).toBe(false);
    expect(bodyRegions(c)).toContain(REGIONS.hair);
    expect(layerBones(geometryOf(c)).get(layerOf('headgear'))).toEqual(new Set(['head']));
  });

  // the owner (23 Oct): "when selecting the clothes it wasn't updating the characters at all"
  for (const body of ['male', 'female'] as const) {
    it(`every slot the creator dresses changes the ${body} soldier`, async () => {
      const a = assembler(fakeSource({}));
      const look = (items: Partial<CosmeticLoadout['items']> = {}, dyes: Partial<CosmeticLoadout['dyes']> = {}) =>
        wearing({ ...(body === 'female' ? { bodyType: 'body_female' } : {}), headgear: 'headgear_none', ...items }, dyes);
      const c = await a.create(look());
      expect(c.body).toBe(body);
      const picks: Partial<CosmeticLoadout['items']>[] = [
        { headgear: 'headgear_field_cap' },
        { eyewear: 'eyewear_aviators' },
        { top: 'top_bomber' },
        { legs: 'legs_joggers' },
        { gloves: 'gloves_tactical' },
        { boots: 'boots_jungle' },
        { jetpack: 'jetpack_drum' },
        ...(body === 'female' ? [{ hair: 'hair_braids' }] : []),
      ];
      for (const pick of picks) {
        const before = geometryOf(c);
        await c.setLoadout(look(pick));
        expect(geometryOf(c), JSON.stringify(pick)).not.toBe(before);
        expect(c.loadout.items).toMatchObject(pick);
        await c.setLoadout(look());
      }
      // a colourway is a uniform: the colours change at once, the geometry stays
      const before = geometryOf(c);
      const hash = c.loadoutHash;
      await c.setLoadout(look({}, { primary: 'dye_red' }));
      expect(geometryOf(c)).toBe(before);
      expect(c.loadoutHash).not.toBe(hash);
      expect(c.material.dye.primary.equals(new Color(getCosmetic('dye_red')!.colour!))).toBe(true);
    });
  }
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

  /** Each joint's rest transform (glTF node TRS): the bind pose a body or part is skinned in. */
  const restPose = (path: string) => {
    const buf = readFileSync(assets(path));
    const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString()) as {
      nodes: { name: string; translation?: number[]; rotation?: number[]; scale?: number[] }[];
      skins: { joints: number[] }[];
    };
    return new Map(json.skins[0]!.joints.map((j) => {
      const n = json.nodes[j]!;
      return [n.name, [...(n.translation ?? [0, 0, 0]), ...(n.rotation ?? [0, 0, 0, 1]), ...(n.scale ?? [1, 1, 1])]];
    }));
  };
  const expectSamePose = (path: string, ref: Map<string, number[]>) => {
    const pose = restPose(path);
    for (const [bone, trs] of pose) {
      const want = ref.get(bone);
      expect(want, `${path}: ${bone}`).toBeDefined();
      trs.forEach((v, k) => expect(Math.abs(v - want![k]!), `${path}: ${bone}[${k}]`).toBeLessThan(1e-4));
    }
  };

  it('every base body is on the Rookie\'s skeleton: the same joints and rest pose, and his clips', () => {
    const rookiePose = restPose(`characters/rookie/${manifest.lods.lod0}`);
    for (const body of BODIES) {
      const path = BODY_MANIFESTS[body];
      const dir = path.slice(0, path.lastIndexOf('/') + 1);
      const m = JSON.parse(readFileSync(assets(path), 'utf8')) as typeof manifest & { body?: string };
      expect(m.body ?? 'male', path).toBe(body);
      for (const file of [...Object.values(m.lods), ...Object.values(m.dye).flatMap((d) => [d.mask, d.albedo])]) {
        expect(existsSync(assets(dir + file)), `${body}: ${file}`).toBe(true);
      }
      // one clip library for every body (the bones they key are the same bones): a body manifest without `anims`
      // shares the male one
      if (body !== 'male') expect(m.anims, body).toBeUndefined();
      for (const lod of ['lod0', 'lod1']) {
        expect(glbJoints(dir + m.lods[lod]), `${body} ${lod}`).toEqual(joints);
        expectSamePose(dir + m.lods[lod]!, rookiePose);
      }
      for (const [slot, id] of Object.entries(m.defaultParts)) expect(getCosmetic(id)?.slot, `${body}: ${id}`).toBe(slot);
    }
  });

  it('a part\'s fit for another body (`bodies.<body>`) names its files and is on the same skeleton', () => {
    const rookiePose = restPose(`characters/rookie/${manifest.lods.lod0}`);
    let fits = 0;
    for (const item of cosmetics.filter((c) => c.assets.manifest)) {
      const path = item.assets.manifest!;
      const dir = path.slice(0, path.lastIndexOf('/') + 1);
      const m = JSON.parse(readFileSync(assets(path), 'utf8')) as {
        bodies?: Record<string, { lods: Record<string, string>; dye: Record<string, { mask: string; albedo: string }> }>;
      };
      for (const [body, fit] of Object.entries(m.bodies ?? {})) {
        expect(BODIES as readonly string[], `${item.id}: ${body}`).toContain(body);
        for (const lod of ['lod0', 'lod1']) {
          expect(glbJoints(dir + fit.lods[lod]).filter((j) => !BODY_ONLY_SOCKETS.has(j)), `${item.id} ${body} ${lod}`).toEqual(joints.filter((j) => !BODY_ONLY_SOCKETS.has(j)));
          expectSamePose(dir + fit.lods[lod]!, rookiePose);
          for (const file of [fit.dye[lod]!.mask, fit.dye[lod]!.albedo]) expect(existsSync(assets(dir + file)), `${item.id} ${body}: ${file}`).toBe(true);
        }
        fits++;
      }
    }
    expect(fits).toBeGreaterThanOrEqual(1);
  });

  /** RIFF chunk ids of a WebP file; ['VP8L'] is the simple lossless format (alpha inside, no premultiply). */
  const webpChunks = (path: string): string[] | null => {
    const b = readFileSync(path);
    if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
    const out: string[] = [];
    for (let i = 12; i + 8 <= b.length; ) {
      const size = b.readUInt32LE(i + 4);
      out.push(b.toString('latin1', i, i + 4));
      i += 8 + size + (size & 1);
    }
    return out;
  };

  it('every dye mask ships as lossless WebP, as the manifests and GLB extras name it (audit 29 Oct: PNG was 2.4x the bytes, and Safari dropped the dye weights under zero alpha)', () => {
    const masks = new Set<string>();
    const note = (dir: string, dye: Record<string, { mask: string; heroMask?: string }>) => {
      for (const d of Object.values(dye)) for (const m of [d.mask, d.heroMask]) if (m) masks.add(dir + m);
    };
    for (const path of Object.values(BODY_MANIFESTS)) {
      note(path.slice(0, path.lastIndexOf('/') + 1), (JSON.parse(readFileSync(assets(path), 'utf8')) as typeof manifest).dye);
    }
    const glbs: string[] = [];
    for (const item of cosmetics.filter((c) => c.assets.manifest)) {
      const path = item.assets.manifest!;
      const dir = path.slice(0, path.lastIndexOf('/') + 1);
      type Fit = { lods: Record<string, string>; dye: Record<string, { mask: string }> };
      const m = JSON.parse(readFileSync(assets(path), 'utf8')) as Fit & { bodies?: Record<string, Fit> };
      for (const fit of [m, ...Object.values(m.bodies ?? {})]) {
        note(dir, fit.dye);
        glbs.push(...Object.values(fit.lods).map((f) => dir + f));
      }
    }
    expect(masks.size).toBeGreaterThanOrEqual(100);
    for (const mask of masks) {
      // a .png here is an export from before art/pipeline/dye.py mask_webp (cwebp -lossless -exact)
      expect(mask, mask).toMatch(/_dye_mask\.webp$/);
      expect(webpChunks(assets(mask)), mask).toEqual(['VP8L']);
      expect(existsSync(assets(mask.replace(/\.webp$/, '.png'))), `${mask}: an old PNG beside it`).toBe(false);
    }
    // the parts' `dyeMask` extras (tools/asset-check finds the mask by them) name the same files
    for (const glb of glbs) {
      const buf = readFileSync(assets(glb));
      const json = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString()) as { nodes: { extras?: { dyeMask?: string } }[] };
      const named = json.nodes.map((n) => n.extras?.dyeMask).filter((m): m is string => !!m);
      for (const m of named) expect(masks.has(glb.slice(0, glb.lastIndexOf('/') + 1) + 'textures/' + m), `${glb}: ${m}`).toBe(true);
    }
  });
});
