/**
 * The Lobby feed on Home (the owner's "a public chat section where anyone can chat"): one public
 * channel of system cards (rooms posted, match results, welcomes, level-ups, the daily Fight night)
 * and quick chat (preset phrases and emotes, picked from a sheet or tapped under a card). The API's
 * /lobby routes (apps/api src/lobby) hold it; @military-forge/shared lobbyFeed.ts is the contract.
 *
 * Data on phones: the feed loads when the panel opens and its live stream (/lobby/events) runs only
 * while the panel is open. On Home the Lobby button asks for the newest line's id every 2 minutes
 * (a few bytes) to show its unread dot.
 *
 * What stays on this device: the last line seen (the dot), players muted in the Lobby (their lines
 * hidden), "Hide public chat", and a Fight night reminder. Nothing here for an under-18 device or
 * offline training (socialAllowed).
 */
import { CARD_REPLIES, LOBBY_LIMITS, quickChat, type LobbyCardKind, type LobbyChat, type LobbyEntry, type QuickChatId } from '@military-forge/shared';
import { useSyncExternalStore } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { ApiError, type Api } from '../shell/api';
import { OFFLINE_TITLE } from '../shell/offline';
import type { Intent, ShellStore } from '../shell/store';
import { EventStream } from '../social/events';
import { socialAllowed } from '../social/social';

/** Home's unread check while the panel is closed */
export const HEAD_POLL_MS = 120_000;
/** lines kept in memory */
const KEEP = 150;
/** the feed counts as quiet when no one has said anything for this long */
export const QUIET_MS = 60 * 60_000;
const SEEN_KEY = 'lobby.seen.v1';
const PREFS_KEY = 'lobby.prefs.v1';
const REMIND_KEY = 'lobby.remind.v1';

export interface FreeTextGate {
  on: boolean;
  allowed: boolean;
  needs: ('account' | 'rules')[];
}

export interface FeedResponse {
  entries: LobbyEntry[];
  now: string;
  lastMatchAt: string | null;
  fightNight: { startsAt: string; endsAt: string; live: boolean };
  me: { mute: { until: string; reason: string } | null; freeText: FreeTextGate };
}

export type FeedStatus = 'idle' | 'loading' | 'ready' | 'error' | 'offline';

export interface FeedState {
  open: boolean;
  status: FeedStatus;
  /** why the last load failed (the panel keeps what it had) */
  error: string | null;
  entries: readonly LobbyEntry[];
  /** server clock minus this device's (a phone's clock may be off) */
  skew: number;
  lastMatchAt: string | null;
  fightNight: { startsAt: number; endsAt: number } | null;
  mute: { until: string; reason: string } | null;
  freeText: FreeTextGate;
  /** the live stream is open */
  live: boolean;
  /** something new since the panel was last open */
  unread: boolean;
  /** the quick chat sheet: open, answering a line or not */
  picker: { replyTo: string | null } | null;
  sending: boolean;
  /** the last send's trouble, in words (cleared by the next) */
  notice: string | null;
  /** "Hide public chat": players' lines are hidden, the cards stay */
  hideChat: boolean;
  /** players muted in the Lobby on this device: id → name */
  muted: Readonly<Record<string, string>>;
  /** a Fight night reminder is set for this start (ms) */
  remindAt: number | null;
  /** the line whose actions (Report, Mute, Block) are showing */
  actionsFor: string | null;
}

/** Quick replies a card offers (the contract's list). */
export function cardReplies(kind: LobbyCardKind): readonly QuickChatId[] {
  return CARD_REPLIES[kind];
}

/** "3 h ago", "12 min ago", "just now". */
export function agoText(iso: string | null, now: number): string {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400 * 2) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} days ago`;
}

/** "2 h 14 min", "45 min", "under a minute". */
export function spanText(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under a minute';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

/** The quiet feed's honest line: when someone last spoke, and when the last match ended. */
export function quietLine(entries: readonly LobbyEntry[], lastMatchAt: string | null, now: number): string | null {
  const lastChat = [...entries].reverse().find((e) => e.kind === 'chat');
  if (lastChat && now - Date.parse(lastChat.at) < QUIET_MS) return null;
  const match = lastMatchAt ? `Last match ${agoText(lastMatchAt, now)}.` : 'No matches yet today.';
  return `Quiet right now. ${match}`;
}

/** In words, for what the API said to a message. */
export function sendErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'That didn’t send: try again';
  switch (e.code) {
    case 'slow_down':
      return 'One message every 3 seconds';
    case 'rate_limited': {
      const wait = Number(e.extra.retryAfter);
      return wait > 0 && wait <= 120 ? `That’s a lot of messages. Wait ${Math.ceil(wait)} s` : 'That’s a lot of messages. Try again later';
    }
    case 'chat_muted':
      return 'You can’t post in the Lobby right now';
    case 'adults_only':
      return 'The Lobby is for players 18 and over';
    case 'free_text_off':
    case 'free_text_locked':
      return 'Pick a phrase from Quick chat';
    case 'empty':
    case 'too_long':
    case 'link':
    case 'digits':
    case 'refused':
      return e.message;
    default:
      return e.offline ? `${OFFLINE_TITLE}. Try again in a moment` : 'That didn’t send: try again';
  }
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: it lasts the session */
  }
}

/** What the feed needs from the shell (a ShellController fits; tests pass a fake). */
export interface FeedShell {
  readonly api: Pick<Api, 'authed'> & Partial<Pick<Api, 'stream' | 'onSignIn'>>;
  readonly store: ShellStore;
  go(intent: Intent): void;
  notify(message: string, ms?: number): void;
}

export class FeedController {
  readonly store: StoreApi<FeedState>;
  private stream: EventStream | null = null;
  private headTimer: ReturnType<typeof setInterval> | null = null;
  private headWatchers = 0;
  private remindTimer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    readonly shell: FeedShell,
    private readonly doc: Pick<Document, 'visibilityState' | 'addEventListener'> | null = typeof document === 'undefined' ? null : document,
  ) {
    const prefs = read<{ hideChat?: boolean; muted?: Record<string, string> }>(PREFS_KEY, {});
    const remindAt = read<number | null>(REMIND_KEY, null);
    this.store = createStore<FeedState>(() => ({
      open: false,
      status: 'idle',
      error: null,
      entries: [],
      skew: 0,
      lastMatchAt: null,
      fightNight: null,
      mute: null,
      freeText: { on: false, allowed: false, needs: [] },
      live: false,
      unread: false,
      picker: null,
      sending: false,
      notice: null,
      hideChat: prefs.hideChat === true,
      muted: prefs.muted && typeof prefs.muted === 'object' ? prefs.muted : {},
      remindAt: typeof remindAt === 'number' && remindAt > Date.now() ? remindAt : null,
      actionsFor: null,
    }));
    this.armReminder();
    // a different player signed in: the last one's feed state goes (the device prefs stay)
    shell.api.onSignIn?.(() => {
      this.set({ entries: [], status: 'idle', error: null, mute: null, unread: false, picker: null, notice: null, actionsFor: null });
      if (this.store.getState().open) void this.load();
    });
    this.doc?.addEventListener('visibilitychange', () => {
      if (this.doc?.visibilityState === 'visible' && this.headWatchers && !this.store.getState().open) void this.checkHead();
    });
  }

  private set(partial: Partial<FeedState>): void {
    this.store.setState(partial);
  }

  get available(): boolean {
    return socialAllowed(this.shell.store.getState().profile);
  }

  /** This device's clock, moved to the server's. */
  now(): number {
    return Date.now() + this.store.getState().skew;
  }

  // ---- open / close ----

  open(): void {
    if (!this.available) return;
    this.set({ open: true, unread: false, actionsFor: null });
    void this.load();
    this.startStream();
  }

  close(): void {
    this.set({ open: false, picker: null, actionsFor: null, notice: null });
    this.stream?.stop();
  }

  private startStream(): void {
    if (!this.shell.api.stream) return;
    if (!this.stream) {
      this.stream = new EventStream(
        this.shell.api as Pick<Api, 'stream'>,
        (type, data) => this.onEvent(type, data),
        (live) => {
          this.set({ live });
          // what was said while it was down
          if (live && this.store.getState().status === 'ready') void this.load();
        },
        this.doc,
        '/lobby/events',
      );
    }
    this.stream.start();
  }

  /** The feed now (one load at a time). */
  load(): Promise<void> {
    if (!this.available) return Promise.resolve();
    if (this.loading) return this.loading;
    const st = this.store.getState();
    if (st.status !== 'ready') this.set({ status: 'loading', error: null });
    this.loading = this.shell.api
      .authed<FeedResponse>('GET', '/lobby')
      .then(
        (r) => {
          const skew = Date.parse(r.now) - Date.now();
          this.set({
            status: 'ready',
            error: null,
            entries: r.entries.slice(-KEEP),
            skew: Number.isFinite(skew) ? skew : 0,
            lastMatchAt: r.lastMatchAt,
            fightNight: { startsAt: Date.parse(r.fightNight.startsAt), endsAt: Date.parse(r.fightNight.endsAt) },
            mute: r.me.mute,
            freeText: r.me.freeText,
          });
          this.markSeen();
        },
        (e: unknown) => {
          const offline = !(e instanceof ApiError) || e.offline;
          this.set({ status: offline ? 'offline' : 'error', error: offline ? OFFLINE_TITLE : e instanceof ApiError && e.code === 'adults_only' ? 'The Lobby is for players 18 and over' : 'The Lobby didn’t load' });
        },
      )
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  /** One event off the live stream. */
  onEvent(type: string, data: unknown): void {
    const d = data as { entry?: LobbyEntry; id?: string } | null;
    if (type === 'lobby_entry' && d?.entry) this.add(d.entry);
    else if (type === 'lobby_remove' && d?.id) this.set({ entries: this.store.getState().entries.filter((e) => e.id !== d.id) });
  }

  private add(entry: LobbyEntry): void {
    const st = this.store.getState();
    if (st.entries.some((e) => e.id === entry.id)) return;
    const entries = [...st.entries, entry].sort((a, b) => Number(a.id) - Number(b.id)).slice(-KEEP);
    this.set({ entries });
    if (st.open) this.markSeen();
    else this.set({ unread: true });
  }

  private markSeen(): void {
    const last = this.store.getState().entries.at(-1);
    if (last) write(SEEN_KEY, last.id);
    this.set({ unread: false });
  }

  // ---- Home's unread dot ----

  /** The newest line vs the last one seen here. */
  async checkHead(): Promise<void> {
    if (!this.available || this.store.getState().open || this.store.getState().hideChat) return;
    try {
      const head = await this.shell.api.authed<{ id: string | null }>('GET', '/lobby/head');
      const seen = read<string | null>(SEEN_KEY, null);
      this.set({ unread: !!head.id && (seen === null || Number(head.id) > Number(seen)) });
    } catch {
      /* the dot waits for the next look */
    }
  }

  /** While Home shows the Lobby button: a look now and every 2 minutes (only while the page is in front). */
  watchHead(): () => void {
    this.headWatchers++;
    if (this.headWatchers === 1) {
      void this.checkHead();
      this.headTimer = setInterval(() => {
        if (this.doc?.visibilityState !== 'hidden') void this.checkHead();
      }, HEAD_POLL_MS);
    }
    return () => {
      this.headWatchers--;
      if (!this.headWatchers && this.headTimer) {
        clearInterval(this.headTimer);
        this.headTimer = null;
      }
    };
  }

  // ---- saying something ----

  openPicker(replyTo: string | null = null): void {
    this.set({ picker: { replyTo }, notice: null });
  }

  closePicker(): void {
    this.set({ picker: null });
  }

  /** A phrase (the sheet, a card's one-tap reply). */
  async send(quick: QuickChatId, replyTo: string | null = null): Promise<boolean> {
    return this.post({ quick, ...(replyTo ? { replyTo } : {}) });
  }

  /** Free text: only when the API says it's on and this player may (the box isn't shown otherwise). */
  async sendText(text: string): Promise<boolean> {
    const st = this.store.getState();
    if (!st.freeText.on || !st.freeText.allowed) return false;
    return this.post({ text: text.slice(0, LOBBY_LIMITS.textMax) });
  }

  private async post(body: Record<string, string>): Promise<boolean> {
    if (this.store.getState().sending) return false;
    this.set({ sending: true, notice: null });
    try {
      const r = await this.shell.api.authed<{ entry?: LobbyChat; dropped?: 'repeat' }>('POST', '/lobby/messages', body);
      if (r.entry) this.add(r.entry);
      this.set({ sending: false, picker: null, notice: r.dropped ? 'You just said that' : null });
      return !!r.entry;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'chat_muted') this.set({ mute: { until: String(e.extra.until), reason: String(e.extra.reason) } });
      this.set({ sending: false, notice: sendErrorText(e) });
      return false;
    }
  }

  async acceptRules(): Promise<void> {
    try {
      const gate = await this.shell.api.authed<FreeTextGate>('POST', '/lobby/rules', {});
      this.set({ freeText: gate });
    } catch (e) {
      this.set({ notice: sendErrorText(e) });
    }
  }

  // ---- your own controls ----

  toggleActions(id: string | null): void {
    this.set({ actionsFor: this.store.getState().actionsFor === id ? null : id });
  }

  setHideChat(hide: boolean): void {
    this.set({ hideChat: hide, actionsFor: null });
    this.savePrefs();
  }

  mute(id: string, name: string): void {
    this.set({ muted: { ...this.store.getState().muted, [id]: name }, actionsFor: null });
    this.savePrefs();
    this.shell.notify(`${name} is muted in the Lobby on this device`);
  }

  unmute(id: string): void {
    const { [id]: _gone, ...muted } = this.store.getState().muted;
    this.set({ muted });
    this.savePrefs();
  }

  private savePrefs(): void {
    const st = this.store.getState();
    write(PREFS_KEY, { hideChat: st.hideChat, muted: st.muted });
  }

  /** A room card's Join: the usual /r/CODE flow. */
  join(code: string): void {
    this.close();
    this.shell.go({ to: 'join', code });
  }

  // ---- Fight night ----

  /**
   * Remind me: a notification on this device at the start when the browser allows one (asked here, on
   * the tap), else a message in the game if it's open then. Kept on this device.
   */
  async remind(): Promise<void> {
    const fn = this.store.getState().fightNight;
    if (!fn) return;
    let notify = false;
    const N = typeof Notification === 'undefined' ? null : Notification;
    if (N) {
      try {
        if (N.permission === 'default') await N.requestPermission();
      } catch {
        /* an old browser's callback form, or refused */
      }
      notify = N.permission === 'granted';
    }
    this.set({ remindAt: fn.startsAt });
    write(REMIND_KEY, fn.startsAt);
    this.armReminder();
    this.shell.notify(notify ? 'We’ll remind you when Fight night starts' : 'We’ll remind you here when Fight night starts, if the game is open');
  }

  cancelReminder(): void {
    this.set({ remindAt: null });
    write(REMIND_KEY, null);
    if (this.remindTimer) clearTimeout(this.remindTimer);
    this.remindTimer = null;
  }

  private armReminder(): void {
    if (this.remindTimer) clearTimeout(this.remindTimer);
    this.remindTimer = null;
    const at = this.store.getState().remindAt;
    if (at === null) return;
    const wait = at - Date.now();
    if (wait <= 0) return this.fireReminder();
    // a timer can't wait past ~24.8 days; Fight night is daily
    this.remindTimer = setTimeout(() => this.fireReminder(), Math.min(wait, 2 ** 31 - 1));
  }

  private fireReminder(): void {
    this.cancelReminder();
    const title = 'Fight night is on';
    const body = 'Players are on now, 20:00–22:00 WAT. Open the Lobby and join a room.';
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && this.doc?.visibilityState !== 'visible') {
        new Notification(title, { body, tag: 'fight-night' });
        return;
      }
    } catch {
      /* some phones only allow notifications from a service worker: the message below instead */
    }
    this.shell.notify(`${title}. Open the Lobby and join a room.`, 6000);
  }
}

/** The words for a phrase id (the server sends them too; this is for the sheet's buttons). */
export function phraseText(id: string): string {
  return quickChat(id)?.text ?? id;
}

const controllers = new WeakMap<object, FeedController>();

/** The one FeedController for a shell (made on first use). */
export function feedOf(shell: FeedShell): FeedController {
  let c = controllers.get(shell);
  if (!c) controllers.set(shell, (c = new FeedController(shell)));
  return c;
}

/** A store's slice for React (see social.ts useSel). */
export function useFeedSel<U>(feed: FeedController, select: (s: FeedState) => U): U {
  const get = () => select(feed.store.getState());
  return useSyncExternalStore(feed.store.subscribe, get, get);
}
