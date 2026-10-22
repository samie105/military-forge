/**
 * Where the Locker gets and keeps a player's look. Milestone A saves on this device; W3's API
 * plugs in later as another LoadoutStore (PUT /me/loadout, docs/04 §6) and Inventory.
 */
import {
  DEFAULT_COSMETIC_LOADOUT,
  DYE_CHANNELS,
  LOADOUT_SLOTS,
  cosmeticsForSlot,
  fitsBody,
  getCosmetic,
  sanitizeCosmeticLoadout,
  type Body,
  type CosmeticLoadout,
  type DyeChannel,
  type LoadoutSlot,
} from '@military-forge/content';

export interface LoadoutStore {
  /** null when nothing is saved yet; may reject (offline, signed out): the Locker then starts from the default look */
  load(): Promise<CosmeticLoadout | null>;
  /** resolves once the look is stored; rejects when it was not (the Locker shows "Not saved: <message>") */
  save(loadout: CosmeticLoadout): Promise<void>;
  /** where saves go, for the Locker header ("Saved on this device") */
  readonly label: string;
}

/** Which items the player owns. Until W3's inventory exists, everyone owns the starter items. */
export interface Inventory {
  owns(id: string): boolean;
}

export const starterInventory: Inventory = { owns: (id) => getCosmetic(id)?.source.kind === 'starter' };

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): KeyValueStorage | null {
  try {
    return window.localStorage; // throws in some sandboxed iframes and with blocked site data
  } catch {
    return null;
  }
}

export class LocalLoadoutStore implements LoadoutStore {
  readonly label = 'Saved on this device';

  constructor(
    private readonly storage: KeyValueStorage | null = browserStorage(),
    private readonly key = 'locker.loadout.v1',
  ) {}

  async load(): Promise<CosmeticLoadout | null> {
    try {
      const raw = this.storage?.getItem(this.key);
      const saved = raw ? (JSON.parse(raw) as { version?: number; loadout?: unknown }) : null;
      return saved?.version === 1 ? sanitizeCosmeticLoadout(saved.loadout) : null;
    } catch {
      return null;
    }
  }

  /** Rejects when storage is blocked, missing or full; the look still applies for this session. */
  async save(loadout: CosmeticLoadout): Promise<void> {
    if (!this.storage) throw new Error('storage unavailable');
    try {
      this.storage.setItem(this.key, JSON.stringify({ version: 1, loadout }));
    } catch {
      throw new Error('storage unavailable');
    }
  }
}

export function withItem(loadout: CosmeticLoadout, slot: LoadoutSlot, id: string): CosmeticLoadout {
  return { items: { ...loadout.items, [slot]: id }, dyes: loadout.dyes };
}

export function withDye(loadout: CosmeticLoadout, channel: DyeChannel, id: string): CosmeticLoadout {
  return { items: loadout.items, dyes: { ...loadout.dyes, [channel]: id } };
}

/** Swaps anything the player doesn't own for the slot default (saved data is never trusted, docs/04 §6). */
export function ownedOnly(loadout: CosmeticLoadout, inventory: Inventory): CosmeticLoadout {
  let out = sanitizeCosmeticLoadout(loadout);
  for (const slot of LOADOUT_SLOTS) if (!inventory.owns(out.items[slot])) out = withItem(out, slot, DEFAULT_COSMETIC_LOADOUT.items[slot]);
  for (const ch of DYE_CHANNELS) if (!inventory.owns(out.dyes[ch])) out = withDye(out, ch, DEFAULT_COSMETIC_LOADOUT.dyes[ch]);
  return out;
}

/** A random look from owned items only (docs/04 §6 "randomise"): the body first, then parts that fit it. */
export function randomLoadout(inventory: Inventory, random: () => number = Math.random): CosmeticLoadout {
  let body: Body = 'male';
  const pick = (slot: LoadoutSlot | 'dye') => {
    const owned = cosmeticsForSlot(slot).filter((c) => inventory.owns(c.id) && fitsBody(c, body));
    const chosen = owned[Math.floor(random() * owned.length)]!;
    if (slot === 'bodyType') body = chosen.body ?? 'male';
    return chosen.id;
  };
  const items = Object.fromEntries(LOADOUT_SLOTS.map((s) => [s, pick(s)])) as Record<LoadoutSlot, string>;
  const dyes = Object.fromEntries(DYE_CHANNELS.map((c) => [c, pick('dye')])) as Record<DyeChannel, string>;
  return { items, dyes };
}
