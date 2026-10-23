/**
 * The character creator's model (owner, 22 Oct: "the 3D setup"): the bodies and their builds, which
 * slots a body dresses (grouped into the creator's tabs) and what fits it. Pure: the screen
 * (creator/index.ts) draws it. Everything is read from content (#172: body_female, the hair slot,
 * `fits`, the colourways), so new items and slots show up as they land.
 */
import {
  BODIES,
  LOADOUT_SLOTS,
  cosmeticsForSlot,
  fitsBody,
  sanitizeCosmeticLoadout,
  type Body,
  type CosmeticDef,
  type CosmeticLoadout,
  type CosmeticSlot,
} from '@military-forge/content';

export const BODY_NAMES: Readonly<Record<Body, string>> = { male: 'Male soldier', female: 'Female soldier' };

/** A body type's base body (content `body`, male when absent). */
export const bodyOf = (def: CosmeticDef): Body => def.body ?? 'male';

/** The builds (body types) of a body, in content order. */
export function bodyTypesFor(body: Body): CosmeticDef[] {
  return cosmeticsForSlot('bodyType').filter((c) => bodyOf(c) === body);
}

/**
 * The look on another body: that body's build (`bodyType`, else its first), with every part that
 * doesn't fit it back to the slot default (content's sanitiser). Unchanged when the body has no build.
 */
export function withBody(loadout: CosmeticLoadout, body: Body, bodyType?: string): CosmeticLoadout {
  const types = bodyTypesFor(body);
  const type = types.find((t) => t.id === bodyType) ?? types[0];
  return type ? sanitizeCosmeticLoadout({ items: { ...loadout.items, bodyType: type.id }, dyes: loadout.dyes }) : loadout;
}

export interface BodyCard {
  body: Body;
  name: string;
  /** its builds; none = not in the game */
  builds: number;
}

export function bodyCards(): BodyCard[] {
  return BODIES.map((body) => ({ body, name: BODY_NAMES[body], builds: bodyTypesFor(body).length }));
}

export interface SlotTab {
  id: string;
  label: string;
  icon: string;
  slots: readonly { slot: CosmeticSlot; label: string }[];
}

/**
 * The look's tabs, in order. Slots that aren't in the loadout yet (jackets, accessories) are listed so
 * they appear once content has them; any other new slot joins Outfit.
 */
const TABS: readonly SlotTab[] = [
  { id: 'hair', label: 'Hair', icon: 'user', slots: [{ slot: 'hair', label: 'Hair' }] },
  { id: 'head', label: 'Headwear', icon: 'helmet', slots: [{ slot: 'headgear', label: 'Headgear' }, { slot: 'eyewear', label: 'Eyewear' }] },
  {
    id: 'outfit',
    label: 'Outfit',
    icon: 'shirt',
    slots: [
      { slot: 'top', label: 'Top' },
      { slot: 'jacket' as CosmeticSlot, label: 'Jacket or vest' },
      { slot: 'legs', label: 'Trousers' },
      { slot: 'gloves', label: 'Gloves' },
      { slot: 'boots', label: 'Boots' },
    ],
  },
  {
    id: 'gear',
    label: 'Gear',
    icon: 'backpack',
    slots: [
      { slot: 'accessory' as CosmeticSlot, label: 'Accessories' },
      { slot: 'jetpack', label: 'Jetpack' },
      { slot: 'exhaust', label: 'Exhaust' },
      { slot: 'trail', label: 'Dash trail' },
    ],
  },
  { id: 'colours', label: 'Colourways', icon: 'palette', slots: [{ slot: 'dye', label: 'Colourway' }] },
];

/** The body step's own slots: the build and the skin. */
export const BODY_SLOTS: readonly { slot: CosmeticSlot; label: string }[] = [
  { slot: 'bodyType', label: 'Build' },
  { slot: 'skinTone', label: 'Skin tone' },
];

const isSlot = (slot: CosmeticSlot) => slot === 'dye' || (LOADOUT_SLOTS as readonly string[]).includes(slot);

/** What a body can wear in a slot, in content order: its own builds, and the parts that fit it. */
export function itemsFor(slot: CosmeticSlot, body: Body): CosmeticDef[] {
  if (!isSlot(slot)) return [];
  if (slot === 'bodyType') return bodyTypesFor(body);
  return cosmeticsForSlot(slot).filter((c) => fitsBody(c, body));
}

/**
 * The tabs a body dresses: slots in the loadout with a choice to make (two or more items that fit),
 * so Hair appears for a body with hairstyles (the male body has only his own hair); any loadout slot
 * no tab names joins Outfit.
 */
export function lookTabs(body: Body): SlotTab[] {
  const named = new Set<string>([...TABS.flatMap((t) => t.slots.map((s) => s.slot)), ...BODY_SLOTS.map((s) => s.slot)]);
  const extra = LOADOUT_SLOTS.filter((s) => !named.has(s)).map((slot) => ({ slot: slot as CosmeticSlot, label: slot.charAt(0).toUpperCase() + slot.slice(1) }));
  return TABS.map((t) => ({ ...t, slots: [...t.slots, ...(t.id === 'outfit' ? extra : [])].filter((s) => itemsFor(s.slot, body).length > 1) })).filter((t) => t.slots.length > 0);
}

/** First-run: the creator follows the name screen once on this device (Skip or Save both count). */
export const CREATOR_SEEN_KEY = 'mf-creator-seen';

export function creatorSeen(storage: Pick<Storage, 'getItem'> | null): boolean {
  try {
    return storage?.getItem(CREATOR_SEEN_KEY) === '1';
  } catch {
    return true; // no storage: don't push the step on every visit
  }
}

export function markCreatorSeen(storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(CREATOR_SEEN_KEY, '1');
  } catch {
    /* fine: it shows again next time */
  }
}
