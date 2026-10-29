/**
 * Which look each player wears (character.ts tells the whole story). No three import: the app's boot
 * code (main.ts, looks/book.ts) keeps the directory before the 3D view's chunk arrives (audit 28 Oct).
 */
import { DEFAULT_COSMETIC_LOADOUT, type CosmeticLoadout } from '@military-forge/content';
import { LocalLoadoutStore, accountInventory, ownedOnly, type LoadoutStore } from '../locker/loadouts';
import { onGrants } from '../looks/grants';

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

/** Which look each player wears; `onChange` fires whenever any of it changes (the saved look loading, `setLooks`, `setLocal`). */
export class LoadoutDirectory {
  private local: CosmeticLoadout = DEFAULT_COSMETIC_LOADOUT;
  /** v19: looks from the wire (or training's bots), by player id */
  private looks: ReadonlyMap<number, CosmeticLoadout> = new Map();
  onChange: (() => void) | null = null;

  /** the look as saved, before the owned-only filter: a grant arriving later (sign-in) lets it through */
  private saved: CosmeticLoadout | null = null;

  constructor(store: LoadoutStore | null = new LocalLoadoutStore()) {
    onGrants(() => {
      if (this.saved) this.setLocal(this.saved);
    });
    store
      ?.load()
      .then((saved) => {
        if (!saved) return;
        this.saved = saved;
        this.local = ownedOnly(saved, accountInventory);
        this.onChange?.();
      })
      .catch(() => {}); // the default look; the Locker reports storage problems itself
  }

  /** v19: everyone's look the room sent (apps/web/src/looks); a player missing here wears the fallback. */
  setLooks(looks: ReadonlyMap<number, CosmeticLoadout>): void {
    this.looks = looks;
    this.onChange?.();
  }

  /** The local player's look changed (a Locker or creator save): owned items only, as at load. */
  setLocal(look: CosmeticLoadout): void {
    this.saved = look;
    this.local = ownedOnly(look, accountInventory);
    this.onChange?.();
  }

  for(p: { id: number; isLocal: boolean }): CosmeticLoadout {
    return this.looks.get(p.id) ?? (p.isLocal ? this.local : placeholderLoadout(p.id));
  }
}
