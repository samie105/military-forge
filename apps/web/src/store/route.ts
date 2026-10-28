/**
 * The Store as the game's #/store route: what main.ts loads lazily (a module of its own, like tour/briefingRoute.ts,
 * so the lazy import's namespace helper stays out of shared chunks).
 */
import { DEFAULT_COSMETIC_LOADOUT, getCosmetic, weaponSkinSlot } from '@military-forge/content';
import { withItem, type LoadoutStore } from '../locker/loadouts';

export { mountStore } from './screen';

/** "Wear it": the item goes on in its slot (a gun skin in its gun's slot) and is saved, before the Locker opens. */
export async function wearItem(loadouts: LoadoutStore | null, itemId: string): Promise<void> {
  const def = getCosmetic(itemId);
  const slot = def?.weaponId ? weaponSkinSlot(def.weaponId) : null;
  if (!loadouts || !slot) return;
  const current = (await loadouts.load().catch(() => null)) ?? DEFAULT_COSMETIC_LOADOUT;
  await loadouts.save(withItem(current, slot, itemId)).catch(() => {});
}
