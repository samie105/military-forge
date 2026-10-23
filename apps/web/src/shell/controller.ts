/**
 * The app shell's navigation and flows (docs/06 §4 layer L4, docs/07 §2): boot → name → home →
 * play with friends / join with code / training, the room lifecycle, and leaving. It talks to the
 * API (api.ts) and starts and stops game modes through the GameHost that main.ts provides; the
 * React screens only read the store and call these methods.
 */
import { GAME_NAME, normalizeRoomCode } from '@military-forge/shared';
import type { OnlineMode } from '../onlineMode';
import type { LocalMode } from '../localMode';
import { alertFromApiError } from './alerts';
import { Api, ApiError, NICKNAME_REASONS, type Me, type NicknameCheck, type RoomJoin } from './api';
import { sanitizePadSettings } from '../gamepad/settings';
import { sanitizeBindings } from './controls';
import { DEFAULT_SETTINGS, type AudioSettings, type GraphicsPreset, type Intent, type Overlay, type Profile, type Settings, type SettingsTab, type ShellState, type ShellStore, type TuneNote } from './store';

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
  startOnline(url: string, name: string, room: string, ticket: string | null, refreshTicket?: () => Promise<string | null>, options?: { spectate?: boolean }): void;
  /**
   * Local rooms (same Wi-Fi, lan/): host one here (its code from the game server's relay, '' with
   * no connection), or join one by code (the relay) or by the host's QR code (a peer `answerFor`
   * made, no internet).
   */
  startLocalHost?(name: string): Promise<string>;
  startLocalJoin?(name: string, how: { code: string } | { answered: import('../lan/peer').Peer }): void;
  /** the local room hosted here, while it runs */
  readonly lan?: import('../lan/host').LanHost | null;
  /** back to the menus (the map turns slowly behind them) */
  stop(): void;
  applySettings(settings: Settings): void;
  /** menus over the game: no gameplay buttons reach the sim (aim still follows the mouse) */
  setInputBlocked(blocked: boolean): void;
  /**
   * The live tuning panel (hostTuning.ts), where this page offers it (pnpm playtest --tune, dev
   * builds): the in-match menu offers it to the room's host, and in training.
   */
  readonly tuning?: { open(): void; close(): void; readonly isOpen: boolean; setCovered?(covered: boolean): void } | null;
  /** the preset Settings → Graphics → Auto picks on this device (gfxAuto.ts) */
  readonly autoGraphics?: GraphicsPreset;
}

export interface NameResult {
  ok: boolean;
  /** why not, in words */
  error?: string;
  suggestions?: string[];
}

/** What Join with code says back (the screen stays up and shows it). */
export type JoinResult = 'ok' | 'not_found' | 'rate_limited' | 'error';

const SETTINGS_KEY = 'settings.v1';
/**
 * Saved settings carry this. Before rev 2 (none): Low graphics and double-tap dash off were the
 * defaults, not choices, so those two values load as the new defaults (Auto, on) once. Before
 * rev 3: V was melee's; it's push to talk now (voice chat), so a saved V on melee moves to C.
 */
export const SETTINGS_REV = 3;
const OFFLINE_NAME_KEY = 'profile.offlineName.v1';
const TIPS_SEEN_KEY = 'tips.seen.v1';

function flagged(key: string, storage: () => Storage): boolean {
  try {
    return storage().getItem(key) === '1';
  } catch {
    return false;
  }
}

function flag(key: string, storage: () => Storage): void {
  try {
    storage().setItem(key, '1');
  } catch {
    /* this session only */
  }
}

/** Saved settings → valid settings (anything unknown or malformed falls back to `defaults`). */
export function sanitizeSettings(raw: unknown, defaults: Settings = DEFAULT_SETTINGS): Settings {
  const s = { ...(typeof raw === 'object' && raw !== null ? raw : {}) } as Partial<Record<keyof Settings | 'rev', unknown>>;
  const rev = typeof s.rev === 'number' ? s.rev : 0;
  if (raw !== null && typeof raw === 'object' && rev < 2) {
    // saved before the defaults changed (rev 2): the old defaults weren't choices
    if (s.graphics === 'low') delete s.graphics;
    if (s.doubleTapDash === false) delete s.doubleTapDash;
  }
  if (raw !== null && typeof raw === 'object' && rev < 3 && typeof s.bindings === 'object' && s.bindings !== null) {
    // rev 3: V is push to talk; melee's V moves to C (unless C does something else already)
    const b = { ...(s.bindings as Record<string, unknown>) };
    const melee = b.melee;
    const cTaken = Object.entries(b).some(([k, v]) => k !== 'melee' && Array.isArray(v) && v.includes('KeyC'));
    if (Array.isArray(melee) && melee.includes('KeyV')) b.melee = cTaken ? melee.filter((c) => c !== 'KeyV') : melee.map((c) => (c === 'KeyV' ? 'KeyC' : c));
    s.bindings = b;
  }
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const unit = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback);
  const a = (typeof s.audio === 'object' && s.audio !== null ? s.audio : {}) as Partial<Record<keyof AudioSettings, unknown>>;
  const da = defaults.audio;
  const scale = typeof s.textScale === 'number' && Number.isFinite(s.textScale) ? Math.round(Math.min(1.5, Math.max(1, s.textScale)) * 10) / 10 : defaults.textScale;
  return {
    graphics: s.graphics === 'auto' || s.graphics === 'low' || s.graphics === 'medium' || s.graphics === 'high' ? s.graphics : defaults.graphics,
    showFps: flag(s.showFps, defaults.showFps),
    audio: {
      master: unit(a.master, da.master),
      effects: unit(a.effects, da.effects),
      music: unit(a.music, da.music),
      ui: unit(a.ui, da.ui),
      voice: unit(a.voice, da.voice),
      masterMuted: flag(a.masterMuted, da.masterMuted),
      effectsMuted: flag(a.effectsMuted, da.effectsMuted),
      musicMuted: flag(a.musicMuted, da.musicMuted),
      uiMuted: flag(a.uiMuted, da.uiMuted),
      voiceMuted: flag(a.voiceMuted, da.voiceMuted),
      headphones: flag(a.headphones, da.headphones),
    },
    netGraph: flag(s.netGraph, defaults.netGraph),
    lowBandwidth: flag(s.lowBandwidth, defaults.lowBandwidth),
    reduceFlashes: flag(s.reduceFlashes, defaults.reduceFlashes),
    softBursts: flag(s.softBursts, defaults.softBursts),
    reduceMotion: flag(s.reduceMotion, defaults.reduceMotion),
    reduceTransparency: flag(s.reduceTransparency, defaults.reduceTransparency),
    colorBlind: s.colorBlind === 'deutan' || s.colorBlind === 'tritan' || s.colorBlind === 'standard' ? s.colorBlind : defaults.colorBlind,
    textScale: scale,
    doubleTapDash: flag(s.doubleTapDash, defaults.doubleTapDash),
    blood: flag(s.blood, defaults.blood),
    bindings: sanitizeBindings(s.bindings),
    pad: sanitizePadSettings(s.pad),
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

/** The OS asks for less transparency: solid surfaces start on (ui/frost.css). */
function prefersReducedTransparency(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-transparency: reduce)').matches;
  } catch {
    return false;
  }
}

/** The settings saved on this device (main.ts reads them before the shell starts: the 3D view's first preset). */
export function loadSettings(): Settings {
  const reduced = prefersReducedMotion();
  const defaults = { ...DEFAULT_SETTINGS, reduceFlashes: reduced, reduceMotion: reduced, reduceTransparency: prefersReducedTransparency() };
  try {
    return sanitizeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null'), defaults);
  } catch {
    return sanitizeSettings(null, defaults);
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...s, rev: SETTINGS_REV }));
  } catch {
    /* fine: this session only */
  }
}

/** `/r/CODE` or `?room=CODE` → join it; anything else → home. */
export function intentFromLocation(loc: Pick<Location, 'pathname' | 'search'>): Intent {
  // the Armory's "Try it in training" (?try=<weapon id>): straight to training
  if (/^[a-z0-9_-]{1,32}$/.test(new URLSearchParams(loc.search).get('try') ?? '')) return { to: 'training' };
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

/** The invitation that goes with the link. */
export function inviteText(): string {
  return `Join my ${GAME_NAME} room:`;
}

/** WhatsApp's "send to a chat" page with the invitation and the room's link. */
export function whatsAppLink(code: string, origin = location.origin): string {
  return `https://wa.me/?text=${encodeURIComponent(`${inviteText()} ${roomLink(code, origin)}`)}`;
}

/** Where a room's game server is: the API's gsUrl, or this site's own /ws/<code>. */
export function roomSocketUrl(room: Pick<RoomJoin, 'code' | 'gsUrl'>, loc?: Pick<Location, 'protocol' | 'host'>): string {
  if (room.gsUrl) return room.gsUrl;
  const page = loc ?? location;
  return `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}/ws/${room.code}`;
}

function profileOf(me: Me): Profile {
  return { nickname: me.nickname, changeableAt: me.nicknameChangeableAt, offline: false };
}

export class ShellController {
  private noticeTimer = 0;
  /** Settings was opened from the in-match menu: Back returns there */
  private settingsFrom: 'menu' | null = null;

  constructor(
    readonly store: ShellStore,
    readonly host: GameHost,
    readonly api: Api = new Api(),
  ) {
    const settings = loadSettings();
    store.setState({ settings });
    host.applySettings(settings);
    window.addEventListener('popstate', () => this.onPopState());
    // the tuning panel goes away with host rights (another player became host, or we left), and
    // steps aside while a menu is open
    store.subscribe((s) => {
      if (!host.tuning) return;
      if (host.tuning.isOpen && !this.canTune()) host.tuning.close();
      host.tuning.setCovered?.(s.overlay !== null);
    });
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
      this.go(intent.to === 'join' || intent.to === 'training' ? intent : { to: 'home' });
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
        this.set({ screen: { name: 'home' }, match: null, lobby: null, connection: null, tips: false });
        return;
      case 'training':
        this.host.stop();
        this.setUrl('/');
        this.host.startTraining(this.profile?.nickname ?? 'You');
        this.set({ screen: { name: 'training' }, lobby: null, connection: null });
        this.firstTips();
        return;
      case 'local':
        if (!this.profile) {
          this.set({ screen: { name: 'name', then: intent } });
          return;
        }
        void this.hostLocal();
        return;
      case 'create':
      case 'join':
      case 'watch':
        if (!this.profile) {
          this.set({ screen: { name: 'name', then: intent } });
          return;
        }
        if (this.profile.offline) {
          // no API: a code may still be a local room's, through the game server's relay (local rooms
          // have no spectators: watching one needs the API)
          if (intent.to === 'join' && this.host.startLocalJoin) return this.joinLocal(intent.code);
          this.set({ screen: { name: 'error', alert: alertFromApiError(new ApiError(0, 'network', 'offline'), intent.to === 'create' ? undefined : intent.code), retry: intent } });
          return;
        }
        void this.findRoom(intent);
        return;
    }
  }

  /** Host a local room (same Wi-Fi): this device runs it; friends join by its code or QR codes. */
  private async hostLocal(): Promise<void> {
    if (!this.host.startLocalHost) return;
    this.host.stop();
    this.set({ screen: { name: 'finding', code: null, creating: true }, match: null, lobby: null });
    const code = await this.host.startLocalHost(this.profile!.nickname);
    this.setUrl(code ? `/r/${code}` : '/');
    this.set({ screen: { name: 'room', code, local: true } });
    this.firstTips();
  }

  /** Join a local room by its code (the relay), or by the host's QR code (`answered`, no internet). */
  joinLocal(code: string, answered?: import('../lan/peer').Peer): void {
    if (!this.host.startLocalJoin || !this.profile) return;
    this.closeOverlay();
    this.host.stop();
    this.set({ match: null, lobby: null });
    this.host.startLocalJoin(this.profile.nickname, answered ? { answered } : { code });
    this.setUrl(code ? `/r/${code}` : '/');
    this.set({ screen: { name: 'room', code, local: true } });
    this.firstTips();
  }

  private async findRoom(intent: Extract<Intent, { to: 'create' | 'join' | 'watch' }>): Promise<void> {
    this.host.stop();
    const code = intent.to === 'create' ? null : intent.code;
    this.set({ screen: { name: 'finding', code, creating: intent.to === 'create' }, match: null, lobby: null });
    try {
      // a watcher's ticket is the same join ticket: the HELLO says "as a spectator"
      const room = code === null ? await this.api.createRoom() : await this.api.joinRoom(code);
      this.enterRoom(room, intent.to === 'watch');
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'no_session' || e.status === 401)) {
        // the saved session is gone (expired, revoked): pick a name again
        this.set({ profile: null, screen: { name: 'name', then: intent } });
        return;
      }
      const alert = alertFromApiError(e, code ?? undefined);
      this.set({ screen: { name: 'error', alert, retry: alert.action ? intent : null } });
    }
  }

  /**
   * Join with code: asks the API first and stays on the Join screen when the room isn't there
   * ("No room with that code"); a room that exists is entered at once.
   */
  async joinByCode(code: string, watch = false): Promise<JoinResult> {
    const intent: Intent = watch ? { to: 'watch', code } : { to: 'join', code };
    if (!this.profile || this.profile.offline) {
      this.go(intent);
      return 'error';
    }
    let room: RoomJoin;
    try {
      room = await this.api.joinRoom(code);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'room_not_found' || e.code === 'invalid_room_code')) {
        // not one of the server's rooms: maybe a local room (same Wi-Fi) with that code (joined, not
        // watched: local rooms have no spectators)
        if (!watch && e.code === 'room_not_found' && (await this.localRoomExists(code))) {
          this.joinLocal(code);
          return 'ok';
        }
        return 'not_found';
      }
      if (e instanceof ApiError && e.code === 'rate_limited') return 'rate_limited';
      if (e instanceof ApiError && (e.code === 'no_session' || e.status === 401)) {
        this.closeOverlay();
        this.set({ profile: null, screen: { name: 'name', then: intent } });
        return 'error';
      }
      this.closeOverlay();
      const alert = alertFromApiError(e, code);
      this.set({ screen: { name: 'error', alert, retry: alert.action ? intent : null } });
      return 'error';
    }
    this.closeOverlay();
    this.host.stop();
    this.set({ match: null, lobby: null });
    this.enterRoom(room, watch);
    return 'ok';
  }

  /** Join with code's Watch: the same checks as Join, then the room as a spectator. */
  watchByCode(code: string): Promise<JoinResult> {
    return this.joinByCode(code, true);
  }

  /** Watch a room by code as a spectator (no slot: the room seats us when we ask and one is free). */
  watch(code: string): void {
    this.go({ to: 'watch', code });
  }

  /**
   * A full room's Watch (the connection screen): watch the room on screen instead, the one the
   * failed connection or the API lookup was for.
   */
  watchHere(): void {
    const screen = this.store.getState().screen;
    const code = screen.name === 'room' && !screen.local ? screen.code : screen.name === 'error' && screen.retry && 'code' in screen.retry ? screen.retry.code : '';
    if (code) this.watch(code);
  }

  /** Whether the relay knows a local room with `code` (it answers within a moment either way). */
  private async localRoomExists(code: string): Promise<boolean> {
    if (!this.host.startLocalJoin) return false;
    const { lanRoomExists } = await import('../lan/guest');
    return lanRoomExists(code);
  }

  /** Into the room the API found: to play, or (`watch`) as a spectator. */
  private enterRoom(room: RoomJoin, watch = false): void {
    this.setUrl(`/r/${room.code}`);
    const code = room.code;
    const refreshTicket = () =>
      this.api.joinRoom(code).then(
        (again) => again.ticket,
        (e: unknown) => (e instanceof ApiError && e.code === 'room_not_found' ? null : Promise.reject(e)),
      );
    if (watch) this.host.startOnline(roomSocketUrl(room), this.profile!.nickname, code, room.ticket, refreshTicket, { spectate: true });
    else this.host.startOnline(roomSocketUrl(room), this.profile!.nickname, code, room.ticket, refreshTicket);
    this.set({ screen: watch ? { name: 'room', code: room.code, watch: true } : { name: 'room', code: room.code } });
    this.firstTips();
  }

  /** The controls card and tips the first time a player gets into a game. */
  private firstTips(): void {
    if (!flagged(TIPS_SEEN_KEY, () => localStorage)) this.set({ tips: true });
  }

  showTips(): void {
    this.closeOverlay();
    this.set({ tips: true });
  }

  closeTips(): void {
    flag(TIPS_SEEN_KEY, () => localStorage);
    this.set({ tips: false });
  }

  /**
   * Reconnect to the same room after a failure (the session may still resume within its grace); a
   * watcher watches again.
   */
  rejoin(): void {
    const screen = this.store.getState().screen;
    if (screen.name === 'room' && screen.local) {
      if (screen.code) this.joinLocal(screen.code);
      else this.go({ to: 'home' });
    } else if (screen.name === 'room') this.go({ to: screen.watch ? 'watch' : 'join', code: screen.code });
  }

  /** "Tune the game" in the menu: this page offers the panel, and you're the room's host (or in training). */
  canTune(): boolean {
    if (!this.host.tuning) return false;
    const { screen, lobby } = this.store.getState();
    return screen.name === 'training' || (screen.name === 'room' && lobby?.isHost === true);
  }

  /** Back to the game with the tuning panel open beside it. */
  openTuning(): void {
    if (!this.canTune()) return;
    this.closeOverlay();
    this.host.tuning!.open();
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
      else return { ok: false, error: alertFromApiError(e).message };
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
    this.settingsFrom = null;
    this.set({ overlay: null });
    this.host.setInputBlocked(false);
  }

  /** Back from an overlay: Settings opened from the in-match menu goes back to it, anything else closes. */
  back(): void {
    const { overlay } = this.store.getState();
    if (overlay === 'settings' && this.settingsFrom === 'menu') {
      this.settingsFrom = null;
      this.set({ overlay: 'menu' });
    } else this.closeOverlay();
  }

  /** Settings at a section (Home's "Change keys" opens Controls); the last one used otherwise. */
  openSettings(tab?: SettingsTab): void {
    const from = this.store.getState().overlay;
    if (tab) this.set({ settingsTab: tab });
    this.openOverlay('settings');
    this.settingsFrom = from === 'menu' ? 'menu' : null;
  }

  setSettingsTab(tab: SettingsTab): void {
    this.set({ settingsTab: tab });
  }

  /** Esc: back out of whatever is open, or the in-match menu during play. */
  toggleMenu(): void {
    const { overlay, screen } = this.store.getState();
    if (overlay) this.back();
    else if (screen.name === 'room' || screen.name === 'training') this.openOverlay('menu');
  }

  updateSettings(patch: Partial<Settings>): void {
    const settings = { ...this.store.getState().settings, ...patch };
    saveSettings(settings);
    this.set({ settings });
    this.host.applySettings(settings);
  }

  private tuneNotes = 0;

  /** A guest's toast: the host just retuned the room (main.ts hears it from the online mode). */
  showTuneNote(note: Omit<TuneNote, 'id'>): void {
    this.set({ tuneNote: { ...note, id: ++this.tuneNotes } });
  }

  notify(message: string): void {
    this.set({ notice: message });
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => this.set({ notice: null }), 2200);
  }

  /** Copies the room's link; `quiet` when the screen shows it itself (the lobby's button turns green). */
  async copyLink(code: string, quiet = false): Promise<boolean> {
    const link = roomLink(code);
    try {
      await navigator.clipboard.writeText(link);
      if (!quiet) this.notify('Link copied: send it to a friend');
      return true;
    } catch {
      window.prompt('Copy this link and send it to a friend:', link);
      return false;
    }
  }

  /** WhatsApp's share page with the room's link (a new tab; the player picks the chat there). */
  shareOnWhatsApp(code: string): void {
    window.open(whatsAppLink(code), '_blank', 'noopener,noreferrer');
  }

  /** The system share sheet where the browser has one (phones); otherwise the link is copied. */
  async shareLink(code: string): Promise<void> {
    const url = roomLink(code);
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title: GAME_NAME, text: inviteText(), url });
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
      }
    }
    await this.copyLink(code);
  }

  // ---- browser history ----

  /** the path and query the shell last stood on: a popstate that changes only the #hash isn't the shell's */
  private lastPath = typeof location === 'undefined' ? '' : location.pathname + location.search;

  private setUrl(path: string): void {
    if (location.pathname + location.search !== path) history.pushState(null, '', path);
    this.lastPath = location.pathname + location.search;
  }

  private onPopState(): void {
    // a #hash of its own (the landing's #about, a route's #/locker): the screens stay as they are
    const path = location.pathname + location.search;
    if (path === this.lastPath) return;
    this.lastPath = path;
    const intent = intentFromLocation(location);
    const screen = this.store.getState().screen;
    if (intent.to === 'join' && screen.name === 'room' && screen.code === intent.code) return;
    if (intent.to === 'home' && (screen.name === 'home' || screen.name === 'training')) return;
    if (screen.name === 'room') this.host.online?.leave();
    this.go(intent);
  }
}
