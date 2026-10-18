/**
 * Where the character assembler gets W8's runtime files (apps/web/public/assets, w8-art-assets.md):
 * JSON manifests, meshopt GLBs and the dye textures. Tests pass a fake source.
 */
import { NoColorSpace, SRGBColorSpace, TextureLoader, type AnimationClip, type Object3D, type Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export interface LoadedGltf {
  scene: Object3D;
  animations: AnimationClip[];
}

export interface CharacterSource {
  /** paths are relative to the assets root, e.g. `characters/rookie/rookie.json` */
  json(path: string): Promise<unknown>;
  gltf(path: string): Promise<LoadedGltf>;
  /** colour textures are sRGB, data textures (dye masks) linear; both in glTF UV orientation (flipY false) */
  texture(path: string, colour: boolean): Promise<Texture>;
}

/** A GLTFLoader that reads W8's GLBs (EXT_meshopt_compression, EXT_texture_webp). */
export function characterGltfLoader(): GLTFLoader {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
}

/** The assets under `base` (a URL prefix ending in '/'), e.g. `import.meta.env.BASE_URL + 'assets/'`. */
export function assetSource(base: string, loader: GLTFLoader = characterGltfLoader()): CharacterSource {
  const textures = new TextureLoader();
  return {
    async json(path) {
      const res = await fetch(base + path);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.json();
    },
    gltf: (path) => loader.loadAsync(base + path),
    async texture(path, colour) {
      const t = await textures.loadAsync(base + path);
      t.flipY = false;
      t.colorSpace = colour ? SRGBColorSpace : NoColorSpace;
      t.anisotropy = 4;
      return t;
    },
  };
}
