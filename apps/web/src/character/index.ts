/**
 * Character assembly for every renderer that draws a soldier (W1's in-game renderer, the Locker).
 * Interface notes: w2-character-interface.md in the shared notes folder.
 */
export {
  CharacterAssembler,
  LOD0_ABOVE_PX,
  LOD1_BELOW_PX,
  partsKey,
  selectLod,
  type CharacterAssemblerOptions,
  type CharacterInstance,
  type CharacterLod,
} from './assembler';
export { DyeMaterial, characterToonRamp, type DyeColours } from './dyeMaterial';
