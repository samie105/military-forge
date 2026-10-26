/**
 * A route's code on its way (store.ts ShellRoute.load; App.tsx RouteView draws the route's frame
 * meanwhile). A phone's request can drop once, so a failed fetch gets one quiet second try before
 * the frame says it couldn't load. Try again then opens a fresh page at the same place (#/locker):
 * that also fixes the other way it fails, a new version of the game replacing the files under a page
 * opened before it (the old page asks for code that's gone).
 */
import type { RouteMount, ShellRoute } from './store';

/** How long the quiet second try waits. */
export const ROUTE_RETRY_MS = 700;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The route's mount: its code fetched, with one second try. Rejects when both fail. */
export async function loadRoute(route: Pick<ShellRoute, 'load'>, wait: (ms: number) => Promise<void> = sleep): Promise<RouteMount> {
  if (!route.load) throw new Error('this route has no code to load');
  try {
    return await route.load();
  } catch {
    await wait(ROUTE_RETRY_MS);
    return route.load();
  }
}

/** Resolves once the next frame has been painted (two animation frames; a timer where there are none). */
export function afterPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') return void setTimeout(resolve, 0);
    // a hidden tab runs no frames: don't wait on them there
    const fallback = setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(fallback);
        resolve();
      }),
    );
  });
}

/** Try again: the page afresh, at the same route (its #hash stays). */
export function retryRoute(): void {
  location.reload();
}
