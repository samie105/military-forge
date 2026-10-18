/**
 * W8's real skeleton and clip library (apps/web/public/assets/characters/rookie/rookie_anims.glb) for tests:
 * no mesh, no textures, so it parses in Node with the meshopt decoder. Clips are repaired as the assembler does.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AnimationClip, Bone, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { repairClips } from '../../character';
import type { CharacterInstance } from '../character';

let cached: Promise<{ scene: Object3D; animations: AnimationClip[] }> | null = null;
/** the clips as the assembler serves them (clipRepair.ts), shared like the assembler shares them */
let repaired: AnimationClip[] | null = null;

function parse(): Promise<{ scene: Object3D; animations: AnimationClip[] }> {
  const buf = readFileSync(fileURLToPath(new URL('../../../public/assets/characters/rookie/rookie_anims.glb', import.meta.url)));
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  return new Promise((resolve, reject) => loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', resolve, reject));
}

/** A fresh Rookie skeleton (its own bones) with the shared clip library. */
export async function rookieRig(): Promise<CharacterInstance> {
  cached ??= parse();
  const gltf = await cached;
  const { clone } = await import('three/addons/utils/SkeletonUtils.js');
  const root = clone(gltf.scene);
  const bones = new Map<string, Bone>();
  root.traverse((o) => {
    if ((o as Bone).isBone) bones.set(o.name, o as Bone);
  });
  return { root, meshes: [], clips: (repaired ??= repairClips(gltf.animations)), bone: (n) => bones.get(n) ?? null, dispose: () => root.removeFromParent() };
}
