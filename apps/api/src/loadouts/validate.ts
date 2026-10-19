/**
 * A saved loadout is checked against the game's own content (@military-forge/content) before it's
 * stored: every cosmetic id must exist, sit in the slot it's worn in, and be one the player owns;
 * both guns must be real, different, non-melee weapons. Nothing is fixed up silently: a bad id is
 * a 400 naming the field, so a client bug shows instead of a look quietly changing.
 */
import { DYE_CHANNELS, LOADOUT_SLOTS, getCosmetic, isLoadoutGun, weapons, type CosmeticDef } from '@military-forge/content';
import { z } from 'zod';
import type { LoadoutData } from '../db/schema';

const id = z.string().min(1).max(64);

export const LoadoutBody = z.strictObject({
  look: z.strictObject({
    items: z.strictObject(Object.fromEntries(LOADOUT_SLOTS.map((s) => [s, id])) as Record<(typeof LOADOUT_SLOTS)[number], typeof id>),
    dyes: z.strictObject(Object.fromEntries(DYE_CHANNELS.map((c) => [c, id])) as Record<(typeof DYE_CHANNELS)[number], typeof id>),
  }),
  guns: z.tuple([id, id]),
});
export type LoadoutBody = z.infer<typeof LoadoutBody>;

/**
 * Who owns what, until the inventory table exists (docs/06 §7): everyone owns the starter items,
 * and a level item once the profile reaches that level. Store, battle-pass, achievement and event
 * items need the inventory, so nobody can wear them yet (the Locker shows them locked).
 */
export function owns(def: CosmeticDef, level: number): boolean {
  if (def.source.kind === 'starter') return true;
  if (def.source.kind === 'level') return level >= def.source.level;
  return false;
}

/** The guns a loadout may hold: every weapon but the melee ones. */
export const LOADOUT_GUNS: ReadonlySet<string> = new Set(weapons.filter((w) => isLoadoutGun(w.id)).map((w) => w.id));

export interface LoadoutIssue {
  path: string;
  message: string;
}

/** The problems with a loadout (empty = fine to store), for a player at `level`. */
export function loadoutIssues(body: LoadoutBody, level: number): LoadoutIssue[] {
  const issues: LoadoutIssue[] = [];
  const cosmetic = (path: string, value: string, slot: CosmeticDef['slot']) => {
    const def = getCosmetic(value);
    if (!def) issues.push({ path, message: `unknown item "${value}"` });
    else if (def.slot !== slot) issues.push({ path, message: `"${value}" is a ${def.slot} item, not ${slot}` });
    else if (!owns(def, level)) issues.push({ path, message: `"${value}" isn't unlocked` });
  };
  for (const slot of LOADOUT_SLOTS) cosmetic(`look.items.${slot}`, body.look.items[slot], slot);
  for (const ch of DYE_CHANNELS) cosmetic(`look.dyes.${ch}`, body.look.dyes[ch], 'dye');
  body.guns.forEach((gun, i) => {
    if (!LOADOUT_GUNS.has(gun)) issues.push({ path: `guns.${i}`, message: `"${gun}" isn't a gun you can carry` });
  });
  if (body.guns[0] === body.guns[1]) issues.push({ path: 'guns.1', message: 'the two guns must differ' });
  return issues;
}

export function toLoadoutData(body: LoadoutBody): LoadoutData {
  return { look: { items: { ...body.look.items }, dyes: { ...body.look.dyes } }, guns: [body.guns[0], body.guns[1]] };
}
