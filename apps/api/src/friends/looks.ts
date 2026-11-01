/**
 * Players' looks for the friends panel's rows (the owner's rule: a player's own soldier is their avatar
 * everywhere). A look is the saved loadout's (slot 0), held to content and to what the player owns as
 * the join ticket holds it (rooms/routes.ts savedLoadout), and sent as cosmetic wire ids: the web
 * draws the portrait from them. Two queries for any number of players: the loadouts, then the
 * store's inventory (plus the owner's COSMETIC_GRANTS).
 */
import { allowedLook, cosmeticLoadoutWireIds, cosmeticUnlocked, sanitizeCosmeticLoadout } from '@military-forge/content';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { inventory, loadouts } from '../db/schema';

/** `null`: the player never saved a look (the web shows the silhouette with their initial). */
export type LookIds = number[] | null;

export async function savedLooks(db: Db, grants: ReadonlyMap<string, readonly string[]>, players: readonly { id: string; level: number }[]): Promise<Map<string, LookIds>> {
  const out = new Map<string, LookIds>();
  if (!players.length) return out;
  const ids = [...new Set(players.map((p) => p.id))];
  const [saved, owned] = await Promise.all([
    db
      .select({ userId: loadouts.userId, data: loadouts.data })
      .from(loadouts)
      .where(and(inArray(loadouts.userId, ids), eq(loadouts.slot, 0))),
    db.select({ userId: inventory.userId, itemId: inventory.itemId }).from(inventory).where(inArray(inventory.userId, ids)),
  ]);
  const ownedBy = new Map<string, string[]>();
  for (const r of owned) ownedBy.set(r.userId, [...(ownedBy.get(r.userId) ?? []), r.itemId]);
  const lookBy = new Map(saved.map((r) => [r.userId, r.data.look]));
  for (const p of players) {
    const look = lookBy.get(p.id);
    if (!look) {
      out.set(p.id, null);
      continue;
    }
    const items = [...(grants.get(p.id) ?? []), ...(ownedBy.get(p.id) ?? [])];
    out.set(p.id, cosmeticLoadoutWireIds(allowedLook(sanitizeCosmeticLoadout(look), (def) => cosmeticUnlocked(def, p.level, items))));
  }
  return out;
}
