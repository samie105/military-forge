/**
 * A tiny stand-in for W8's runtime character art, served through a fake CharacterSource: the shared-v1
 * skeleton, a body with one triangle per region, one triangle per cosmetic part (skinned to its bone),
 * a clip library and 2×1 dye textures. LOD1 files list the joints in reverse, to exercise the remap.
 */
import { AnimationClip, Bone, BufferGeometry, DataTexture, Float32BufferAttribute, Group, Matrix4, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute, type Texture } from 'three';
import type { CharacterSource, LoadedGltf } from '../../src/character';

export const JOINTS = [
  'root', 'pelvis', 'spine1', 'spine2', 'clavicle_L', 'upperarm_L', 'forearm_L', 'hand_L', 'socket_weapon_L', 'clavicle_R',
  'upperarm_R', 'forearm_R', 'hand_R', 'socket_weapon_R', 'socket_offhand_IK', 'neck', 'head', 'eye_L', 'eye_R', 'jaw',
  'socket_hat', 'socket_back', 'socket_jetpack', 'thigh_L', 'calf_L', 'foot_L', 'toe_L', 'thigh_R', 'calf_R', 'foot_R',
  'toe_R', 'socket_nameplate',
];

/** bind-pose bone positions (the Rookie's, rounded) */
const BONE_AT: Record<string, [number, number, number]> = {
  pelvis: [0, 0.47, -0.016], spine1: [0, 0.57, -0.016], spine2: [0, 0.715, -0.016], neck: [0, 0.86, -0.016], head: [0, 0.99, -0.011],
  hand_L: [0.374, 0.578, -0.024], hand_R: [-0.374, 0.578, -0.024], foot_L: [0.186, 0.12, -0.06], foot_R: [-0.186, 0.12, -0.06],
};

/** [bone, centroid x, y, z] per body triangle */
export const BODY: readonly [string, number, number, number][] = [
  ['spine2', 0.1, 0.7, 0.05], // uniform
  ['spine2', -0.1, 0.75, 0.1], // webbing
  ['head', 0, 1.1, 0.2], // face
  ['hand_L', 0.37, 0.56, 0], // hand
];

/** [bone, centroid] of each part's single triangle; rigid parts name their attachBone */
export const PARTS: Record<string, { slot: string; bone: string; at: [number, number, number]; rigid: boolean; defaults: Record<string, string> }> = {
  headgear_brim_helmet: { slot: 'headgear', bone: 'head', at: [0, 1.35, 0], rigid: true, defaults: { primary: '#b2925f', accent: '#1a7a79' } },
  headgear_field_cap: { slot: 'headgear', bone: 'head', at: [0, 1.3, 0.05], rigid: true, defaults: { primary: '#556b2f' } },
  eyewear_aviators: { slot: 'eyewear', bone: 'head', at: [0, 1.12, 0.24], rigid: true, defaults: { secondary: '#ebba42' } },
  gloves_tactical: { slot: 'gloves', bone: 'hand_L', at: [0.38, 0.55, 0], rigid: false, defaults: { primary: '#171719' } },
  boots_combat: { slot: 'boots', bone: 'foot_L', at: [0.19, 0.06, 0.02], rigid: false, defaults: {} },
  boots_jungle: { slot: 'boots', bone: 'foot_L', at: [0.19, 0.07, 0.02], rigid: false, defaults: { secondary: '#4a5a2a' } },
  jetpack_twin_tank: { slot: 'jetpack', bone: 'spine2', at: [0, 0.7, -0.3], rigid: true, defaults: { secondary: '#70623d' } },
  jetpack_drum: { slot: 'jetpack', bone: 'spine2', at: [0, 0.72, -0.31], rigid: true, defaults: {} },
};

export const BODY_DEFAULTS = { primary: '#b99664', secondary: '#665b2c', accent: '#239090' };

/** 2×1 sRGB texels of the body albedo: a neutral grey dye texel and a lit skin texel */
export const BODY_TEXELS = [
  [200, 200, 200, 255],
  [218, 159, 117, 255],
];

function rig(order: readonly string[], triangles: readonly [string, number, number, number][], height = 1): Group {
  const bones = order.map((name) => Object.assign(new Bone(), { name }));
  const byName = new Map(bones.map((b) => [b.name, b]));
  const root = byName.get('root')!;
  for (const b of bones) {
    if (b === root) continue;
    root.add(b); // flat hierarchy: enough for skinning maths
    b.position.fromArray(BONE_AT[b.name] ?? [0, 0, 0]);
    b.position.y *= height;
  }
  root.updateMatrixWorld(true);
  const pos: number[] = [];
  const uv: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  for (const [bone, x, y, z] of triangles) {
    for (const [dx, dy] of [[-0.02, -0.02], [0.02, -0.02], [0, 0.03]]) {
      pos.push(x + dx!, y + dy!, z);
      uv.push(0.25, 0.5);
      skinIndex.push(order.indexOf(bone), 0, 0, 0);
      skinWeight.push(1, 0, 0, 0);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geometry.computeVertexNormals();
  geometry.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(Array.from({ length: pos.length / 3 }, (_, i) => i));
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
  mesh.add(root);
  mesh.bind(new Skeleton(bones, bones.map((b) => new Matrix4().copy(b.matrixWorld).invert())));
  const scene = new Group();
  scene.add(mesh);
  return scene;
}

function texture(texels: number[][]): Texture {
  const t = new DataTexture(Uint8Array.from(texels.flat()), texels.length, 1);
  t.needsUpdate = true;
  return t;
}

const lods = (stem: string) => ({ lod0: `${stem}.glb`, lod1: `${stem}_lod1.glb` });
const dye = (stem: string, defaults: Record<string, string>) => ({
  lod0: { mask: `textures/${stem}_dye_mask.png`, albedo: `textures/${stem}_dye_albedo.webp`, defaults },
  lod1: { mask: `textures/${stem}_lod1_dye_mask.png`, albedo: `textures/${stem}_lod1_dye_albedo.webp`, defaults },
});

/** A second body (the character creator): its rig's joint order, height (bone y scale) and bones it lacks. */
export interface FakeBody {
  joints?: readonly string[];
  height?: number;
  missing?: readonly string[];
  /** its own clip library (else it shares the male one) */
  anims?: boolean;
}

export const FEMALE_MANIFEST = 'characters/rookie_female/rookie_female.json';

export interface FakeSource extends CharacterSource {
  /** paths requested so far */
  readonly requests: string[];
  /** item ids whose files fail to load */
  readonly broken: Set<string>;
  /** reject this many base loads first (a network blip) */
  failBase: number;
}

export function fakeSource(female: FakeBody | null = null): FakeSource {
  const requests: string[] = [];
  const broken = new Set<string>();
  const src: FakeSource = {
    requests,
    broken,
    failBase: 0,
    async json(path) {
      requests.push(path);
      if (path === 'characters/rookie/rookie.json') {
        if (src.failBase > 0 && src.failBase--) throw new Error('network blip');
        return {
          lods: lods('rookie_body'),
          anims: 'rookie_anims.glb',
          dye: dye('rookie_body', BODY_DEFAULTS),
          defaultParts: { headgear: 'headgear_brim_helmet', boots: 'boots_combat', jetpack: 'jetpack_twin_tank' },
          upperBodyBones: ['spine1', 'spine2', 'neck', 'head'],
        };
      }
      if (path === FEMALE_MANIFEST) {
        if (!female) throw new Error(`${path}: HTTP 404`);
        return {
          lods: lods('rookie_female_body'),
          ...(female.anims ? { anims: 'rookie_female_anims.glb' } : {}),
          dye: dye('rookie_female_body', BODY_DEFAULTS),
          defaultParts: { headgear: 'headgear_brim_helmet', boots: 'boots_combat', jetpack: 'jetpack_twin_tank' },
          upperBodyBones: ['spine1', 'spine2', 'neck', 'head'],
        };
      }
      const id = path.slice(path.lastIndexOf('/') + 1, -'.json'.length);
      const part = PARTS[id];
      if (!part || broken.has(id)) throw new Error(`${path}: HTTP 404`);
      return {
        id,
        slot: part.slot,
        lods: lods(id),
        dye: dye(id, part.defaults),
        ...(part.rigid ? { attachBone: part.bone } : {}),
        ...(id === 'jetpack_twin_tank' ? { nozzles: [[-0.06, 0.54, -0.3], [0.07, 0.54, -0.23]] } : id === 'jetpack_drum' ? { nozzles: [[0, 0.5, -0.31]] } : {}),
      };
    },
    async gltf(path): Promise<LoadedGltf> {
      requests.push(path);
      const order = path.includes('_lod1') ? [...JOINTS].reverse() : JOINTS;
      if (path.endsWith('rookie_anims.glb')) return { scene: rig(order, []), animations: [new AnimationClip('idle', 1, []), new AnimationClip('walk', 1, [])] };
      if (path.endsWith('rookie_female_anims.glb')) return { scene: rig(order, []), animations: [new AnimationClip('idle_f', 1, [])] };
      if (path.includes('rookie_female_body') && female) {
        const joints = (female.joints ?? JOINTS).filter((j) => !female.missing?.includes(j));
        return { scene: rig(path.includes('_lod1') ? [...joints].reverse() : joints, BODY, female.height ?? 1), animations: [] };
      }
      if (path.includes('rookie_body')) return { scene: rig(order, BODY), animations: [] };
      const id = path.slice(path.lastIndexOf('/') + 1).replace(/(_lod1)?\.glb$/, '');
      const part = PARTS[id]!;
      return { scene: rig(order, [[part.bone, ...part.at]]), animations: [] };
    },
    async texture(path, colour) {
      requests.push(path);
      if (path.includes('rookie_body') && colour) return texture(BODY_TEXELS);
      return texture(colour ? [[255, 255, 255, 255], [128, 128, 128, 255]] : [[255, 0, 0, 0], [0, 255, 0, 0]]);
    },
  };
  return src;
}
