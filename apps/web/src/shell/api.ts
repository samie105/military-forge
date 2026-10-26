/**
 * The API as the shell uses it (apps/api, docs/07 §3 and §11): guest sessions, the live nickname
 * check, nickname changes, rooms by code and the saved loadout (locker/accountSync.ts). Same origin under `/api` (the playtest proxy, Vite's
 * dev proxy), so no CORS and no third-party cookies.
 *
 * Session contract (W3): the access token lives in memory only; the refresh token in localStorage,
 * shared by every tab and read again right before each refresh (single use, rotated each time).
 * The refresh cookie is Path=/auth, which `/api/auth/...` never matches, so the body token is the
 * one that counts here.
 */

export interface Me {
  id: string;
  nickname: string;
  isGuest: boolean;
  createdAt: string;
  /** null = may change now */
  nicknameChangeableAt: string | null;
  level: number;
  xp: number;
}

interface SessionBody {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  user: Me;
}

/** `GET /auth/account`: whether this account is saved with an email (apps/api auth/accountRoutes.ts). */
export interface AccountInfo {
  email: string | null;
  saved: boolean;
  /** a guest that has something to lose (a chosen name, XP, matches, friends, a saved look) */
  hasProgress: boolean;
  /** "Forgot password?" works (the server can send email) */
  resetByEmail: boolean;
}

/**
 * The unsaved guest that was on this device when a saved account signed in (the API kept it, as it
 * had progress): its refresh token, kept aside for {@link PARKED_GUEST_DAYS} days so the player can
 * switch back to it. Nothing is ever merged into the saved account.
 */
export interface ParkedGuest {
  refreshToken: string;
  nickname: string;
  level: number;
  /** ms since the epoch */
  parkedAt: number;
}

export const PARKED_GUEST_DAYS = 30;
const PARKED_KEY = 'session.parkedGuest.v1';

export interface NicknameCheck {
  nickname: string;
  valid: boolean;
  available: boolean;
  reason?: string;
  suggestions?: string[];
}

/** A saved loadout (apps/api `/me/loadout/:slot`): the Locker look and the two guns, by id. */
export interface SavedLoadout {
  slot: number;
  look: { items: Record<string, string>; dyes: Record<string, string> };
  guns: [string, string];
  updatedAt: string;
}

export interface RoomJoin {
  code: string;
  roomId: string;
  /** null: this site's own /ws/<code> */
  gsUrl: string | null;
  ticket: string | null;
}

/** An `{ error: { code, message } }` answer, or a network failure (`code` 'network'). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  get offline(): boolean {
    return this.code === 'network' || this.status >= 500;
  }
}

const REFRESH_KEY = 'session.refreshToken.v1';
/** refresh a little before the access token runs out */
const EARLY_MS = 30_000;

function storedRefreshToken(): string | null {
  try {
    return localStorage.getItem(REFRESH_KEY);
  } catch {
    return null;
  }
}

function storeRefreshToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(REFRESH_KEY, token);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    /* private mode: the session lasts as long as the page */
  }
}

function readParked(now = Date.now()): ParkedGuest | null {
  try {
    const p = JSON.parse(localStorage.getItem(PARKED_KEY) ?? 'null') as ParkedGuest | null;
    if (!p || typeof p.refreshToken !== 'string' || typeof p.parkedAt !== 'number') return null;
    return now - p.parkedAt < PARKED_GUEST_DAYS * 86_400_000 ? p : null;
  } catch {
    return null;
  }
}

function writeParked(p: ParkedGuest | null): void {
  try {
    if (p) localStorage.setItem(PARKED_KEY, JSON.stringify(p));
    else localStorage.removeItem(PARKED_KEY);
  } catch {
    /* private mode: no switching back after a reload */
  }
}

export class Api {
  private access: { token: string; expiresAt: number } | null = null;
  /** in memory too, for browsers that refuse localStorage */
  private refreshFallback: string | null = null;
  me: Me | null = null;
  private readonly signInListeners = new Set<(me: Me) => void>();
  private readonly roomHooks: (() => Promise<void>)[] = [];

  constructor(
    private readonly base = '/api',
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, auth = false, extra: Record<string, string> = {}): Promise<T> {
    const headers: Record<string, string> = { ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) headers.authorization = `Bearer ${await this.accessToken()}`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    } catch (e) {
      throw new ApiError(0, 'network', `Can't reach the server (${(e as Error).message})`);
    }
    if (res.status === 204) return undefined as T;
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      /* not JSON (a proxy error page) */
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string } } | null)?.error;
      const { code, message, ...extra } = (err ?? {}) as { code?: string; message?: string } & Record<string, unknown>;
      throw new ApiError(res.status, code ?? (res.status >= 500 ? 'server_error' : 'http_error'), message ?? `HTTP ${res.status}`, extra);
    }
    return json as T;
  }

  private adopt(s: SessionBody): Me {
    this.access = { token: s.accessToken, expiresAt: Date.parse(s.accessTokenExpiresAt) };
    this.refreshFallback = s.refreshToken;
    storeRefreshToken(s.refreshToken);
    const changed = this.me?.id !== s.user.id;
    this.me = s.user;
    if (changed) for (const listener of this.signInListeners) listener(s.user);
    return s.user;
  }

  /** Called whenever a different player is signed in (a restored session, a new guest); returns an unsubscribe. */
  onSignIn(listener: (me: Me) => void): () => void {
    this.signInListeners.add(listener);
    return () => this.signInListeners.delete(listener);
  }

  /** A live access token: refreshes with the stored refresh token when needed. */
  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - EARLY_MS > Date.now()) return this.access.token;
    if (!(await this.refresh())) throw new ApiError(401, 'no_session', 'Not signed in');
    return this.access!.token;
  }

  /** Refresh-token rotation; false when there is no usable refresh token (sign in again). */
  private async refresh(): Promise<boolean> {
    const token = storedRefreshToken() ?? this.refreshFallback;
    if (!token) return false;
    try {
      this.adopt(await this.request<SessionBody>('POST', '/auth/refresh', { refreshToken: token }));
      return true;
    } catch (e) {
      if (e instanceof ApiError && !e.offline) {
        storeRefreshToken(null);
        this.refreshFallback = null;
        return false;
      }
      throw e;
    }
  }

  /** The saved session's player, or null when there is none (first visit, expired, revoked). */
  async restore(): Promise<Me | null> {
    return (await this.refresh()) ? this.me : null;
  }

  /** A new guest account (docs/07 §3), named `nickname` or a generated name. */
  async guest(nickname?: string): Promise<Me> {
    return this.adopt(await this.request<SessionBody>('POST', '/auth/guest', nickname === undefined ? {} : { nickname }));
  }

  // ---- saved accounts: email + password (apps/api auth/accountRoutes.ts)

  /** Whether the signed-in account is saved, and with which email. */
  account(): Promise<AccountInfo> {
    return this.request<AccountInfo>('GET', '/auth/account', undefined, true);
  }

  /** What the server offers before anyone signs in ("Forgot password?"). False when it can't be asked. */
  async resetByEmail(): Promise<boolean> {
    try {
      return (await this.request<{ resetByEmail: boolean }>('GET', '/auth/options')).resetByEmail;
    } catch {
      return false;
    }
  }

  /**
   * Adds an email and password to this account ("Save your account"). 'saved' at once, or
   * 'check_email' when the server confirms the email by a link first.
   */
  async saveAccount(email: string, password: string): Promise<'saved' | 'check_email'> {
    const r = await this.request<{ status: 'saved' | 'check_email'; user?: Me }>('POST', '/auth/save', { email, password }, true);
    if (r.user) this.me = r.user;
    return r.status;
  }

  /** The emailed "Save my account" link (any device, no session needed). */
  async confirmSave(token: string): Promise<void> {
    await this.request<unknown>('POST', '/auth/confirm', { token });
    if (this.me) this.me = { ...this.me, isGuest: false };
  }

  /**
   * Signs this device in to a saved account. The device's current session goes with the request,
   * so the server can tell what to do with it: a guest with nothing to lose is discarded; a guest
   * with progress is kept and parked here ({@link parkedGuest}); another saved account is signed out.
   */
  async signIn(email: string, password: string): Promise<{ me: Me; previousGuest: 'kept' | 'discarded' | null }> {
    const before = this.me;
    const beforeToken = storedRefreshToken() ?? this.refreshFallback;
    let extra: Record<string, string> = {};
    if (before) {
      try {
        extra = { authorization: `Bearer ${await this.accessToken()}` };
      } catch {
        /* that session is over: sign in without it */
      }
    }
    const s = await this.request<SessionBody & { previousGuest: 'kept' | 'discarded' | null }>('POST', '/auth/login', { email, password }, false, extra);
    if (s.previousGuest === 'kept' && before && beforeToken) writeParked({ refreshToken: beforeToken, nickname: before.nickname, level: before.level, parkedAt: Date.now() });
    return { me: this.adopt(s), previousGuest: s.previousGuest };
  }

  /** The unsaved guest kept on this device by a sign-in, while it can still be switched back to. */
  parkedGuest(): ParkedGuest | null {
    return readParked();
  }

  /**
   * Signs this device out (`everywhere`: every device, every session of the account). Then the
   * parked guest, if there is one, comes back; returns who is signed in after (null: nobody).
   */
  async signOut(everywhere = false): Promise<Me | null> {
    if (everywhere) await this.request<unknown>('POST', '/auth/logout-all', {}, true);
    else {
      const token = storedRefreshToken() ?? this.refreshFallback;
      if (token) await this.request<unknown>('POST', '/auth/logout', { refreshToken: token });
    }
    this.access = null;
    this.me = null;
    this.refreshFallback = null;
    storeRefreshToken(null);
    const parked = readParked();
    writeParked(null);
    if (!parked) return null;
    this.refreshFallback = parked.refreshToken;
    storeRefreshToken(parked.refreshToken);
    try {
      return (await this.refresh()) ? this.me : null;
    } catch {
      return null;
    }
  }

  /** A new password; this device carries on with a new session, every other one is signed out. */
  async changePassword(currentPassword: string, newPassword: string): Promise<Me> {
    return this.adopt(await this.request<SessionBody>('POST', '/auth/password', { currentPassword, newPassword }, true));
  }

  /** "Forgot password?": the server emails a link if the email has an account (it answers the same either way). */
  async forgotPassword(email: string): Promise<void> {
    await this.request<unknown>('POST', '/auth/forgot', { email });
  }

  /** The emailed reset link: a new password, and every session of the account ends. */
  async resetPassword(token: string, password: string): Promise<void> {
    await this.request<unknown>('POST', '/auth/reset', { token, password });
  }

  checkNickname(nickname: string): Promise<NicknameCheck> {
    return this.request<NicknameCheck>('GET', `/nicknames/check?nickname=${encodeURIComponent(nickname)}`);
  }

  async changeNickname(nickname: string): Promise<Me> {
    this.me = await this.request<Me>('PATCH', '/me', { nickname }, true);
    return this.me;
  }

  /**
   * Runs `hook` before each room create or join, for at most 2 s (a slow one never holds a join up):
   * the saved loadout sends a just-made change, so the join ticket carries the guns just chosen.
   */
  beforeRoom(hook: () => Promise<void>): void {
    this.roomHooks.push(hook);
  }

  private async roomHooksDone(): Promise<void> {
    if (!this.roomHooks.length) return;
    await Promise.race([Promise.all(this.roomHooks.map((h) => h().catch(() => {}))), new Promise((r) => setTimeout(r, 2000))]);
  }

  async createRoom(): Promise<RoomJoin> {
    await this.roomHooksDone();
    return this.request<RoomJoin>('POST', '/rooms', {}, true);
  }

  /** Whose room a code is (the invite link's name screen; no session needed). Null when unknown or unreachable. */
  async peekRoom(code: string): Promise<{ code: string; host: string | null } | null> {
    try {
      return await this.request<{ code: string; host: string | null }>('GET', `/rooms/${encodeURIComponent(code)}`);
    } catch {
      return null;
    }
  }

  async joinRoom(code: string): Promise<RoomJoin> {
    await this.roomHooksDone();
    return this.request<RoomJoin>('POST', `/rooms/${encodeURIComponent(code)}/join`, {}, true);
  }

  /** The account's saved loadout in `slot`, or null when nothing is saved there yet. */
  async getLoadout(slot: number): Promise<SavedLoadout | null> {
    try {
      return await this.request<SavedLoadout>('GET', `/me/loadout/${slot}`, undefined, true);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_loadout') return null;
      throw e;
    }
  }

  putLoadout(slot: number, loadout: Pick<SavedLoadout, 'look' | 'guns'>): Promise<SavedLoadout> {
    return this.request<SavedLoadout>('PUT', `/me/loadout/${slot}`, { look: loadout.look, guns: loadout.guns }, true);
  }

  /** "I'm here" (presence, every 30 s while the page is visible): in `room` when in one. */
  async beatPresence(room: string | null): Promise<void> {
    await this.request<unknown>('PUT', '/me/presence', { room }, true);
  }

  /** Offline now (the page is going away). */
  async clearPresence(): Promise<void> {
    await this.request<unknown>('DELETE', '/me/presence', undefined, true);
  }

  /**
   * A signed-in call for the modules beside the shell (social/: friends, invites): the same base,
   * session refresh and `{ error }` contract as everything here.
   */
  authed<T>(method: string, path: string, body?: unknown): Promise<T> {
    return this.request<T>(method, path, body, true);
  }

  /**
   * A signed-in long response (the social push channel, GET /events: Server-Sent Events read with
   * fetch, so the token travels in a header, never in a URL). The caller reads and closes the body.
   */
  async stream(path: string, signal: AbortSignal): Promise<Response> {
    const token = await this.accessToken();
    return this.fetchImpl(`${this.base}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' }, signal, credentials: 'same-origin', cache: 'no-store' });
  }

  /** The server's round trip (GET /version: no database work), ms: the ping the menus show before a game connects. */
  async ping(): Promise<number> {
    const t0 = performance.now();
    await this.request<unknown>('GET', '/version');
    return performance.now() - t0;
  }
}

/** Human words for the API's nickname `reason` codes (docs/07 §3, W3 notes). */
export const NICKNAME_REASONS: Record<string, string> = {
  too_short: 'At least 3 characters',
  too_long: 'At most 16 characters',
  invalid_characters: 'Letters, digits, spaces and _ - . only',
  mixed_scripts: 'Stick to one alphabet',
  no_letters: 'Needs at least one letter',
  profanity: "Let's keep it friendly",
  reserved: 'That name is reserved',
  taken: 'Someone already has that name',
};
