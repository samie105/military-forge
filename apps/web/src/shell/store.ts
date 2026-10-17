/**
 * Shell state (Zustand, vanilla so the game loop can write it without React) and the route
 * registry other workstreams plug their screens into (W2's Locker: one line in main.ts).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { MatchView } from './matchView';

export interface ShellActions {
  playAgain(): void;
  backToLobby(): void;
  ready(): void;
}

/** What a route's mount returns: a cleanup function, or a handle with unmount() (W2's mountLocker). */
export type RouteCleanup = (() => void) | { unmount(): void } | void;

export interface ShellRoute {
  /** opened at #/<id> */
  id: string;
  title: string;
  /**
   * Render into an empty full-screen element. `close()` leaves the route (wire it to your own
   * Back/Exit button); Escape and the shell's back button also close it, then the cleanup runs.
   */
  mount(el: HTMLElement, close: () => void): RouteCleanup;
}

/** Leaves the open route. */
export function closeRoute(): void {
  if (location.hash) location.hash = '';
}

export function runCleanup(cleanup: RouteCleanup): void {
  if (typeof cleanup === 'function') cleanup();
  else cleanup?.unmount();
}

export interface ShellState {
  match: MatchView | null;
  route: ShellRoute | null;
  actions: ShellActions;
}

export type ShellStore = StoreApi<ShellState>;

const noop = (): void => {};

export function createShellStore(): ShellStore {
  return createStore<ShellState>(() => ({ match: null, route: null, actions: { playAgain: noop, backToLobby: noop, ready: noop } }));
}

const routes: ShellRoute[] = [];
const routeListeners = new Set<() => void>();

export function registerRoute(route: ShellRoute): void {
  const i = routes.findIndex((r) => r.id === route.id);
  if (i >= 0) routes[i] = route;
  else routes.push(route);
  for (const fn of routeListeners) fn();
}

export function findRoute(id: string): ShellRoute | null {
  return routes.find((r) => r.id === id) ?? null;
}

export function onRoutesChanged(fn: () => void): () => void {
  routeListeners.add(fn);
  return () => routeListeners.delete(fn);
}
