/**
 * The admin values in force in this process (admin.ts has the HTTP side). Kept apart from it, with
 * no Node imports, so a room can run in a browser too: a local room's host (apps/web/src/lan) runs
 * the same Room, and has no admin values (the owner's page tunes the servers, not local rooms).
 */
import { applyContentOverrides, clampAdmin, type AdminValues } from '@military-forge/content';

let current: AdminValues = {};
let json = '{}';
const listeners = new Set<(values: AdminValues) => void>();

/** The admin values in force on this server (only what differs from the defaults). */
export function adminValues(): AdminValues {
  return current;
}

/** The same, as the JSON clients get (WELCOME, OVERRIDES). */
export function adminJson(): string {
  return json;
}

/**
 * New admin values for the whole server (clamped; anything not in them goes back to its default):
 * the content numbers change now, then every room hears of it (`onAdminValues`).
 */
export function setAdminValues(raw: unknown): AdminValues {
  current = clampAdmin(raw);
  json = JSON.stringify(current);
  applyContentOverrides(current, true);
  for (const fn of listeners) fn(current);
  return current;
}

/** Calls `fn` with the values every time they change; returns the unsubscribe. */
export function onAdminValues(fn: (values: AdminValues) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
