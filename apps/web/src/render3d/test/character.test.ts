import { Bone, BufferGeometry, Float32BufferAttribute, Group, MeshStandardMaterial, Skeleton, SkinnedMesh, Uint16BufferAttribute } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { RookieAssembler, toonRamp, type GltfSource } from '../character';

/** A one-bone skinned scene, the shape GLTFLoader returns for the Rookie. */
function fakeGltf(): GLTF {
  const bone = new Bone();
  bone.name = 'pelvis';
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new SkinnedMesh(geometry, new MeshStandardMaterial());
  mesh.add(bone);
  mesh.bind(new Skeleton([bone]));
  const scene = new Group();
  scene.add(mesh);
  return { scene, scenes: [scene], animations: [], cameras: [], asset: {}, parser: null, userData: {} } as unknown as GLTF;
}

class StubLoader implements GltfSource {
  calls = 0;
  constructor(private failures: number) {}
  loadAsync(): Promise<GLTF> {
    this.calls++;
    return this.failures-- > 0 ? Promise.reject(new Error('network blip')) : Promise.resolve(fakeGltf());
  }
}

describe('RookieAssembler', () => {
  it('frees each instance skeleton bone texture on dispose (no GPU texture leak per avatar)', async () => {
    const assembler = new RookieAssembler('/', toonRamp(), new StubLoader(0));
    const inst = await assembler.create(null, 0);
    const skeleton = inst.meshes[0]!.skeleton;
    skeleton.computeBoneTexture(); // what WebGLRenderer does on the first skinned draw
    const texture = skeleton.boneTexture!;
    let disposed = false;
    texture.addEventListener('dispose', () => (disposed = true));
    inst.dispose();
    expect(disposed).toBe(true);
    expect(skeleton.boneTexture).toBeNull();
  });

  it('gives every instance its own skeleton, so disposing one leaves the others drawable', async () => {
    const assembler = new RookieAssembler('/', toonRamp(), new StubLoader(0));
    const a = await assembler.create(null, 0);
    const b = await assembler.create(null, 0);
    expect(a.meshes[0]!.skeleton).not.toBe(b.meshes[0]!.skeleton);
    b.meshes[0]!.skeleton.computeBoneTexture();
    a.dispose();
    expect(b.meshes[0]!.skeleton.boneTexture).not.toBeNull();
  });

  it('does not cache a failed base-rig load: the next create() tries again', async () => {
    const loader = new StubLoader(1);
    const assembler = new RookieAssembler('/', toonRamp(), loader);
    await expect(assembler.create(null, 0)).rejects.toThrow('network blip');
    const inst = await assembler.create(null, 0);
    expect(inst.meshes).toHaveLength(1);
    expect(loader.calls).toBe(2);
    await assembler.create(null, 0);
    expect(loader.calls).toBe(2); // a successful load is cached
  });
});
