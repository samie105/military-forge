/**
 * Shell state (Zustand, vanilla so the game loop can write it without React) and the route
 * registry other workstreams plug their screens into (W2's Locker: one line in main.ts).
 */
import type { SpectateQueueId } from '@military-forge/protocol';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { DEFAULT_PAD_SETTINGS, type PadSettings } from '../gamepad/settings';
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
  /** the big word behind the route's frame while it loads (default: the title) */
  word?: string;
  /**
   * Render into an empty full-screen element. `close()` leaves the route (wire it to your own
   * Back/Exit button); Escape and the shell's back button also close it, then the cleanup runs.
   */
  mount?(el: HTMLElement, close: () => void): RouteCleanup;
  /**
   * A route whose code loads when it opens (a lazy chunk): resolves to its mount. Until then the shell
   * draws the route's frame at once (its title, Back, a loading line), so a tap never shows an empty
   * screen; if the code can't be fetched (no connection, or a new version of the game replaced it
   * under an open page), the frame says so and offers Try again.
   */
  load?(): Promise<RouteMount>;
}

/** A route's mount, as `load()` resolves it. */
export type RouteMount = (el: HTMLElement, close: () => void) => RouteCleanup;

/** Leaves the open route. */
export function closeRoute(): void {
  if (location.hash) location.hash = '';
}

export function runCleanup(cleanup: RouteCleanup): void {
  if (typeof cleanup === 'function') cleanup();
  else cleanup?.unmount();
}

/** Where the player wants to go next (the app shell's navigation). */
/** `local`: host a local room (same Wi-Fi, lan/); `watch`: a room by code as a spectator (v20: no slot, no input) */
export type Intent = { to: 'home' } | { to: 'create' } | { to: 'join'; code: string } | { to: 'watch'; code: string } | { to: 'training' } | { to: 'local' };

export type Screen =
  | { name: 'boot' }
  /** choose a name, then carry on to `then` */
  | { name: 'name'; then: Intent }
  /** the 18+ step before the first online room (age.ts), then `then`; `refused`: this device said under 18 */
  | { name: 'age'; then: Intent; refused?: boolean }
  | { name: 'home' }
  /** creating (code null) or looking up a room (API), before the game connects */
  | { name: 'finding'; code: string | null; creating: boolean }
  /** `local`: a local room (same Wi-Fi), hosted here or joined; `watch`: we asked to watch it (a retry watches again) */
  | { name: 'room'; code: string; local?: boolean; watch?: boolean }
  /** `tour`: the onboarding's First flight runs in it (tour/firstFlight.ts): the range, no match */
  | { name: 'training'; tour?: 'first-flight' }
  | { name: 'error'; alert: AlertInfo; retry: Intent | null };

/** `lan-add`: the host adds a player by QR codes; `lan-join`: join a local room by the host's QR code (no internet) */
export type Overlay = 'menu' | 'settings' | 'join' | 'name' | 'lan-add' | 'lan-join' | null;

/** Settings sections (the kit's five tabs, and Touch for the phone controls). */
export type SettingsTab = 'graphics' | 'audio' | 'controls' | 'controller' | 'accessibility' | 'network' | 'touch' | 'account' | 'privacy';

/**
 * What Settings → Account opens on: the sign-in form (the name screen's "Sign in"), or an emailed
 * link's form (`#reset=…`: a new password; `#confirm=…`: finish saving the account).
 */
export type AccountIntent = { mode: 'signin' } | { mode: 'reset'; token: string } | { mode: 'confirm'; token: string };

/**
 * Why the player can't get into (or stay in) a room, as the kit's connection screen shows it: the
 * kind picks the icon and tone, `code` is the line under the message ("ROOM_FULL · room KMTXRA").
 */
export type AlertKind = 'room-full' | 'room-not-found' | 'new-version' | 'server-full' | 'connection-lost' | 'offline' | 'slow-down' | 'replaced' | 'refused' | 'error';

export interface AlertInfo {
  /** a dropped connection that gave up: the tries made, of the most the window holds (the pips) */
  tries?: { made: number; of: number };
  kind: AlertKind;
  title: string;
  message: string;
  code: string;
  /**
   * The main button: rejoin the room, reload the page, watch the room instead (a full room: Watch,
   * with Try again beside it), or none (Home only).
   */
  action: 'rejoin' | 'reload' | 'watch' | null;
  /** a local room that couldn't be reached: "Swap QR codes" (the no-internet way in) beside the action */
  qrSwap?: boolean;
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

/** Volumes 0..1 and mutes (Settings → Audio). */
export interface AudioSettings {
  master: number;
  /** the world: guns, footsteps, jetpacks, explosions */
  effects: number;
  music: number;
  /** menu clicks, the countdown, hit and kill confirms */
  ui: number;
  /** the soldiers' voices (hurt, coughing) and the flashbang's ear ring */
  voice: number;
  masterMuted: boolean;
  effectsMuted: boolean;
  musicMuted: boolean;
  uiMuted: boolean;
  voiceMuted: boolean;
  /** headphones or earbuds: 3D (HRTF) sound, so enemies left, right, above and below are placed by ear */
  headphones: boolean;
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
  /** accessibility: explosions and flashbangs quieter, no ear ring, a harder limiter on the mix */
  softBursts: boolean;
  /** accessibility: no shake, no zooming numbers, no pulsing warnings (html.reduce-motion) */
  reduceMotion: boolean;
  /** accessibility: solid surfaces instead of frosted glass (html.reduce-transparency, ui/frost.css) */
  reduceTransparency: boolean;
  /** team colours for colour-blind players (teams aren't in the game yet: saved) */
  colorBlind: ColorBlindMode;
  /** menus and HUD text, 1..1.5 (the kit's --text-scale) */
  textScale: number;
  /** double-tap a direction key to dash that way (on by default: the owner's call, 18 Oct) */
  doubleTapDash: boolean;
  /** blood when soldiers are hit (the 3D view's setBlood); off by default */
  blood: boolean;
  /** other players' kill effects (docs/17 §3.7: a skin line's stardust); off draws the default death for their kills */
  showKillEffects: boolean;
  /** every action's keys and mouse buttons (controls.ts) */
  bindings: Bindings;
  /** game controllers: buttons, sticks, triggers, rumble (Settings → Controls → Controller; gamepad/settings.ts) */
  pad: PadSettings;
}

export const DEFAULT_AUDIO: AudioSettings = { master: 0.8, effects: 0.9, music: 0.35, ui: 0.7, voice: 0.8, masterMuted: false, effectsMuted: false, musicMuted: false, uiMuted: false, voiceMuted: false, headphones: false };

export const DEFAULT_SETTINGS: Settings = {
  graphics: 'auto',
  showFps: false,
  audio: DEFAULT_AUDIO,
  netGraph: false,
  lowBandwidth: false,
  reduceFlashes: false,
  softBursts: false,
  reduceMotion: false,
  reduceTransparency: false,
  colorBlind: 'standard',
  textScale: 1,
  doubleTapDash: true,
  blood: false,
  showKillEffects: true,
  bindings: defaultBindings(),
  pad: DEFAULT_PAD_SETTINGS,
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
  /** the card was asked for (the menu's Controls): it may open over a running match; queued ones never do */
  tipsAsked?: boolean;
  /** the Settings section open (Home's "Change keys" opens Controls) */
  settingsTab: SettingsTab;
  /**
   * The title screen (Title.tsx; the owner, 23 Oct: "tap anywhere to continue"): on until the first
   * press; `pressed` while the app is still getting ready (the prompt becomes a loading line); then
   * `leaving` (the camera push into the next screen) and off.
   */
  title: TitleState;
  /** performance.now() of the press that left the title (0 = none yet): the audio's war-tone hit */
  titleHit: number;
  /** the room took us as a spectator (v20, onlineMode's `spectating`): the lobby offers no Ready or Start */
  spectating: boolean;
  /** a spectator's wish to play (SPECTATE's queue): 0 watching, 1 the moment a slot is free, 2 next round */
  spectateQueue: SpectateQueueId;
  /** Settings → Account's opening form, taken (and cleared) by the panel */
  accountIntent: AccountIntent | null;
}

export type TitleState = 'on' | 'pressed' | 'leaving' | 'off';

export type ShellStore = StoreApi<ShellState>;

/** "Ade changed Gravity to 12 m/s² · Dash chain window to 0.6 s" (two at most, then how many more). */
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
    title: 'off',
    titleHit: 0,
    spectating: false,
    spectateQueue: 0,
    accountIntent: null,
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
