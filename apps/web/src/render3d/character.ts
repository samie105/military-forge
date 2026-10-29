/**
 * The in-game side of character assembly. Soldiers are built by the same CharacterAssembler as the Locker
 * (apps/web/src/character: W8's rig, parts, dye masks and clip library, one toon ramp), so the player in
 * game looks exactly like the Locker preview. This file decides which look each player wears:
 * - anyone whose look the room sent (protocol v19 ROSTER, `setLooks`): that look, the local player's too
 *   (online, what everyone else sees us in), and training's bots (their seeded looks);
 * - the local player otherwise: the look saved in the Locker (LocalLoadoutStore, owned items only);
 * - everyone else: PLACEHOLDER (an older page that sends no look): the default Rookie with dyes picked
 *   by player id, so a room isn't a row of clones.
 */
import type { AnimationClip, Bone, Color, Material, Object3D, SkinnedMesh } from 'three';

export type { CharacterLod } from '../character';
/** the shared toon ramp (one for soldiers, guns and the map); old name kept for existing callers */
export { characterToonRamp as toonRamp } from '../character';
/** who wears which look: three-free (loadouts.ts), so the app's boot code has it before the 3D view's chunk */
export { LoadoutDirectory, PLACEHOLDER_DYES, placeholderLoadout } from './loadouts';

/** What an Avatar needs from a character (the assembler's CharacterInstance has all of this and more). */
export interface CharacterInstance {
  /** glTF +Z forward, +Y up, feet at y = 0, 1.5 m tall */
  readonly root: Object3D;
  readonly meshes: readonly SkinnedMesh[];
  /** shared-v1 bone or socket by name (docs/04 §4.1) */
  bone(name: string): Bone | null;
  readonly clips: readonly AnimationClip[];
  dispose(): void;
  /** the dye material's dissolve (a dying soldier fades: death.ts) and tint (a kill effect's colour: docs/17 §3.7); absent on test rigs */
  readonly material?: { readonly dissolve: { value: number }; readonly tint?: { readonly colour: Color; readonly amount: { value: number } } };
  /** the outline hull and how to swap its material (a dying soldier's dissolves on its own) */
  readonly outline?: { material: Material | Material[] } | null;
  setOutline?(material: Material | null): void;
}
