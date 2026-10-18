/**
 * The API as the shell uses it (apps/api, docs/07 §3 and §11): guest sessions, the live nickname
 * check, nickname changes and rooms by code. Same origin under `/api` (the playtest proxy, Vite's
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

export interface NicknameCheck {
  nickname: string;
  valid: boolean;
  available: boolean;
  reason?: string;
  suggestions?: string[];
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

export class Api {
  private access: { token: string; expiresAt: number } | null = null;
  /** in memory too, for browsers that refuse localStorage */
  private refreshFallback: string | null = null;
  me: Me | null = null;

  constructor(
    private readonly base = '/api',
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown, auth = false): Promise<T> {
    const headers: Record<string, string> = {};
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
    this.me = s.user;
    return s.user;
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

  checkNickname(nickname: string): Promise<NicknameCheck> {
    return this.request<NicknameCheck>('GET', `/nicknames/check?nickname=${encodeURIComponent(nickname)}`);
  }

  async changeNickname(nickname: string): Promise<Me> {
    this.me = await this.request<Me>('PATCH', '/me', { nickname }, true);
    return this.me;
  }

  createRoom(): Promise<RoomJoin> {
    return this.request<RoomJoin>('POST', '/rooms', {}, true);
  }

  joinRoom(code: string): Promise<RoomJoin> {
    return this.request<RoomJoin>('POST', `/rooms/${encodeURIComponent(code)}/join`, {}, true);
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
