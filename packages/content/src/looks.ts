/**
 * Looks on the wire (protocol v19; docs/04 §5.1, §5.7): who may wear what, and the bots' looks.
 *
 * A look travels as its cosmetic wire ids (cosmeticLoadoutWireIds). The game server admits a look only
 * after the same checks the API makes when a loadout is saved: every id known and in its slot, every
 * part made for the body it's on (sanitizeCosmeticLoadout), and every item one the player has unlocked.
 * What fails a check is not refused outright: that slot falls back to its default, so a player always
 * plays, and plays as close to their chosen look as they're allowed.
 */
import {
  BODIES,
  DEFAULT_COSMETIC_LOADOUT,
  DYE_CHANNELS,
  LOADOUT_SLOTS,
  cosmeticLoadoutFromWireIds,
  cosmeticsForSlot,
  fitsBody,
  getCosmetic,
  sanitizeCosmeticLoadout,
  type Body,
  type CosmeticDef,
  type CosmeticLoadout,
  type DyeChannel,
  type LoadoutSlot,
} from './cosmetics';

/** The most ids a look may carry on the wire (a u5 count): 15 today, room for 16 more slots. */
export const MAX_LOOK_IDS = 31;

/**
 * Whether a player at `level` has an item (docs/06 §7), until the inventory table exists: everyone has
 * the starter items, and a level item once they reach that level. Store, battle-pass, achievement and
 * event items need the inventory, so nobody wears them yet (the Locker shows them locked). The API's
 * loadout check and the game server's look check both use this.
 */
export function cosmeticUnlocked(def: CosmeticDef, level: number): boolean {
  if (def.source.kind === 'starter') return true;
  if (def.source.kind === 'level') return level >= def.source.level;
  return false;
}

/** Items anyone can earn by playing (starter and level unlocks): what bots wear. */
export function cosmeticEarnable(def: CosmeticDef): boolean {
  return def.source.kind === 'starter' || def.source.kind === 'level';
}

/**
 * A look with everything `allowed` refuses swapped for the slot's default (defaults are starter items),
 * then held to the body's fit again: a refused female body takes her hairstyle with her.
 */
export function allowedLook(loadout: CosmeticLoadout, allowed: (def: CosmeticDef) => boolean): CosmeticLoadout {
  const clean = sanitizeCosmeticLoadout(loadout);
  const ok = (id: string) => {
    const def = getCosmetic(id);
    return def !== undefined && allowed(def);
  };
  const items = {} as Record<LoadoutSlot, string>;
  for (const slot of LOADOUT_SLOTS) items[slot] = ok(clean.items[slot]) ? clean.items[slot] : DEFAULT_COSMETIC_LOADOUT.items[slot];
  const dyes = {} as Record<DyeChannel, string>;
  for (const ch of DYE_CHANNELS) dyes[ch] = ok(clean.dyes[ch]) ? clean.dyes[ch] : DEFAULT_COSMETIC_LOADOUT.dyes[ch];
  return sanitizeCosmeticLoadout({ items, dyes });
}

/** What the server knows about a player's items: their level, and a look the API vouched for (the join ticket's). */
export interface LookVouch {
  level: number;
  /** wire ids of a look the API checked when it minted the ticket: owned, whatever the level says */
  ids?: readonly number[];
}

/**
 * A look from the wire, as the game server admits it (v19): null when the client sent none (an empty
 * list); otherwise sanitised (unknown ids, wrong slots, parts that don't fit the body → slot defaults)
 * and held to what the player has (cosmeticUnlocked at `vouch.level`, or an item of the vouched look).
 */
export function admitLook(ids: readonly number[] | null | undefined, vouch: LookVouch): CosmeticLoadout | null {
  if (!ids || ids.length === 0) return null;
  const vouched = new Set(vouch.ids ?? []);
  return allowedLook(cosmeticLoadoutFromWireIds(ids.slice(0, MAX_LOOK_IDS)), (def) => cosmeticUnlocked(def, vouch.level) || vouched.has(def.wireId));
}

/**
 * Bot colourways: three dyes (primary, secondary, accent) that sit together, in field and street
 * tones. Every dye is earnable; nothing reads as a team colour.
 */
export const BOT_COLOURWAYS: readonly (readonly [string, string, string])[] = [
  ['dye_olive', 'dye_sand', 'dye_charcoal'],
  ['dye_charcoal', 'dye_olive', 'dye_red'],
  ['dye_forest', 'dye_brown', 'dye_yellow'],
  ['dye_khaki', 'dye_gunmetal', 'dye_mustard'],
  ['dye_stone', 'dye_charcoal', 'dye_terracotta'],
  ['dye_gunmetal', 'dye_khaki', 'dye_lime'],
  ['dye_brown', 'dye_sand', 'dye_lime'],
  ['dye_white', 'dye_charcoal', 'dye_red'],
  ['dye_terracotta', 'dye_stone', 'dye_charcoal'],
  ['dye_mustard', 'dye_olive', 'dye_white'],
  ['dye_wine', 'dye_charcoal', 'dye_khaki'],
  ['dye_denim', 'dye_stone', 'dye_orange'],
  ['dye_forest', 'dye_khaki', 'dye_orange'],
  ['dye_sand', 'dye_forest', 'dye_white'],
];

/** splitmix32 (packages/shared has the same; content depends on nothing) */
function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return ((z ^ (z >>> 16)) >>> 0) / 4294967296;
  };
}

/** A bot's look seed: the room's seed with its name, so a bot keeps its look all room long, and rooms differ. */
export function lookSeed(roomSeed: number, name: string): number {
  let h = 0x811c9dc5 ^ (roomSeed >>> 0);
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * A bot's look (v19): seeded, so every client and the server agree, and varied. Half the bots are on
 * each body; every slot is an earnable item that fits that body; the dyes are one of BOT_COLOURWAYS.
 */
export function botLook(seed: number): CosmeticLoadout {
  const random = stream(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.min(list.length - 1, Math.floor(random() * list.length))]!;
  const body: Body = pick(BODIES);
  const items = {} as Record<LoadoutSlot, string>;
  for (const slot of LOADOUT_SLOTS) {
    const choices = cosmeticsForSlot(slot).filter((c) => cosmeticEarnable(c) && fitsBody(c, body) && (slot !== 'bodyType' || c.body === body));
    items[slot] = choices.length > 0 ? pick(choices).id : DEFAULT_COSMETIC_LOADOUT.items[slot];
  }
  const [primary, secondary, accent] = pick(BOT_COLOURWAYS);
  return sanitizeCosmeticLoadout({ items, dyes: { primary, secondary, accent } });
}
