/**
 * The friends side of the app (the owner's 23 Oct ask): one SocialController per shell, holding the
 * friends list (with each friend's presence), the panel's state and every friend action. Actions
 * apply at once and roll back if the API says no (the owner's "optimistic updates with rollback").
 *
 * The list is fetched when something shows it: the Home squad card asks for a look every 60 s and
 * the open panel every 30 s, both only while the page is visible. The push channel (events.ts)
 * carries the rest the moment it happens: invites, requests, a friend's status, the party; while
 * it's open the list's own refresh slows to every 2 minutes.
 *
 * Invites (PR 2): invite a friend to your room (the panel, the lobby, the pause menu's picker), and
 * answer theirs from the toast (menus and mid-match) or the panel. An invite lasts 2 minutes; its
 * countdown runs on this device's clock, set from the server's at load (a phone's clock may be off).
 *
 * Finding players (31 Oct, "add a search friend feature, let's make it a bit social"): the panel's
 * field searches names as you type (from 2 letters, 300 ms after the last key, answers kept a minute),
 * and Played with recently lists the people from your last matches. A request that arrives while you
 * are elsewhere shows a toast (audit C-26).
 */
import { useSyncExternalStore } from 'react';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { ApiError, type Api } from '../shell/api';
import { OFFLINE_TITLE } from '../shell/offline';
import type { Intent, ShellStore } from '../shell/store';
import { FriendsApi, asFriendCode, type FoundPlayer, type Friend, type FriendsList, type Invite, type Party, type Person, type Relation } from './api';
import { EventStream } from './events';

export type FriendsTab = 'friends' | 'requests' | 'blocked';

export interface AddOutcome {
  tone: 'ok' | 'warn';
  message: string;
  /** a request sent: to whom (the line follows them when they accept, audit C-27) */
  to?: { id: string; nickname: string };
}

/**
 * The name search: `short` under 2 letters, `busy` while asking, `done` with the players, `failed`
 * with why (Can't reach the server, too many searches).
 */
export interface SearchState {
  query: string;
  status: 'idle' | 'short' | 'busy' | 'done' | 'failed';
  players: readonly FoundPlayer[];
  error: string | null;
}

export interface SocialState {
  /** the friends list as last loaded; null before the first load */
  list: FriendsList | null;
  loading: boolean;
  /** the last load failed: the panel keeps the old list and says so */
  error: string | null;
  panel: { open: boolean; tab: FriendsTab };
  /** Add a friend: a request on its way, and what came back */
  adding: boolean;
  added: AddOutcome | null;
  /** player ids with an action on its way (their buttons wait) */
  busy: Readonly<Record<string, true>>;
  /** invites to you, waiting for an answer, newest first */
  invites: readonly ClientInvite[];
  /** your invites from the last 2 minutes, by friend id: Sent (with its time), Declined, Joined */
  sent: Readonly<Record<string, ClientInvite>>;
  /** invites that came in since you last looked (they count in the Friends badge) */
  unseen: number;
  /** invites whose toast was put away (they stay in the panel) */
  hidden: Readonly<Record<string, true>>;
  party: Party | null;
  /** the push channel is open */
  live: boolean;
  /** the invite picker (lobby, pause menu) */
  picker: boolean;
  search: SearchState;
  /** Played with recently (the panel loads it when it opens); null before the first load */
  recent: readonly FoundPlayer[] | null;
  /** friend requests that arrived while you were elsewhere, for the toast (audit C-26), oldest first */
  requestToasts: readonly Person[];
}

/** An invite with when it runs out on this device's clock (ms since the epoch). */
export interface ClientInvite extends Invite {
  deadline: number;
}

export type SocialStore = StoreApi<SocialState>;

/** What the controller needs from the shell (a ShellController fits; tests pass a fake). */
export interface SocialShell {
  readonly api: Pick<Api, 'authed' | 'onSignIn'> & Partial<Pick<Api, 'stream'>>;
  readonly store: ShellStore;
  /** the running game: an invite accepted mid-match leaves this room for good first */
  readonly host?: { readonly online: { leave(): void } | null };
  go(intent: Intent): void;
  notify(message: string): void;
  /** the room link for people who aren't friends yet (the picker) */
  copyLink?(code: string, quiet?: boolean): Promise<boolean>;
  shareLink?(code: string): Promise<void>;
  shareOnWhatsApp?(code: string): void;
}

export const PANEL_POLL_MS = 30_000;
export const HOME_POLL_MS = 60_000;
/** the name search waits this long after the last key */
export const SEARCH_DEBOUNCE_MS = 300;
/** an answer is reused this long (backspacing, typing the same name again) */
const SEARCH_CACHE_MS = 60_000;
/** a request this new, found on the first load of the list, still gets its toast */
const REQUEST_TOAST_FRESH_MS = 2 * 60_000;
/** an invite's life (apps/api INVITE_TTL_MS) */
export const INVITE_SECONDS = 120;
/** the list's refresh while the push channel is open (it only catches friends going quiet) */
export const LIVE_POLL_MS = 120_000;

/** In words, for the API's friend error codes. */
export function friendErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return 'Something went wrong: try again';
  switch (e.code) {
    case 'player_not_found':
      return 'No player has that name or friend code';
    case 'cannot_add_self':
      return "That's you";
    case 'blocked_by_you':
      return 'You blocked this player: unblock them first (Blocked tab)';
    case 'too_many_requests':
    case 'friends_full':
      return e.message;
    case 'rate_limited': {
      const wait = Number(e.extra.retryAfter);
      return wait > 0 && wait <= 90 ? `Too many tries: wait ${Math.ceil(wait)} s` : 'Too many tries: wait a few minutes';
    }
    case 'no_request':
      return 'That request is gone';
    case 'invite_not_found':
      return 'That invite has run out';
    case 'room_not_found':
      return e.message;
    case 'already_in_room':
      return "They're in your room already";
    case 'not_friends':
      return 'You can invite friends only: send them the room link';
    default:
      return e.offline ? `${OFFLINE_TITLE}. Try again in a moment` : e.message;
  }
}

/** The friends who are on (in a match first), for the Home strip. */
export function onlineFriends(list: FriendsList | null): Friend[] {
  return list?.friends.filter((f) => f.status !== 'offline') ?? [];
}

/** "2 h ago", "3 min ago", "just now": when a friend was last around. */
export function agoText(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
}

/** Seconds left on an invite (0 when it's run out). */
export function secondsLeft(inv: Pick<ClientInvite, 'deadline'>, now = Date.now()): number {
  return Math.max(0, Math.ceil((inv.deadline - now) / 1000));
}

/** 1:24 */
export function clockText(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Letters a search counts (separators and spaces don't): 2 are needed. */
export function searchLetters(text: string): number {
  return [...text.replace(/[\s_.-]+/gu, '')].length;
}

/**
 * A friend's status line: "In a match · room KMTXRA", "In the lobby · room KMTXRA" (a room whose match
 * hasn't started: audit C-27), "Online · in the menus", "Last seen 2 h ago".
 */
export function statusText(f: Friend, now = Date.now()): string {
  if (f.status === 'in_room') {
    const where = f.playing === true ? 'In a match' : f.playing === false ? 'In the lobby' : 'In a room';
    return f.room ? `${where} · room ${f.room}` : where;
  }
  if (f.status === 'online') return 'Online · in the menus';
  const ago = agoText(f.lastSeenAt, now);
  return ago ? `Last seen ${ago}` : 'Offline';
}

export class SocialController {
  readonly store: SocialStore;
  readonly friends: FriendsApi;
  private readonly watchers = new Map<number, number>();
  private watchSeq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private push: EventStream | null = null;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private searchSeq = 0;
  private readonly searchCache = new Map<string, { at: number; players: FoundPlayer[] }>();
  /** requests that had their toast (or were here before we looked): never toasted again */
  private readonly toasted = new Set<string>();

  constructor(
    readonly shell: SocialShell,
    private readonly doc: Pick<Document, 'visibilityState' | 'addEventListener'> | null = typeof document === 'undefined' ? null : document,
  ) {
    this.friends = new FriendsApi(shell.api);
    this.store = createStore<SocialState>(() => ({
      list: null,
      loading: false,
      error: null,
      panel: { open: false, tab: 'friends' },
      adding: false,
      added: null,
      busy: {},
      invites: [],
      sent: {},
      unseen: 0,
      hidden: {},
      party: null,
      live: false,
      picker: false,
      search: EMPTY_SEARCH,
      recent: null,
      requestToasts: [],
    }));
    // a different player signed in (a new guest): nothing of the last one's stays
    shell.api.onSignIn(() => {
      this.searchCache.clear();
      this.toasted.clear();
      this.store.setState({ list: null, error: null, added: null, busy: {}, invites: [], sent: {}, unseen: 0, hidden: {}, party: null, search: EMPTY_SEARCH, recent: null, requestToasts: [] });
      if (this.watchers.size) void this.refresh();
      if (this.push) {
        this.push.stop();
        this.push.start();
      }
    });
    this.doc?.addEventListener('visibilitychange', () => {
      if (this.doc?.visibilityState === 'visible' && this.watchers.size) void this.refresh();
    });
  }

  // ---- the push channel ----

  /** Opens the push channel (SocialLayer does, while a signed-in online player is here). */
  connect(): void {
    if (!this.available || !this.shell.api.stream) return;
    if (!this.push) {
      const api = this.shell.api as Pick<Api, 'stream'>;
      this.push = new EventStream(
        api,
        (type, data) => this.onEvent(type, data),
        (live) => {
          this.set({ live });
          this.schedule();
          // what happened while it was closed
          if (live) void this.catchUp();
        },
      );
    }
    this.push.start();
    this.startSweeper();
  }

  disconnect(): void {
    this.push?.stop();
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  private async catchUp(): Promise<void> {
    await Promise.all([this.loadInvites(), this.loadParty(), this.store.getState().list || this.watchers.size ? this.refresh() : null]);
  }

  /** One event off the push channel (events/bus.ts on the API). */
  onEvent(type: string, data: unknown): void {
    const d = data as Record<string, unknown> | null;
    switch (type) {
      case 'friends':
        void this.refresh();
        // a request answered, a friend gone: the people met in matches may change too
        if (this.store.getState().panel.open) void this.loadRecent();
        return;
      case 'presence': {
        const list = this.store.getState().list;
        if (!list || !d) return;
        const id = d.id as string;
        if (!list.friends.some((f) => f.id === id)) return;
        const status = d.status as Friend['status'];
        const changed = (f: Friend): Friend => {
          const { playing: _was, ...rest } = f;
          return { ...rest, status, room: (d.room as string | null) ?? null, lastSeenAt: new Date().toISOString(), ...(typeof d.playing === 'boolean' ? { playing: d.playing } : {}) };
        };
        const friends = list.friends.map((f) => (f.id === id ? changed(f) : f));
        const order = { in_room: 0, online: 1, offline: 2 } as const;
        friends.sort((a, b) => order[a.status] - order[b.status] || a.nickname.localeCompare(b.nickname));
        this.set({ list: { ...list, friends } });
        return;
      }
      case 'invite': {
        const inv = d?.invite as Invite | undefined;
        if (!inv) return;
        const local: ClientInvite = { ...inv, deadline: Date.now() + Math.max(0, Date.parse(inv.expiresAt) - Date.parse(inv.at)) };
        const st = this.store.getState();
        const known = st.invites.some((i) => i.id === inv.id);
        const { [inv.id]: _shown, ...hidden } = st.hidden;
        this.set({ invites: [local, ...st.invites.filter((i) => i.id !== inv.id)], unseen: known ? st.unseen : st.unseen + 1, hidden });
        this.startSweeper();
        return;
      }
      case 'invite_gone':
        this.dropInvite(d?.id as string);
        return;
      case 'invite_answered': {
        const to = d?.to as string;
        const sent = this.store.getState().sent;
        const was = sent[to];
        if (was && was.id === d?.id) this.set({ sent: { ...sent, [to]: { ...was, answer: d?.answer as 'accepted' | 'declined' } } });
        return;
      }
      case 'party':
        void this.loadParty();
        return;
    }
  }

  private dropInvite(id: string): void {
    const st = this.store.getState();
    if (!st.invites.some((i) => i.id === id)) return;
    this.set({ invites: st.invites.filter((i) => i.id !== id), unseen: Math.max(0, st.unseen - (st.hidden[id] ? 0 : 1)) });
  }

  /** Drops invites that ran out (once a second while any wait). */
  private startSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const st = this.store.getState();
      const now = Date.now();
      const invites = st.invites.filter((i) => i.deadline > now);
      const sent = Object.fromEntries(Object.entries(st.sent).filter(([, i]) => i.deadline > now));
      if (invites.length !== st.invites.length || Object.keys(sent).length !== Object.keys(st.sent).length) {
        this.set({ invites, sent, unseen: Math.min(st.unseen, invites.length) });
      }
      if (!invites.length && !Object.keys(sent).length && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, 1000);
  }

  /** Invites waiting for you and the ones you sent (on start, and when the push channel reopens). */
  async loadInvites(): Promise<void> {
    if (!this.available) return;
    try {
      const { incoming, sent, now } = await this.friends.invites();
      const skew = (now ? Date.parse(now) : Date.now()) - Date.now();
      const local = (i: Invite): ClientInvite => ({ ...i, deadline: Date.parse(i.expiresAt) - skew });
      const st = this.store.getState();
      const fresh = incoming.filter((i) => !st.invites.some((x) => x.id === i.id)).length;
      const bySent: Record<string, ClientInvite> = {};
      for (const i of [...sent].reverse()) bySent[i.to.id] = local(i);
      this.set({ invites: incoming.map(local), sent: bySent, unseen: Math.min(incoming.length, st.unseen + fresh) });
      if (incoming.length || sent.length) this.startSweeper();
    } catch {
      /* the toast just waits for the next look */
    }
  }

  async loadParty(): Promise<void> {
    if (!this.available) return;
    try {
      this.set({ party: (await this.friends.party()).party });
    } catch {
      /* keep what we had */
    }
  }

  private set(partial: Partial<SocialState>): void {
    this.store.setState(partial);
  }

  /** Friends need a signed-in, online player (no friends in offline training). */
  get available(): boolean {
    const p = this.shell.store.getState().profile;
    return !!p && !p.offline;
  }

  /** Loads the list now (one load at a time; a second call shares it). */
  refresh(): Promise<void> {
    if (!this.available) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.set({ loading: true });
    this.inFlight = this.friends
      .list()
      .then(
        (list) => {
          this.noteRequests(this.store.getState().list, list);
          this.set({ list, error: null });
        },
        (e: unknown) => this.set({ error: friendErrorText(e) }),
      )
      .finally(() => {
        this.inFlight = null;
        this.set({ loading: false });
      });
    return this.inFlight;
  }

  /**
   * Keep the list fresh while something shows it: a load now, then every `everyMs` (the shortest
   * of everyone watching) while the page is visible. Returns the stop.
   */
  watch(everyMs: number): () => void {
    const id = ++this.watchSeq;
    this.watchers.set(id, everyMs);
    if (!this.store.getState().list) void this.refresh();
    this.schedule();
    return () => {
      this.watchers.delete(id);
      this.schedule();
    };
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.watchers.size) return;
    const asked = Math.min(...this.watchers.values());
    const every = this.store.getState().live ? Math.max(asked, LIVE_POLL_MS) : asked;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.doc?.visibilityState !== 'hidden') void this.refresh();
      this.schedule();
    }, every);
  }

  /**
   * New requests to you get a toast (audit C-26): the ones that weren't in the last list. On the first
   * load there's no last list, so only requests from the last 2 minutes count as new. Never while the
   * panel is open (it shows them), never twice for one request.
   */
  private noteRequests(before: FriendsList | null, after: FriendsList): void {
    const known = before ? new Set(before.incoming.map((p) => p.id)) : null;
    const now = Date.now();
    const st = this.store.getState();
    const fresh = after.incoming.filter((p) => !this.toasted.has(p.id) && (known ? !known.has(p.id) : now - Date.parse(p.at) < REQUEST_TOAST_FRESH_MS));
    for (const p of after.incoming) this.toasted.add(p.id);
    const waiting = new Set(after.incoming.map((p) => p.id));
    // answered elsewhere (another tab, the panel): its toast goes
    const toasts = st.requestToasts.filter((p) => waiting.has(p.id));
    this.set({ requestToasts: st.panel.open ? [] : [...toasts, ...fresh] });
  }

  /** Put a request's toast away (the request stays in Friends). */
  hideRequestToast(id: string): void {
    this.set({ requestToasts: this.store.getState().requestToasts.filter((p) => p.id !== id) });
  }

  // ---- the panel ----

  openPanel(tab?: FriendsTab): void {
    const panel = this.store.getState().panel;
    // what's waiting is seen once the panel shows it (request toasts too)
    this.set({ panel: { open: true, tab: tab ?? panel.tab }, added: null, unseen: 0, requestToasts: [] });
    void this.loadRecent();
  }

  closePanel(): void {
    this.clearSearch();
    this.set({ panel: { ...this.store.getState().panel, open: false } });
  }

  // ---- finding players ----

  /**
   * The search field changed: under 2 letters it just says so; otherwise it asks the API 300 ms after
   * the last key (an answer from the last minute is shown at once). Only the latest answer lands.
   */
  setQuery(text: string): void {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    const seq = ++this.searchSeq;
    const query = text.trim();
    if (!query) {
      this.set({ search: EMPTY_SEARCH });
      return;
    }
    const before = this.store.getState().search;
    if (searchLetters(query) < 2) {
      this.set({ search: { query: text, status: 'short', players: [], error: null } });
      return;
    }
    const key = query.toLowerCase();
    const cached = this.searchCache.get(key);
    if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) {
      this.set({ search: { query: text, status: 'done', players: cached.players, error: null } });
      return;
    }
    // the last answer stays on screen while the next one comes (no flicker as you type)
    this.set({ search: { query: text, status: 'busy', players: before.status === 'done' || before.status === 'busy' ? before.players : [], error: null } });
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.friends.search(query).then(
        ({ players }) => {
          this.searchCache.set(key, { at: Date.now(), players });
          if (seq === this.searchSeq) this.set({ search: { query: text, status: 'done', players, error: null } });
        },
        (e: unknown) => {
          if (seq === this.searchSeq) this.set({ search: { query: text, status: 'failed', players: [], error: searchErrorText(e) } });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
  }

  clearSearch(): void {
    this.setQuery('');
  }

  /** Played with recently (the panel's Friends tab). Keeps the last list when the API can't be reached. */
  async loadRecent(): Promise<void> {
    if (!this.available) return;
    try {
      this.set({ recent: (await this.friends.recent()).players });
    } catch {
      /* the section just waits for the next look */
    }
  }

  /**
   * Where you stand with a player now: the friends list knows best (it follows accepts and cancels as
   * they happen), else what the search said.
   */
  relationOf(p: Pick<FoundPlayer, 'id' | 'relation'>): Relation {
    const list = this.store.getState().list;
    if (!list) return p.relation;
    if (list.friends.some((f) => f.id === p.id)) return 'friends';
    if (list.incoming.some((r) => r.id === p.id)) return 'incoming';
    if (list.outgoing.some((r) => r.id === p.id)) return 'sent';
    // the list was loaded after the search: a request it doesn't hold any more was answered or taken back
    return p.relation === 'friends' ? 'friends' : 'none';
  }

  /** Add a player found by name or met in a match: Request sent at once, back to Add if the API says no. */
  async addPlayer(p: Pick<FoundPlayer, 'id' | 'nickname' | 'look'>): Promise<boolean> {
    let became = 'requested' as 'requested' | 'friends';
    const ok = await this.act(
      p.id,
      (l) => (l.outgoing.some((r) => r.id === p.id) ? l : { ...l, outgoing: [{ id: p.id, nickname: p.nickname, at: new Date().toISOString(), look: p.look }, ...l.outgoing] }),
      async () => {
        became = (await this.friends.request({ name: p.nickname })).status;
      },
    );
    if (ok) this.shell.notify(became === 'friends' ? `You and ${p.nickname} are friends now` : `Request sent to ${p.nickname}`);
    return ok;
  }

  /** "Let players find me by name" (Settings → Privacy). */
  async setFindable(on: boolean): Promise<boolean> {
    const before = this.store.getState().list;
    if (before) this.set({ list: { ...before, findable: on } });
    try {
      const { findable } = await this.friends.setFindable(on);
      const list = this.store.getState().list;
      if (list) this.set({ list: { ...list, findable } });
      return true;
    } catch (e) {
      const list = this.store.getState().list;
      if (list) this.set({ list: { ...list, findable: before?.findable ?? !on } });
      this.shell.notify(friendErrorText(e));
      return false;
    }
  }

  setTab(tab: FriendsTab): void {
    this.set({ panel: { ...this.store.getState().panel, tab } });
  }

  // ---- actions ----

  /** Add a friend by exact name or friend code (a code-shaped name that isn't a code is tried as a name). */
  async add(text: string): Promise<AddOutcome | null> {
    const typed = text.trim();
    if (!typed || this.store.getState().adding) return null;
    this.set({ adding: true, added: null });
    let outcome: AddOutcome;
    try {
      const code = asFriendCode(typed);
      let result;
      try {
        result = await this.friends.request(code ? { code } : { name: typed });
      } catch (e) {
        if (!(code && e instanceof ApiError && e.code === 'player_not_found')) throw e;
        result = await this.friends.request({ name: typed });
      }
      outcome =
        result.status === 'friends'
          ? { tone: 'ok', message: `You and ${result.friend.nickname} are friends now` }
          : { tone: 'ok', message: `Request sent to ${result.user.nickname}. It waits until they answer.`, to: { id: result.user.id, nickname: result.user.nickname } };
      void this.refresh();
    } catch (e) {
      outcome = { tone: 'warn', message: friendErrorText(e) };
    }
    this.set({ adding: false, added: outcome });
    return outcome;
  }

  /**
   * One optimistic action: `change` the list at once, call the API, and put the list back (with a
   * notice) when it fails. The list is reloaded afterwards either way.
   */
  private async act(id: string, change: (list: FriendsList) => FriendsList, call: () => Promise<unknown>, failText?: string): Promise<boolean> {
    const before = this.store.getState().list;
    this.set({ busy: { ...this.store.getState().busy, [id]: true }, ...(before ? { list: change(before) } : {}) });
    let ok = true;
    try {
      await call();
    } catch (e) {
      ok = false;
      if (before) this.set({ list: before });
      this.shell.notify(failText ?? friendErrorText(e));
    }
    const { [id]: _done, ...busy } = this.store.getState().busy;
    this.set({ busy });
    void this.refresh();
    return ok;
  }

  accept(person: Person): Promise<boolean> {
    return this.act(
      person.id,
      (l) => ({
        ...l,
        incoming: l.incoming.filter((p) => p.id !== person.id),
        friends: [...l.friends, { id: person.id, nickname: person.nickname, status: 'offline', room: null, lastSeenAt: null, since: new Date().toISOString() }],
      }),
      () => this.friends.accept(person.id),
    );
  }

  decline(person: Person): Promise<boolean> {
    return this.act(person.id, (l) => ({ ...l, incoming: l.incoming.filter((p) => p.id !== person.id) }), () => this.friends.decline(person.id));
  }

  cancel(person: Person): Promise<boolean> {
    return this.act(person.id, (l) => ({ ...l, outgoing: l.outgoing.filter((p) => p.id !== person.id) }), () => this.friends.cancel(person.id));
  }

  remove(friend: Pick<Friend, 'id' | 'nickname'>): Promise<boolean> {
    return this.act(friend.id, (l) => ({ ...l, friends: l.friends.filter((f) => f.id !== friend.id) }), () => this.friends.remove(friend.id));
  }

  /** Block: they go from friends and requests, onto the Blocked tab. They aren't told. */
  block(who: { id: string; nickname: string }): Promise<boolean> {
    return this.act(
      who.id,
      (l) => ({
        ...l,
        friends: l.friends.filter((f) => f.id !== who.id),
        incoming: l.incoming.filter((p) => p.id !== who.id),
        outgoing: l.outgoing.filter((p) => p.id !== who.id),
        blocked: [...l.blocked.filter((p) => p.id !== who.id), { id: who.id, nickname: who.nickname, at: new Date().toISOString() }],
      }),
      () => this.friends.block(who.id),
    );
  }

  unblock(person: Person): Promise<boolean> {
    return this.act(person.id, (l) => ({ ...l, blocked: l.blocked.filter((p) => p.id !== person.id) }), () => this.friends.unblock(person.id));
  }

  /** Copies your friend code (a prompt to copy it by hand where the clipboard is refused). */
  async copyCode(): Promise<void> {
    const code = this.store.getState().list?.code;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.shell.notify('Friend code copied: send it to a friend');
    } catch {
      window.prompt('Your friend code:', code);
    }
  }

  /** A new friend code (the old one stops working: for a code that went too far). */
  async newCode(): Promise<void> {
    try {
      const { code } = await this.friends.newCode();
      const list = this.store.getState().list;
      if (list) this.set({ list: { ...list, code } });
      this.shell.notify('New friend code: the old one no longer works');
    } catch (e) {
      this.shell.notify(friendErrorText(e));
    }
  }

  /** Join a friend's room (their presence carries its code; the usual /r/CODE flow). */
  join(friend: Friend): void {
    if (!friend.room) return;
    this.goTo(friend.room);
  }

  /** The room by code, the usual way (/r/CODE): leaving the one we're in for good first. */
  private goTo(code: string): void {
    this.set({ panel: { ...this.store.getState().panel, open: false }, picker: false });
    const screen = this.shell.store.getState().screen;
    if (screen.name === 'room' && screen.code === code) return;
    if (screen.name === 'room') this.shell.host?.online?.leave();
    this.shell.go({ to: 'join', code });
  }

  // ---- invites ----

  /** The room you're in (by code), the one invites take friends to; null outside rooms (local rooms too). */
  myRoom(): string | null {
    const s = this.shell.store.getState().screen;
    return s.name === 'room' && !s.local && s.code ? s.code : null;
  }

  /** Invite a friend to your room. */
  async invite(friend: Pick<Friend, 'id' | 'nickname'>): Promise<boolean> {
    const room = this.myRoom();
    if (!room) return false;
    const st = this.store.getState();
    this.set({ busy: { ...st.busy, [friend.id]: true } });
    let ok = true;
    try {
      const { invite } = await this.friends.invite(friend.id, room);
      const local: ClientInvite = { ...invite, deadline: Date.now() + Math.max(0, Date.parse(invite.expiresAt) - Date.parse(invite.at)) };
      this.set({ sent: { ...this.store.getState().sent, [friend.id]: local } });
      this.startSweeper();
    } catch (e) {
      ok = false;
      this.shell.notify(friendErrorText(e));
    }
    const { [friend.id]: _done, ...busy } = this.store.getState().busy;
    this.set({ busy });
    return ok;
  }

  /** Join the room an invite is for (and the inviter's party). Mid-match this leaves the match. */
  async acceptInvite(inv: Invite): Promise<boolean> {
    this.dropInvite(inv.id);
    try {
      const { room } = await this.friends.acceptInvite(inv.id);
      this.goTo(room);
      return true;
    } catch (e) {
      this.shell.notify(friendErrorText(e));
      return false;
    }
  }

  async declineInvite(inv: Invite): Promise<void> {
    this.dropInvite(inv.id);
    try {
      await this.friends.declineInvite(inv.id);
    } catch {
      /* it runs out by itself */
    }
  }

  /** Put the toast away (the invite stays in the panel until it runs out). */
  hideInvite(inv: Invite): void {
    const st = this.store.getState();
    this.set({ hidden: { ...st.hidden, [inv.id]: true }, unseen: Math.max(0, st.unseen - 1) });
  }

  async leaveParty(): Promise<void> {
    const before = this.store.getState().party;
    this.set({ party: null });
    try {
      await this.friends.leaveParty();
    } catch (e) {
      this.set({ party: before });
      this.shell.notify(friendErrorText(e));
    }
  }

  // ---- the invite picker (lobby, pause menu) ----

  openPicker(): void {
    this.set({ picker: true });
    void this.refresh();
  }

  closePicker(): void {
    this.set({ picker: false });
  }
}

const EMPTY_SEARCH: SearchState = { query: '', status: 'idle', players: [], error: null };

/** In words, for a failed search. */
export function searchErrorText(e: unknown): string {
  if (e instanceof ApiError && e.code === 'rate_limited') {
    const wait = Number(e.extra.retryAfter);
    return wait > 0 && wait <= 90 ? `Too many searches in a row. Wait ${Math.ceil(wait)} s and try again.` : 'Too many searches in a row. Wait a few minutes and try again.';
  }
  if (!(e instanceof ApiError) || e.offline) return `${OFFLINE_TITLE}. Check your connection and try again.`;
  return friendErrorText(e);
}

/** The line under a request you sent, now: it follows them when they accept (audit C-27). */
export function addedText(added: AddOutcome, list: FriendsList | null): AddOutcome {
  if (added.to && list?.friends.some((f) => f.id === added.to!.id)) return { tone: 'ok', message: `${added.to.nickname} accepted: you're friends now` };
  return added;
}

/** The Friends badge: requests waiting for you, and invites you haven't seen. */
export function badgeCount(s: Pick<SocialState, 'list' | 'unseen'>): number {
  return (s.list?.incoming.length ?? 0) + s.unseen;
}

/**
 * A store's slice for React (the selector must return a value or an existing object, not a new
 * one). Unlike zustand's useStore, a server render (tests, renderToStaticMarkup) sees the current
 * state, not the initial one.
 */
export function useSel<T, U>(store: StoreApi<T>, select: (s: T) => U): U {
  const get = () => select(store.getState());
  return useSyncExternalStore(store.subscribe, get, get);
}

const controllers = new WeakMap<object, SocialController>();

/** The one SocialController for a shell controller (made on first use). */
export function socialOf(shell: SocialShell): SocialController {
  let c = controllers.get(shell);
  if (!c) controllers.set(shell, (c = new SocialController(shell)));
  return c;
}
