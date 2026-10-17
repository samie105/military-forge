/**
 * A tiny stand-in for the Rookie GLB: the shared-v1 skeleton, one triangle per body region and a
 * 4×1 albedo (sand, skin, olive, brown), served through a fake GLTFLoader.
 */
import { AnimationClip, Bone, BufferGeometry, DataTexture, Float32BufferAttribute, Group, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import type { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const JOINTS = [
  'root', 'pelvis', 'spine1', 'spine2', 'clavicle_L', 'upperarm_L', 'forearm_L', 'hand_L', 'socket_weapon_L', 'clavicle_R',
  'upperarm_R', 'forearm_R', 'hand_R', 'socket_weapon_R', 'socket_offhand_IK', 'neck', 'head', 'eye_L', 'eye_R', 'jaw',
  'socket_hat', 'socket_back', 'socket_jetpack', 'thigh_L', 'calf_L', 'foot_L', 'toe_L', 'thigh_R', 'calf_R', 'foot_R',
  'toe_R', 'socket_nameplate',
];

/** sRGB texels: u = 0.125 sand, 0.375 skin, 0.625 olive, 0.875 brown */
const TEXELS = [[155, 127, 86], [201, 146, 106], [77, 66, 33], [73, 51, 32]];

/** [bone, centroid x, y, z, texel u] per triangle */
export const TRIANGLES: readonly [string, number, number, number, number][] = [
  ['spine2', 0.1, 0.7, 0.05, 0.125], // uniform (primary)
  ['spine2', -0.1, 0.75, 0.1, 0.625], // webbing (secondary)
  ['head', 0, 1.1, 0.2, 0.375], // face (skin): stays
  ['head', 0, 1.4, 0, 0.125], // helmet dome
  ['foot_L', 0.18, 0.05, 0.05, 0.875], // boot
  ['spine2', 0, 0.75, -0.3, 0.625], // jetpack tank
];

function rig(order: readonly string[]): Group {
  const bones = order.map((name) => Object.assign(new Bone(), { name }));
  const byName = new Map(bones.map((b) => [b.name, b]));
  const root = byName.get('root')!;
  for (const b of bones) if (b !== root) root.add(b); // flat hierarchy: enough for skinning maths
  const pos: number[] = [];
  const uv: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  for (const [bone, x, y, z, u] of TRIANGLES) {
    for (const [dx, dy] of [[-0.02, -0.02], [0.02, -0.02], [0, 0.03]]) {
      pos.push(x + dx!, y + dy!, z);
      uv.push(u, 0.5);
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
  geometry.setIndex(pos.map((_, i) => i).slice(0, pos.length / 3));
  const map = new DataTexture(Uint8Array.from(TEXELS.flatMap((t) => [...t, 255])), 4, 1);
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial({ map }));
  mesh.add(root);
  mesh.bind(new Skeleton(bones));
  const scene = new Group();
  scene.add(mesh);
  return scene;
}

/** LOD1 lists the same joints in another order, to exercise the skinIndex remap. */
export function fakeLoader(): GLTFLoader {
  return {
    loadAsync: async (url: string) => ({
      scene: rig(url.includes('lod1') ? [...JOINTS].reverse() : JOINTS),
      animations: [new AnimationClip('idle', 1, [])],
    }),
  } as unknown as GLTFLoader;
}

export const FAKE_URLS = { 0: 'rookie.glb', 1: 'rookie_lod1.glb' } as const;
