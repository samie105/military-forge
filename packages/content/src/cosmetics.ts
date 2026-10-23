/**
 * Cosmetics (docs/04 §3, §6, §8): what an item is, where it goes on the soldier, how rare it is,
 * which art it uses and how a player gets it. Cosmetics never change gameplay (docs/04 §1), so an
 * item has no hitbox, speed, size or loudness fields; test/cosmetics.test.ts enforces that on
 * every item. Loadouts travel as fixed lists of compact wire ids (docs/04 §5.1).
 */

/** Every slot a loadout fills. `dye` items fill the three dye channels instead. `hair` (22 Oct, the female
 *  body) came after the wire form was fixed, so on the wire it follows the dyes (cosmeticLoadoutWireIds). */
export const LOADOUT_SLOTS = [
  'bodyType', 'skinTone', 'headgear', 'eyewear', 'top', 'gloves', 'legs', 'boots', 'jetpack', 'exhaust', 'trail', 'hair',
] as const;
export type LoadoutSlot = (typeof LOADOUT_SLOTS)[number];
export type CosmeticSlot = LoadoutSlot | 'dye';

/** Slots filled by a mesh part merged into the character's single skinned mesh (docs/04 §5.3). */
export const PART_SLOTS = ['headgear', 'eyewear', 'top', 'gloves', 'legs', 'boots', 'jetpack', 'hair'] as const;
export type PartSlot = (typeof PART_SLOTS)[number];

/** The base body meshes (docs/04 §3): every body type is built on one of them, on the one shared skeleton. */
export const BODIES = ['male', 'female'] as const;
export type Body = (typeof BODIES)[number];

/** Dye-mask channels (docs/04 §5.4): R = primary, G = secondary, B = accent. */
export const DYE_CHANNELS = ['primary', 'secondary', 'accent'] as const;
export type DyeChannel = (typeof DYE_CHANNELS)[number];

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

/** Each tier has its own frame shape as well as a colour, so it reads without colour vision (docs/04 §6). */
export const RARITY_STYLE: Readonly<Record<Rarity, { label: string; colour: string; shape: 'circle' | 'triangle' | 'diamond' | 'pentagon' | 'star' }>> = {
  common: { label: 'Common', colour: '#9aa4ad', shape: 'circle' },
  uncommon: { label: 'Uncommon', colour: '#4cc38a', shape: 'triangle' },
  rare: { label: 'Rare', colour: '#4c9cf0', shape: 'diamond' },
  epic: { label: 'Epic', colour: '#b57cf2', shape: 'pentagon' },
  legendary: { label: 'Legendary', colour: '#f0b43c', shape: 'star' },
};

export type CosmeticSource =
  | { kind: 'starter' }
  | { kind: 'level'; level: number }
  | { kind: 'battlePass'; season: number; tier: number }
  | { kind: 'store' }
  | { kind: 'achievement'; label: string }
  | { kind: 'event'; label: string };

/** "How to get" text for locked items in the Locker (docs/04 §6). */
export function cosmeticSourceLabel(source: CosmeticSource): string {
  switch (source.kind) {
    case 'starter':
      return 'Starter item';
    case 'level':
      return `Reach level ${source.level}`;
    case 'battlePass':
      return `Battle pass S${source.season} tier ${source.tier}`;
    case 'store':
      return 'Store';
    case 'achievement':
      return `Achievement: ${source.label}`;
    case 'event':
      return `Event: ${source.label}`;
  }
}

export interface CosmeticAssets {
  /** W8 manifest under /assets/ (cosmetics/<slot>/<id>.json); absent until the art exists. Until then
   *  the client draws a procedural stand-in or the slot's default (docs/04 §5.2: art never blocks play). */
  manifest?: string;
}

export interface CosmeticDef {
  id: string;
  /** compact id on the wire (u16); unique and never reused */
  wireId: number;
  slot: CosmeticSlot;
  name: string;
  rarity: Rarity;
  assets: CosmeticAssets;
  /** parts: tinted by the dye mask; colour items: false */
  dyeable: boolean;
  source: CosmeticSource;
  releaseSeason?: number;
  tags?: readonly string[];
  /** dyes, skin tones and exhaust colours: sRGB hex */
  colour?: string;
  /** body types: width of the torso and limbs, 1..COSMETIC_ENVELOPE_MUL (the head never scales, so it stays on its hitbox) */
  widthMul?: number;
  /** body types: the base body mesh they're built on */
  body?: Body;
  /** parts made for some bodies only (e.g. the female body's hairstyles); absent = every body */
  fits?: readonly Body[];
}

/** docs/04 §1.2: parts may grow the base body's bounds by at most 10%... */
export const COSMETIC_ENVELOPE_MUL = 1.1;
/** ...and may not shrink it ("no tiny skins that hide the real hitbox"), so no body type is narrower than standard. */
export const MIN_BODY_WIDTH_MUL = 1;

const STARTER: CosmeticSource = { kind: 'starter' };
const STORE: CosmeticSource = { kind: 'store' };

function item(
  wireId: number,
  id: string,
  slot: CosmeticSlot,
  name: string,
  rarity: Rarity,
  source: CosmeticSource,
  extra: Partial<Pick<CosmeticDef, 'colour' | 'widthMul' | 'body' | 'fits' | 'tags' | 'releaseSeason'>> & { art?: boolean; dyeable?: boolean } = {},
): CosmeticDef {
  const { art, dyeable, ...rest } = extra;
  const isPart = (PART_SLOTS as readonly string[]).includes(slot);
  return {
    id,
    wireId,
    slot,
    name,
    rarity,
    assets: art ? { manifest: `cosmetics/${slot}/${id}.json` } : {},
    dyeable: dyeable ?? isPart,
    source,
    ...rest,
  };
}

function colours(slot: CosmeticSlot, firstWireId: number, list: readonly [string, string, string, Rarity?, CosmeticSource?][]): CosmeticDef[] {
  return list.map(([id, name, colour, rarity, source], i) => item(firstWireId + i, id, slot, name, rarity ?? 'common', source ?? STARTER, { colour }));
}

/**
 * The starter set. A colour is the fully lit colour of the region it tints: the default dyes and skin
 * tone are the Rookie's painted colours measured from the Phase 0 albedo (95th-percentile brightness),
 * so the default loadout reproduces the concept. Ids match W8's catalogue
 * (apps/web/public/assets/cosmetics/index.json) where W8 has made the item.
 */
export const cosmetics: readonly CosmeticDef[] = [
  item(1, 'body_standard', 'bodyType', 'Standard', 'common', STARTER, { widthMul: 1, body: 'male' }),
  item(2, 'body_stocky', 'bodyType', 'Stocky', 'common', STARTER, { widthMul: 1.08, body: 'male' }),
  // Slim keeps the standard width (docs/04 §1.2 forbids shrinking): its look comes from W8's slim mesh
  // variant (slimmer limbs inside the same silhouette). Until that lands it renders as Standard.
  item(3, 'body_slim', 'bodyType', 'Slim', 'uncommon', { kind: 'level', level: 5 }, { widthMul: 1, body: 'male' }),
  // The female soldier (owner, 22 Oct): her own base mesh on the same skeleton, sockets and hitbox. The
  // Forge's art is on its way; until it lands she renders as Standard (docs/04 §5.2: art never blocks play).
  item(4, 'body_female', 'bodyType', 'Female', 'common', STARTER, { widthMul: 1, body: 'female' }),

  ...colours('skinTone', 20, [
    ['skin_01', 'Porcelain', '#f6dcc8'], ['skin_02', 'Ivory', '#edc5a9'], ['skin_03', 'Peach', '#e4b28f'],
    ['skin_04', 'Apricot', '#da9f75'], ['skin_05', 'Honey', '#c48a5e'], ['skin_06', 'Caramel', '#ad744a'],
    ['skin_07', 'Bronze', '#94603a'], ['skin_08', 'Chestnut', '#7d4e2f'], ['skin_09', 'Mocha', '#673e26'],
    ['skin_10', 'Cocoa', '#53311f'], ['skin_11', 'Espresso', '#402619'], ['skin_12', 'Ebony', '#2f1c12'],
    ['skin_chrome', 'Robot Chrome', '#b8c4cf', 'epic', { kind: 'battlePass', season: 1, tier: 20 }],
    ['skin_zombie', 'Zombie', '#8fae7a', 'rare', { kind: 'event', label: 'Night of the Undead' }],
  ]),

  item(40, 'headgear_brim_helmet', 'headgear', 'Brim Helmet', 'common', STARTER, { art: true }),
  item(41, 'headgear_field_cap', 'headgear', 'Field Cap', 'common', STARTER, { art: true }),
  item(42, 'headgear_bandana', 'headgear', 'Bandana', 'common', STARTER, { art: true }),
  item(43, 'headgear_beret', 'headgear', 'Beret', 'uncommon', { kind: 'level', level: 10 }, { art: true }),
  item(44, 'headgear_combat_helmet', 'headgear', 'Combat Helmet', 'rare', STORE, { art: true }),
  item(45, 'headgear_crown', 'headgear', 'Paper Crown', 'legendary', { kind: 'achievement', label: '100 headshots' }),
  // a bare head (22 Oct): the hair shows in full; every other hat hides it or sits over it (its `hidesHair` extra)
  item(46, 'headgear_none', 'headgear', 'None', 'common', STARTER, { dyeable: false }),
  // the 22 Oct set (military + Lagos street): fits both bodies (hers sits inside his hair cap)
  item(47, 'headgear_beanie', 'headgear', 'Watch Beanie', 'common', STARTER, { art: true }),
  item(48, 'headgear_headwrap', 'headgear', 'Head Wrap', 'uncommon', { kind: 'level', level: 4 }, { art: true }),
  item(49, 'headgear_patrol_cap', 'headgear', 'Patrol Cap', 'common', STARTER, { art: true }),

  item(60, 'eyewear_none', 'eyewear', 'None', 'common', STARTER, { dyeable: false }),
  item(61, 'eyewear_aviators', 'eyewear', 'Aviators', 'common', STARTER, { art: true }),
  item(62, 'eyewear_gas_mask', 'eyewear', 'Gas Mask', 'rare', { kind: 'battlePass', season: 1, tier: 34 }, { art: true }),
  // face pieces (22 Oct); each has a female fit (its manifest's `bodies.female`)
  item(63, 'eyewear_shades', 'eyewear', 'Street Shades', 'common', STARTER, { art: true }),
  item(64, 'eyewear_dust_scarf', 'eyewear', 'Dust Scarf', 'common', STARTER, { art: true }),
  item(65, 'eyewear_goggles', 'eyewear', 'Ballistic Goggles', 'uncommon', { kind: 'level', level: 7 }, { art: true }),

  item(80, 'top_fatigues', 'top', 'Rookie Fatigues', 'common', STARTER),
  item(81, 'top_track_jacket', 'top', 'Track Jacket', 'epic', STORE),
  // tops and trousers (22 Oct): each replaces the body's own (`hidesBody` in cosmetics/<slot>/<id>.json) with a fit
  // per body; they get `art` once the assembler draws the top and legs slots (forge-female-art.md)
  item(82, 'top_tee_field', 'top', 'Field Tee', 'common', STARTER),
  item(83, 'top_hoodie_street', 'top', 'Street Hoodie', 'common', STARTER),
  item(84, 'top_jersey_street', 'top', 'Street Jersey', 'common', STARTER),
  item(85, 'top_print_shirt', 'top', 'Print Shirt', 'uncommon', { kind: 'level', level: 5 }),
  item(86, 'top_bomber', 'top', 'Bomber Jacket', 'uncommon', { kind: 'level', level: 8 }),
  item(87, 'top_plate_carrier', 'top', 'Plate Carrier', 'rare', { kind: 'level', level: 12 }),
  item(88, 'top_field_jacket', 'top', 'Field Jacket', 'common', STARTER),

  item(100, 'gloves_none', 'gloves', 'None', 'common', STARTER, { dyeable: false }),
  item(101, 'gloves_tactical', 'gloves', 'Tactical Gloves', 'common', STARTER, { art: true }),

  item(120, 'legs_fatigues', 'legs', 'Rookie Fatigues', 'common', STARTER),
  item(121, 'legs_cargo_shorts', 'legs', 'Cargo Shorts', 'uncommon', { kind: 'level', level: 15 }),
  item(122, 'legs_combat_trousers', 'legs', 'Combat Trousers', 'common', STARTER),
  item(123, 'legs_joggers', 'legs', 'Street Joggers', 'common', STARTER),
  item(124, 'legs_cargo_long', 'legs', 'Long Cargos', 'uncommon', { kind: 'level', level: 6 }),

  item(140, 'boots_combat', 'boots', 'Combat Boots', 'common', STARTER, { art: true }),
  item(141, 'boots_jungle', 'boots', 'Jungle Boots', 'common', STARTER, { art: true }),
  item(142, 'boots_sneakers', 'boots', 'Sneakers', 'uncommon', { kind: 'level', level: 5 }, { art: true }),
  item(143, 'boots_high_tops', 'boots', 'High-Tops', 'common', STARTER, { art: true }),
  item(144, 'boots_desert', 'boots', 'Desert Boots', 'common', STARTER, { art: true }),

  item(160, 'jetpack_twin_tank', 'jetpack', 'Twin Tank', 'common', STARTER, { art: true }),
  item(161, 'jetpack_drum', 'jetpack', 'Drum Pack', 'common', STARTER, { art: true }),
  item(162, 'jetpack_rocket', 'jetpack', 'Rocket Pack', 'epic', { kind: 'battlePass', season: 1, tier: 50 }, { art: true }),

  ...colours('exhaust', 180, [
    ['exhaust_flame', 'Classic Flame', '#ff8a1f'], ['exhaust_plasma', 'Plasma Blue', '#3fa9ff'],
    ['exhaust_toxic', 'Toxic Green', '#7cf05a'], ['exhaust_violet', 'Violet Burn', '#b06cff', 'rare', STORE],
  ]),
  item(200, 'trail_ribbon', 'trail', 'Ribbon', 'common', STARTER),
  item(201, 'trail_smoke', 'trail', 'Smoke Puffs', 'common', STARTER),
  item(202, 'trail_sparks', 'trail', 'Sparks', 'epic', { kind: 'battlePass', season: 1, tier: 12 }),

  ...colours('dye', 220, [
    ['dye_sand', 'Sand', '#b19164'], ['dye_olive', 'Olive', '#736234'], ['dye_teal', 'Teal', '#328b88'],
    ['dye_white', 'Chalk', '#e8e6df'], ['dye_charcoal', 'Charcoal', '#2b2d31'], ['dye_red', 'Signal Red', '#c8332b'],
    ['dye_orange', 'Tangerine', '#e8742a'], ['dye_yellow', 'Hazard Yellow', '#e9c22e'], ['dye_lime', 'Lime', '#8cc63f'],
    ['dye_forest', 'Forest', '#2f6b3a'], ['dye_sky', 'Sky', '#5aa9e6'], ['dye_navy', 'Navy', '#24365e'],
    ['dye_purple', 'Grape', '#6d3fa0'], ['dye_pink', 'Bubblegum', '#ee7fb4'], ['dye_brown', 'Cocoa', '#6b4428'],
    ['dye_crimson', 'Crimson', '#8f1028', 'rare', STORE], ['dye_gold', 'Gold Leaf', '#d4a017', 'legendary', { kind: 'battlePass', season: 1, tier: 100 }],
    // colourways for the outfits (22 Oct): field and street tones
    ['dye_khaki', 'Khaki', '#9a8c5e'], ['dye_stone', 'Stone', '#8a8578'], ['dye_gunmetal', 'Gunmetal', '#4a4f56'],
    ['dye_indigo', 'Indigo', '#2f3a6e'], ['dye_terracotta', 'Terracotta', '#9c4a32'], ['dye_mustard', 'Mustard', '#b8922e'],
    ['dye_wine', 'Wine', '#5c1e2b', 'uncommon', { kind: 'level', level: 8 }], ['dye_denim', 'Denim', '#4b6080', 'uncommon', { kind: 'level', level: 12 }],
  ]),

  // hair (22 Oct): `hair_body` is the body's own hair, part of each body's mesh (his short crop under the helmet, her
  // natural afro). The styles are made for the female body (`fits`) and replace hers (`hidesBody: hair` in their
  // manifests, cosmetics/hair/<id>.json); they get `art` once the assembler draws the hair slot.
  item(260, 'hair_body', 'hair', 'Natural', 'common', STARTER, { dyeable: false }),
  item(261, 'hair_bun', 'hair', 'Field Bun', 'common', STARTER, { fits: ['female'] }),
  item(262, 'hair_braids', 'hair', 'Cornrow Braids', 'common', STARTER, { fits: ['female'] }),
  item(263, 'hair_crop', 'hair', 'Short Crop', 'uncommon', { kind: 'level', level: 6 }, { fits: ['female'] }),
];

const byId = new Map(cosmetics.map((c) => [c.id, c]));
const byWireId = new Map(cosmetics.map((c) => [c.wireId, c]));

export function getCosmetic(id: string): CosmeticDef | undefined {
  return byId.get(id);
}

export function getCosmeticByWireId(wireId: number): CosmeticDef | undefined {
  return byWireId.get(wireId);
}

export function cosmeticsForSlot(slot: CosmeticSlot): CosmeticDef[] {
  return cosmetics.filter((c) => c.slot === slot);
}

export interface CosmeticLoadout {
  readonly items: Readonly<Record<LoadoutSlot, string>>;
  readonly dyes: Readonly<Record<DyeChannel, string>>;
}

/** The Rookie as concept A shows him. Every slot holds an item, so a loadout's wire form has a fixed length. */
export const DEFAULT_COSMETIC_LOADOUT: CosmeticLoadout = Object.freeze({
  items: Object.freeze({
    bodyType: 'body_standard',
    skinTone: 'skin_04',
    headgear: 'headgear_brim_helmet',
    eyewear: 'eyewear_none',
    top: 'top_fatigues',
    gloves: 'gloves_none',
    legs: 'legs_fatigues',
    boots: 'boots_combat',
    jetpack: 'jetpack_twin_tank',
    exhaust: 'exhaust_flame',
    trail: 'trail_ribbon',
    hair: 'hair_body',
  }),
  dyes: Object.freeze({ primary: 'dye_sand', secondary: 'dye_olive', accent: 'dye_teal' }),
});

function pick(value: unknown, slot: CosmeticSlot, fallback: string): string {
  return typeof value === 'string' && byId.get(value)?.slot === slot ? value : fallback;
}

/** The base body a loadout's body type is built on. */
export function loadoutBody(loadout: CosmeticLoadout): Body {
  return byId.get(loadout.items.bodyType)?.body ?? 'male';
}

/** Whether a part fits a body (absent `fits` = every body). */
export function fitsBody(def: CosmeticDef, body: Body): boolean {
  return !def.fits || def.fits.includes(body);
}

/**
 * Any value (saved JSON, a network message) → a valid loadout. Unknown ids, items in the wrong slot and
 * parts made for another body fall back to the default for that slot; so does a slot the value lacks (a
 * loadout saved before `hair` existed gets the body's own hair). Ownership is checked separately (inventory).
 */
export function sanitizeCosmeticLoadout(value: unknown): CosmeticLoadout {
  const v = (typeof value === 'object' && value !== null ? value : {}) as { items?: Record<string, unknown>; dyes?: Record<string, unknown> };
  const items = {} as Record<LoadoutSlot, string>;
  for (const slot of LOADOUT_SLOTS) items[slot] = pick(v.items?.[slot], slot, DEFAULT_COSMETIC_LOADOUT.items[slot]);
  const body = byId.get(items.bodyType)?.body ?? 'male';
  for (const slot of LOADOUT_SLOTS) if (!fitsBody(byId.get(items[slot])!, body)) items[slot] = DEFAULT_COSMETIC_LOADOUT.items[slot];
  const dyes = {} as Record<DyeChannel, string>;
  for (const ch of DYE_CHANNELS) dyes[ch] = pick(v.dyes?.[ch], 'dye', DEFAULT_COSMETIC_LOADOUT.dyes[ch]);
  return { items, dyes };
}

/** The slots of the first wire form (14 ids: these 11, then the 3 dyes); slots added later follow the dyes. */
const WIRE_V1_SLOTS = 11;
const WIRE_ORDER: readonly ({ slot: LoadoutSlot } | { dye: DyeChannel })[] = [
  ...LOADOUT_SLOTS.slice(0, WIRE_V1_SLOTS).map((slot) => ({ slot })),
  ...DYE_CHANNELS.map((dye) => ({ dye })),
  ...LOADOUT_SLOTS.slice(WIRE_V1_SLOTS).map((slot) => ({ slot })),
];

/** Wire form: one u16 per slot of the first form, one per dye channel, then one per later slot (15 ids:
 *  `hair` last). A 14-id loadout from before `hair` still reads: its hair is the body's own. */
export function cosmeticLoadoutWireIds(loadout: CosmeticLoadout): number[] {
  return WIRE_ORDER.map((w) => byId.get('slot' in w ? loadout.items[w.slot] : loadout.dyes[w.dye])?.wireId ?? 0);
}

export function cosmeticLoadoutFromWireIds(wireIds: readonly number[]): CosmeticLoadout {
  const id = (i: number) => (wireIds[i] === undefined ? undefined : byWireId.get(wireIds[i]!)?.id);
  const items: Record<string, string | undefined> = {};
  const dyes: Record<string, string | undefined> = {};
  WIRE_ORDER.forEach((w, i) => {
    if ('slot' in w) items[w.slot] = id(i);
    else dyes[w.dye] = id(i);
  });
  return sanitizeCosmeticLoadout({ items, dyes });
}

/** FNV-1a over the wire ids: equal looks hash equally on every client and on the server (docs/04 §5.7). */
export function cosmeticLoadoutHash(loadout: CosmeticLoadout): number {
  let h = 0x811c9dc5;
  for (const id of cosmeticLoadoutWireIds(loadout)) {
    h = Math.imul(h ^ (id & 0xff), 0x01000193);
    h = Math.imul(h ^ (id >>> 8), 0x01000193);
  }
  return h >>> 0;
}
