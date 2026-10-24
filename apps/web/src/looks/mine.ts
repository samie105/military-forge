/**
 * The player's own look (their soldier) for the menus: Home's stage. This device's saved look at once
 * (the Locker's store), else the default soldier; then every new look main.ts hears of (LoadoutSync's
 * onLook: a Locker or creator save, the account's look at sign-in).
 */
import { DEFAULT_COSMETIC_LOADOUT, type CosmeticLoadout } from '@military-forge/content';
import { useSyncExternalStore } from 'react';
import { LocalLoadoutStore } from '../locker/loadouts';

let current: CosmeticLoadout | null = null;
const listeners = new Set<() => void>();

/** The look now (read from this device's save the first time). */
export function myLook(): CosmeticLoadout {
  return (current ??= new LocalLoadoutStore().peek() ?? DEFAULT_COSMETIC_LOADOUT);
}

/** A new look (main.ts, from LoadoutSync.onLook). */
export function setMyLook(look: CosmeticLoadout): void {
  if (look === current) return;
  current = look;
  for (const l of [...listeners]) l();
}

export function onMyLook(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React: the look, re-rendering when it changes. */
export function useMyLook(): CosmeticLoadout {
  return useSyncExternalStore(onMyLook, myLook, myLook);
}
