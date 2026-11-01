/**
 * The app shell's navigation and flows (docs/06 §4 layer L4, docs/07 §2): boot → name → home →
 * play with friends / join with code / training, the room lifecycle, and leaving. It talks to the
 * API (api.ts) and starts and stops game modes through the GameHost that main.ts provides; the
 * React screens only read the store and call these methods.
 */
import { GAME_NAME, normalizeRoomCode } from '@military-forge/shared';
import { MatchPhase } from '@military-forge/sim';
import type { OnlineMode } from '../onlineMode';
import { diag } from '../diag/log';
import { RECRUIT_MATCHES, playNowBotLevel, type BotLevel } from '../tour/facts';
import type { LocalMode } from '../localMode';
import { adultOnDevice, ageOnDevice, answerAge } from './age';
import { alertFromApiError, suspendedAlert } from './alerts';
import { Api, ApiError, NICKNAME_REASONS, type AdultAnswer, type Me, type NicknameCheck, type RoomJoin } from './api';
import { sanitizePadSettings } from '../gamepad/settings';
import { sanitizeBindings } from './controls';
import { NavHistory, pageNav, setNavHooks, type Layer } from './history';
import { activeRouteBack } from './focus';
import { DEFAULT_SETTINGS, SETTINGS_TABS, findRoute, type AccountIntent, type AudioSettings, type GraphicsPreset, type Intent, type Overlay, type Profile, type Settings, type SettingsTab, type ShellState, type ShellStore, type TuneNote } from './store';

/**
 * What training plays: a local match against bots (the default), First flight (the onboarding's range:
 * the map's targets, no match) or Live fire (a recruit's first match: 3 Easy bots, first to 5).
 */
export type TrainingKind = 'match' | 'flight' | 'live-fire' | 'hard';

/** What main.ts gives the shell: the running game mode and how to swap it. */
export interface GameHost {
  readonly local: LocalMode | null;
  readonly online: OnlineMode | null;
  /** training: a local match against bots, First flight or Live fire */
  startTraining(name: string, kind?: TrainingKind): void;
  /** the onboarding tour running in training (First flight): the pause menu's Restart and Skip training */
  readonly tour?: { restart(): void; skip(): void } | null;
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
  /** another card is up that the controls card mustn't stack on (the phone's first-run fire chooser) */
  readonly cardUp?: () => boolean;
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
/** "Keep this name?" is due (KeepName.tsx): set when a first visit gets a generated callsign, cleared once answered */
export const NAME_ASK_KEY = 'callsign.ask.v1';

/** This session's offline name, where storage fails: the same name all session. */
let sessionOfflineName: string | null = null;

/**
 * The name used while the API can't be reached: `chosen` (saved for next time), else the one saved on
 * this device, else a new PilotNNN saved at once, so it stays the same on every load (audit 28 Oct).
 */
export function offlineName(chosen?: string | null, storage: () => Storage = () => localStorage): string {
  const typed = chosen?.trim();
  let name = typed || null;
  if (!name) {
    try {
      name = storage().getItem(OFFLINE_NAME_KEY)?.trim() || null;
    } catch {
      /* none */
    }
  }
  name ??= sessionOfflineName ?? `Pilot${Math.floor(Math.random() * 900 + 100)}`;
  sessionOfflineName = name;
  try {
    storage().setItem(OFFLINE_NAME_KEY, name);
  } catch {
    /* this session only */
  }
  return name;
}

/** Flags set this session: where storage fails (Safari private mode), a card still shows once per session. */
const sessionFlags = new Set<string>();

/** Before Play now's bots followed results, they were Easy for this many finished matches (audit B-30) */
export { RECRUIT_MATCHES };
/** how long Play now waits for the room to say its bots are at the level asked before it starts anyway (ms) */
const QUICK_BOTS_WAIT_MS = 2500;

/**
 * Play now's bot level on this device (audit 2 P-01, tour/facts.ts `bots`): Easy to start, a step up
 * after two top-two finishes, down after two last places, or the player's own pick.
 */
export function playNowBots(storage: () => Storage): BotLevel {
  try {
    return playNowBotLevel(storage());
  } catch {
    return 'normal';
  }
}

function flagged(key: string, storage: () => Storage): boolean {
  if (sessionFlags.has(key)) return true;
  try {
    return storage().getItem(key) === '1';
  } catch {
    return false;
  }
}

function flag(key: string, storage: () => Storage): void {
  sessionFlags.add(key);
  try {
    storage().setItem(key, '1');
  } catch {
    /* this session only */
  }
}

function unflag(key: string, storage: () => Storage): void {
  sessionFlags.delete(key);
  try {
    storage().removeItem(key);
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
    showKillEffects: flag(s.showKillEffects, defaults.showKillEffects),
    damageNumbers: flag(s.damageNumbers, defaults.damageNumbers),
    hitMarkers: flag(s.hitMarkers, defaults.hitMarkers),
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
/**
 * An emailed account link in the address (`#reset=<token>` / `#confirm=<token>`): taken off the
 * address bar at once, so the token isn't left in history or a shared screenshot. The token rides in
 * the #fragment, which browsers never send to a server.
 */
export function accountLinkFrom(hash: string): AccountIntent | null {
  const m = /^#(reset|confirm)=([A-Za-z0-9_.-]{10,200})$/.exec(hash);
  return m ? { mode: m[1] as 'reset' | 'confirm', token: m[2]! } : null;
}

function takeAccountLink(): AccountIntent | null {
  if (typeof location === 'undefined') return null;
  const link = accountLinkFrom(location.hash);
  if (link) {
    try {
      history.replaceState(history.state, '', location.pathname + location.search);
    } catch {
      /* fine */
    }
  }
  return link;
}

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

/** Where the 18+ step (age.ts) comes first: a room with other players, online or local. */
const onlineIntent = (i: Intent): boolean => i.to === 'create' || i.to === 'join' || i.to === 'watch' || i.to === 'local';

/** Where a room's game server is: the API's gsUrl, or this site's own /ws/<code>. */
export function roomSocketUrl(room: Pick<RoomJoin, 'code' | 'gsUrl'>, loc?: Pick<Location, 'protocol' | 'host'>): string {
  if (room.gsUrl) return room.gsUrl;
  const page = loc ?? location;
  return `${page.protocol === 'https:' ? 'wss' : 'ws'}://${page.host}/ws/${room.code}`;
}

/** This device said under 18 (age.ts): training only (audit-2 L-03). */
const minorOnDevice = (): boolean => ageOnDevice()?.adult === false;

function profileOf(me: Me): Profile {
  const minor = me.minor === true || minorOnDevice();
  return { nickname: me.nickname, changeableAt: me.nicknameChangeableAt, offline: false, ...(minor ? { minor: true } : {}) };
}

export class ShellController {
  private noticeTimer = 0;
  /** Settings was opened from the in-match menu: Back returns there */
  private settingsFrom: 'menu' | null = null;
  /**
   * The back stack (history.ts, audit N-18): a room or training ('play'), routes, overlays and the
   * Friends panel are one browser entry each, and Back, Escape and a pad's B close the same one.
   */
  readonly nav: NavHistory;
  /** the room's link while one is open (the 'play' layer's path), undefined in training */
  private playPath: string | undefined;
  /** layers drawn outside the shell's store (the Friends panel, the invite picker): how each closes */
  private readonly layerClosers = new Map<string, () => void>();
  /** the #hash the page opened on (#/settings/audio, #/friends, #/join): opened once the player is in */
  private deepLink: string;

  constructor(
    readonly store: ShellStore,
    readonly host: GameHost,
    readonly api: Api = new Api(),
  ) {
    const settings = loadSettings();
    store.setState({ settings, nameAsk: flagged(NAME_ASK_KEY, () => localStorage) });
    host.applySettings(settings);
    this.deepLink = typeof location === 'undefined' ? '' : (location.hash ?? '');
    this.nav = new NavHistory(pageNav());
    // a route opened by setting the address (Home's tabs: location.hash = '#/locker'), or typed
    this.nav.resolve = (hash) => {
      const id = /^#\/([a-z-]+)$/.exec(hash)?.[1];
      return id && findRoute(id) ? this.routeLayer(id) : null;
    };
    setNavHooks({ closeTop: () => this.closeTop(), closeRoute: () => this.closeRoute(), openRoute: (id) => this.openRoute(id), swapRoute: (id) => this.swapRoute(id) });
    // a route the address names as the page opens (a reload on #/locker): over Home, so Back is Home
    const opened = /^#\/([a-z-]+)$/.exec(this.deepLink)?.[1];
    if (opened && findRoute(opened)) this.openRoute(opened);
    // the tab's title says where the player is (audit C-41, D-29); Home keeps index.html's
    const pageTitle = typeof document === 'undefined' ? '' : document.title;
    store.subscribe((s) => {
      const t = tabTitle(s) ?? pageTitle;
      if (typeof document !== 'undefined' && document.title !== t) document.title = t;
    });
    // the match ended under the menu or Settings (mobile audit P1-2): they close, so Results shows (the
    // pause must never say the match is running after its end)
    store.subscribe((s, before) => {
      if (matchEnded(before, s) && (s.overlay === 'menu' || s.overlay === 'settings')) this.closeOverlay();
      if (tipsLeaveWithLobby(before, s)) this.set({ tips: false });
    });
    // Play now's room (P1-6): as soon as it's ours and full enough (bots count), the countdown starts.
    // The 18+ step on a first visit keeps it: answered, the room comes and starts as promised (audit A-02)
    // Its bots play at the device's Play now level (audit B-30, audit 2 P-01): the start waits until the
    // room says its bots are at it.
    // Play now is set on Home a moment before the screen moves (the room's back-stack entry goes first,
    // and the page answers it): only a move to another screen ends it, not an update while on Home.
    store.subscribe((s, before) => {
      if (!this.quickStart && !this.quickRoom) return;
      if (s.screen !== before.screen && s.screen.name !== 'room' && s.screen.name !== 'finding' && !(s.screen.name === 'age' && !s.screen.refused)) {
        this.quickStart = false;
        this.quickRoom = false;
        this.wantBots = null;
        return;
      }
      if (!this.quickStart || !quickStartReady(s)) return;
      if (this.wantBots && s.lobby!.bots > 0 && s.lobby!.botLevel !== this.wantBots) {
        if (this.botsAskedAt === 0) {
          this.host.online?.setMatchSettings({ botLevel: this.wantBots });
          this.botsAskedAt = performance.now();
          // a room that never says so (an older server) starts anyway, a moment later
          window.setTimeout(() => this.startQuick(), QUICK_BOTS_WAIT_MS);
        }
        return;
      }
      this.startQuick();
    });
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

  /**
   * First screen: restore the session, then follow the link (a room) or show home. An emailed
   * account link (#reset=… / #confirm=…) then opens Settings → Account on its form.
   */
  async boot(): Promise<void> {
    const link = takeAccountLink();
    await this.bootSession();
    if (link) this.openAccount(link);
    else this.openDeepLink();
  }

  /**
   * The layer the address named as the page opened (a shared #/settings/controls, a reload with
   * Settings open: audit N-19): over the first screen, once. #/friends is the Friends panel's
   * (takeDeepLink); routes opened with the controller.
   */
  private openDeepLink(): void {
    const hash = this.deepLink;
    const settings = /^#\/settings(?:\/([a-z]+))?$/.exec(hash);
    const screen = this.store.getState().screen.name;
    if (screen === 'name' || screen === 'age' || screen === 'boot') return; // the first visit's steps come first (enlist opens it after)
    if (settings) {
      const tab = SETTINGS_TABS.find((t) => t.id === settings[1])?.id;
      this.deepLink = '';
      this.openSettings(tab);
    } else if ((hash === '#/join' || hash === '#/rooms') && screen === 'home') {
      this.deepLink = '';
      this.openOverlay(hash === '#/join' ? 'join' : 'rooms');
    }
  }

  /** The address named `what` as the page opened (#/friends): true once, for the one who opens it. */
  takeDeepLink(what: string): boolean {
    if (this.deepLink !== `#/${what}`) return false;
    this.deepLink = '';
    return true;
  }

  private async bootSession(): Promise<void> {
    this.set({ screen: { name: 'boot' } });
    const intent = intentFromLocation(location);
    let me: Me | null;
    try {
      me = await this.api.restore();
    } catch {
      // the API is down: training still works, with a local name (the same one on every load)
      this.set({ profile: { nickname: offlineName(), changeableAt: null, offline: true } });
      this.go(intent.to === 'join' || intent.to === 'training' ? intent : { to: 'home' });
      return;
    }
    if (!me && this.api.disabled) {
      // suspended or banned (audit-2 L-04): training only, under the account's own name if we knew it
      this.set({ profile: { nickname: offlineName(), changeableAt: null, offline: true, suspended: this.api.disabled } });
      if (onlineIntent(intent)) this.set({ screen: { name: 'error', alert: suspendedAlert(this.api.disabled.until), retry: null } });
      else {
        this.go(intent);
        this.notify(suspendedAlert(this.api.disabled.until).message);
      }
      return;
    }
    if (!me) {
      // a room link on a first visit: the 18+ step before the name (age.ts)
      if (onlineIntent(intent) && this.ageGate(intent)) return;
      // a first visit through the title (a real browser at the front door): no name step. The press
      // makes the guest with a generated callsign, then Home, or Play now from the landing's Play now;
      // "Keep this name?" comes after the first match (enlist, KeepName.tsx). A room link, the debug
      // client and automation (no title) keep the name step.
      if (this.store.getState().title !== 'off' && (intent.to === 'home' || intent.to === 'training')) {
        this.awaitFirstPress(intent);
        return;
      }
      this.set({ screen: { name: 'name', then: intent } });
      return;
    }
    this.set({ profile: profileOf(me) });
    // a device that said under 18 before the account knew (audit-2 L-03): tell it, once
    if (minorOnDevice() && !me.minor) this.markMinor();
    this.go(intent);
  }

  /**
   * A first visit through the title: the screen stays 'boot' (the title says "Getting ready…" if pressed
   * meanwhile) until the press, which enlists. A visitor who never presses (a crawler) makes no account.
   */
  private awaitFirstPress(intent: Intent): void {
    let started = false;
    const check = (s: ShellState) => {
      if (started || s.title === 'on') return;
      started = true;
      stop();
      void this.enlist(intent);
    };
    const stop = this.store.subscribe(check);
    check(this.store.getState());
  }

  /**
   * The first press: a guest account with the API's generated callsign (the same as the name step's "Pick
   * one for me"), then where the visit was going, or straight into Play now when the press was the
   * landing's Play now (the 18+ step first, as for any online room). No API: training under a local name,
   * as at any boot. Any other failure: the name step, so nobody is stuck on the title.
   */
  async enlist(intent: Intent): Promise<void> {
    try {
      const me = await this.api.guest(undefined, minorOnDevice());
      this.set({ profile: profileOf(me), nameAsk: true });
      flag(NAME_ASK_KEY, () => localStorage);
      diag('name', 'first visit: a generated callsign (Keep this name? comes later)');
    } catch (e) {
      if (!(e instanceof ApiError && e.offline)) {
        this.set({ screen: { name: 'name', then: intent } });
        return;
      }
      this.set({ profile: { nickname: offlineName(), changeableAt: null, offline: true } });
    }
    if (this.store.getState().titlePlay && !this.profile?.offline && !this.profile?.minor) this.playNow();
    else this.go(this.profile?.offline && intent.to !== 'training' ? { to: 'home' } : intent);
    this.openDeepLink();
  }

  /** "Keep this name?": kept. The question goes for good. */
  keepName(): void {
    this.set({ nameAsk: false });
    unflag(NAME_ASK_KEY, () => localStorage);
  }

  /** "Keep this name?": Change. Edit name opens; the question goes either way (it was answered). */
  changeName(): void {
    this.keepName();
    this.openOverlay('name');
  }

  /** The account learns this device said under 18 (only the flag): it trains only from now on. */
  private markMinor(): void {
    void this.api.markMinor().then(
      (me) => this.set({ profile: profileOf(me) }),
      () => {
        /* the device's answer still keeps friends and voice off here; the next start tries again */
      },
    );
  }

  /**
   * The 18+ step (age.ts) before an online room: true when it's in the way (its screen is up, and
   * carries on to `then` once answered).
   */
  private ageGate(then: Intent): boolean {
    const age = ageOnDevice();
    if (age?.adult) return false;
    // asked from Home (Play now, Create room): Back closes it, Home (audit N-18); on a first visit
    // from a link there's nothing under it
    const fromHome = this.store.getState().screen.name === 'home';
    this.closeOverlay();
    this.host.stop();
    if (fromHome && !this.nav.has('age')) this.nav.push({ key: 'age', hash: '', popped: () => this.go({ to: 'home' }) });
    this.set({ screen: { name: 'age', then, ...(age ? { refused: true } : {}) }, match: null, lobby: null, connection: null });
    return true;
  }

  /**
   * The 18+ step's answer (`turned18`: only for the year they turn 18): an adult carries on where
   * they were going; an under-18 sees the refusal.
   */
  answerAge(birthYear: number, turned18?: boolean): 'ok' | 'refused' | 'invalid' {
    const record = answerAge(birthYear, Date.now(), turned18);
    if (record === 'invalid') return 'invalid';
    const screen = this.store.getState().screen;
    const then = screen.name === 'age' ? screen.then : ({ to: 'home' } as const);
    if (!record.adult) {
      diag('age', 'under 18: no online play');
      // friends, search and voice go too (audit-2 L-03), here and on the account
      const p = this.profile;
      if (p) this.set({ profile: { ...p, minor: true } });
      if (this.api.me && !this.api.me.minor) this.markMinor();
      this.set({ screen: { name: 'age', then, refused: true } });
      return 'refused';
    }
    this.go(then);
    return 'ok';
  }

  /** Navigation. Anything that needs the API waits for a name first; an online room, for the 18+ step. */
  go(intent: Intent): void {
    this.closeOverlay();
    // the age question answered (or Not now): its entry goes
    this.nav.close('age');
    if (onlineIntent(intent) && this.ageGate(intent)) return;
    switch (intent.to) {
      case 'home':
        // the first-run controls card comes before play or not at all: not on the Home a match ended into
        this.tipsQueued = false;
        this.host.stop();
        this.leavePlay();
        this.set({ screen: { name: 'home' }, match: null, lobby: null, connection: null, tips: false });
        return;
      case 'training':
        this.host.stop();
        this.enterPlay(undefined);
        this.host.startTraining(this.profile?.nickname ?? 'You');
        this.set({ screen: { name: 'training' }, lobby: null, connection: null, tips: false });
        this.firstTips(); // the first time: the controls card, with training held still under it
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
        if (this.profile.suspended) {
          this.set({ screen: { name: 'error', alert: suspendedAlert(this.profile.suspended.until), retry: null } });
          return;
        }
        if (this.profile.offline) {
          // no API: a code may still be a local room's, through the game server's relay (local rooms
          // have no spectators: watching one needs the API)
          if (intent.to === 'join' && this.host.startLocalJoin) return this.joinLocal(intent.code);
          this.set({ screen: { name: 'error', alert: alertFromApiError(new ApiError(0, 'network', 'offline'), intent.to === 'create' ? undefined : intent.code), retry: intent } });
          return;
        }
        this.enterPlay(intent.to === 'create' ? undefined : `/r/${intent.code}`);
        void this.findRoom(intent);
        return;
    }
  }

  /** Host a local room (same Wi-Fi): this device runs it; friends join by its code or QR codes. */
  private async hostLocal(): Promise<void> {
    if (!this.host.startLocalHost) return;
    this.host.stop();
    this.enterPlay(undefined);
    this.set({ screen: { name: 'finding', code: null, creating: true }, match: null, lobby: null });
    diag('room', 'host a local room');
    const code = await this.host.startLocalHost(this.profile!.nickname);
    diag('room', code ? `local room ${code} up` : 'local room up with no code (no relay: QR codes only)');
    if (this.store.getState().screen.name !== 'finding') return; // gone back meanwhile
    this.enterPlay(code ? `/r/${code}` : undefined);
    this.set({ screen: { name: 'room', code, local: true } });
    this.firstTips();
  }

  /** Join a local room by its code (the relay), or by the host's QR code (`answered`, no internet). */
  joinLocal(code: string, answered?: import('../lan/peer').Peer): void {
    if (!this.host.startLocalJoin || !this.profile) return;
    // by QR codes the answer can't wait for the step: after it, Home (scan again)
    if (this.ageGate(code ? { to: 'join', code } : { to: 'home' })) return;
    diag('room', `join local room ${code || 'by QR codes'}`);
    this.closeOverlay();
    this.host.stop();
    this.set({ match: null, lobby: null });
    this.host.startLocalJoin(this.profile.nickname, answered ? { answered } : { code });
    this.enterPlay(code ? `/r/${code}` : undefined);
    this.set({ screen: { name: 'room', code, local: true } });
    this.firstTips();
  }

  private async findRoom(intent: Extract<Intent, { to: 'create' | 'join' | 'watch' }>): Promise<void> {
    this.host.stop();
    const code = intent.to === 'create' ? null : intent.code;
    this.set({ screen: { name: 'finding', code, creating: intent.to === 'create' }, match: null, lobby: null });
    // a local room's link: the relay is asked alongside the API (one round trip, the host never hears)
    const local = intent.to === 'join' && code ? this.localRoomExists(code).catch(() => false) : null;
    try {
      // a watcher's ticket is the same join ticket: the HELLO says "as a spectator"
      const room = code === null ? (intent.to === 'create' && intent.quick ? await this.api.quickRoom() : await this.api.createRoom()) : await this.api.joinRoom(code);
      // cancelled meanwhile (Cancel, Back, B): the room isn't entered after all
      if (this.store.getState().screen.name !== 'finding') return;
      if (room.joined) this.joinedQuick();
      this.enterRoom(room, intent.to === 'watch');
    } catch (e) {
      if (this.store.getState().screen.name !== 'finding') return;
      diag('room', `${intent.to} ${code ?? ''}: the API said ${e instanceof ApiError ? `${e.code} (${e.status})` : (e as Error)?.message}`);
      // not one of the server's rooms: a local room's link (its QR, Share room link) lands here, so
      // ask the relay before saying there's no room (the owner, 24 Oct: "the local room flow is
      // terrible": a local room's link said Room not found)
      if (local && code && e instanceof ApiError && e.code === 'room_not_found' && (await local)) {
        this.joinLocal(code);
        return;
      }
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
    if (!this.profile || this.profile.offline || !adultOnDevice()) {
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

  /**
   * A room picked in the Rooms list (rooms/): the API checks again that it's open to us and has a seat.
   * Taken meanwhile (it filled, went private, or isn't ours to see): Play now instead, which finds the
   * next best room the same way ("Taken. Joining the next best room").
   */
  async joinListed(code: string): Promise<'ok' | 'taken' | 'error'> {
    if (!this.profile || this.profile.offline || !adultOnDevice()) {
      this.go({ to: 'join', code });
      return 'error';
    }
    let room: RoomJoin;
    try {
      room = await this.api.joinRoom(code, 'list');
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'room_taken' || e.code === 'room_not_found')) {
        this.closeOverlay();
        this.playNow();
        this.notify('Taken. Joining the next best room');
        return 'taken';
      }
      if (e instanceof ApiError && (e.code === 'no_session' || e.status === 401)) {
        this.closeOverlay();
        this.set({ profile: null, screen: { name: 'name', then: { to: 'join', code } } });
        return 'error';
      }
      this.closeOverlay();
      const alert = alertFromApiError(e, code);
      this.set({ screen: { name: 'error', alert, retry: alert.action ? { to: 'join', code } : null } });
      return 'error';
    }
    this.closeOverlay();
    this.host.stop();
    this.set({ match: null, lobby: null });
    this.enterRoom(room);
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
    this.enterPlay(`/r/${room.code}`);
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

  /** "How to play", waiting for a calm moment (firstTips) */
  private tipsQueued = false;

  /**
   * The controls card the first time a player gets into a game: queued, never over a running match
   * (mobile audit P0-3). It opens at the next calm moment before play (releaseTips): a room's lobby
   * and warm-up, or training (which holds still under it), with nothing else open and no other card
   * up (the phone's fire chooser). Going Home drops the queue: the card never shows after a match.
   */
  private firstTips(): void {
    if (!this.tipsQueued && !flagged(TIPS_SEEN_KEY, () => localStorage)) this.tipsQueued = true;
    this.releaseTips();
  }

  /** The first-run controls card has been shown on this device (tests, checks). */
  get tipsSeen(): boolean {
    return flagged(TIPS_SEEN_KEY, () => localStorage);
  }

  /** Every frame (shell.update) and on queueing: opens the queued controls card when it's calm. */
  releaseTips(): void {
    // Play now's lobby is gone in a moment (its countdown starts at once): the card waits for a calm
    // lobby rather than open there unseen and count as shown (audit B-01)
    if (!this.tipsQueued || this.quickRoom || !tipsCalm(this.store.getState()) || this.host.cardUp?.()) return;
    this.tipsQueued = false;
    // shown once per device: the decision is saved the moment it opens, so however it then closes (Got
    // it, starting a match, leaving, Escape, a route, the lobby folding it) it never comes back by
    // itself; the menu's Controls opens it on request (the owner, 24 Oct: "always showing how to play")
    flag(TIPS_SEEN_KEY, () => localStorage);
    this.set({ tips: true, tipsAsked: false });
  }

  showTips(): void {
    this.closeOverlay();
    this.set({ tips: true, tipsAsked: true });
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

  /** First flight (the onboarding tour, tour/firstFlight.ts): the range and its targets, no match. */
  startFlight(): void {
    this.closeOverlay();
    this.host.stop();
    this.enterPlay(undefined);
    this.host.startTraining(this.profile?.nickname ?? 'You', 'flight');
    this.set({ screen: { name: 'training', tour: 'first-flight' }, lobby: null, connection: null, tips: false });
  }

  /** Play now's room waits to start its countdown (playNow) */
  private quickStart = false;
  /** we're in (or on the way to) Play now's room: its lobby is gone in a moment */
  private quickRoom = false;
  /** Play now's bot level: the room's bots go to it before the start (audit B-30, audit 2 P-01) */
  private wantBots: BotLevel | null = null;
  /** when the bots' level was asked for (performance.now), 0 = not yet */
  private botsAskedAt = 0;

  /** Play now's countdown, once: the room is ours and has its players. */
  private startQuick(): void {
    if (!this.quickStart || !quickStartReady(this.store.getState())) return;
    this.quickStart = false;
    this.host.online?.startMatch();
  }

  /**
   * Play now (mobile audit P1-6): one tap to a fight. Online: a room of our own that bots fill, its
   * countdown started at once (friends can still join by its code), its bots at this device's Play now
   * level (or `bots`, once: Next orders' "One more, Easy bots"). No API (offline): training against
   * bots. No name yet: the name screen first, then the same.
   */
  playNow(bots?: BotLevel): void {
    if (!this.profile) {
      this.set({ screen: { name: 'name', then: { to: 'training' } } });
      return;
    }
    if (this.profile.offline) return bots === 'easy' ? this.train('live-fire') : this.go({ to: 'training' });
    this.quickStart = true;
    this.quickRoom = true;
    this.wantBots = bots ?? playNowBots(() => localStorage);
    this.botsAskedAt = 0;
    // its own level (Easy, once) is a room of our own; otherwise first an open Play now room with people in it (P-07)
    this.go(bots ? { to: 'create' } : { to: 'create', quick: true });
  }

  /**
   * Play now found someone else's open room (audit 2 P-07): its host starts it and its bots stay at
   * the level it has; once its lobby is here, one line says so ("Bots here: Normal"). Found empty (the
   * others just left), it's ours and starts as our own room would.
   */
  private joinedQuick(): void {
    const stop = this.store.subscribe((s) => {
      if (s.screen.name !== 'room' && s.screen.name !== 'finding') return stop();
      const l = s.lobby;
      if (!l) return;
      stop();
      // everyone else had gone (it's ours now, waiting): it starts as our own would; else it's theirs to run
      if (!quickStartReady(s) && !(l.isHost && (s.match === null || s.match.phase === MatchPhase.Waiting))) {
        this.quickStart = false;
        this.wantBots = null;
      }
      const people = l.players.filter((p) => !p.isBot).length;
      this.notify(`In a Play now room with ${people - 1} ${people - 1 === 1 ? 'other player' : 'other players'}${l.bots > 0 ? ` · Bots here: ${l.botLevel[0]!.toUpperCase()}${l.botLevel.slice(1)}` : ''}`);
    });
  }

  /** Live fire: a recruit's first match, against 3 Easy bots (first to 5 kills, or 3 minutes). */
  startLiveFire(): void {
    this.train('live-fire');
  }

  /** Training of a kind (Next orders: Live fire, Normal or Hard bots); First flight is startFlight. */
  train(kind: TrainingKind): void {
    if (kind === 'flight') return this.startFlight();
    if (kind === 'match') return this.go({ to: 'training' });
    this.closeOverlay();
    this.host.stop();
    this.enterPlay(undefined);
    this.host.startTraining(this.profile?.nickname ?? 'You', kind);
    this.set({ screen: { name: 'training' }, lobby: null, connection: null, tips: false });
  }

  /** The pause menu's Restart First flight. */
  restartTour(): void {
    this.closeOverlay();
    this.host.tour?.restart();
  }

  /** The pause menu's Skip training (the tour ends; back to Home). */
  skipTour(): void {
    this.closeOverlay();
    this.host.tour?.skip();
  }

  /** Leave the room or the training match for the home screen. */
  leave(): void {
    this.host.online?.leave();
    this.go({ to: 'home' });
  }

  // ---- names (docs/07 §3) ----

  /** Whose room an invite's code is, for the name screen (null: unknown). */
  peekRoom(code: string): Promise<{ code: string; host: string | null } | null> {
    return this.api.peekRoom(code);
  }

  checkName(nickname: string): Promise<NicknameCheck> {
    return this.api.checkNickname(nickname);
  }

  /** Sets the player's name: a new guest account the first time, a nickname change after. */
  async setName(nickname: string | null): Promise<NameResult> {
    try {
      const me = !this.api.me ? await this.api.guest(nickname ?? undefined, minorOnDevice()) : nickname && nickname.trim() !== this.api.me.nickname ? await this.api.changeNickname(nickname) : this.api.me;
      this.set({ profile: profileOf(me) });
    } catch (e) {
      if (!(e instanceof ApiError)) return { ok: false, error: (e as Error).message };
      if (e.offline) {
        // no API: keep a local name (the one typed, else this device's) and let the player train
        this.set({ profile: { nickname: offlineName(nickname), changeableAt: null, offline: true } });
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

  // ---- saved accounts: Settings → Account (account/AccountPanel.tsx) ----

  /** Settings → Account, on a form (`intent`) or its summary. */
  openAccount(intent: AccountIntent | null = null): void {
    this.set({ accountIntent: intent });
    this.openSettings('account');
  }

  /**
   * "Save your account": this account gets an email and password; 'check_email' when a link
   * confirms it first. `birthYear`: the 18+ answer (the device's, or the form's: age.ts).
   */
  async saveAccount(email: string, password: string, age: AdultAnswer, turnstileToken?: string): Promise<'saved' | 'check_email'> {
    const result = await this.api.saveAccount(email, password, age, turnstileToken);
    if (this.api.me) this.set({ profile: profileOf(this.api.me) });
    return result;
  }

  /** Switching players mid-room would leave the room's player behind under the old name. */
  get accountSwitchBlocked(): boolean {
    const screen = this.store.getState().screen.name;
    return screen === 'room' || screen === 'finding';
  }

  /** Signs this device in to a saved account (the guest-on-this-device rule is the API's: Api.signIn). */
  async signIn(email: string, password: string, turnstileToken?: string): Promise<{ me: Me; previousGuest: 'kept' | 'discarded' | null }> {
    if (this.accountSwitchBlocked) throw new ApiError(409, 'in_room', 'Leave the room first');
    const result = await this.api.signIn(email, password, turnstileToken);
    this.set({ profile: profileOf(result.me) });
    // signed in from the first visit's name screen: carry on where it was going
    const screen = this.store.getState().screen;
    if (screen.name === 'name') {
      this.closeOverlay();
      this.go(screen.then);
    }
    return result;
  }

  /**
   * Signs out (`everywhere`: every device). The guest a sign-in kept on this device comes back if
   * there is one; otherwise this device starts over at the name screen, like a first visit.
   */
  async signOut(everywhere = false): Promise<Me | null> {
    if (this.accountSwitchBlocked) throw new ApiError(409, 'in_room', 'Leave the room first');
    const me = await this.api.signOut(everywhere);
    if (me) {
      this.set({ profile: profileOf(me) });
      return me;
    }
    this.closeOverlay();
    this.host.stop();
    this.leavePlay();
    this.set({ profile: null, screen: { name: 'name', then: { to: 'home' } }, match: null, lobby: null, connection: null });
    return null;
  }

  /** A new password: every other device is signed out, this one carries on. */
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    const me = await this.api.changePassword(currentPassword, newPassword);
    this.set({ profile: profileOf(me) });
  }

  // ---- overlays and settings ----

  openOverlay(overlay: Exclude<Overlay, null>): void {
    const now = this.store.getState().overlay;
    this.set({ overlay });
    this.host.setInputBlocked(true);
    // one entry each: Settings over the pause menu stacks (Back returns to the menu); one overlay in
    // another's place takes its entry
    const layer = this.overlayLayer(overlay);
    const top = this.nav.top()?.key ?? '';
    if (now !== null && now !== 'menu' && top.startsWith('overlay:')) this.nav.replaceTop(layer);
    else if (now === overlay && top === layer.key) this.nav.replaceTop(layer);
    else this.nav.push(layer);
  }

  closeOverlay(): void {
    if (this.store.getState().overlay === null) return;
    this.settingsFrom = null;
    this.set({ overlay: null, menuAsk: false });
    this.host.setInputBlocked(false);
    const first = this.nav.keys().find((k) => k.startsWith('overlay:'));
    if (first) this.nav.close(first);
  }

  /** Back from an overlay: Settings opened from the in-match menu goes back to it, anything else closes. */
  back(): void {
    const { overlay } = this.store.getState();
    if (overlay === 'settings' && this.settingsFrom === 'menu') {
      this.settingsFrom = null;
      this.set({ overlay: 'menu' });
      this.nav.close('overlay:settings');
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
    // the address names the tab (#/settings/controls): a reload or a shared link opens it
    if (this.nav.top()?.key === 'overlay:settings') this.nav.replaceTop(this.overlayLayer('settings'));
  }

  /** Esc: back out of whatever is open, or the in-match menu during play (closeTop). */
  toggleMenu(): void {
    this.closeTop();
  }

  /**
   * The one way back (history.ts closeTop; Escape, a controller's B): the top layer closes, the way its
   * own Back or ✕ would. Nothing open in a room or training: the pause menu. Home: nothing (false).
   */
  closeTop(): boolean {
    const top = this.nav.top();
    const own = top ? this.layerClosers.get(top.key) : undefined;
    if (own) {
      own();
      return true;
    }
    const s = this.store.getState();
    if (s.overlay) {
      this.back();
      return true;
    }
    if (s.route) {
      this.escapeRoute();
      return true;
    }
    switch (s.screen.name) {
      case 'age':
        // asked from Home: Not now; a first visit's (a link) has nothing under it
        if (!this.nav.has('age')) return false;
        this.go({ to: 'home' });
        return true;
      case 'finding':
      case 'error':
        this.go({ to: 'home' });
        return true;
      case 'room':
      case 'training':
        this.openOverlay('menu');
        return true;
      default:
        return false;
    }
  }

  // ---- the back stack's layers (history.ts) ----

  private overlayLayer(overlay: Exclude<Overlay, null>): Layer {
    // the pause menu has no address of its own (a reload doesn't bring it back); the rest name themselves
    const hash = overlay === 'menu' ? '' : overlay === 'settings' ? `#/settings/${this.store.getState().settingsTab}` : `#/${overlay}`;
    return { key: `overlay:${overlay}`, hash, popped: () => this.overlayPopped() };
  }

  /** The browser's Back closed an overlay: the one under it (the pause menu under Settings) shows, or none. */
  private overlayPopped(): void {
    const keys = this.nav.keys().filter((k) => k.startsWith('overlay:'));
    const top = (keys.at(-1)?.slice('overlay:'.length) ?? null) as Overlay;
    if (top === this.store.getState().overlay) return;
    this.settingsFrom = top === 'settings' && keys.includes('overlay:menu') ? 'menu' : null;
    this.set({ overlay: top, ...(top === null ? { menuAsk: false } : {}) });
    this.host.setInputBlocked(top !== null || this.store.getState().route !== null);
  }

  private routeLayer(id: string): Layer {
    return { key: `route:${id}`, hash: `#/${id}`, popped: () => activeRouteBack()?.() };
  }

  /** A route over what's open (#/<id>): one entry. */
  openRoute(id: string): void {
    this.nav.push(this.routeLayer(id));
  }

  /** Route to route with no new entry: back to `id` when it's right under this one, else in this one's place. */
  swapRoute(id: string): void {
    const keys = this.nav.keys();
    const top = keys.at(-1) ?? '';
    if (top.startsWith('route:') && keys.at(-2) === `route:${id}`) this.nav.close(top);
    else if (top.startsWith('route:')) this.nav.replaceTop(this.routeLayer(id));
    else this.openRoute(id);
  }

  /** The open route closes (its Back, Done): back over its entry. */
  closeRoute(): void {
    const id = this.nav.routeId();
    if (id) this.nav.close(`route:${id}`);
  }

  /** Escape (or B) in a route: the route's own Back when it has one (the first-run creator's Skip), else it closes. */
  private escapeRoute(): void {
    const back = activeRouteBack();
    if (back) back();
    else this.closeRoute();
  }

  /**
   * A layer drawn outside the shell's store (the Friends panel, the invite picker) opened: one entry;
   * Escape, B and the browser's Back close it with `close`.
   */
  openLayer(key: string, hash: string, close: () => void): void {
    this.layerClosers.set(key, close);
    if (!this.nav.has(key)) this.nav.push({ key, hash, popped: close });
  }

  /** …and it closed itself: back over its entry. */
  closedLayer(key: string): void {
    this.layerClosers.delete(key);
    this.nav.close(key);
  }

  /**
   * A room (from finding it to its results) or training is the 'play' layer: one entry with the
   * room's link. The browser's Back on it never leaves at once (audit N-07): it comes back and asks.
   */
  private enterPlay(path: string | undefined): void {
    this.playPath = path;
    if (this.nav.has('play')) this.nav.update('play', { path });
    else this.nav.push({ key: 'play', hash: '', path, popped: () => this.playPopped() });
  }

  /** Out of the room or training: back over its entries; the address is Home's (a room the page opened on too). */
  private leavePlay(): void {
    this.playPath = undefined;
    this.nav.setBasePath('/');
    this.nav.close('play');
  }

  /**
   * The browser's Back (Android's back gesture) took the room's or training's entry. Still joining, a
   * failed join or a lost connection: that's leaving. Otherwise the entry comes back and the pause
   * menu opens: in a match or training as it is (Resume, Leave), in a lobby or the results on "Leave
   * the room?" (audit N-07, N-18).
   */
  private playPopped(): void {
    const s = this.store.getState();
    const name = s.screen.name;
    const joining = name === 'room' && (!s.connection || s.connection.state === 'connecting' || s.connection.state === 'joining' || s.connection.state === 'failed');
    if (name === 'finding' || name === 'error' || joining) {
      this.host.online?.leave();
      this.go({ to: 'home' });
      return;
    }
    if (name !== 'room' && name !== 'training') return;
    this.nav.push({ key: 'play', hash: '', path: this.playPath, popped: () => this.playPopped() });
    const phase = s.match?.phase;
    const ask = name === 'room' && (phase === undefined || phase === MatchPhase.Waiting || phase === MatchPhase.Ending || phase === MatchPhase.Postgame || phase === MatchPhase.Closed);
    if (s.overlay === 'menu') return;
    this.closeOverlay();
    this.set({ menuAsk: ask });
    this.openOverlay('menu');
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

  /** A short-lived line ("Link copied"); `ms`: how long it stays (a longer one for news to read). */
  notify(message: string, ms = 2200): void {
    this.set({ notice: message });
    window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => this.set({ notice: null }), ms);
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
}

/**
 * The browser tab's title for where the player is (audit C-41, D-29): "Lobby · KTVGBD · Forged Force",
 * "In match · Street Market · …", "Settings · Controls · …". Null: the page's own (Home, the first
 * visit's steps), the one index.html gives search results.
 */
export function tabTitle(s: Pick<ShellState, 'screen' | 'overlay' | 'route' | 'match' | 'lobby' | 'connection' | 'settingsTab'>): string | null {
  const t = (...parts: string[]) => [...parts, GAME_NAME].join(' · ');
  if (s.route) return t(s.route.title);
  if (s.overlay === 'settings') return t('Settings', SETTINGS_TABS.find((x) => x.id === s.settingsTab)?.label ?? '');
  if (s.overlay === 'join') return t('Join a room');
  if (s.overlay === 'name') return t('Your name');
  const sc = s.screen;
  if (sc.name === 'training') return t(sc.tour ? 'First flight' : s.match && s.match.phase !== MatchPhase.Waiting ? 'Training' : 'Warm-up');
  if (sc.name === 'finding') return t(sc.creating ? 'Making a room' : `Joining ${sc.code ?? ''}`.trim());
  if (sc.name === 'error') return t(sc.alert.title);
  if (sc.name !== 'room') return null;
  if (!s.connection || s.connection.state === 'connecting' || s.connection.state === 'joining' || (s.connection.state === 'reconnecting' && !s.match)) return t(`Joining ${sc.code}`);
  if (s.connection.state === 'failed') return t('Connection lost');
  const phase = s.match?.phase;
  const map = s.match?.mapName || s.lobby?.mapName || '';
  if (phase === MatchPhase.Countdown || phase === MatchPhase.InProgress) return t('In match', ...(map ? [map] : []));
  if (phase === MatchPhase.Ending || phase === MatchPhase.Postgame || phase === MatchPhase.Closed) return t('Results');
  return t('Lobby', ...(sc.code ? [sc.code] : []));
}

/**
 * A moment the first-run controls card may open in, before play (mobile audit P0-3; audit 28 Oct: it
 * must come before the first match, never after it): a room's lobby and warm-up (no countdown, no
 * clock), or training, which holds still under the card (trainingPaused). Never First flight (it
 * teaches the controls itself), never over another overlay, and never once a match there has ended:
 * the lobby after a match is Waiting too, but it comes with the results (audit B-01).
 */
export function tipsCalm(s: ShellState): boolean {
  if (s.overlay !== null || s.route !== null || s.tips || s.title !== 'off') return false;
  if (s.screen.name === 'training') return !s.screen.tour;
  return s.screen.name === 'room' && (s.match === null || (s.match.phase === MatchPhase.Waiting && s.match.results === null));
}

/**
 * The first-run card goes with the lobby it opened in (audit B-01): released there (the lobby's own
 * panel) and not asked for, it closes as the countdown starts, so it never comes back as a card over
 * the match or its results. Seen already: it was saved as seen the moment it opened (releaseTips).
 */
export function tipsLeaveWithLobby(before: ShellState, now: ShellState): boolean {
  return now.tips && now.tipsAsked !== true && now.screen.name === 'room' && before.match?.phase === MatchPhase.Waiting && !!now.match && now.match.phase !== MatchPhase.Waiting;
}

/**
 * Training holds still (LocalMode.paused): something is open over it (the pause menu, Settings, a full
 * screen route) or the controls card is up. Training runs on this device alone, so its pause is real;
 * an online room keeps playing under its menu.
 */
export function trainingPaused(s: Pick<ShellState, 'screen' | 'overlay' | 'route' | 'tips'>): boolean {
  return s.screen.name === 'training' && (s.overlay !== null || s.route !== null || s.tips);
}

/** The clock stopped: the match went from its countdown or play to its end (results, the vote, closed). */
export function matchEnded(before: ShellState, now: ShellState): boolean {
  const was = before.match?.phase;
  const is = now.match?.phase;
  return (was === MatchPhase.InProgress || was === MatchPhase.Countdown) && (is === MatchPhase.Ending || is === MatchPhase.Postgame || is === MatchPhase.Closed);
}

/** Play now's room may start: we host it, it's in the lobby, and it has the players it needs (bots count). */
export function quickStartReady(s: ShellState): boolean {
  const l = s.lobby;
  return s.screen.name === 'room' && !!l && l.isHost && (s.match === null || s.match.phase === MatchPhase.Waiting) && l.players.length >= l.minPlayers;
}
