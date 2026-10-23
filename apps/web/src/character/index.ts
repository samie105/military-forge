/**
 * Character assembly for every renderer that draws a soldier (the in-game renderer, the Locker).
 * Interface notes: w2-character-interface.md in the shared notes folder.
 */
export {
  ART_SLOTS,
  BODY_MANIFESTS,
  CharacterAssembler,
  LOD0_ABOVE_PX,
  LOD1_BELOW_PX,
  ROOKIE_MANIFEST,
  bodyOfLoadout,
  partsKey,
  selectLod,
  type ArtSlot,
  type CharacterAssemblerOptions,
  type CharacterInstance,
  type CharacterLod,
} from './assembler';
export { assetSource, characterGltfLoader, type CharacterSource, type LoadedGltf } from './assets';
export { CLIP_FPS, repairClip, repairClips } from './clipRepair';
export { DYE_LAYERS, DyeMaterial, characterToonRamp, type DyeColours } from './dyeMaterial';
export { OUTLINE_COLOUR, OutlineMaterial } from './outline';
