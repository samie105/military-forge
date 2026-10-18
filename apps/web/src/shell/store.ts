/**
 * Shell state (Zustand, vanilla so the game loop can write it without React) and the route
 * registry other workstreams plug their screens into (W2's Locker: one line in main.ts).
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import { defaultBindings, type Bindings } from './controls';
import type { MapEventBanner } from './mapEventBanner';
import type { MatchView } from './matchView';
import type { LobbyView } from './onlineView';

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
  /** the route draws its own Back/Exit control (the shell's back button is left out) */
  ownExit?: boolean;
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

/** Where the player wants to go next (the app shell's navigation). */
export type Intent = { to: 'home' } | { to: 'create' } | { to: 'join'; code: string } | { to: 'training' };

export type Screen =
  | { name: 'boot' }
  /** choose a name, then carry on to `then` */
  | { name: 'name'; then: Intent }
  | { name: 'home' }
  /** creating or looking up a room (API), before the game connects */
  | { name: 'finding'; label: string }
  | { name: 'room'; code: string }
  | { name: 'training' }
  | { name: 'error'; title: string; message: string; retry: Intent | null };

export type Overlay = 'menu' | 'settings' | 'join' | 'name' | null;

export interface Profile {
  nickname: string;
  /** ISO date of the next allowed change, null = now */
  changeableAt: string | null;
  /** the API can't be reached: training only, with a local name */
  offline: boolean;
}

export type GraphicsPreset = 'low' | 'medium' | 'high';

export interface Settings {
  graphics: GraphicsPreset;
  /** the net graph (N) */
  netGraph: boolean;
  /** 15 Hz snapshots, 30 Hz inputs (docs/05 §2.2) for poor connections */
  lowBandwidth: boolean;
  /** accessibility: soften full-screen flashes (flashbangs, explosions) */
  reduceFlashes: boolean;
  /** double-tap a direction key to dash that way */
  doubleTapDash: boolean;
  /** every action's keys and mouse buttons (controls.ts) */
  bindings: Bindings;
}

export const DEFAULT_SETTINGS: Settings = {
  graphics: 'low',
  netGraph: false,
  lowBandwidth: false,
  reduceFlashes: false,
  doubleTapDash: false,
  bindings: defaultBindings(),
};

/** Online connection, as the shell shows it (onlineMode.ts ConnectionInfo). */
export interface ConnectionView {
  state: 'connecting' | 'joining' | 'connected' | 'reconnecting' | 'failed';
  detail: string;
  code: number;
}

export interface ShellState {
  /** the app shell's screen; the debug client (dev `/`) stays on 'training' and shows match overlays only */
  screen: Screen;
  overlay: Overlay;
  profile: Profile | null;
  match: MatchView | null;
  /** online rooms: the lobby (players, host, settings) */
  lobby: LobbyView | null;
  connection: ConnectionView | null;
  route: ShellRoute | null;
  actions: ShellActions;
  settings: Settings;
  /** a short-lived message ("Link copied") */
  notice: string | null;
  /** the map event being announced or running (docs/02 §20.7), null when none */
  mapEvent: MapEventBanner | null;
  /** the controls card and tips (first match, or Menu → Controls & tips) */
  tips: boolean;
  /** a phone or tablet: the "best on a computer" card */
  touchWarning: boolean;
}

export type ShellStore = StoreApi<ShellState>;

const noop = (): void => {};

export function createShellStore(initial: Partial<ShellState> = {}): ShellStore {
  return createStore<ShellState>(() => ({
    screen: { name: 'training' },
    overlay: null,
    profile: null,
    match: null,
    lobby: null,
    connection: null,
    route: null,
    actions: { playAgain: noop, backToLobby: noop, ready: noop },
    settings: DEFAULT_SETTINGS,
    notice: null,
    mapEvent: null,
    tips: false,
    touchWarning: false,
    ...initial,
  }));
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
