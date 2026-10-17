/**
 * Character assembly stand-in. W2 owns the real assembler (`apps/web/src/character/**`: parts,
 * dyes, one merged SkinnedMesh, docs/04 §5). W2 published its v1 interface (notes folder,
 * w2-character-interface.md) on the shape proposed in w1-render3d-interfaces.md §1; its code is
 * on the unmerged ws/locker branch. Until that merges, render3d loads the Phase 0 Rookie through
 * this adapter. Swap plan when ws/locker lands: construct W2's `CharacterAssembler` with
 * `baseUrls` pointing at assets/characters/rookie_phase0/ and this file's loader, take the jet
 * flame colour from `instance.exhaustColour`, and apply presets by setting properties on
 * `instance.material` instead of replacing it (that would lose the dyes).
 */
import { DataTexture, MeshToonMaterial, NearestFilter, RedFormat, type AnimationClip, type Bone, type Material, type Object3D, type SkinnedMesh } from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export type CharacterLod = 0 | 1;

export interface CharacterInstance {
  /** glTF +Z forward, +Y up, feet at y = 0, 1.5 m tall */
  readonly root: Object3D;
  readonly meshes: readonly SkinnedMesh[];
  /** shared-v1 bone or socket by name (docs/04 §4.1) */
  bone(name: string): Bone | null;
  readonly clips: readonly AnimationClip[];
  dispose(): void;
}

export interface CharacterAssembler {
  /** loadout null = the default Rookie */
  create(loadout: unknown | null, lod: CharacterLod): Promise<CharacterInstance>;
}

/** The toon ramp from the art-style test (art/README.md): three bands, nearest-filtered. */
export function toonRamp(): DataTexture {
  const ramp = new DataTexture(new Uint8Array([110, 185, 255]), 3, 1, RedFormat);
  ramp.minFilter = ramp.magFilter = NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

const PHASE0_URLS: Record<CharacterLod, string> = {
  0: 'assets/characters/rookie_phase0/rookie.glb',
  1: 'assets/characters/rookie_phase0/rookie_lod1.glb',
};

/** the part of GLTFLoader the assembler uses (tests pass a stub) */
export interface GltfSource {
  loadAsync(url: string): Promise<GLTF>;
}

export class RookieAssembler implements CharacterAssembler {
  private readonly sources = new Map<CharacterLod, Promise<GLTF>>();
  /** one toon material per source material, shared by every instance */
  private readonly materials = new Map<Material, MeshToonMaterial>();

  constructor(
    private readonly baseUrl: string,
    private readonly ramp = toonRamp(),
    private readonly loader: GltfSource = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder),
  ) {}

  private source(lod: CharacterLod): Promise<GLTF> {
    let p = this.sources.get(lod);
    if (!p) {
      p = this.loader.loadAsync(this.baseUrl + PHASE0_URLS[lod]);
      this.sources.set(lod, p);
      // a failed load (network blip, a deploy mid-load) is not cached: the next create() tries again
      const failed = p;
      p.catch(() => {
        if (this.sources.get(lod) === failed) this.sources.delete(lod);
      });
    }
    return p;
  }

  async create(_loadout: unknown | null, lod: CharacterLod): Promise<CharacterInstance> {
    const gltf = await this.source(lod);
    const root = cloneSkinned(gltf.scene);
    const meshes: SkinnedMesh[] = [];
    const bones = new Map<string, Bone>();
    root.traverse((o) => {
      if ((o as SkinnedMesh).isSkinnedMesh) {
        const mesh = o as SkinnedMesh;
        mesh.material = this.toon(mesh.material as Material);
        mesh.frustumCulled = false; // the bind-pose bounds don't follow the animated skeleton
        meshes.push(mesh);
      } else if ((o as Bone).isBone) bones.set(o.name, o as Bone);
    });
    return {
      root,
      meshes,
      clips: gltf.animations,
      bone: (name) => bones.get(name) ?? null,
      dispose: () => {
        // geometry, textures and materials are shared with the cached source; the cloned
        // skeletons are per instance, and each one owns a bone texture on the GPU once drawn
        for (const m of meshes) m.skeleton.dispose();
        root.removeFromParent();
      },
    };
  }

  private toon(src: Material): MeshToonMaterial {
    let m = this.materials.get(src);
    if (!m) {
      const s = src as Material & { map?: MeshToonMaterial['map'] };
      m = new MeshToonMaterial({ map: s.map ?? null, gradientMap: this.ramp });
      this.materials.set(src, m);
    }
    return m;
  }
}
