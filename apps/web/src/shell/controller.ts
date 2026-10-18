/**
 * The app shell's navigation and flows (docs/06 §4 layer L4, docs/07 §2): boot → name → home →
 * play with friends / join with code / training, the room lifecycle, and leaving. It talks to the
 * API (api.ts) and starts and stops game modes through the GameHost that main.ts provides; the
 * React screens only read the store and call these methods.
 */
import { normalizeRoomCode } from '@military-forge/shared';
import type { OnlineMode } from '../onlineMode';
import type { LocalMode } from '../localMode';
import { Api, ApiError, NICKNAME_REASONS, type Me, type NicknameCheck, type RoomJoin } from './api';
import { sanitizeBindings } from './controls';
import { DEFAULT_SETTINGS, type Intent, type Overlay, type Profile, type Settings, type ShellState, type ShellStore } from './store';

/** What main.ts gives the shell: the running game mode and how to swap it. */
export interface GameHost {
  readonly local: LocalMode | null;
  readonly online: OnlineMode | null;
  /** training: a local match against bots */
  startTraining(name: string): void;
  /**
   * A room by code on the game server at `url`, admitted with the API's join ticket (null: the server
   * checks none). `refreshTicket` asks the API for a new one when a long drop outlasted the player.
   */
  startOnline(url: string, name: string, room: string, ticket: string | null, refreshTicket?: () => Promise<string | null>): void;
  /** back to the menus (the map turns slowly behind them) */
  stop(): void;
  applySettings(settings: Settings): void;
  /** menus over the game: no gameplay buttons reach the sim (aim still follows the mouse) */
  setInputBlocked(blocked: boolean): void;
}

export interface NameResult {
  ok: boolean;
  /** why not, in words */
  error?: string;
  suggestions?: string[];
}

const SETTINGS_KEY = 'settings.v1';
const OFFLINE_NAME_KEY = 'profile.offlineName.v1';

/** Saved settings → valid settings (anything unknown or malformed falls back to `defaults`). */
export function sanitizeSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  return {
    graphics: s.graphics === 'low' || s.graphics === 'medium' || s.graphics === 'high' ? s.graphics : defaults.graphics,
    netGraph: flag(s.netGraph, defaults.netGraph),
    lowBandwidth: flag(s.lowBandwidth, defaults.lowBandwidth),
    reduceFlashes: flag(s.reduceFlashes, defaults.reduceFlashes),
    doubleTapDash: flag(s.doubleTapDash, defaults.doubleTapDash),
    bindings: sanitizeBindings(s.bindings),
  };
}

/** The OS asks for less motion: "Reduce flashes" starts on (the flashbang effect's own default too). */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function loadSettings(): Settings {
  const defaults = { ...DEFAULT_SETTINGS, reduceFlashes: prefersReducedMotion() };
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'), defaults);
  } catch {
    return sanitizeSettings(null, defaults);
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* fine: this session only */
  }
}

/** `/r/CODE` or `?room=CODE` → join it; anything else → home. */
export function intentFromLocation(loc: Pick<Location, 'pathname' | 'search'>): Intent {
  const path = /^\/r\/([^/]+)\/?$/.exec(loc.pathname);
  const raw = path ? decodeURIComponent(path[1]!) : new URLSearchParams(loc.search).get('room');
  if (raw === null) return { to: 'home' };
  const code = normalizeRoomCode(raw);
  return code ? { to: 'join', code } : { to: 'home' };
}

/** The room's share link on this site. */
export function roomLink(code: string, origin = location.origin): string {
  return `${origin}/r/${code}`;
}

/** Where a room's game server is: the API's gsUrl, or this site's own /ws/<code>. */
export function roomSocketUrl(room: Pick<RoomJoin, 'code' | 'gsUrl'>, loc?: Pick<Location, 'protocol' | 'host'>): string {
  if (room.gsUrl) return room.gsUrl;
  const page = loc ?? location;
  return `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}/ws/${room.code}`;
}

function describeApiError(e: unknown): { title: string; message: string } {
  if (e instanceof ApiError) {
    if (e.code === 'room_not_found') return { title: 'Room not found', message: 'That room code does not exist or has expired. Check the link, or ask your friend for a new one.' };
    if (e.code === 'invalid_room_code') return { title: 'Not a room code', message: 'Room codes are 6 letters, like KQXMZP.' };
    if (e.code === 'rate_limited') return { title: 'Slow down', message: `Too many tries. Wait ${String(e.extra.retryAfter ?? 60)} s and try again.` };
    if (e.offline) return { title: "Can't reach the server", message: 'The game server is not answering. It may have stopped: ask whoever sent you the link.' };
    return { title: 'Something went wrong', message: e.message };
  }
  return { title: 'Something went wrong', message: (e as Error).message };
}

function profileOf(me: Me): Profile {
  return { nickname: me.nickname, changeableAt: me.nicknameChangeableAt, offline: false };
}

export class ShellController {
  private noticeTimer = 0;

  constructor(
    readonly store: ShellStore,
    readonly host: GameHost,
    readonly api: Api = new Api(),
  ) {
    const settings = loadSettings();
    store.setState({ settings });
    host.applySettings(settings);
    window.addEventListener('popstate', () => this.onPopState());
  }

  private set(partial: Partial<ShellState>): void {
    this.store.setState(partial);
  }

  private get profile(): Profile | null {
    return this.store.getState().profile;
  }

  /** First screen: restore the session, then follow the link (a room) or show home. */
  async boot(): Promise<void> {
    this.set({ screen: { name: 'boot' } });
    const intent = intentFromLocation(location);
    let me: Me | null;
    try {
      me = await this.api.restore();
    } catch {
      // the API is down: training still works, with a local name
      let name = '';
      try {
        name = localStorage.getItem(OFFLINE_NAME_KEY) ?? '';
      } catch {
        /* none */
      }
      this.set({ profile: { nickname: name || `Pilot${Math.floor(Math.random() * 900 + 100)}`, changeableAt: null, offline: true } });
      this.go(intent.to === 'join' ? intent : { to: 'home' });
      return;
    }
    if (!me) {
      this.set({ screen: { name: 'name', then: intent } });
      return;
    }
    this.set({ profile: profileOf(me) });
    this.go(intent);
  }

  /** Navigation. Anything that needs the API waits for a name first. */
  go(intent: Intent): void {
    this.closeOverlay();
    switch (intent.to) {
      case 'home':
        this.host.stop();
        this.setUrl('/');
        this.set({ screen: { name: 'home' }, match: null, lobby: null, connection: null });
        return;
      case 'training':
        this.host.stop();
        this.setUrl('/');
        this.host.startTraining(this.profile?.nickname ?? 'You');
        this.set({ screen: { name: 'training' }, lobby: null, connection: null });
        return;
      case 'create':
      case 'join':
        if (!this.profile) {
          this.set({ screen: { name: 'name', then: intent } });
          return;
        }
        if (this.profile.offline) {
          this.set({ screen: { name: 'error', ...describeApiError(new ApiError(0, 'network', 'offline')), retry: intent } });
          return;
        }
        void this.findRoom(intent);
        return;
    }
  }

  private async findRoom(intent: Extract<Intent, { to: 'create' | 'join' }>): Promise<void> {
    this.host.stop();
    this.set({ screen: { name: 'finding', label: intent.to === 'create' ? 'Creating a room…' : `Looking for room ${intent.code}…` }, match: null, lobby: null });
    try {
      const room = intent.to === 'create' ? await this.api.createRoom() : await this.api.joinRoom(intent.code);
      this.enterRoom(room);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'no_session' || e.status === 401)) {
        // the saved session is gone (expired, revoked): pick a name again
        this.set({ profile: null, screen: { name: 'name', then: intent } });
        return;
      }
      this.set({ screen: { name: 'error', ...describeApiError(e), retry: e instanceof ApiError && e.offline ? intent : null } });
    }
  }

  private enterRoom(room: RoomJoin): void {
    this.setUrl(`/r/${room.code}`);
    const code = room.code;
    const refreshTicket = () =>
      this.api.joinRoom(code).then(
        (again) => again.ticket,
        (e: unknown) => (e instanceof ApiError && e.code === 'room_not_found' ? null : Promise.reject(e)),
      );
    this.host.startOnline(roomSocketUrl(room), this.profile!.nickname, code, room.ticket, refreshTicket);
    this.set({ screen: { name: 'room', code: room.code } });
  }

  /** Reconnect to the same room after a failure (the session may still resume within its grace). */
  rejoin(): void {
    const screen = this.store.getState().screen;
    if (screen.name === 'room') this.go({ to: 'join', code: screen.code });
  }

  /** Leave the room or the training match for the home screen. */
  leave(): void {
    this.host.online?.leave();
    this.go({ to: 'home' });
  }

  // ---- names (docs/07 §3) ----

  checkName(nickname: string): Promise<NicknameCheck> {
    return this.api.checkNickname(nickname);
  }

  /** Sets the player's name: a new guest account the first time, a nickname change after. */
  async setName(nickname: string | null): Promise<NameResult> {
    try {
      const me = !this.api.me ? await this.api.guest(nickname ?? undefined) : nickname && nickname.trim() !== this.api.me.nickname ? await this.api.changeNickname(nickname) : this.api.me;
      this.set({ profile: profileOf(me) });
    } catch (e) {
      if (!(e instanceof ApiError)) return { ok: false, error: (e as Error).message };
      if (e.offline) {
        // no API: keep a local name and let the player train
        if (nickname) {
          try {
            localStorage.setItem(OFFLINE_NAME_KEY, nickname);
          } catch {
            /* fine */
          }
        }
        this.set({ profile: { nickname: nickname || 'Pilot', changeableAt: null, offline: true } });
      } else if (e.code === 'nickname_taken') return { ok: false, error: NICKNAME_REASONS.taken, suggestions: (e.extra.suggestions as string[] | undefined) ?? [] };
      else if (e.code === 'invalid_nickname') return { ok: false, error: NICKNAME_REASONS[String(e.extra.reason)] ?? e.message };
      else if (e.code === 'nickname_cooldown') return { ok: false, error: `You can change your name again on ${new Date(String(e.extra.nicknameChangeableAt)).toLocaleDateString()}` };
      else return { ok: false, error: describeApiError(e).message };
    }
    const screen = this.store.getState().screen;
    if (screen.name === 'name') this.go(screen.then);
    else this.closeOverlay();
    return { ok: true };
  }

  // ---- overlays and settings ----

  openOverlay(overlay: Exclude<Overlay, null>): void {
    this.set({ overlay });
    this.host.setInputBlocked(true);
  }

  closeOverlay(): void {
    if (this.store.getState().overlay === null) return;
    this.set({ overlay: null });
    this.host.setInputBlocked(false);
  }

  /** Esc during play: the in-game menu (or close whatever is open). */
  toggleMenu(): void {
    const { overlay, screen } = this.store.getState();
    if (overlay) this.closeOverlay();
    else if (screen.name === 'room' || screen.name === 'training') this.openOverlay('menu');
  }

  updateSettings(patch: Partial<Settings>): void {
    const settings = { ...this.store.getState().settings, ...patch };
    saveSettings(settings);
    this.set({ settings });
    this.host.applySettings(settings);
  }

  notify(message: string): void {
    this.set({ notice: message });
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => this.set({ notice: null }), 2200);
  }

  async copyLink(code: string): Promise<void> {
    const link = roomLink(code);
    try {
      await navigator.clipboard.writeText(link);
      this.notify('Link copied: send it to a friend');
    } catch {
      window.prompt('Copy this link and send it to a friend:', link);
    }
  }

  // ---- browser history ----

  private setUrl(path: string): void {
    if (location.pathname + location.search !== path) history.pushState(null, '', path);
  }

  private onPopState(): void {
    const intent = intentFromLocation(location);
    const screen = this.store.getState().screen;
    if (intent.to === 'join' && screen.name === 'room' && screen.code === intent.code) return;
    if (intent.to === 'home' && (screen.name === 'home' || screen.name === 'training')) return;
    if (screen.name === 'room') this.host.online?.leave();
    this.go(intent);
  }
}
