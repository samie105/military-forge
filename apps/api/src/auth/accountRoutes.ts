/**
 * Saved accounts: email + password (auth/accounts.ts), under /auth.
 *
 * ```
 * GET  /auth/options     → {resetByEmail}                        no session needed (the sign-in form)
 * GET  /auth/account     → {email, saved, hasProgress, resetByEmail}
 * POST /auth/save        {email, password, birthYear, adult: true, turnstileToken?}
 *                        → 200 {status:'saved', user} | 202 {status:'check_email'}
 * POST /auth/confirm     {token} → {status:'saved'}               the emailed "Save my account" link
 * POST /auth/login       {email, password, turnstileToken?} → Session + previousGuest
 * POST /auth/password    {currentPassword, newPassword} → Session (this device, new session)
 * POST /auth/forgot      {email, turnstileToken?} → 202 {status:'check_email'}   only with EMAIL_PROVIDER
 * POST /auth/reset       {token, password} → 204
 * ```
 * Sign out and "sign out everywhere" are the existing /auth/logout and /auth/logout-all.
 *
 * **Security rules** (the tests in test/accounts.test.ts check each one):
 * - Passwords: Argon2id, 10–128 characters, not common or repetitive, never logged or returned.
 * - Sign-in answers one thing for a wrong password and an unknown email (`invalid_credentials`),
 *   after the same Argon2id work (a dummy hash). Guessing backs off per account and per IP
 *   (auth/throttle.ts), and is counted the same for unknown emails.
 * - "Forgot password?" answers 202 whether or not the email has an account, and does its work
 *   after answering. With email on, "Save" does the same: it always says "check your email"; the
 *   owner of an email that already has an account gets a note instead of a link.
 *   With email off, a save must link at once, so a taken email gets `email_unavailable` (rate
 *   limited: 5 an hour per player, 20 per IP); that is the one place an email's use shows.
 * - Sessions: a sign-in always makes a new session (never reuses the device's old one); a
 *   password change ends every session and gives this device a new one; a reset ends them all.
 * - Emailed links: single use, sha256 at rest, 30 minutes (reset) or 24 hours (save).
 * - 18+ only (shared/age.ts): a save needs the device's answer to the age step, sent with it (the
 *   web asks it once, at the age gate or in the save form, never again): the birth year and
 *   `adult: true` (for the year they turn 18, their word that they've had that birthday). A year
 *   that makes them a minor is refused (403 `underage`). The account keeps when they answered and
 *   the year, never a full date of birth.
 * - Bot check (auth/botCheck.ts): with TURNSTILE_SECRET set, a save and "Forgot password?" need a
 *   Turnstile token that passes, and so does a sign-in once that email or that address has had
 *   LOGIN_BOT_CHECK_AFTER (3) wrong passwords in the throttle's window (400 `bot_check_required`
 *   before the password is checked; the first tries never need it). Off without the secret. It runs
 *   after the cheap checks, so a typo doesn't burn the token.
 * - CSRF: the app's origin guard refuses state changes from other sites (app.ts); the refresh
 *   cookie is httpOnly, Secure in production, SameSite=Lax.
 *
 * **Signing in on a device that has a guest** (the device's access token comes with the request):
 * - the guest has no progress (accounts.ts) → it is discarded: nothing is lost;
 * - the guest has progress → it is kept, untouched, and its session stays good. The client keeps
 *   its refresh token aside for 30 days ("Switch back"), after which the idle-guest cleanup
 *   (docs/13 #341) may remove it. Nothing is ever merged into the saved account.
 * - the device was signed in to another saved account → that session ends.
 * `previousGuest` in the answer says which: 'kept' | 'discarded' | null.
 */
import { birthYearAnswer } from '@military-forge/shared';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Config } from '../config';
import { isUniqueViolation, type Db } from '../db/client';
import { users } from '../db/schema';
import { clientIp, clientRateLimitKey } from '../http/clientIp';
import type { AppEnv } from '../http/context';
import { ApiError, errorResponse, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import type { ProfileService } from '../me/profiles';
import { RESET_TTL_MS, SAVE_TTL_MS, type AccountService } from './accounts';
import type { Audit } from './audit';
import { LOGIN_BOT_CHECK_AFTER, type BotCheck, type BotCheckAction } from './botCheck';
import { EMAILS, confirmLink, resetLink, type EmailSender } from './email';
import { requireAuth } from './middleware';
import { PASSWORD_REASON_TEXT, parseEmail, normalizeEmail, passwordProblem, type PasswordHasher } from './passwords';
import { deviceOf, sessionResponder } from './routes';
import type { AuthService } from './sessions';
import { BACKOFF, emailSubject, type Subject, type Throttle } from './throttle';

export interface AccountRouteDeps {
  config: Config;
  db: Db;
  kv: Kv;
  auth: AuthService;
  profiles: ProfileService;
  accounts: AccountService;
  hasher: PasswordHasher;
  throttle: Throttle;
  /** null = no email provider (EMAIL_PROVIDER unset) */
  email: EmailSender | null;
  audit: Audit;
  /** the Turnstile check on save, forgot and a sign-in after wrong passwords (auth/botCheck.ts); null = off */
  botCheck: BotCheck | null;
  /** runs work after the answer has gone (sending email), so its time never shows in the answer's */
  defer: (task: () => Promise<void>) => void;
  now: () => number;
}

/** Long enough for any real email or password; anything longer is refused before hashing. */
const EmailField = z.string().max(320);
const PasswordField = z.string().max(1024);
const Credentials = z.object({ email: EmailField, password: PasswordField });
const TokenField = z.string().max(200);
/** Turnstile's tokens are up to 2048 characters */
const BotToken = z.string().max(2048).optional();
const LoginBody = Credentials.extend({ turnstileToken: BotToken });
const SaveBody = Credentials.extend({ birthYear: z.number().optional(), adult: z.boolean().optional(), turnstileToken: BotToken });
const ChangeBody = z.object({ currentPassword: PasswordField, newPassword: PasswordField });

const WRONG = 'The email or password is wrong';

/** An error as the log may see it from account routes: its kind and code, never its message. */
export function safeError(err: unknown): { name: string; code?: string } {
  let code: unknown;
  for (let e: unknown = err, depth = 0; e && depth < 4 && code === undefined; e = (e as { cause?: unknown }).cause, depth++) code = (e as { code?: unknown }).code;
  return { name: err instanceof Error ? err.name : typeof err, ...(typeof code === 'string' ? { code } : {}) };
}

export function accountRoutes(deps: AccountRouteDeps): Hono<AppEnv> {
  const { config, db, kv, auth, profiles, accounts, hasher, throttle, email: sender, audit, botCheck, defer, now } = deps;
  const app = new Hono<AppEnv>();
  const sessionResponse = sessionResponder(config, auth, profiles);
  const ipKey = (c: Context<AppEnv>) => clientRateLimitKey(c, config);
  const ipSubject = (c: Context<AppEnv>): Subject => ({ key: `ip:${ipKey(c)}`, rule: BACKOFF.ip });

  /** The 18+ rule (see the file comment): returns the birth year to keep. */
  function requireAdult(c: Context<AppEnv>, userId: string, body: { birthYear?: number; adult?: boolean }): number {
    if (body.adult !== true || body.birthYear === undefined) throw new ApiError(400, 'age_required', 'Confirm you are 18 or older, with the year you were born');
    const answer = birthYearAnswer(body.birthYear, new Date(now()).getUTCFullYear());
    if (answer === 'invalid') throw new ApiError(400, 'invalid_birth_year', "That year doesn't look right");
    if (answer === 'minor') {
      audit(c, 'save_refused_underage', { userId });
      throw new ApiError(403, 'underage', 'Military Forge is for players 18 and over');
    }
    return body.birthYear;
  }

  const checkBot = async (c: Context<AppEnv>, token: string | undefined, action: BotCheckAction) => {
    if (!botCheck) return;
    try {
      await botCheck(token, clientIp(c, config), action);
    } catch (err) {
      if (err instanceof ApiError && err.status < 500) audit(c, 'bot_check_failed', { action, code: err.code });
      throw err;
    }
  };

  function requirePassword(password: string, email?: string): void {
    const reason = passwordProblem(password, email);
    if (reason) throw new ApiError(400, 'weak_password', PASSWORD_REASON_TEXT[reason], { reason });
  }

  /** The device's current session from its access token, when it's still good; null otherwise. */
  async function currentSession(c: Context<AppEnv>): Promise<{ userId: string; sessionId: string } | null> {
    const m = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    const claims = m ? auth.verifyAccessToken(m[1]!) : null;
    if (!claims || !(await auth.sessionActive(claims.sid, claims.sub))) return null;
    return { userId: claims.sub, sessionId: claims.sid };
  }

  // a database error's message carries its query's parameters (an email, a hash): only its name
  // and code reach the log from these routes
  app.onError((err, c) => {
    if (err instanceof ApiError) {
      for (const [name, value] of Object.entries(err.headers)) c.header(name, value);
      return errorResponse(c, err.status, err.code, err.message, err.extra);
    }
    c.get('log').error({ err: safeError(err) }, 'account route failed');
    return errorResponse(c, 500, 'internal_error', 'Something went wrong', { requestId: c.get('requestId') });
  });

  app.get('/options', (c) => c.json({ resetByEmail: sender !== null }));

  app.get('/account', requireAuth(auth), async (c) => {
    const { userId } = c.get('auth')!;
    const [cred, hasProgress] = await Promise.all([accounts.credentialOf(userId), accounts.hasProgress(userId)]);
    return c.json({ email: cred?.email ?? null, saved: cred !== null, hasProgress, resetByEmail: sender !== null });
  });

  // ---- save: a guest adds an email and password to the account they have

  app.post('/save', requireAuth(auth), async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.accountSave, userId);
    await enforceRateLimit(kv, LIMITS.accountSaveIp, ipKey(c));
    const body = await readJson(c, SaveBody);
    const birthYear = requireAdult(c, userId, body);
    const email = parseEmail(body.email);
    if (!email) throw new ApiError(400, 'invalid_email', "That doesn't look like an email address");
    requirePassword(body.password, email);
    if (await accounts.credentialOf(userId)) throw new ApiError(409, 'already_saved', 'This account is saved already');
    await checkBot(c, body.turnstileToken, 'save');
    await accounts.confirmAdult(userId, birthYear);

    if (sender) {
      // the same answer whether or not the email is free; the work happens after it
      const password = body.password;
      const appUrl = config.appUrl;
      defer(async () => {
        const owner = await accounts.lookup(email);
        if (owner) {
          if (owner.userId !== userId) await sender.send(EMAILS.alreadySaved(email, appUrl));
          return;
        }
        const hashed = await hasher.hash(password);
        const token = await accounts.createToken(userId, 'save', SAVE_TTL_MS, { email, passwordHash: hashed });
        await sender.send(EMAILS.confirm(email, confirmLink(appUrl, token)));
      });
      audit(c, 'save_requested', { userId, emailHash: emailSubject(email) });
      return c.json({ status: 'check_email' }, 202);
    }

    const hashed = await hasher.hash(body.password);
    try {
      await accounts.link(userId, email, hashed);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      audit(c, 'save_refused', { userId, emailHash: emailSubject(email) });
      throw new ApiError(409, 'email_unavailable', "That email can't be used. If it's yours, sign in with it instead.");
    }
    audit(c, 'account_saved', { userId, emailHash: emailSubject(email) });
    return c.json({ status: 'saved', user: await profiles.me(userId) });
  });

  /** The "Save my account" link from the confirm email (works on any device: it needs no session). */
  app.post('/confirm', async (c) => {
    await enforceRateLimit(kv, LIMITS.emailLink, ipKey(c));
    const { token } = await readJson(c, z.object({ token: TokenField }));
    const used = await accounts.useToken(token, 'save');
    const expired = () => new ApiError(400, 'link_expired', 'This link has expired or was used already');
    if (!used?.email || !used.passwordHash) {
      audit(c, 'link_rejected', { purpose: 'save' });
      throw expired();
    }
    try {
      await accounts.link(used.userId, used.email, used.passwordHash);
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      audit(c, 'link_rejected', { purpose: 'save', userId: used.userId });
      throw expired();
    }
    audit(c, 'account_saved', { userId: used.userId, emailHash: emailSubject(used.email), via: 'email' });
    return c.json({ status: 'saved' });
  });

  // ---- sign in

  app.post('/login', async (c) => {
    await enforceRateLimit(kv, LIMITS.login, ipKey(c));
    const body = await readJson(c, LoginBody);
    const email = normalizeEmail(body.email);
    const account: Subject = { key: emailSubject(email), rule: BACKOFF.account };
    const subjects = [account, ipSubject(c)];
    try {
      await throttle.check(subjects);
    } catch (err) {
      audit(c, 'login_locked', { emailHash: account.key });
      throw err;
    }
    // after a few wrong passwords for this email or from this address: the bot check, before the password
    if (botCheck && (await throttle.misses(subjects)) >= LOGIN_BOT_CHECK_AFTER) await checkBot(c, body.turnstileToken, 'login');

    const found = await accounts.lookup(email);
    const ok = found ? await hasher.verify(found.passwordHash, body.password) : await hasher.verifyDummy(body.password);
    if (!found || !ok) {
      await throttle.miss(subjects);
      audit(c, 'login_failed', { emailHash: account.key });
      throw new ApiError(401, 'invalid_credentials', WRONG);
    }
    await throttle.clear(account);
    if (found.status !== 'active') {
      audit(c, 'login_disabled', { userId: found.userId });
      throw new ApiError(403, 'account_disabled', 'This account is disabled');
    }
    // parameters raised since this hash was made: store one with today's
    if (hasher.needsRehash(found.passwordHash)) await accounts.setPassword(found.userId, await hasher.hash(body.password));

    // what happens to the session this device had (see the file comment)
    let previousGuest: 'kept' | 'discarded' | null = null;
    const prior = await currentSession(c);
    if (prior && prior.userId !== found.userId && (await accounts.isGuest(prior.userId))) {
      if (await accounts.hasProgress(prior.userId)) previousGuest = 'kept';
      else if (await accounts.discardGuest(prior.userId)) {
        previousGuest = 'discarded';
        audit(c, 'guest_discarded', { userId: prior.userId });
      }
    } else if (prior) await auth.revokeSession(prior.sessionId);

    const issued = await db.transaction((tx) => auth.createSession(tx, found.userId, deviceOf(c, config)));
    await db.update(users).set({ lastSeenAt: new Date(now()) }).where(eq(users.id, found.userId));
    audit(c, 'login', { userId: found.userId, previousGuest });
    return sessionResponse(c, issued, 200, { previousGuest });
  });

  // ---- change password (signed in, knows the current one)

  app.post('/password', requireAuth(auth), async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.passwordChange, userId);
    const body = await readJson(c, ChangeBody);
    const cred = await accounts.credentialOf(userId);
    if (!cred) throw new ApiError(409, 'not_saved', 'Save your account first');
    const subjects: Subject[] = [{ key: `u:${userId}`, rule: BACKOFF.account }, ipSubject(c)];
    await throttle.check(subjects);
    if (!(await hasher.verify(cred.passwordHash, body.currentPassword))) {
      await throttle.miss(subjects);
      audit(c, 'password_change_failed', { userId });
      throw new ApiError(401, 'wrong_password', "That isn't your current password");
    }
    await throttle.clear(subjects[0]!);
    requirePassword(body.newPassword, cred.email);
    await accounts.setPassword(userId, await hasher.hash(body.newPassword));
    // every session ends, this one too; this device carries on with a new one
    await auth.revokeAllSessions(userId);
    await accounts.cancelTokens(userId, 'reset');
    const issued = await db.transaction((tx) => auth.createSession(tx, userId, deviceOf(c, config)));
    audit(c, 'password_changed', { userId });
    return sessionResponse(c, issued, 200);
  });

  // ---- forgot password (only with an email provider)

  app.post('/forgot', async (c) => {
    if (!sender) throw new ApiError(404, 'not_available', 'Password reset by email is not available');
    await enforceRateLimit(kv, LIMITS.forgot, ipKey(c));
    const body = await readJson(c, z.object({ email: EmailField, turnstileToken: BotToken }));
    await checkBot(c, body.turnstileToken, 'forgot');
    const email = parseEmail(body.email);
    const appUrl = config.appUrl;
    if (email) {
      defer(async () => {
        // at most 3 emails an hour to one address, silently (the answer is the same either way)
        const { value } = await kv.incr(`rl:forgotto:${emailSubject(email)}`, 60 * 60_000);
        if (value > 3) return;
        const owner = await accounts.lookup(email);
        if (!owner || owner.status !== 'active') return;
        const token = await accounts.createToken(owner.userId, 'reset', RESET_TTL_MS);
        await sender.send(EMAILS.reset(email, resetLink(appUrl, token)));
      });
    }
    audit(c, 'reset_requested', { emailHash: email ? emailSubject(email) : undefined, valid: email !== null });
    return c.json({ status: 'check_email' }, 202);
  });

  app.post('/reset', async (c) => {
    await enforceRateLimit(kv, LIMITS.emailLink, ipKey(c));
    const body = await readJson(c, z.object({ token: TokenField, password: PasswordField }));
    const expired = () => new ApiError(400, 'link_expired', 'This link has expired or was used already');
    const good = await accounts.peekToken(body.token, 'reset');
    const cred = good ? await accounts.credentialOf(good.userId) : null;
    if (!good || !cred) {
      audit(c, 'link_rejected', { purpose: 'reset' });
      throw expired();
    }
    // a weak password leaves the link unused, so the player can try another
    requirePassword(body.password, cred.email);
    const hashed = await hasher.hash(body.password);
    if (!(await accounts.useToken(body.token, 'reset'))) throw expired();
    await accounts.setPassword(good.userId, hashed);
    await auth.revokeAllSessions(good.userId);
    await accounts.cancelTokens(good.userId);
    // they proved they own the email: the account's wrong-password count starts over
    await throttle.clear({ key: emailSubject(cred.email), rule: BACKOFF.account });
    audit(c, 'password_reset', { userId: good.userId });
    return c.body(null, 204);
  });

  return app;
}
