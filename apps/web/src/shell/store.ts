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
  /** creating (code null) or looking up a room (API), before the game connects */
  | { name: 'finding'; code: string | null; creating: boolean }
  | { name: 'room'; code: string }
  | { name: 'training' }
  | { name: 'error'; alert: AlertInfo; retry: Intent | null };

export type Overlay = 'menu' | 'settings' | 'join' | 'name' | null;

/** Settings sections (the kit's five tabs, and Touch for the phone controls). */
export type SettingsTab = 'graphics' | 'audio' | 'controls' | 'accessibility' | 'network' | 'touch';

/**
 * Why the player can't get into (or stay in) a room, as the kit's connection screen shows it: the
 * kind picks the icon and tone, `code` is the line under the message ("ROOM_FULL · room KMTXRA").
 */
export type AlertKind = 'room-full' | 'room-not-found' | 'new-version' | 'server-full' | 'connection-lost' | 'offline' | 'slow-down' | 'replaced' | 'refused' | 'error';

export interface AlertInfo {
  kind: AlertKind;
  title: string;
  message: string;
  code: string;
  /** the main button: rejoin the room, reload the page, or none (Home only) */
  action: 'rejoin' | 'reload' | null;
}

export interface Profile {
  nickname: string;
  /** ISO date of the next allowed change, null = now */
  changeableAt: string | null;
  /** the API can't be reached: training only, with a local name */
  offline: boolean;
}

export type GraphicsPreset = 'low' | 'medium' | 'high';
/** The Quality setting: a preset, or 'auto' (main.ts picks one for this device: gfxAuto.ts). */
export type GraphicsSetting = 'auto' | GraphicsPreset;
export type ColorBlindMode = 'standard' | 'deutan' | 'tritan';

/** Volumes 0..1 and mutes (Settings → Audio; saved for when the game has sound). */
export interface AudioSettings {
  master: number;
  effects: number;
  music: number;
  masterMuted: boolean;
  effectsMuted: boolean;
  musicMuted: boolean;
}

export interface Settings {
  graphics: GraphicsSetting;
  /** a frame counter in the HUD's top-left corner */
  showFps: boolean;
  audio: AudioSettings;
  /** the net graph (N) */
  netGraph: boolean;
  /** 15 Hz snapshots, 30 Hz inputs (docs/05 §2.2) for poor connections */
  lowBandwidth: boolean;
  /** accessibility: soften full-screen flashes (flashbangs, explosions) */
  reduceFlashes: boolean;
  /** accessibility: no shake, no zooming numbers, no pulsing warnings (html.reduce-motion) */
  reduceMotion: boolean;
  /** team colours for colour-blind players (teams aren't in the game yet: saved) */
  colorBlind: ColorBlindMode;
  /** menus and HUD text, 1..1.5 (the kit's --text-scale) */
  textScale: number;
  /** double-tap a direction key to dash that way (on by default: the owner's call, 18 Oct) */
  doubleTapDash: boolean;
  /** blood when soldiers are hit (the 3D view's setBlood); off by default */
  blood: boolean;
  /** every action's keys and mouse buttons (controls.ts) */
  bindings: Bindings;
}

export const DEFAULT_AUDIO: AudioSettings = { master: 0.8, effects: 0.9, music: 0.35, masterMuted: false, effectsMuted: false, musicMuted: false };

export const DEFAULT_SETTINGS: Settings = {
  graphics: 'auto',
  showFps: false,
  audio: DEFAULT_AUDIO,
  netGraph: false,
  lowBandwidth: false,
  reduceFlashes: false,
  reduceMotion: false,
  colorBlind: 'standard',
  textScale: 1,
  doubleTapDash: true,
  blood: false,
  bindings: defaultBindings(),
};

/** Online connection, as the shell shows it (onlineMode.ts ConnectionInfo). */
export interface ConnectionView {
  state: 'connecting' | 'joining' | 'connected' | 'reconnecting' | 'failed';
  detail: string;
  code: number;
  /** reconnecting: when the outage began, and when the tries stop (performance.now) */
  since: number;
  until: number;
  /** reconnecting: the try under way; failed: the tries made */
  attempt: number;
  /** failed: the last round trip heard (-1 = none) and the snapshot loss then */
  lastPingMs: number;
  lossPct: number;
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
  /** a guest's word that the host just retuned the room (Tune the game); a new id each time */
  tuneNote: TuneNote | null;
  /** the map event being announced or running (docs/02 §20.7), null when none */
  mapEvent: MapEventBanner | null;
  /** the controls card and tips (first match, or Menu → Controls & tips) */
  tips: boolean;
  /** the Settings section open (Home's "Change keys" opens Controls) */
  settingsTab: SettingsTab;
}

export type ShellStore = StoreApi<ShellState>;

/** "Ade changed Gravity to 12 m/s² · Dash cooldown to 0.6 s" (two at most, then how many more). */
export interface TuneNote {
  id: number;
  who: string;
  items: readonly { label: string; value: string }[];
  more: number;
}

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
    tuneNote: null,
    mapEvent: null,
    tips: false,
    settingsTab: 'graphics',
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
