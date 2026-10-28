/**
 * A saved loadout is checked against the game's own content (@military-forge/content) before it's
 * stored: every cosmetic id must exist, sit in the slot it's worn in, and be one the player owns;
 * both guns must be real, different, non-melee weapons. Nothing is fixed up silently: a bad id is
 * a 400 naming the field, so a client bug shows instead of a look quietly changing.
 */
import { DEFAULT_COSMETIC_LOADOUT, DYE_CHANNELS, LOADOUT_SLOTS, cosmeticUnlocked, fitsBody, getCosmetic, isLoadoutGun, weapons, type CosmeticDef, type LoadoutSlot } from '@military-forge/content';
import { z } from 'zod';
import type { LoadoutData } from '../db/schema';

const id = z.string().min(1).max(64);

/** Slots added after clients were saving looks: a body without them is still valid, and stores the default. */
const LATER_SLOTS: ReadonlySet<LoadoutSlot> = new Set(['hair', 'skin_k47']);

export const LoadoutBody = z.strictObject({
  look: z.strictObject({
    items: z.strictObject(Object.fromEntries(LOADOUT_SLOTS.map((s) => [s, LATER_SLOTS.has(s) ? id.optional() : id])) as Record<LoadoutSlot, typeof id>),
    dyes: z.strictObject(Object.fromEntries(DYE_CHANNELS.map((c) => [c, id])) as Record<(typeof DYE_CHANNELS)[number], typeof id>),
  }),
  guns: z.tuple([id, id]),
});
export type LoadoutBody = z.infer<typeof LoadoutBody>;

/**
 * Who owns what, until the inventory table exists (docs/06 §7): content's `cosmeticUnlocked` (starter
 * items for everyone, a level item from its level, and what the owner granted the account: config
 * COSMETIC_GRANTS). The game server holds looks on the wire to the same rule (protocol v19) and takes a
 * granted item from the join ticket's vouched look, so a look the API stores is a look a room lets the player wear.
 */
export function owns(def: CosmeticDef, level: number, grants: readonly string[] = []): boolean {
  return cosmeticUnlocked(def, level, grants);
}

/** The guns a loadout may hold: every weapon but the melee ones. */
export const LOADOUT_GUNS: ReadonlySet<string> = new Set(weapons.filter((w) => isLoadoutGun(w.id)).map((w) => w.id));

export interface LoadoutIssue {
  path: string;
  message: string;
}

/** The problems with a loadout (empty = fine to store), for a player at `level` with the owner's `grants`. */
export function loadoutIssues(body: LoadoutBody, level: number, grants: readonly string[] = []): LoadoutIssue[] {
  const issues: LoadoutIssue[] = [];
  const cosmetic = (path: string, value: string, slot: CosmeticDef['slot']) => {
    const def = getCosmetic(value);
    if (!def) issues.push({ path, message: `unknown item "${value}"` });
    else if (def.slot !== slot) issues.push({ path, message: `"${value}" is a ${def.slot} item, not ${slot}` });
    else if (!owns(def, level, grants)) issues.push({ path, message: `"${value}" isn't unlocked` });
  };
  const items = withDefaults(body);
  for (const slot of LOADOUT_SLOTS) cosmetic(`look.items.${slot}`, items[slot], slot);
  // a part made for another body (the female body's hairstyles on the male one)
  const frame = getCosmetic(items.bodyType)?.body;
  for (const slot of LOADOUT_SLOTS) {
    const def = getCosmetic(items[slot]);
    if (frame && def?.slot === slot && !fitsBody(def, frame)) issues.push({ path: `look.items.${slot}`, message: `"${items[slot]}" is made for the ${def.fits!.join(' or ')} body` });
  }
  for (const ch of DYE_CHANNELS) cosmetic(`look.dyes.${ch}`, body.look.dyes[ch], 'dye');
  body.guns.forEach((gun, i) => {
    if (!LOADOUT_GUNS.has(gun)) issues.push({ path: `guns.${i}`, message: `"${gun}" isn't a gun you can carry` });
  });
  if (body.guns[0] === body.guns[1]) issues.push({ path: 'guns.1', message: 'the two guns must differ' });
  return issues;
}

/** The look's items with every later slot the client left out filled with its default. */
function withDefaults(body: LoadoutBody): Record<LoadoutSlot, string> {
  const items = { ...body.look.items } as Record<LoadoutSlot, string>;
  for (const slot of LATER_SLOTS) items[slot] ??= DEFAULT_COSMETIC_LOADOUT.items[slot];
  return items;
}

export function toLoadoutData(body: LoadoutBody): LoadoutData {
  return { look: { items: withDefaults(body), dyes: { ...body.look.dyes } }, guns: [body.guns[0], body.guns[1]] };
}
