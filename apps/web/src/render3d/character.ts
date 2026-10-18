/**
 * The in-game side of character assembly. Soldiers are built by the same CharacterAssembler as the Locker
 * (apps/web/src/character: W8's rig, parts, dye masks and clip library, one toon ramp), so the player in
 * game looks exactly like the Locker preview. This file decides which look each player wears:
 * - the local player: the look saved in the Locker (LocalLoadoutStore, owned items only);
 * - everyone else: PLACEHOLDER until loadouts travel over the wire (W6 reserves 0x27 LOADOUTS, w6 notes):
 *   the default Rookie with dyes picked by player id, so a room isn't a row of clones.
 */
import { DEFAULT_COSMETIC_LOADOUT, type CosmeticLoadout } from '@military-forge/content';
import type { AnimationClip, Bone, Object3D, SkinnedMesh } from 'three';
import { LocalLoadoutStore, ownedOnly, starterInventory, type LoadoutStore } from '../locker/loadouts';

export type { CharacterLod } from '../character';
/** the shared toon ramp (one for soldiers, guns and the map); old name kept for existing callers */
export { characterToonRamp as toonRamp } from '../character';

/** What an Avatar needs from a character (the assembler's CharacterInstance has all of this and more). */
export interface CharacterInstance {
  /** glTF +Z forward, +Y up, feet at y = 0, 1.5 m tall */
  readonly root: Object3D;
  readonly meshes: readonly SkinnedMesh[];
  /** shared-v1 bone or socket by name (docs/04 §4.1) */
  bone(name: string): Bone | null;
  readonly clips: readonly AnimationClip[];
  dispose(): void;
}

/**
 * PLACEHOLDER dyes for players whose look we don't know yet (no loadout on the wire): starter dyes only, team
 * colours (blue, orange) left out so nobody reads as a team, and never the default look (that's yours).
 */
export const PLACEHOLDER_DYES: readonly (readonly [string, string, string])[] = [
  ['dye_charcoal', 'dye_olive', 'dye_red'],
  ['dye_forest', 'dye_brown', 'dye_yellow'],
  ['dye_white', 'dye_charcoal', 'dye_red'],
  ['dye_brown', 'dye_sand', 'dye_lime'],
  ['dye_olive', 'dye_charcoal', 'dye_pink'],
  ['dye_purple', 'dye_white', 'dye_yellow'],
  ['dye_red', 'dye_charcoal', 'dye_white'],
  ['dye_sand', 'dye_forest', 'dye_white'],
];

/** PLACEHOLDER: the default Rookie dyed by player id, until W2's 0x27 LOADOUTS reaches the renderer. */
export function placeholderLoadout(playerId: number): CosmeticLoadout {
  const [primary, secondary, accent] = PLACEHOLDER_DYES[((playerId % PLACEHOLDER_DYES.length) + PLACEHOLDER_DYES.length) % PLACEHOLDER_DYES.length]!;
  return { items: DEFAULT_COSMETIC_LOADOUT.items, dyes: { primary, secondary, accent } };
}

/** Which look each player wears; `onChange` fires when the local player's saved look has loaded. */
export class LoadoutDirectory {
  private local: CosmeticLoadout = DEFAULT_COSMETIC_LOADOUT;
  onChange: (() => void) | null = null;

  constructor(store: LoadoutStore | null = new LocalLoadoutStore()) {
    store
      ?.load()
      .then((saved) => {
        if (!saved) return;
        this.local = ownedOnly(saved, starterInventory);
        this.onChange?.();
      })
      .catch(() => {}); // the default look; the Locker reports storage problems itself
  }

  for(p: { id: number; isLocal: boolean }): CosmeticLoadout {
    return p.isLocal ? this.local : placeholderLoadout(p.id);
  }
}
