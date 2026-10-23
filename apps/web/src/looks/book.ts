/**
 * Everyone's look, as this page knows it (protocol v19, owner 23 Oct: "everyone must see everyone's
 * chosen character"). Online it is the ROSTER's: each player's look as the room lets them wear it, ours
 * included (what everyone else sees us in). In training it is the bots' seeded looks.
 *
 * Who reads it: the 3D view (render3d's LoadoutDirectory draws each soldier in his or her look) and the
 * avatar portraits (the lobby, scoreboard, results and friends: see match-presentation.md in the notes).
 * A player missing from the book has no look known (an older page): draw a placeholder.
 */
import { DEFAULT_COSMETIC_LOADOUT, botLook, cosmeticLoadoutFromWireIds, cosmeticLoadoutHash, cosmeticLoadoutWireIds, lookSeed, type CosmeticLoadout } from '@military-forge/content';
import { LocalLoadoutStore } from '../locker/loadouts';
import { placeholderLoadout } from '../render3d/character';

/** Who is in the room, as the presentation shows them (the VS poster, team cards): the ROSTER's names. */
export interface Fighter {
  id: number;
  /** the roster's name ("[BOT] Kolo" for a bot) */
  name: string;
  isBot: boolean;
}

export class LookBook {
  private byId = new Map<number, CosmeticLoadout>();
  private hashes = new Map<number, number>();
  private fightersNow: readonly Fighter[] = [];
  private local = -1;
  private host = -1;
  private teamCount = 0;
  private teamById = new Map<number, number>();
  private readonly listeners = new Set<() => void>();
  /** bumped on every change (React's useSyncExternalStore snapshot) */
  version = 0;

  /** Who is in the room and which of them is us (a ROSTER, a training match's players). */
  setRoster(localId: number, fighters: readonly Fighter[]): void {
    const same =
      localId === this.local &&
      fighters.length === this.fightersNow.length &&
      fighters.every((f, i) => {
        const g = this.fightersNow[i]!;
        return f.id === g.id && f.name === g.name && f.isBot === g.isBot;
      });
    if (same) return;
    this.local = localId;
    this.fightersNow = fighters.map((f) => ({ ...f }));
    this.emit();
  }

  /** Everyone in the room (roster order). */
  fighters(): readonly Fighter[] {
    return this.fightersNow;
  }

  /** Our player id (-1: not in a room). */
  get localId(): number {
    return this.local;
  }

  /** The room's host (MATCH_STATE's hostId; -1: none, or training). */
  get hostId(): number {
    return this.host;
  }

  /** Team modes (v21): how many teams (0 = free-for-all) and who is on which. */
  setTeams(teams: number, byId: ReadonlyMap<number, number>): void {
    const same = teams === this.teamCount && byId.size === this.teamById.size && [...byId].every(([id, t]) => this.teamById.get(id) === t);
    if (same) return;
    this.teamCount = teams;
    this.teamById = new Map(teams > 0 ? byId : []);
    this.emit();
  }

  /** 0 = free-for-all, else the number of teams. */
  get teams(): number {
    return this.teamCount;
  }

  /** A player's team, −1 = none. */
  teamOf(id: number): number {
    return this.teamById.get(id) ?? -1;
  }

  /** The players on `id`'s team besides `id` (empty in a free-for-all): the minimap's allies. */
  teammatesOf(id: number): Set<number> {
    const team = this.teamOf(id);
    const out = new Set<number>();
    if (team >= 0) for (const [other, t] of this.teamById) if (t === team && other !== id) out.add(other);
    return out;
  }

  setHost(id: number): void {
    if (id === this.host) return;
    this.host = id;
    this.emit();
  }

  /** Everyone's look at once (a new ROSTER, a new training match): replaces what was there. */
  replace(looks: Iterable<readonly [number, CosmeticLoadout]>): void {
    const next = new Map(looks);
    const hashes = new Map([...next].map(([id, l]) => [id, cosmeticLoadoutHash(l)] as const));
    const same = hashes.size === this.hashes.size && [...hashes].every(([id, h]) => this.hashes.get(id) === h);
    this.byId = next;
    this.hashes = hashes;
    if (!same) this.emit();
  }

  /** Nobody's look, nobody in the room (left the room, back to the menus). */
  clear(): void {
    this.setHost(-1);
    this.setTeams(0, new Map());
    this.setRoster(-1, []);
    this.replace([]);
  }

  /** The look of player `id`; null = none known (draw a placeholder). */
  get(id: number): CosmeticLoadout | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * What player `id` is drawn in: their look, else (a player in the room whose page sends none) the 3D
   * view's placeholder for that id, so the avatar and the soldier in the world agree; null for nobody.
   */
  drawn(id: number): CosmeticLoadout | null {
    return this.byId.get(id) ?? (id >= 0 && this.fightersNow.some((f) => f.id === id) ? placeholderLoadout(id) : null);
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
    this.version++;
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
 * room's HELLO; the default Rookie when nothing is saved. Everything goes: the room holds it to what the
 * player owns.
 */
export function savedLookIds(store: Pick<LocalLoadoutStore, 'peek'> = new LocalLoadoutStore()): number[] {
  // nothing saved yet: the default Rookie, as this page draws us (a later account sync sends the saved one)
  return cosmeticLoadoutWireIds(store.peek() ?? DEFAULT_COSMETIC_LOADOUT);
}

/** Feeds the book to a view that draws looks (render3d's LoadoutDirectory) now and on every change; returns the unsubscribe. */
export function followLooks(book: LookBook, view: { setLooks(looks: ReadonlyMap<number, CosmeticLoadout>): void }): () => void {
  view.setLooks(book.all());
  return book.subscribe(() => view.setLooks(book.all()));
}
