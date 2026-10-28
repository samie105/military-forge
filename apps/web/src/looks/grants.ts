/**
 * Cosmetics the owner granted this account (GET /me `grants`: the API's COSMETIC_GRANTS), until the store and the
 * inventory exist (docs/17 §9). The Locker shows them unlocked and the look keeps them; the API vouches for them in
 * the join ticket, so the game server lets the player wear them and everyone in the room sees them.
 *
 * A dev build (vite) also takes `?grant=<itemId>,…` or localStorage `mf.devGrants` for offline previews (practice,
 * the Locker, the animation lab). Online rooms still hold a look to what the API vouched for, so this unlocks
 * nothing anyone else sees.
 */
import { grantedItems } from '@military-forge/content';

let fromAccount: readonly string[] = [];
let all: ReadonlySet<string> = grantedItems(devGrants());
const listeners = new Set<() => void>();

function devGrants(): string[] {
  if (!import.meta.env.DEV || typeof location === 'undefined') return [];
  const ids = new URLSearchParams(location.search).get('grant')?.split(',') ?? [];
  try {
    ids.push(...(localStorage.getItem('mf.devGrants')?.split(',') ?? []));
  } catch {
    // blocked storage: the URL's grants only
  }
  return ids.map((s) => s.trim()).filter(Boolean);
}

/** The signed-in account's grants changed (shell/api.ts, on every `me`). */
export function setAccountGrants(ids: readonly string[] | undefined): void {
  const next = ids ?? [];
  if (next.length === fromAccount.length && next.every((id, i) => id === fromAccount[i])) return;
  fromAccount = [...next];
  all = grantedItems([...fromAccount, ...devGrants()]);
  for (const l of listeners) l();
}

/** Whether this account (or the dev build) has been granted item `id`, with what the grant includes. */
export function granted(id: string): boolean {
  return all.has(id);
}

/** Granted item ids (with what they include). */
export function grantedIds(): readonly string[] {
  return [...all];
}

/** Called whenever the grants change (the Locker re-renders, the 3D view re-dresses). Returns an unsubscribe. */
export function onGrants(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
