/**
 * Everyone's look, as this page knows it (protocol v19, owner 23 Oct: "everyone must see everyone's
 * chosen character"). Online it is the ROSTER's: each player's look as the room lets them wear it, ours
 * included (what everyone else sees us in). In training it is the bots' seeded looks.
 *
 * Who reads it: the 3D view (render3d's LoadoutDirectory draws each soldier in his or her look) and the
 * avatar portraits (the lobby, scoreboard, results and friends: see match-presentation.md in the notes).
 * A player missing from the book has no look known (an older page): draw a placeholder.
 */
import { botLook, cosmeticLoadoutFromWireIds, cosmeticLoadoutHash, cosmeticLoadoutWireIds, lookSeed, type CosmeticLoadout } from '@military-forge/content';
import { LocalLoadoutStore } from '../locker/loadouts';

export class LookBook {
  private byId = new Map<number, CosmeticLoadout>();
  private hashes = new Map<number, number>();
  private readonly listeners = new Set<() => void>();

  /** Everyone's look at once (a new ROSTER, a new training match): replaces what was there. */
  replace(looks: Iterable<readonly [number, CosmeticLoadout]>): void {
    const next = new Map(looks);
    const hashes = new Map([...next].map(([id, l]) => [id, cosmeticLoadoutHash(l)] as const));
    const same = hashes.size === this.hashes.size && [...hashes].every(([id, h]) => this.hashes.get(id) === h);
    this.byId = next;
    this.hashes = hashes;
    if (!same) this.emit();
  }

  /** Nobody's look (left the room, back to the menus). */
  clear(): void {
    this.replace([]);
  }

  /** The look of player `id`; null = none known (draw a placeholder). */
  get(id: number): CosmeticLoadout | null {
    return this.byId.get(id) ?? null;
  }

  /** cosmeticLoadoutHash of player `id`'s look (the avatar cache's key); null = none known. */
  hashOf(id: number): number | null {
    return this.hashes.get(id) ?? null;
  }

  /** Every known look, by player id (a copy). */
  all(): Map<number, CosmeticLoadout> {
    return new Map(this.byId);
  }

  /** Called after every change; returns the unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** The page's one book: the modes write it (onlineMode, localMode), the views read it. */
export const lookBook = new LookBook();

/** The ROSTER's looks (player id → cosmetic wire ids, NetClient.looks) as loadouts. */
export function looksFromWire(looks: Iterable<readonly [number, readonly number[]]>): Map<number, CosmeticLoadout> {
  return new Map([...looks].map(([id, ids]) => [id, cosmeticLoadoutFromWireIds(ids)] as const));
}

/** Training's bots: the same seeded looks a room gives its bots (content botLook), by player id. */
export function botLooks(seed: number, bots: Iterable<{ id: number; name: string }>): Map<number, CosmeticLoadout> {
  return new Map([...bots].map((b) => [b.id, botLook(lookSeed(seed, b.name))] as const));
}

/**
 * The look this device has saved (the Locker's, the account's once synced), as cosmetic wire ids for a
 * room's HELLO; null when nothing is saved (the room then uses the account's look from the join ticket,
 * or a placeholder). Everything goes: the room holds it to what the player owns.
 */
export function savedLookIds(store: Pick<LocalLoadoutStore, 'peek'> = new LocalLoadoutStore()): number[] | null {
  const look = store.peek();
  return look ? cosmeticLoadoutWireIds(look) : null;
}

/** Feeds the book to a view that draws looks (render3d's LoadoutDirectory) now and on every change; returns the unsubscribe. */
export function followLooks(book: LookBook, view: { setLooks(looks: ReadonlyMap<number, CosmeticLoadout>): void }): () => void {
  view.setLooks(book.all());
  return book.subscribe(() => view.setLooks(book.all()));
}
