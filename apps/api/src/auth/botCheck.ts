/**
 * The bot check (docs/10 §1 "bot farms", §6): Cloudflare Turnstile where a script would farm or
 * guess: saving an account and "Forgot password?" (auth/accountRoutes.ts), signing in once that email
 * or that address has had LOGIN_BOT_CHECK_AFTER wrong passwords (the first tries never need it), and
 * every problem report, the game's automatic ones included (reports/routes.ts). On only with
 * TURNSTILE_SECRET; off, nothing is asked, so dev and the tests need no widget.
 *
 * The web shows the widget when its build has VITE_TURNSTILE_SITEKEY and sends the token it gets
 * as `turnstileToken`; here it is checked once with Cloudflare's siteverify (a token is single use
 * and lives 5 minutes). The check fails closed: when Cloudflare can't be reached the answer is
 * 503 `bot_check_unavailable` (try again), never a free pass.
 */
import { ApiError } from '../http/errors';
import type { Logger } from '../log';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const VERIFY_TIMEOUT_MS = 5_000;

/** Which form the token came from: the widget's `action`, matched when Cloudflare reports one. */
export type BotCheckAction = 'save' | 'forgot' | 'login' | 'report';

/** Sign-in asks for the bot check once the email or the address has this many wrong passwords in its window (auth/throttle.ts). */
export const LOGIN_BOT_CHECK_AFTER = 3;

/** Throws an ApiError unless `token` passes; `ip` is the client's (sent as remoteip when known). */
export type BotCheck = (token: string | undefined, ip: string, action: BotCheckAction) => Promise<void>;

interface SiteverifyAnswer {
  success?: boolean;
  action?: string;
  'error-codes'?: string[];
}

/** Errors that are ours (the secret), not the player's: they say "unavailable", and log loudly. */
const OUR_FAULT = new Set(['missing-input-secret', 'invalid-input-secret']);

export function turnstileCheck(secret: string, log: Logger, fetchImpl: typeof fetch = fetch, url = SITEVERIFY_URL): BotCheck {
  const unavailable = () => new ApiError(503, 'bot_check_unavailable', "Couldn't check you're not a bot just now. Try again in a moment.");
  return async (token, ip, action) => {
    if (!token) throw new ApiError(400, 'bot_check_required', "Finish the check that you're not a bot, then try again");
    const form = new URLSearchParams({ secret, response: token });
    if (ip && ip !== 'unknown') form.set('remoteip', ip);
    let answer: SiteverifyAnswer;
    try {
      const res = await fetchImpl(url, { method: 'POST', body: form, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`siteverify answered ${res.status}`);
      answer = (await res.json()) as SiteverifyAnswer;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'bot check unreachable');
      throw unavailable();
    }
    const codes = answer['error-codes'] ?? [];
    if (codes.some((c) => OUR_FAULT.has(c))) {
      log.error({ codes }, 'bot check refused our secret (TURNSTILE_SECRET)');
      throw unavailable();
    }
    if (answer.success !== true || (answer.action && answer.action !== action)) {
      throw new ApiError(403, 'bot_check_failed', "The check that you're not a bot didn't pass. Try it again.", { codes });
    }
  };
}

/** The bot check the config asks for: null = off (TURNSTILE_SECRET unset). */
export function botCheckFor(config: { turnstileSecret: string | null }, log: Logger): BotCheck | null {
  return config.turnstileSecret ? turnstileCheck(config.turnstileSecret, log) : null;
}
