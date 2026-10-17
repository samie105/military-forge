/**
 * The refresh-token cookie: httpOnly (scripts can't read it), scoped to /auth (only sent to the
 * routes that need it), SameSite=Lax by default (docs/10 §6). Portal iframes that block
 * third-party cookies use the copy returned in the JSON body instead (docs/07 §3).
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Config } from '../config';

export const REFRESH_COOKIE = 'refresh_token';
const PATH = '/auth';

export function setRefreshCookie(c: Context, cookie: Config['cookie'], token: string, expires: Date): void {
  setCookie(c, REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: PATH,
    expires,
    ...(cookie.domain ? { domain: cookie.domain } : {}),
  });
}

/** Same attributes as the set: a clear without SameSite=None is dropped on cross-site (iframe) responses. */
export function clearRefreshCookie(c: Context, cookie: Config['cookie']): void {
  deleteCookie(c, REFRESH_COOKIE, {
    httpOnly: true,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
    path: PATH,
    ...(cookie.domain ? { domain: cookie.domain } : {}),
  });
}

export function readRefreshCookie(c: Context): string | undefined {
  return getCookie(c, REFRESH_COOKIE);
}
