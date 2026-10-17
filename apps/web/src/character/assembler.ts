/**
 * Character assembler (docs/04 §5): loadout → one SkinnedMesh on the shared skeleton.
 * Parts are merged into the body's geometry (one draw call), dyes are material uniforms, and
 * merged geometries are cached by body type + parts + LOD, so equal outfits share one build.
 * Interface notes for W1: w2-character-interface.md in the shared notes folder.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  SkinnedMesh,
  Uint16BufferAttribute,
  type AnimationClip,
  type Bone,
  type ColorRepresentation,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  DEFAULT_COSMETIC_LOADOUT,
  PART_SLOTS,
  cosmeticLoadoutHash,
  getCosmetic,
  sanitizeCosmeticLoadout,
  type CosmeticLoadout,
} from '@military-forge/content';
import rookieLod0Url from '../../../../art/character/rookie.glb?url';
import rookieLod1Url from '../../../../art/character/rookie_lod1.glb?url';
import { DyeMaterial } from './dyeMaterial';
import { createDyeTextures, hexToLinear } from './dyeTextures';
import { BUILT_IN, PLACEHOLDERS, Region, classifyRegion } from './rookiePhase0';

export type CharacterLod = 0 | 1;

/** Below this many pixels tall a character switches to LOD1; above LOD0_ABOVE_PX it switches back. */
export const LOD1_BELOW_PX = 40;
export const LOD0_ABOVE_PX = 48;

/** LOD for a character `pixelHeight` px tall on screen, with hysteresis so it doesn't flicker (docs/04 §5.6). */
export function selectLod(pixelHeight: number, current: CharacterLod): CharacterLod {
  if (current === 0) return pixelHeight < LOD1_BELOW_PX ? 1 : 0;
  return pixelHeight > LOD0_ABOVE_PX ? 0 : 1;
}

/** Body types widen everything below the neck; the head keeps its hitbox (docs/04 §1). */
const NECK_Y = 0.97;
const SPINE_Z = -0.016;

/** Where body type `widthMul` moves a bind-pose point: x and z scale about the spine below the neck. */
export function widenPoint(p: Vector3, widthMul: number): Vector3 {
  if (p.y < NECK_Y) p.set(p.x * widthMul, p.y, SPINE_Z + (p.z - SPINE_Z) * widthMul);
  return p;
}

/**
 * Fits a rigid part piece to a body type: it moves with the body surface under it (its bounding-box
 * centre follows widenPoint) but keeps its own size, so the body's widening never stacks on top of
 * the part's own bulk and pushes it out of the cosmetic envelope (docs/04 §1.2).
 */
export function fitPieceToBody(geometry: BufferGeometry, widthMul: number): BufferGeometry {
  if (widthMul === 1) return geometry;
  geometry.computeBoundingBox();
  const centre = geometry.boundingBox!.getCenter(new Vector3());
  const offset = widenPoint(centre.clone(), widthMul).sub(centre);
  return geometry.translate(offset.x, offset.y, offset.z);
}

/** Geometry key: what changes the mesh. Dyes, skin tone, exhaust and trail don't. */
export function partsKey(loadout: CosmeticLoadout, lod: CharacterLod): string {
  return [lod, loadout.items.bodyType, ...PART_SLOTS.map((s) => loadout.items[s])].join('|');
}

export interface CharacterAssemblerOptions {
  /** base rig GLB per LOD; defaults to the Phase 0 Rookie in art/character */
  baseUrls?: Readonly<Record<CharacterLod, string>>;
  /** share a configured loader (meshopt decoder, KTX2) */
  loader?: GLTFLoader;
}

export interface CharacterInstance {
  /** glTF +Z forward, +Y up, feet at y = 0, 1.5 m tall */
  readonly root: Object3D;
  /** exactly one: body + parts merged, one material */
  readonly meshes: readonly SkinnedMesh[];
  readonly clips: readonly AnimationClip[];
  readonly material: DyeMaterial;
  readonly loadout: CosmeticLoadout;
  readonly loadoutHash: number;
  readonly lod: CharacterLod;
  /** colour of the equipped exhaust, for the jet flame */
  readonly exhaustColour: Color;
  bone(name: string): Bone | null;
  setLoadout(loadout: CosmeticLoadout): void;
  setLod(lod: CharacterLod): void;
  /** Team colour for the dye mask's A channel (armband glow, docs/04 §1.4); null = off. No visible
   *  effect yet: the Phase 0 bake and the placeholder parts have nothing in A until W8's mask lands. */
  setTeamColour(colour: ColorRepresentation | null): void;
  dispose(): void;
}

interface BaseRig {
  /** template scene: cloned per instance for its own bones, never rendered */
  scene: Object3D;
  /** position, normal, uv, skinIndex (LOD0 joint order), skinWeight, color, dyeMask, texLayer */
  geometry: BufferGeometry;
  /** Region per triangle */
  regions: Uint8Array;
  albedo: Texture;
  mask: Texture;
  clips: AnimationClip[];
}

interface CacheEntry {
  geometry: BufferGeometry;
  refs: number;
}

/** Unreferenced merged geometries kept around for quick re-use (e.g. flicking through the Locker). */
const IDLE_CACHE = 8;

function findSkinnedMesh(root: Object3D): SkinnedMesh {
  let found: SkinnedMesh | null = null;
  root.traverse((o) => {
    if (!found && (o as SkinnedMesh).isSkinnedMesh) found = o as SkinnedMesh;
  });
  if (!found) throw new Error('Character GLB has no skinned mesh');
  return found;
}

/** Float32 copy of any attribute (handles normalised integer storage). */
function float32(attr: BufferAttribute, itemSize = attr.itemSize): Float32BufferAttribute {
  const out = new Float32Array(attr.count * itemSize);
  for (let i = 0; i < attr.count; i++) for (let c = 0; c < itemSize; c++) out[i * itemSize + c] = attr.getComponent(i, c);
  return new Float32BufferAttribute(out, itemSize);
}

function constant(count: number, values: readonly number[]): Float32BufferAttribute {
  const out = new Float32Array(count * values.length);
  for (let i = 0; i < count; i++) out.set(values, i * values.length);
  return new Float32BufferAttribute(out, values.length);
}

export class CharacterAssembler {
  readonly stats = { builds: 0, hits: 0 };
  private readonly loader: GLTFLoader;
  private readonly urls: Readonly<Record<CharacterLod, string>>;
  private loading: Promise<void> | null = null;
  private bases: BaseRig[] = [];
  /** LOD0 joint names: the canonical skinIndex order */
  private joints: string[] = [];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly idle = new Set<string>();

  constructor(options: CharacterAssemblerOptions = {}) {
    this.loader = options.loader ?? new GLTFLoader();
    this.urls = options.baseUrls ?? { 0: rookieLod0Url, 1: rookieLod1Url };
  }

  preload(): Promise<void> {
    this.loading ??= Promise.all([this.loader.loadAsync(this.urls[0]), this.loader.loadAsync(this.urls[1])]).then(
      ([lod0, lod1]) => {
        const base0 = this.makeBase(lod0.scene, lod0.animations, null);
        this.bases = [base0, this.makeBase(lod1.scene, lod1.animations, this.joints)];
      },
      (error: unknown) => {
        this.loading = null; // let a later create() retry
        throw error;
      },
    );
    return this.loading;
  }

  async create(loadout: CosmeticLoadout | null, lod: CharacterLod = 0): Promise<CharacterInstance> {
    await this.preload();
    return new Instance(this, sanitizeCosmeticLoadout(loadout ?? DEFAULT_COSMETIC_LOADOUT), lod);
  }

  dispose(): void {
    for (const { geometry } of this.cache.values()) geometry.dispose();
    this.cache.clear();
    this.idle.clear();
    for (const b of this.bases) {
      b.geometry.dispose();
      b.albedo.dispose();
      b.mask.dispose();
    }
    this.bases = [];
    this.loading = null;
  }

  /** @internal */
  base(lod: CharacterLod): BaseRig {
    return this.bases[lod]!;
  }

  /** @internal merged geometry for a loadout, from the cache when possible; pair with release() */
  acquire(loadout: CosmeticLoadout, lod: CharacterLod): BufferGeometry {
    const key = partsKey(loadout, lod);
    let entry = this.cache.get(key);
    if (entry) this.stats.hits++;
    else {
      entry = { geometry: this.build(loadout, lod), refs: 0 };
      this.cache.set(key, entry);
      this.stats.builds++;
    }
    entry.refs++;
    this.idle.delete(key);
    return entry.geometry;
  }

  /** @internal */
  release(loadout: CosmeticLoadout, lod: CharacterLod): void {
    const key = partsKey(loadout, lod);
    const entry = this.cache.get(key);
    if (!entry || --entry.refs > 0) return;
    this.idle.add(key);
    for (const old of this.idle) {
      if (this.idle.size <= IDLE_CACHE) break;
      this.idle.delete(old);
      this.cache.get(old)?.geometry.dispose();
      this.cache.delete(old);
    }
  }

  /** Base rig from a loaded GLB; `canonical` = LOD0's joint names (null for LOD0 itself). */
  private makeBase(scene: Object3D, clips: AnimationClip[], canonical: string[] | null): BaseRig {
    const mesh = findSkinnedMesh(scene);
    const names = mesh.skeleton.bones.map((b) => b.name);
    if (!canonical) this.joints = names;
    const src = mesh.geometry;
    const count = src.getAttribute('position').count;
    const joints = src.getAttribute('skinIndex') as BufferAttribute;
    const weights = src.getAttribute('skinWeight') as BufferAttribute;
    const remap = names.map((n) => Math.max(0, (canonical ?? names).indexOf(n)));
    const skinIndex = new Uint16Array(count * 4);
    for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) skinIndex[i * 4 + c] = remap[joints.getComponent(i, c)]!;

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', float32(src.getAttribute('position') as BufferAttribute));
    geometry.setAttribute('normal', float32(src.getAttribute('normal') as BufferAttribute));
    geometry.setAttribute('uv', float32(src.getAttribute('uv') as BufferAttribute));
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
    geometry.setAttribute('skinWeight', float32(weights));
    geometry.setAttribute('color', constant(count, [1, 1, 1]));
    geometry.setAttribute('dyeMask', constant(count, [0, 0, 0, 0]));
    geometry.setAttribute('texLayer', constant(count, [0]));
    geometry.setIndex(src.getIndex()!.clone());

    const source = (mesh.material as MeshStandardMaterial).map;
    if (!source) throw new Error('Character GLB has no albedo texture');
    const d = DEFAULT_COSMETIC_LOADOUT;
    const defaults = [d.dyes.primary, d.dyes.secondary, d.dyes.accent, d.items.skinTone].map((id) => hexToLinear(getCosmetic(id)!.colour!));
    const { albedo, mask, skinAt } = createDyeTextures(source, defaults);
    const regions = classifyTriangles(
      geometry,
      (v) => {
        let best = 0;
        for (let c = 1; c < 4; c++) if (weights.getComponent(v, c) > weights.getComponent(v, best)) best = c;
        return names[joints.getComponent(v, best)] ?? '';
      },
      skinAt,
    );
    source.dispose();
    (source.image as ImageBitmap | undefined)?.close?.();
    return { scene, geometry, regions, albedo, mask, clips };
  }

  private build(loadout: CosmeticLoadout, lod: CharacterLod): BufferGeometry {
    const base = this.bases[lod]!;
    const widthMul = getCosmetic(loadout.items.bodyType)?.widthMul ?? 1;
    const hidden = new Set<Region>();
    const parts: BufferGeometry[] = [];
    for (const slot of PART_SLOTS) {
      const id = loadout.items[slot];
      const builtIn = BUILT_IN[slot];
      const recipe = PLACEHOLDERS[id];
      // An item without art (or "none") keeps the built-in default, so a part never goes missing.
      if (builtIn?.item === id || !recipe) continue;
      if (builtIn) hidden.add(builtIn.region);
      for (const p of recipe()) parts.push(this.pieceGeometry(fitPieceToBody(p.geometry, widthMul), p.bone, p.colour, p.mask));
    }
    const body = new BufferGeometry();
    for (const [name, attr] of Object.entries(base.geometry.attributes)) body.setAttribute(name, attr);
    const index = base.geometry.getIndex()!;
    const kept: number[] = [];
    for (let t = 0; t < base.regions.length; t++) if (!hidden.has(base.regions[t] as Region)) kept.push(index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2));
    body.setIndex(kept);
    const merged = mergeGeometries([body, ...parts]);
    for (const p of parts) p.dispose();
    if (!merged) throw new Error('Character part attributes do not match the body');
    if (widthMul !== 1) {
      // Only the body's own vertices (merged first, all of them) scale; parts were fitted above.
      const pos = merged.getAttribute('position') as BufferAttribute;
      const p = new Vector3();
      for (let i = 0; i < body.getAttribute('position').count; i++) {
        widenPoint(p.fromBufferAttribute(pos, i), widthMul);
        pos.setXYZ(i, p.x, p.y, p.z);
      }
    }
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  }

  private pieceGeometry(source: BufferGeometry, bone: string, colour: string, mask: readonly number[]): BufferGeometry {
    const joint = Math.max(0, this.joints.indexOf(bone));
    const count = source.getAttribute('position').count;
    const g = new BufferGeometry();
    g.setAttribute('position', source.getAttribute('position'));
    g.setAttribute('normal', source.getAttribute('normal'));
    g.setAttribute('uv', source.getAttribute('uv'));
    g.setAttribute('skinIndex', new Uint16BufferAttribute(new Uint16Array(count * 4).map((_, i) => (i % 4 === 0 ? joint : 0)), 4));
    g.setAttribute('skinWeight', constant(count, [1, 0, 0, 0]));
    g.setAttribute('color', constant(count, hexToLinear(colour)));
    g.setAttribute('dyeMask', constant(count, mask));
    g.setAttribute('texLayer', constant(count, [-1]));
    g.setIndex(source.getIndex());
    return g;
  }
}

/** Region of every triangle of an indexed geometry, from its centroid, its first vertex's dominant bone
 *  and the skin weight at its UV centroid. */
export function classifyTriangles(geometry: BufferGeometry, dominantBone: (vertex: number) => string, skinAt: (u: number, v: number) => number): Uint8Array {
  const index = geometry.getIndex()!;
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const regions = new Uint8Array(index.count / 3);
  for (let t = 0; t < regions.length; t++) {
    const [a, b, c] = [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)];
    const x = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const z = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const skin = skinAt((uv.getX(a) + uv.getX(b) + uv.getX(c)) / 3, (uv.getY(a) + uv.getY(b) + uv.getY(c)) / 3);
    regions[t] = classifyRegion(dominantBone(a), x, y, z, skin);
  }
  return regions;
}

class Instance implements CharacterInstance {
  readonly root: Object3D;
  readonly meshes: readonly SkinnedMesh[];
  readonly material: DyeMaterial;
  readonly clips: readonly AnimationClip[];
  readonly exhaustColour = new Color();
  loadout: CosmeticLoadout;
  loadoutHash = 0;
  lod: CharacterLod;
  private readonly mesh: SkinnedMesh;
  private readonly bones = new Map<string, Bone>();
  private disposed = false;

  constructor(
    private readonly assembler: CharacterAssembler,
    loadout: CosmeticLoadout,
    lod: CharacterLod,
  ) {
    const lod0 = assembler.base(0);
    this.root = cloneSkinned(lod0.scene);
    this.mesh = findSkinnedMesh(this.root);
    for (const b of this.mesh.skeleton.bones) this.bones.set(b.name, b);
    this.meshes = [this.mesh];
    this.clips = lod0.clips;
    this.loadout = loadout;
    this.lod = lod;
    const base = assembler.base(lod);
    this.material = new DyeMaterial(base.albedo, base.mask);
    this.mesh.material = this.material;
    this.mesh.geometry = assembler.acquire(loadout, lod);
    this.applyColours();
  }

  bone(name: string): Bone | null {
    return this.bones.get(name) ?? null;
  }

  setLoadout(loadout: CosmeticLoadout): void {
    const next = sanitizeCosmeticLoadout(loadout);
    if (partsKey(next, this.lod) !== partsKey(this.loadout, this.lod)) this.swapGeometry(next, this.lod);
    this.loadout = next;
    this.applyColours();
  }

  setLod(lod: CharacterLod): void {
    if (lod === this.lod) return;
    this.swapGeometry(this.loadout, lod);
    const base = this.assembler.base(lod);
    this.material.setMaps(base.albedo, base.mask);
    this.lod = lod;
  }

  setTeamColour(colour: ColorRepresentation | null): void {
    if (colour === null) this.material.dye.team.setRGB(0, 0, 0);
    else this.material.dye.team.set(colour);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.assembler.release(this.loadout, this.lod);
    this.material.dispose();
    this.root.removeFromParent();
  }

  private swapGeometry(loadout: CosmeticLoadout, lod: CharacterLod): void {
    const geometry = this.assembler.acquire(loadout, lod);
    this.assembler.release(this.loadout, this.lod);
    this.mesh.geometry = geometry;
    this.mesh.computeBoundingBox();
    this.mesh.computeBoundingSphere();
  }

  private applyColours(): void {
    const { dyes, items } = this.loadout;
    const colour = (id: string) => getCosmetic(id)?.colour ?? '#ffffff';
    const d = this.material.dye;
    d.primary.set(colour(dyes.primary));
    d.secondary.set(colour(dyes.secondary));
    d.accent.set(colour(dyes.accent));
    d.skin.set(colour(items.skinTone));
    this.exhaustColour.set(colour(items.exhaust));
    this.loadoutHash = cosmeticLoadoutHash(this.loadout);
  }
}
