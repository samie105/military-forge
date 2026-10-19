/**
 * The two guns a player chooses to spawn with (the Armory's Equip, the Locker's Guns tab), saved to
 * their account by weapon id (ids stay put when indices move). The API checks a pair before storing
 * it and before putting it in a join ticket; the game server checks it again before a player spawns
 * with it. Every gun may be chosen; melee weapons can't (everyone has the swing anyway).
 */
import { DEFAULT_LOADOUT, weapons } from './weapons';

/** May a player choose this weapon id as one of their two guns? */
export function isLoadoutGun(id: string): boolean {
  return weapons.some((w) => w.id === id && w.fireMode !== 'melee');
}

/** The default pair, by id (the Hammer .44 and the Buzz). */
export const DEFAULT_GUN_IDS: readonly [string, string] = [weapons[DEFAULT_LOADOUT[0]]!.id, weapons[DEFAULT_LOADOUT[1]]!.id];

/** A pair of weapon ids as weapon indices, or null unless both are guns a player may choose and they differ. */
export function loadoutGunIndices(ids: unknown): [number, number] | null {
  if (!Array.isArray(ids) || ids.length !== 2 || ids[0] === ids[1]) return null;
  const idx = ids.map((id) => (typeof id === 'string' && isLoadoutGun(id) ? weapons.find((w) => w.id === id)!.index : -1));
  return idx[0]! >= 0 && idx[1]! >= 0 ? [idx[0]!, idx[1]!] : null;
}
