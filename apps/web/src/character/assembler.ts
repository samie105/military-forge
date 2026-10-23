/**
 * Character assembler (docs/04 §5): loadout → one SkinnedMesh on the shared skeleton, from W8's runtime
 * art (w8-art-assets.md): the split body `characters/rookie/rookie_body*.glb`, one GLB per cosmetic part
 * (`cosmetics/<slot>/<id>*.glb`, skinned in character space on a copy of the shared skeleton), baked dye
 * masks + dye albedos per body/part, and the clip library `rookie_anims.glb`.
 * Parts are merged into the body's geometry (one draw call; each vertex keeps its part's texture layer),
 * dyes are material uniforms, and merged geometries are cached by body type + parts + LOD, so equal outfits
 * share one build. The Locker and the in-game renderer both draw soldiers through this.
 * Bodies (the character creator): each base body (content BODIES: male, female) has its own rig, loaded on
 * first use; an instance swaps body in place on setLoadout (same bones, the new rig's bind pose), so whoever
 * animates or attaches to it keeps working (creator-interfaces.md).
 * Interface notes: w2-character-interface.md (and animation-avatar-split.md) in the shared notes folder.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Matrix4,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  Vector3,
  type AnimationClip,
  type Bone,
  type ColorRepresentation,
  type InterleavedBufferAttribute,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import {
  DEFAULT_COSMETIC_LOADOUT,
  DYE_CHANNELS,
  cosmeticLoadoutHash,
  getCosmetic,
  sanitizeCosmeticLoadout,
  type Body,
  type CosmeticLoadout,
  type DyeChannel,
  type PartSlot,
} from '@military-forge/content';
import { assetSource, type CharacterSource, type LoadedGltf } from './assets';
import { repairClips } from './clipRepair';
import { DYE_LAYERS, DyeMaterial } from './dyeMaterial';
import { bodyAlbedoWithSkin } from './skinMask';

export type CharacterLod = 0 | 1;

/** Part slots W8 makes art for, in texture-layer order (layer 0 is the body). Top and legs are body textures. */
export const ART_SLOTS = ['headgear', 'eyewear', 'gloves', 'boots', 'jetpack'] as const satisfies readonly PartSlot[];
export type ArtSlot = (typeof ART_SLOTS)[number];

/**
 * Each base body's rig manifest (content BODIES: every body type is built on one). The female rig is
 * the Forge's (art/README.md, "The female soldier"): on the male skeleton, sharing his clips. A
 * manifest that 404s draws that body on the male rig (instance.body says so).
 */
export const BODY_MANIFESTS: Readonly<Record<Body, string>> = {
  male: 'characters/rookie/rookie.json',
  female: 'characters/rookie_female/rookie_female.json',
};

/** The base character's manifest (W8: `rookie.json`): the male body's. */
export const ROOKIE_MANIFEST = BODY_MANIFESTS.male;

/** The body a loadout is built on: its body type's (content `body`, male when absent). */
export function bodyOfLoadout(loadout: Pick<CosmeticLoadout, 'items'>): Body {
  return getCosmetic(loadout.items.bodyType)?.body ?? 'male';
}

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
 * Fits a rigid part (headgear, eyewear, jetpack) to a body type: it moves with the body surface under it (its
 * bounding-box centre follows widenPoint) but keeps its own size, so the widening never stacks on the part's
 * own bulk and pushes it out of the cosmetic envelope (docs/04 §1.2).
 */
export function fitPieceToBody(geometry: BufferGeometry, widthMul: number): BufferGeometry {
  if (widthMul === 1) return geometry;
  geometry.computeBoundingBox();
  const centre = geometry.boundingBox!.getCenter(new Vector3());
  const offset = widenPoint(centre.clone(), widthMul).sub(centre);
  return geometry.translate(offset.x, offset.y, offset.z);
}

type LodKey = 'lod0' | 'lod1';
const LOD_KEYS: readonly LodKey[] = ['lod0', 'lod1'];

interface DyeEntry {
  mask: string;
  albedo: string;
  defaults?: Partial<Record<DyeChannel, string>>;
  /** proposal for W8: the albedo's alpha already holds the skin weight */
  skin?: 'alpha';
  /** a sharper albedo and mask for close-ups (the creator, portraits, the VS poster): same UVs, e.g. 1024² (the
   *  animation agent's creator stage; the Forge makes them) */
  heroAlbedo?: string;
  heroMask?: string;
}

/** The fields of W8's manifests the assembler reads (rookie.json and cosmetics/<slot>/<id>.json). */
interface Manifest {
  lods: Record<LodKey, string>;
  dye: Record<LodKey, DyeEntry>;
  anims?: string;
  defaultParts?: Partial<Record<string, string>>;
  upperBodyBones?: string[];
  attachBone?: string;
  nozzles?: [number, number, number][];
  /** a part fitted to each body separately: that body's files (creator-interfaces.md §3); absent = the top-level ones */
  bodies?: Partial<Record<Body, { lods: Record<LodKey, string>; dye: Record<LodKey, DyeEntry> }>>;
}

/** One textured piece of the soldier at one LOD: geometry in the canonical joint order + its dye textures. */
interface Layer {
  /** position, normal, uv, skinIndex (LOD0 joint order), skinWeight, texLayer */
  geometry: BufferGeometry;
  albedo: Texture;
  mask: Texture;
  /** default dye per channel (primary, secondary, accent); null = the player's dye */
  defaults: (Color | null)[];
}

interface BaseRig {
  /** the body this rig draws */
  body: Body;
  /** LOD0 joint names: the canonical skinIndex order of this rig's geometry (and its parts') */
  joints: string[];
  /** bind pose: each joint's inverse bind matrix (canonical order), the mesh's bind matrix, each bone's rest transform */
  boneInverses: Matrix4[];
  bindMatrix: Matrix4;
  rest: Map<string, { position: Vector3; quaternion: Object3D['quaternion']; scale: Vector3 }>;
  /** LOD0 template scene: cloned per instance for its own bones, never rendered */
  scene: Object3D;
  lods: [Layer, Layer];
  clips: AnimationClip[];
  defaultParts: Partial<Record<ArtSlot, string>>;
  upperBodyBones: readonly string[];
  /** bind-pose position of every bone, for fitting skinned parts to body types */
  bonePositions: Map<string, Vector3>;
  /** the LOD0 body's close-up textures, loaded on first ask; null when the manifest lists none */
  hero: (() => Promise<{ albedo: Texture; mask: Texture }>) | null;
}

interface Part {
  id: string;
  slot: ArtSlot;
  /** weighted 100% to one bone (W8 `attachBone`): moves as one piece on body types */
  rigid: boolean;
  lods: [Layer, Layer];
  /** jetpack nozzle exits, glTF character space (W8 `nozzles`) */
  nozzles: readonly (readonly [number, number, number])[];
}

export interface CharacterAssemblerOptions {
  /** where the assets come from (tests); default: `assetBase` over fetch + a meshopt GLTFLoader */
  source?: CharacterSource;
  /** URL prefix of apps/web/public/assets; default `import.meta.env.BASE_URL + 'assets/'` */
  assetBase?: string;
  /** share a configured GLTFLoader (must have the meshopt decoder) */
  loader?: GLTFLoader;
}

export interface CharacterInstance {
  /** glTF +Z forward, +Y up, feet at y = 0, 1.5 m tall */
  readonly root: Object3D;
  /** exactly one: body + parts merged, one material */
  readonly meshes: readonly SkinnedMesh[];
  /** W8's shared clip library (locomotion, aim poses, actions) */
  readonly clips: readonly AnimationClip[];
  readonly material: DyeMaterial;
  readonly loadout: CosmeticLoadout;
  readonly loadoutHash: number;
  readonly lod: CharacterLod;
  /** the body drawn: the loadout's, or male while that body's art isn't available */
  readonly body: Body;
  /** colour of the equipped exhaust, for the jet flame */
  readonly exhaustColour: Color;
  /** nozzle exits of the equipped jetpack, glTF character space (empty: no jetpack art) */
  readonly nozzles: readonly (readonly [number, number, number])[];
  bone(name: string): Bone | null;
  /**
   * Dyes, skin and exhaust apply at once; new parts (and a new body) once they have loaded (the promise).
   * A newer call wins. A body swap keeps this instance's root, bones and mesh (the new rig's bind pose).
   */
  setLoadout(loadout: CosmeticLoadout): Promise<void>;
  setLod(lod: CharacterLod): void;
  /** Team colour for the dye mask's A channel (armband glow, docs/04 §1.4); null = off. */
  setTeamColour(colour: ColorRepresentation | null): void;
  /** Draws an outline (outline.ts) with this material, following every part swap and LOD change; null = none. */
  setOutline(material: Material | null): void;
  /** the outline hull, while there is one */
  readonly outline: SkinnedMesh | null;
  /**
   * Close-up textures on the LOD0 body (the creator stage, portraits, posters) when the body's manifest lists them
   * (`dye.lod0.heroAlbedo`, `heroMask`); resolves whether they're in. Off again: the normal ones.
   */
  setHero(on: boolean): Promise<boolean>;
  dispose(): void;
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

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

/** Float32 copy of any attribute (handles normalised integer and interleaved storage). */
function float32(attr: AnyAttribute): Float32BufferAttribute {
  const n = attr.itemSize;
  const out = new Float32Array(attr.count * n);
  for (let i = 0; i < attr.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = attr.getComponent(i, c);
  return new Float32BufferAttribute(out, n);
}

/** Frees what GLTFLoader decoded that the assembler doesn't draw: the GLB's own (undyed) albedo and geometry. */
function dropSourceMesh(mesh: SkinnedMesh): void {
  const material = mesh.material as MeshStandardMaterial;
  material.map?.dispose();
  (material.map?.image as ImageBitmap | undefined)?.close?.();
  material.dispose();
  mesh.geometry.dispose();
  mesh.geometry = new BufferGeometry();
}

/** A GLB's skinned mesh → canonical geometry (joints remapped by name to `joints`, every vertex on `layer`). */
function canonicalGeometry(mesh: SkinnedMesh, joints: readonly string[], layer: number): BufferGeometry {
  const src = mesh.geometry;
  const names = mesh.skeleton.bones.map((b) => b.name);
  const remap = names.map((n) => Math.max(0, joints.indexOf(n)));
  const count = src.getAttribute('position').count;
  const index = src.getAttribute('skinIndex') as AnyAttribute;
  const skinIndex = new Uint16Array(count * 4);
  for (let i = 0; i < count; i++) for (let c = 0; c < 4; c++) skinIndex[i * 4 + c] = remap[index.getComponent(i, c)] ?? 0;
  const g = new BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'skinWeight']) g.setAttribute(name, float32(src.getAttribute(name) as AnyAttribute));
  g.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  g.setAttribute('texLayer', new Float32BufferAttribute(new Float32Array(count).fill(layer), 1));
  const srcIndex = src.getIndex();
  g.setIndex(srcIndex ? Array.from(srcIndex.array) : Array.from({ length: count }, (_, i) => i));
  dropSourceMesh(mesh);
  return g;
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

function dyeDefaults(entry: DyeEntry): (Color | null)[] {
  return DYE_CHANNELS.map((ch) => (entry.defaults?.[ch] ? new Color(entry.defaults[ch]) : null));
}

/** Geometry key: what changes the mesh. Dyes, skin tone, exhaust and trail don't. */
export function partsKey(bodyType: string, parts: readonly (Part | null)[], lod: CharacterLod): string {
  return [lod, bodyType, ...parts.map((p) => p?.id ?? '-')].join('|');
}

export class CharacterAssembler {
  readonly stats = { builds: 0, hits: 0 };
  private readonly source: CharacterSource;
  /** each body's rig, loading or loaded (a body whose art fails resolves to the male rig) */
  private readonly loading = new Map<Body, Promise<BaseRig>>();
  private readonly bases = new Map<Body, BaseRig>();
  /** parts per body (`body:id`): each rig's joint order and the part's files for that body */
  private readonly parts = new Map<string, Promise<Part>>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly idle = new Set<string>();

  constructor(options: CharacterAssemblerOptions = {}) {
    this.source = options.source ?? assetSource(options.assetBase ?? `${import.meta.env.BASE_URL}assets/`, options.loader);
  }

  /** Loads the male body (both LODs), its dye textures and the clip library once; create() calls it for you. */
  preload(): Promise<void> {
    return this.rigFor('male').then(() => undefined);
  }

  /**
   * A body's rig, loaded once. The male rig rejects when it can't load (a later call tries again); any
   * other body whose art can't load (not made yet, a 404) resolves to the male rig, with a warning.
   */
  rigFor(body: Body): Promise<BaseRig> {
    let p = this.loading.get(body);
    if (!p) {
      p = this.loadBase(body).then(
        (rig) => {
          this.bases.set(body, rig);
          return rig;
        },
        (error: unknown) => {
          if (body === 'male') {
            this.loading.delete(body); // let a later create() retry
            throw error;
          }
          console.warn(`character: the ${body} body's art isn't available, drawing the male body`, error);
          return this.rigFor('male');
        },
      );
      this.loading.set(body, p);
    }
    return p;
  }

  /** Whether a body's own art is in the game (false: it is drawn on the male rig). */
  hasBodyArt(body: Body): Promise<boolean> {
    return this.rigFor(body).then((rig) => rig.body === body);
  }

  /** `rookie.json` upperBodyBones: the bones the aim poses and upper-body actions own. */
  get upperBodyBones(): readonly string[] {
    return this.bases.get('male')?.upperBodyBones ?? [];
  }

  /** loadout null = the default Rookie. Never rejects for a missing part (uses the slot default); only for the base body. */
  async create(loadout: CosmeticLoadout | null, lod: CharacterLod = 0): Promise<CharacterInstance> {
    await this.preload();
    const clean = sanitizeCosmeticLoadout(loadout ?? DEFAULT_COSMETIC_LOADOUT);
    const rig = await this.rigFor(bodyOfLoadout(clean));
    return new Instance(this, rig, clean, await this.resolveParts(clean, rig), lod);
  }

  dispose(): void {
    for (const { geometry } of this.cache.values()) geometry.dispose();
    this.cache.clear();
    this.idle.clear();
    for (const p of this.parts.values()) void p.then((part) => part.lods.forEach((l) => disposeLayer(l)), () => {});
    for (const base of new Set(this.bases.values())) for (const l of base.lods) disposeLayer(l);
    this.parts.clear();
    this.bases.clear();
    this.loading.clear();
  }

  /** @internal the male rig (loaded: after preload()) */
  rig(): BaseRig {
    return this.bases.get('male')!;
  }

  /** @internal the part per art slot for a loadout on `rig`'s body: its item, else the slot default, else none */
  async resolveParts(loadout: CosmeticLoadout, rig: BaseRig = this.rig()): Promise<(Part | null)[]> {
    const base = rig;
    return Promise.all(
      ART_SLOTS.map(async (slot) => {
        const id = loadout.items[slot];
        const fallback = base.defaultParts[slot] ?? null;
        // an item without art keeps the slot default ("none" items have no default to keep)
        const wanted = getCosmetic(id)?.assets.manifest ? id : fallback;
        for (const candidate of new Set([wanted, fallback])) {
          if (!candidate) continue;
          try {
            return await this.part(candidate, slot, base);
          } catch (error) {
            console.warn(`character: no art for ${candidate}, using the ${slot} default`, error);
          }
        }
        return null;
      }),
    );
  }

  /** @internal merged geometry for a parts key, from the cache when possible; pair with release() */
  acquire(key: string, build: () => BufferGeometry): BufferGeometry {
    let entry = this.cache.get(key);
    if (entry) this.stats.hits++;
    else {
      entry = { geometry: build(), refs: 0 };
      this.cache.set(key, entry);
      this.stats.builds++;
    }
    entry.refs++;
    this.idle.delete(key);
    return entry.geometry;
  }

  /** @internal */
  release(key: string): void {
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

  /** @internal body + parts → one geometry (body vertices first), fitted to the body type */
  build(parts: readonly (Part | null)[], widthMul: number, lod: CharacterLod, rig: BaseRig = this.rig()): BufferGeometry {
    const body = rig.lods[lod].geometry;
    const fitted: BufferGeometry[] = [];
    for (const part of parts) {
      if (!part) continue;
      const g = part.lods[lod].geometry;
      fitted.push(widthMul === 1 ? g : part.rigid ? fitPieceToBody(g.clone(), widthMul) : this.fitSkinnedPart(g.clone(), widthMul, rig));
    }
    const merged = mergeGeometries([body, ...fitted]);
    if (widthMul !== 1) for (const g of fitted) g.dispose(); // the clones; the parts' own geometry stays cached
    if (!merged) throw new Error('Character part attributes do not match the body');
    if (widthMul !== 1) {
      // only the body's own vertices (merged first) scale; parts were fitted above
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

  /** Boots and gloves move with the bone each vertex mostly follows (a foot, a hand) without scaling. */
  private fitSkinnedPart(geometry: BufferGeometry, widthMul: number, rig: BaseRig): BufferGeometry {
    const positions = rig.bonePositions;
    const pos = geometry.getAttribute('position') as BufferAttribute;
    const joint = geometry.getAttribute('skinIndex') as BufferAttribute;
    const weight = geometry.getAttribute('skinWeight') as BufferAttribute;
    const offsets = rig.joints.map((name) => {
      const at = positions.get(name);
      return at ? widenPoint(at.clone(), widthMul).sub(at) : new Vector3();
    });
    for (let v = 0; v < pos.count; v++) {
      let best = 0;
      for (let c = 1; c < 4; c++) if (weight.getComponent(v, c) > weight.getComponent(v, best)) best = c;
      const o = offsets[joint.getComponent(v, best)]!;
      pos.setXYZ(v, pos.getX(v) + o.x, pos.getY(v) + o.y, pos.getZ(v) + o.z);
    }
    return geometry;
  }

  private async loadBase(body: Body): Promise<BaseRig> {
    const s = this.source;
    const path = BODY_MANIFESTS[body];
    const manifest = (await s.json(path)) as Manifest;
    const dir = dirOf(path);
    // another body without its own clip library shares the male one (same bone names)
    const animsFrom = manifest.anims || body === 'male' ? s.gltf(dir + (manifest.anims ?? 'rookie_anims.glb')).then((g) => repairClips(g.animations)) : this.rigFor('male').then((m) => m.clips);
    const [lod0, lod1, clips] = await Promise.all([s.gltf(dir + manifest.lods.lod0), s.gltf(dir + manifest.lods.lod1), animsFrom]);
    const mesh0 = findSkinnedMesh(lod0.scene);
    const joints = mesh0.skeleton.bones.map((b) => b.name);
    const skin = getCosmetic(DEFAULT_COSMETIC_LOADOUT.items.skinTone)?.colour ?? '#da9f75';
    const layer = async (gltf: LoadedGltf, key: LodKey): Promise<Layer> => {
      const entry = manifest.dye[key];
      const [albedo, mask] = await Promise.all([s.texture(dir + entry.albedo, true), s.texture(dir + entry.mask, false)]);
      return {
        geometry: canonicalGeometry(findSkinnedMesh(gltf.scene), joints, 0),
        albedo: entry.skin === 'alpha' ? albedo : bodyAlbedoWithSkin(albedo, skin),
        mask,
        defaults: dyeDefaults(entry),
      };
    };
    const lods = (await Promise.all([layer(lod0, 'lod0'), layer(lod1, 'lod1')])) as [Layer, Layer];
    const heroOf = () => {
      const entry = manifest.dye.lod0;
      if (!entry.heroAlbedo || !entry.heroMask) return null;
      let loading: Promise<{ albedo: Texture; mask: Texture }> | null = null;
      return () =>
        (loading ??= Promise.all([s.texture(dir + entry.heroAlbedo!, true), s.texture(dir + entry.heroMask!, false)]).then(([albedo, mask]) => ({
          albedo: entry.skin === 'alpha' ? albedo : bodyAlbedoWithSkin(albedo, skin),
          mask,
        })));
    };
    const bonePositions = new Map<string, Vector3>();
    const m = new Matrix4();
    mesh0.skeleton.bones.forEach((b, i) => bonePositions.set(b.name, new Vector3().setFromMatrixPosition(m.copy(mesh0.skeleton.boneInverses[i]!).invert())));
    const defaultParts: Partial<Record<ArtSlot, string>> = {};
    for (const slot of ART_SLOTS) if (manifest.defaultParts?.[slot]) defaultParts[slot] = manifest.defaultParts[slot];
    const rest = new Map<string, { position: Vector3; quaternion: Object3D['quaternion']; scale: Vector3 }>();
    for (const b of mesh0.skeleton.bones) rest.set(b.name, { position: b.position.clone(), quaternion: b.quaternion.clone(), scale: b.scale.clone() });
    // W8's export garbles quaternion tangents: rebuild them (clipRepair.ts) so every clip plays as authored
    return {
      body,
      joints,
      boneInverses: mesh0.skeleton.boneInverses.map((m) => m.clone()),
      bindMatrix: mesh0.bindMatrix.clone(),
      rest,
      scene: lod0.scene,
      lods,
      clips,
      defaultParts,
      upperBodyBones: manifest.upperBodyBones ?? [],
      bonePositions,
      hero: heroOf(),
    };
  }

  /** One cosmetic part on one body's rig, both LODs (cached; a failed load is not, so a later look tries again). */
  private part(id: string, slot: ArtSlot, rig: BaseRig): Promise<Part> {
    const key = `${rig.body}:${id}`;
    let p = this.parts.get(key);
    if (!p) {
      p = this.loadPart(id, slot, rig);
      this.parts.set(key, p);
      const failed = p;
      p.catch(() => {
        if (this.parts.get(key) === failed) this.parts.delete(key);
      });
    }
    return p;
  }

  private async loadPart(id: string, slot: ArtSlot, rig: BaseRig): Promise<Part> {
    const s = this.source;
    const path = getCosmetic(id)?.assets.manifest ?? `cosmetics/${slot}/${id}.json`;
    const manifest = (await s.json(path)) as Manifest;
    const dir = dirOf(path);
    const files = manifest.bodies?.[rig.body] ?? manifest;
    const layerIndex = 1 + ART_SLOTS.indexOf(slot);
    const lods = (await Promise.all(
      LOD_KEYS.map(async (key): Promise<Layer> => {
        const entry = files.dye[key];
        const [gltf, albedo, mask] = await Promise.all([s.gltf(dir + files.lods[key]), s.texture(dir + entry.albedo, true), s.texture(dir + entry.mask, false)]);
        return { geometry: canonicalGeometry(findSkinnedMesh(gltf.scene), rig.joints, layerIndex), albedo, mask, defaults: dyeDefaults(entry) };
      }),
    )) as [Layer, Layer];
    return { id, slot, rigid: !!manifest.attachBone, lods, nozzles: manifest.nozzles ?? [] };
  }
}

function disposeLayer(l: Layer): void {
  l.geometry.dispose();
  l.albedo.dispose();
  l.mask.dispose();
}

class Instance implements CharacterInstance {
  readonly root: Object3D;
  readonly meshes: readonly SkinnedMesh[];
  readonly material = new DyeMaterial();
  readonly clips: readonly AnimationClip[];
  readonly exhaustColour = new Color();
  loadout: CosmeticLoadout;
  loadoutHash = 0;
  lod: CharacterLod;
  private parts: (Part | null)[];
  private key: string;
  private rig: BaseRig;
  outline: SkinnedMesh | null = null;
  private readonly mesh: SkinnedMesh;
  private readonly bones = new Map<string, Bone>();
  /** bumped by every setLoadout(): only the newest may swap parts in */
  private pending = 0;
  private disposed = false;

  constructor(
    private readonly assembler: CharacterAssembler,
    rig: BaseRig,
    loadout: CosmeticLoadout,
    parts: (Part | null)[],
    lod: CharacterLod,
  ) {
    this.rig = rig;
    this.root = cloneSkinned(rig.scene);
    this.mesh = findSkinnedMesh(this.root);
    for (const b of this.mesh.skeleton.bones) this.bones.set(b.name, b);
    this.mesh.material = this.material;
    // bind-pose bounds don't follow the animated skeleton (jet poses, flailing): never cull a soldier
    this.mesh.frustumCulled = false;
    this.meshes = [this.mesh];
    this.clips = rig.clips;
    this.loadout = loadout;
    this.lod = lod;
    this.parts = parts;
    this.key = this.keyFor(parts, lod);
    this.mesh.geometry = this.acquire(this.key, parts, lod);
    this.applyTextures();
    this.applyColours();
  }

  get body(): Body {
    return this.rig.body;
  }

  get nozzles(): readonly (readonly [number, number, number])[] {
    return this.parts[ART_SLOTS.indexOf('jetpack')]?.nozzles ?? [];
  }

  bone(name: string): Bone | null {
    return this.bones.get(name) ?? null;
  }

  async setLoadout(loadout: CosmeticLoadout): Promise<void> {
    const next = sanitizeCosmeticLoadout(loadout);
    const seq = ++this.pending;
    this.loadout = next;
    this.applyColours();
    const wanted = await this.assembler.rigFor(bodyOfLoadout(next));
    const rig = wanted === this.rig || this.fitsSkeleton(wanted) ? wanted : this.rig;
    const parts = await this.assembler.resolveParts(next, rig);
    if (seq !== this.pending || this.disposed) return;
    if (rig !== this.rig) this.rebind(rig);
    this.swap(parts, this.lod);
    this.applyColours();
  }

  /** Whether this instance's bones can take `rig`'s bind pose: every joint it skins to is one of ours. */
  private fitsSkeleton(rig: BaseRig): boolean {
    const missing = rig.joints.filter((n) => !this.bones.has(n));
    if (missing.length) console.warn(`character: the ${rig.body} rig has bones this soldier lacks (${missing.join(', ')}); keeping the ${this.rig.body} body`);
    return missing.length === 0;
  }

  /**
   * Another body's bind pose on the same bones: rest transforms, inverse bind matrices (in that rig's
   * joint order, which its geometry is skinned in) and bind matrix. The root, the bones (sockets,
   * attachments) and the mesh stay, so an AnimationMixer on the root keeps playing.
   */
  private rebind(rig: BaseRig): void {
    for (const [name, rest] of rig.rest) {
      const bone = this.bones.get(name);
      if (!bone) continue;
      bone.position.copy(rest.position);
      bone.quaternion.copy(rest.quaternion);
      bone.scale.copy(rest.scale);
    }
    const old = this.mesh.skeleton;
    const skeleton = new Skeleton(
      rig.joints.map((n) => this.bones.get(n)!),
      rig.boneInverses.map((m) => m.clone()),
    );
    this.mesh.bind(skeleton, rig.bindMatrix);
    this.outline?.bind(skeleton, rig.bindMatrix);
    old.dispose();
    // the old rig's geometry key no longer applies: swap() acquires the new body's
    this.rig = rig;
    // the close-up textures were the old body's
    this.hero = null;
    if (this.heroOn) void this.setHero(true);
  }

  setLod(lod: CharacterLod): void {
    if (lod === this.lod || this.disposed) return;
    this.swap(this.parts, lod);
    this.applyColours();
  }

  setTeamColour(colour: ColorRepresentation | null): void {
    if (colour === null) this.material.dye.team.setRGB(0, 0, 0);
    else this.material.dye.team.set(colour);
  }

  setOutline(material: Material | null): void {
    if (!material) {
      this.outline?.removeFromParent();
      this.outline = null;
      return;
    }
    if (this.outline) {
      this.outline.material = material;
      return;
    }
    // the same geometry and skeleton drawn again (the skeleton updates once a frame for both)
    const hull = new SkinnedMesh(this.mesh.geometry, material);
    hull.name = 'outline';
    hull.bind(this.mesh.skeleton, this.mesh.bindMatrix);
    hull.frustumCulled = false;
    hull.castShadow = false;
    this.mesh.add(hull);
    this.outline = hull;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.assembler.release(this.key);
    this.material.dispose();
    // each instance owns its skeleton's bone texture on the GPU once drawn
    this.mesh.skeleton.dispose();
    this.root.removeFromParent();
  }

  private keyFor(parts: readonly (Part | null)[], lod: CharacterLod): string {
    // the rig drawn, too: a body whose art isn't in yet draws (and caches) on the male rig
    return partsKey(`${this.rig.body}/${this.loadout.items.bodyType}`, parts, lod);
  }

  private acquire(key: string, parts: readonly (Part | null)[], lod: CharacterLod): BufferGeometry {
    const widthMul = getCosmetic(this.loadout.items.bodyType)?.widthMul ?? 1;
    const rig = this.rig;
    return this.assembler.acquire(key, () => this.assembler.build(parts, widthMul, lod, rig));
  }

  private swap(parts: (Part | null)[], lod: CharacterLod): void {
    const key = this.keyFor(parts, lod);
    this.parts = parts;
    this.lod = lod;
    if (key !== this.key) {
      const geometry = this.acquire(key, parts, lod);
      this.assembler.release(this.key);
      this.key = key;
      this.mesh.geometry = geometry;
      if (this.outline) this.outline.geometry = geometry;
    }
    this.applyTextures();
  }

  private hero: { albedo: Texture; mask: Texture } | null = null;
  private heroOn = false;

  async setHero(on: boolean): Promise<boolean> {
    this.heroOn = on;
    const rig = this.rig;
    if (!on || !rig.hero) {
      this.applyTextures();
      return false;
    }
    const hero = await rig.hero().catch(() => null);
    if (!hero || rig !== this.rig || !this.heroOn) return false;
    this.hero = hero;
    this.applyTextures();
    return true;
  }

  private applyTextures(): void {
    const base = this.rig.lods[this.lod];
    const hero = this.heroOn && this.lod === 0 && this.rig.hero ? this.hero : null;
    this.material.setLayer(0, hero?.albedo ?? base.albedo, hero?.mask ?? base.mask);
    ART_SLOTS.forEach((_, i) => {
      const layer = this.parts[i]?.lods[this.lod];
      this.material.setLayer(i + 1, layer?.albedo ?? null, layer?.mask ?? null);
    });
  }

  /** The player's dye per channel, or each part's own default while the channel holds the default dye (docs/04 §5.4). */
  private applyColours(): void {
    const { dyes, items } = this.loadout;
    const colour = (id: string) => getCosmetic(id)?.colour ?? '#ffffff';
    const d = this.material.dye;
    d.primary.set(colour(dyes.primary));
    d.secondary.set(colour(dyes.secondary));
    d.accent.set(colour(dyes.accent));
    d.skin.set(colour(items.skinTone));
    const chosen = [d.primary, d.secondary, d.accent];
    const body = this.rig.lods[this.lod];
    body.defaults.forEach((own, c) => this.material.bodyDefaults[c]!.copy(own ?? chosen[c]!));
    const layers = [body, ...this.parts.map((p) => p?.lods[this.lod])];
    for (let layer = 0; layer < DYE_LAYERS; layer++) {
      DYE_CHANNELS.forEach((ch, c) => {
        const own = layers[layer]?.defaults[c];
        const useDefault = dyes[ch] === DEFAULT_COSMETIC_LOADOUT.dyes[ch] && own;
        this.material.layerColours[layer * 3 + c]!.copy(useDefault ? own : chosen[c]!);
      });
    }
    this.exhaustColour.set(colour(items.exhaust));
    this.loadoutHash = cosmeticLoadoutHash(this.loadout);
  }
}
