/**
 * Saved accounts end to end, in-process: save a guest with email + password, sign in on another
 * device, the guest-on-this-device rule, sign out, change password, sign out everywhere, forgot
 * password and the emailed links, and every security rule (no enumeration, backoff, rotation,
 * revocation, single-use and expiring links, CSRF, the audit trail).
 */
import { DEFAULT_COSMETIC_LOADOUT } from '@military-forge/content';
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateSigningKey } from '../src/auth/keys';
import { verifyJwt } from '../src/auth/tokens';
import { emailTokens, passwordCredentials, users } from '../src/db/schema';
import { LIMITS } from '../src/http/rateLimit';
import { TICKET_AUDIENCE, TICKET_ISSUER, type JoinTicketClaims, type RoomJoin } from '../src/rooms/routes';
import { bearer, createGuest, createTestApi, fakeEmail, json, refreshCookie, type SessionBody, type TestApi } from './helpers';

type Login = SessionBody & { previousGuest: 'kept' | 'discarded' | null };

const PW = 'jetpack-sunrise-42';
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; [k: string]: unknown } }).error;

let mailCount = 0;
/** a fresh address per test, so tests don't share accounts or limits */
const newEmail = () => `pilot${++mailCount}.${Date.now()}@example.com`;

function client(api: TestApi) {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => api.app.request(path, json(body, { 'x-forwarded-for': api.ip(), ...headers }));
  return {
    post,
    // an adult's save (the 18+ rule: test/safeguards.test.ts)
    save: (s: { accessToken: string }, email: string, password = PW) => post('/auth/save', { email, password, birthYear: 1995, adult: true }, bearer(s.accessToken)),
    login: (email: string, password = PW, headers: Record<string, string> = {}) => post('/auth/login', { email, password }, headers),
    refresh: (token: string) => post('/auth/refresh', { refreshToken: token }),
    me: (token: string) => api.app.request('/me', { headers: bearer(token) }),
    account: (token: string) => api.app.request('/auth/account', { headers: bearer(token) }),
  };
}

/** A guest whose account is saved with `email` (email off: linked at once). */
async function savedPlayer(api: TestApi, email = newEmail(), body: Record<string, unknown> = {}) {
  const guest = await createGuest(api, body);
  const res = await client(api).save(guest, email);
  if (res.status !== 200) throw new Error(`save failed: ${res.status} ${await res.text()}`);
  return { ...guest, email };
}

describe('saved accounts, email off (EMAIL_PROVIDER unset)', () => {
  let api: TestApi;
  let c: ReturnType<typeof client>;
  beforeAll(async () => {
    api = await createTestApi();
    c = client(api);
  });
  afterAll(() => api.close());

  describe('POST /auth/save', () => {
    it('adds the email and password to the guest account itself: same id, name and progress', async () => {
      const guest = await createGuest(api, { nickname: 'Kemi Saves' });
      const email = newEmail();
      expect(((await (await c.account(guest.accessToken)).json()) as { saved: boolean }).saved).toBe(false);

      const res = await c.save(guest, `  ${email.toUpperCase()} `);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; user: SessionBody['user'] };
      expect(body.status).toBe('saved');
      expect(body.user).toMatchObject({ id: guest.user.id, nickname: 'Kemi Saves', isGuest: false });
      expect(JSON.stringify(body)).not.toContain(PW);

      const account = (await (await c.account(guest.accessToken)).json()) as Record<string, unknown>;
      expect(account).toEqual({ email, saved: true, hasProgress: true, resetByEmail: false });
      // the session it was saved from carries on
      expect((await c.me(guest.accessToken)).status).toBe(200);
    });

    it('stores only an Argon2id hash', async () => {
      const p = await savedPlayer(api);
      const [row] = await api.database.db.select().from(passwordCredentials).where(eq(passwordCredentials.userId, p.user.id));
      expect(row!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
      expect(row!.passwordHash).not.toContain(PW);
    });

    it('refuses weak passwords and non-emails, with the reason', async () => {
      const guest = await createGuest(api);
      const email = newEmail();
      for (const [password, reason] of [
        ['short1', 'too_short'],
        ['1234567890', 'common'],
        ['abababababab', 'repeats'],
        [email, 'same_as_email'],
        ['x'.repeat(129), 'too_long'],
      ] as const) {
        const res = await c.save(guest, email, password);
        expect(res.status).toBe(400);
        expect(await errorOf(res)).toMatchObject({ code: 'weak_password', reason });
      }
      const bad = await c.save(await createGuest(api), 'nobody at example', PW);
      expect(bad.status).toBe(400);
      expect((await errorOf(bad)).code).toBe('invalid_email');
    });

    it('needs a session, and an account is saved once', async () => {
      expect((await c.post('/auth/save', { email: newEmail(), password: PW })).status).toBe(401);
      const p = await savedPlayer(api);
      const again = await c.save(p, newEmail());
      expect(again.status).toBe(409);
      expect((await errorOf(again)).code).toBe('already_saved');
    });

    it('keeps each email on one account (the normalised form counts)', async () => {
      const p = await savedPlayer(api);
      const other = await createGuest(api);
      const res = await c.save(other, ` ${p.email.toUpperCase()}`);
      expect(res.status).toBe(409);
      expect((await errorOf(res)).code).toBe('email_unavailable');
      expect(((await (await c.me(other.accessToken)).json()) as { isGuest: boolean }).isGuest).toBe(true);
    });

    it(`is rate-limited per player (${LIMITS.accountSave.limit} an hour)`, async () => {
      const guest = await createGuest(api);
      for (let i = 0; i < LIMITS.accountSave.limit; i++) expect((await c.save(guest, newEmail(), 'short')).status).toBe(400);
      const limited = await c.save(guest, newEmail());
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).not.toBeNull();
    });

    it('says the email will not be confirmed by mail (GET /auth/options)', async () => {
      expect(await (await api.app.request('/auth/options')).json()).toEqual({ resetByEmail: false });
      expect((await c.post('/auth/forgot', { email: newEmail() })).status).toBe(404);
    });
  });

  describe('POST /auth/login', () => {
    it('signs a new device in to the saved account: a new session, the httpOnly refresh cookie', async () => {
      const p = await savedPlayer(api, newEmail(), { nickname: 'Tunde Flies' });
      const res = await c.login(`  ${p.email.toUpperCase()}`);
      expect(res.status).toBe(200);
      const s = (await res.json()) as Login;
      expect(s.user).toMatchObject({ id: p.user.id, nickname: 'Tunde Flies', isGuest: false });
      expect(s.previousGuest).toBeNull();
      expect(JSON.stringify(s)).not.toContain(PW);
      // rotation: never the saving device's session
      expect(s.refreshToken.split('.')[0]).not.toBe(p.refreshToken.split('.')[0]);
      const cookie = refreshCookie(res);
      expect(cookie?.value).toBe(s.refreshToken);
      expect(cookie?.attributes).toContain('HttpOnly');
      expect(cookie?.attributes).toContain('SameSite=Lax');
      expect(cookie?.attributes).toContain('Path=/auth');
      // both devices are signed in
      expect((await c.me(s.accessToken)).status).toBe(200);
      expect((await c.me(p.accessToken)).status).toBe(200);
      expect((await c.refresh(s.refreshToken)).status).toBe(200);
    });

    it('answers a wrong password and an unknown email the same way', async () => {
      const p = await savedPlayer(api);
      const wrong = await c.login(p.email, 'not-the-password-1');
      const unknown = await c.login(newEmail(), 'not-the-password-1');
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      const a = await wrong.json();
      expect(a).toEqual(await unknown.json());
      expect(a).toEqual({ error: { code: 'invalid_credentials', message: 'The email or password is wrong' } });
      expect(refreshCookie(wrong)).toBeNull();
    });

    it('rotates: signing in again on the same device ends the session it had', async () => {
      const p = await savedPlayer(api);
      const first = (await (await c.login(p.email)).json()) as Login;
      const second = (await (await c.login(p.email, PW, bearer(first.accessToken))).json()) as Login;
      expect(second.user.id).toBe(p.user.id);
      expect((await c.me(first.accessToken)).status).toBe(401);
      expect((await c.refresh(first.refreshToken)).status).toBe(401);
      expect((await c.me(second.accessToken)).status).toBe(200);
    });

    it('a disabled account gets 403 only with the right password', async () => {
      const p = await savedPlayer(api);
      await api.database.db.update(users).set({ status: 'banned' }).where(eq(users.id, p.user.id));
      expect((await c.login(p.email, 'not-the-password-1')).status).toBe(401);
      const res = await c.login(p.email);
      expect(res.status).toBe(403);
      expect((await errorOf(res)).code).toBe('account_disabled');
    });
  });

  describe('the guest already on the device (the sign-in rule)', () => {
    it('a guest with no progress is discarded: nothing is lost', async () => {
      const p = await savedPlayer(api);
      const fresh = await createGuest(api);
      const s = (await (await c.login(p.email, PW, bearer(fresh.accessToken))).json()) as Login;
      expect(s.previousGuest).toBe('discarded');
      expect(s.user.id).toBe(p.user.id);
      expect(await api.database.db.select().from(users).where(eq(users.id, fresh.user.id))).toHaveLength(0);
      expect((await c.refresh(fresh.refreshToken)).status).toBe(401);
    });

    it('a guest with progress is kept as it is, and its session still works ("Switch back")', async () => {
      const p = await savedPlayer(api);
      const played = await createGuest(api, { nickname: 'Unsaved Ace' }); // a chosen name counts as progress
      const put = await api.app.request('/me/loadout/0', { method: 'PUT', headers: { ...bearer(played.accessToken), 'content-type': 'application/json' }, body: JSON.stringify({ look: DEFAULT_COSMETIC_LOADOUT, guns: ['widow', 'k47'] }) });
      expect(put.status).toBe(200);
      const s = (await (await c.login(p.email, PW, bearer(played.accessToken))).json()) as Login;
      expect(s.previousGuest).toBe('kept');
      expect(s.user.id).toBe(p.user.id);
      // nothing merged: the account is unchanged, the guest is still its own player
      const back = await c.refresh(played.refreshToken);
      expect(back.status).toBe(200);
      expect(((await back.json()) as SessionBody).user).toMatchObject({ id: played.user.id, nickname: 'Unsaved Ace', isGuest: true });
    });

    it('a device signed in to another saved account is signed out of it', async () => {
      const a = await savedPlayer(api);
      const b = await savedPlayer(api);
      const s = (await (await c.login(b.email, PW, bearer(a.accessToken))).json()) as Login;
      expect(s.previousGuest).toBeNull();
      expect((await c.me(a.accessToken)).status).toBe(401);
      expect(await api.database.db.select().from(users).where(eq(users.id, a.user.id))).toHaveLength(1);
    });

    it('a wrong password leaves the guest alone', async () => {
      const p = await savedPlayer(api);
      const fresh = await createGuest(api);
      expect((await c.login(p.email, 'not-the-password-1', bearer(fresh.accessToken))).status).toBe(401);
      expect((await c.me(fresh.accessToken)).status).toBe(200);
    });

    it('progress is: a chosen name, XP, a match, a friend or request, a saved loadout', async () => {
      const fresh = await createGuest(api);
      const progress = async (token: string) => ((await (await c.account(token)).json()) as { hasProgress: boolean }).hasProgress;
      expect(await progress(fresh.accessToken)).toBe(false);
      await api.database.db.execute(sql`update profiles set xp = 5 where user_id = ${fresh.user.id}`);
      expect(await progress(fresh.accessToken)).toBe(true);
    });
  });

  describe('a signed-in account plays as itself', () => {
    it("its name and saved look reach a room's join ticket on the new device", async () => {
      const ticketKey = generateSigningKey();
      const signed = await createTestApi({}, { ticketKey });
      try {
        const sc = client(signed);
        const p = await savedPlayer(signed, newEmail(), { nickname: 'Ada Lift' });
        const look = { ...DEFAULT_COSMETIC_LOADOUT, items: { ...DEFAULT_COSMETIC_LOADOUT.items, bodyType: 'body_female' } };
        const put = await signed.app.request('/me/loadout/0', { method: 'PUT', headers: { ...bearer(p.accessToken), 'content-type': 'application/json' }, body: JSON.stringify({ look, guns: ['widow', 'k47'] }) });
        expect(put.status).toBe(200);

        const s = (await (await sc.login(p.email)).json()) as Login;
        const room = (await (await sc.post('/rooms', {}, bearer(s.accessToken))).json()) as RoomJoin;
        const v = verifyJwt<JoinTicketClaims>(room.ticket!, ticketKey.publicKey, { iss: TICKET_ISSUER, aud: TICKET_AUDIENCE, nowSeconds: Math.floor(signed.clock.now() / 1000) });
        if (!v.ok) throw new Error(v.reason);
        expect(v.claims).toMatchObject({ sub: p.user.id, nick: 'Ada Lift', guns: ['widow', 'k47'] });
        expect(v.claims.look).toBeDefined();
        const saved = (await (await signed.app.request('/me/loadout/0', { headers: bearer(s.accessToken) })).json()) as { guns: string[] };
        expect(saved.guns).toEqual(['widow', 'k47']);
      } finally {
        await signed.close();
      }
    });
  });

  describe('guessing limits', () => {
    it('backs off per account after 5 misses (1 s, 2 s …), even for the right password, then lets it in', async () => {
      const p = await savedPlayer(api);
      for (let i = 0; i < 6; i++) expect((await c.login(p.email, `wrong-password-${i}`)).status).toBe(401);
      const locked = await c.login(p.email);
      expect(locked.status).toBe(429);
      expect(locked.headers.get('retry-after')).toBe('1');
      expect((await errorOf(locked)).code).toBe('too_many_attempts');
      api.clock.advance(1000);
      expect((await c.login(p.email, 'wrong-password-x')).status).toBe(401); // 7th miss: 2 s
      api.clock.advance(1000);
      expect((await c.login(p.email)).status).toBe(429);
      api.clock.advance(1000);
      expect((await c.login(p.email)).status).toBe(200);
      // the right password cleared the account's count: 5 free misses again
      for (let i = 0; i < 5; i++) expect((await c.login(p.email, `wrong-again-${i}`)).status).toBe(401);
    });

    it('counts an unknown email exactly like a real one (the limits never tell)', async () => {
      const ghost = newEmail();
      const real = await savedPlayer(api);
      const run = async (email: string) => {
        const codes: number[] = [];
        for (let i = 0; i < 7; i++) codes.push((await c.login(email, `wrong-password-${i}`)).status);
        return codes;
      };
      expect(await run(ghost)).toEqual(await run(real.email));
      expect(await run(ghost)).toEqual([429, 429, 429, 429, 429, 429, 429]);
    });

    it('backs off per IP across emails (20 free misses), and other IPs are unaffected', async () => {
      const ip = '198.51.100.77';
      for (let i = 0; i < 21; i++) expect((await c.login(newEmail(), 'wrong-password-1', { 'x-forwarded-for': ip })).status).toBe(401);
      const p = await savedPlayer(api);
      expect((await c.login(p.email, PW, { 'x-forwarded-for': ip })).status).toBe(429);
      expect((await c.login(p.email, PW, { 'x-forwarded-for': '198.51.100.78' })).status).toBe(200);
      // a success elsewhere doesn't reset the IP; time does
      api.clock.advance(1000);
      expect((await c.login(p.email, PW, { 'x-forwarded-for': ip })).status).toBe(200);
    });

    it(`caps sign-in requests per IP (${LIMITS.login.limit} per 10 minutes)`, async () => {
      const ip = '198.51.100.90';
      const p = await savedPlayer(api);
      for (let i = 0; i < LIMITS.login.limit; i++) expect((await c.login(p.email, PW, { 'x-forwarded-for': ip })).status).toBe(200);
      expect((await c.login(p.email, PW, { 'x-forwarded-for': ip })).status).toBe(429);
    });
  });

  describe('sign out, change password, sign out everywhere', () => {
    it('sign out ends this device only', async () => {
      const p = await savedPlayer(api);
      const other = (await (await c.login(p.email)).json()) as Login;
      expect((await c.post('/auth/logout', { refreshToken: other.refreshToken })).status).toBe(204);
      expect((await c.refresh(other.refreshToken)).status).toBe(401);
      expect((await c.me(other.accessToken)).status).toBe(401);
      expect((await c.me(p.accessToken)).status).toBe(200);
    });

    it('change password: needs the current one, ends every session, this device gets a new one', async () => {
      const p = await savedPlayer(api);
      const laptop = (await (await c.login(p.email)).json()) as Login;
      const change = (body: unknown, token = p.accessToken) => c.post('/auth/password', body, bearer(token));

      const wrong = await change({ currentPassword: 'not-the-password', newPassword: 'brand-new-skyline-7' });
      expect(wrong.status).toBe(401);
      expect((await errorOf(wrong)).code).toBe('wrong_password');
      const weak = await change({ currentPassword: PW, newPassword: 'password123' });
      expect(weak.status).toBe(400);
      expect((await errorOf(weak)).reason).toBe('common');

      const res = await change({ currentPassword: PW, newPassword: 'brand-new-skyline-7' });
      expect(res.status).toBe(200);
      const s = (await res.json()) as SessionBody;
      expect(s.user.id).toBe(p.user.id);
      expect(refreshCookie(res)?.value).toBe(s.refreshToken);
      // every old session is over, the one it was changed from too
      for (const t of [p.accessToken, laptop.accessToken]) expect((await c.me(t)).status).toBe(401);
      for (const t of [p.refreshToken, laptop.refreshToken]) expect((await c.refresh(t)).status).toBe(401);
      expect((await c.me(s.accessToken)).status).toBe(200);
      expect((await c.login(p.email)).status).toBe(401);
      expect((await c.login(p.email, 'brand-new-skyline-7')).status).toBe(200);
    });

    it('change password backs off on wrong guesses too, and a guest has none to change', async () => {
      const p = await savedPlayer(api);
      for (let i = 0; i < 6; i++) expect((await c.post('/auth/password', { currentPassword: `nope-nope-${i}`, newPassword: 'brand-new-skyline-7' }, bearer(p.accessToken))).status).toBe(401);
      expect((await c.post('/auth/password', { currentPassword: PW, newPassword: 'brand-new-skyline-7' }, bearer(p.accessToken))).status).toBe(429);
      const guest = await createGuest(api);
      const res = await c.post('/auth/password', { currentPassword: PW, newPassword: 'brand-new-skyline-7' }, bearer(guest.accessToken));
      expect((await errorOf(res)).code).toBe('not_saved');
    });

    it('sign out everywhere revokes every session and refresh token', async () => {
      const p = await savedPlayer(api);
      const phone = (await (await c.login(p.email)).json()) as Login;
      expect((await c.post('/auth/logout-all', {}, bearer(phone.accessToken))).status).toBe(204);
      for (const t of [p.accessToken, phone.accessToken]) expect((await c.me(t)).status).toBe(401);
      for (const t of [p.refreshToken, phone.refreshToken]) expect((await c.refresh(t)).status).toBe(401);
      expect((await c.login(p.email)).status).toBe(200); // the account itself is fine
    });

    it('deleting the account removes its email and password', async () => {
      const p = await savedPlayer(api);
      expect((await api.app.request('/me', { method: 'DELETE', headers: bearer(p.accessToken) })).status).toBe(204);
      expect(await api.database.db.select().from(passwordCredentials).where(eq(passwordCredentials.userId, p.user.id))).toHaveLength(0);
      expect((await c.login(p.email)).status).toBe(401);
      expect((await c.save(await createGuest(api), p.email)).status).toBe(200); // the email is free again
    });
  });

  describe('CSRF', () => {
    it('refuses sign-in, save and password changes from another site', async () => {
      const p = await savedPlayer(api);
      const evil = { origin: 'https://evil.example' };
      expect((await c.login(p.email, PW, evil)).status).toBe(403);
      expect((await c.post('/auth/save', { email: newEmail(), password: PW }, { ...bearer(p.accessToken), ...evil })).status).toBe(403);
      expect((await c.post('/auth/password', { currentPassword: PW, newPassword: 'brand-new-skyline-7' }, { ...bearer(p.accessToken), ...evil })).status).toBe(403);
      expect((await c.post('/auth/logout-all', {}, { ...bearer(p.accessToken), ...evil })).status).toBe(403);
      expect((await c.login(p.email, PW, { origin: 'http://localhost:5173' })).status).toBe(200);
    });
  });
});

describe('the refresh cookie in production settings', () => {
  it('is Secure', async () => {
    const secure = await createTestApi({ COOKIE_SECURE: 'true' });
    try {
      const p = await savedPlayer(secure);
      const res = await client(secure).login(p.email);
      expect(refreshCookie(res)?.attributes).toMatch(/HttpOnly.*Secure|Secure.*HttpOnly/);
    } finally {
      await secure.close();
    }
  });
});

describe('with email on (EMAIL_PROVIDER set)', () => {
  let api: TestApi;
  let c: ReturnType<typeof client>;
  const mail = fakeEmail();
  beforeAll(async () => {
    api = await createTestApi({ APP_URL: 'https://play.example' }, { email: mail.sender });
    c = client(api);
  });
  afterAll(() => api.close());
  const mailTo = (to: string) => mail.sent.filter((m) => m.to === to);

  /** a saved account, through the emailed confirm link */
  async function confirmed(email = newEmail(), password = PW) {
    const guest = await createGuest(api);
    expect((await c.save(guest, email, password)).status).toBe(202);
    await api.settle();
    const token = mail.token(mailTo(email).at(-1), 'confirm');
    expect((await c.post('/auth/confirm', { token })).status).toBe(200);
    return { ...guest, email };
  }

  it('GET /auth/options says reset by email is on', async () => {
    expect(await (await api.app.request('/auth/options')).json()).toEqual({ resetByEmail: true });
  });

  describe('save confirms the email first, and says the same for a taken one', () => {
    it('a free email: "check your email", then the link saves the account', async () => {
      const guest = await createGuest(api, { nickname: 'Link Saver' });
      const email = newEmail();
      const res = await c.save(guest, email);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ status: 'check_email' });
      await api.settle();
      const sent = mailTo(email);
      expect(sent).toHaveLength(1);
      expect(sent[0]!.subject).toBe('Confirm your email for Military Forge');
      expect(sent[0]!.text).not.toContain(PW);
      const token = mail.token(sent[0], 'confirm')!;
      expect(sent[0]!.text).toContain(`https://play.example/#confirm=${token}`);

      // not saved until the link is opened
      expect(((await (await c.me(guest.accessToken)).json()) as { isGuest: boolean }).isGuest).toBe(true);
      expect((await c.login(email)).status).toBe(401);
      // the link works on any device (no session), once
      const confirm = await c.post('/auth/confirm', { token });
      expect(confirm.status).toBe(200);
      expect(((await (await c.me(guest.accessToken)).json()) as { isGuest: boolean }).isGuest).toBe(false);
      const again = await c.post('/auth/confirm', { token });
      expect(again.status).toBe(400);
      expect((await errorOf(again)).code).toBe('link_expired');
      const s = (await (await c.login(email)).json()) as Login;
      expect(s.user).toMatchObject({ id: guest.user.id, nickname: 'Link Saver' });
    });

    it('a taken email: the same answer, and its owner gets a note with no link', async () => {
      const owner = await confirmed();
      const other = await createGuest(api);
      const free = await c.save(await createGuest(api), newEmail());
      const taken = await c.save(other, owner.email.toUpperCase());
      expect(taken.status).toBe(free.status);
      expect(await taken.json()).toEqual(await free.json());
      await api.settle();
      const note = mailTo(owner.email).at(-1)!;
      expect(note.subject).toBe('You already have a Military Forge account');
      expect(mail.token(note, 'confirm')).toBeNull();
      expect(((await (await c.me(other.accessToken)).json()) as { isGuest: boolean }).isGuest).toBe(true);
    });

    it('a confirm link expires after 24 hours, and a newer one replaces it', async () => {
      const guest = await createGuest(api);
      const email = newEmail();
      await c.save(guest, email);
      await api.settle();
      const first = mail.token(mailTo(email).at(-1), 'confirm')!;
      await c.save(guest, email);
      await api.settle();
      const second = mail.token(mailTo(email).at(-1), 'confirm')!;
      expect((await c.post('/auth/confirm', { token: first })).status).toBe(400);
      api.clock.advance(24 * 3_600_000 + 1);
      expect((await c.post('/auth/confirm', { token: second })).status).toBe(400);
    });
  });

  describe('forgot password and reset', () => {
    it('answers the same for a saved email, an unknown one and a non-email; only the saved one gets mail', async () => {
      const p = await confirmed();
      const before = mail.sent.length;
      const ghost = newEmail();
      const answers = await Promise.all([p.email, ghost, 'not an email'].map((email) => c.post('/auth/forgot', { email })));
      for (const r of answers) expect(r.status).toBe(202);
      const bodies = await Promise.all(answers.map((r) => r.json()));
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
      await api.settle();
      expect(mail.sent.length - before).toBe(1);
      expect(mailTo(ghost)).toHaveLength(0);
      const m = mailTo(p.email).at(-1)!;
      expect(m.subject).toBe('Reset your Military Forge password');
      expect(m.text).toMatch(/https:\/\/play\.example\/#reset=t_[0-9a-z]{26}\./);
    });

    it('a reset link: single use, every session ends, the new password works and the old one does not', async () => {
      const p = await confirmed();
      const phone = (await (await c.login(p.email)).json()) as Login;
      await c.post('/auth/forgot', { email: p.email });
      await api.settle();
      const token = mail.token(mailTo(p.email).at(-1), 'reset')!;

      // stored hashed: the secret is nowhere in the database
      const [row] = await api.database.db.select().from(emailTokens).where(eq(emailTokens.id, token.split('.')[0]!));
      expect(row!.tokenHash).not.toContain(token.split('.')[1]!);
      expect(JSON.stringify(row)).not.toContain(token.split('.')[1]!);

      // a weak password leaves the link usable
      const weak = await c.post('/auth/reset', { token, password: 'qwertyuiop' });
      expect(weak.status).toBe(400);
      expect((await c.post('/auth/reset', { token, password: 'fresh-start-runway-9' })).status).toBe(204);
      for (const t of [p.accessToken, phone.accessToken]) expect((await c.me(t)).status).toBe(401);
      for (const t of [p.refreshToken, phone.refreshToken]) expect((await c.refresh(t)).status).toBe(401);
      expect((await c.login(p.email)).status).toBe(401);
      expect((await c.login(p.email, 'fresh-start-runway-9')).status).toBe(200);

      const again = await c.post('/auth/reset', { token, password: 'another-runway-10' });
      expect(again.status).toBe(400);
      expect((await errorOf(again)).code).toBe('link_expired');
    });

    it('a reset link expires after 30 minutes, a newer one cancels it, and a changed secret is refused', async () => {
      const p = await confirmed();
      await c.post('/auth/forgot', { email: p.email });
      await api.settle();
      const old = mail.token(mailTo(p.email).at(-1), 'reset')!;
      await c.post('/auth/forgot', { email: p.email });
      await api.settle();
      const fresh = mail.token(mailTo(p.email).at(-1), 'reset')!;
      expect((await c.post('/auth/reset', { token: old, password: 'fresh-start-runway-9' })).status).toBe(400);
      const forged = `${fresh.split('.')[0]}.${'A'.repeat(43)}`;
      expect((await c.post('/auth/reset', { token: forged, password: 'fresh-start-runway-9' })).status).toBe(400);
      api.clock.advance(30 * 60_000 + 1);
      expect((await c.post('/auth/reset', { token: fresh, password: 'fresh-start-runway-9' })).status).toBe(400);
      expect((await c.login(p.email)).status).toBe(200);
    });

    it('a password change cancels a reset link sent before it', async () => {
      const p = await confirmed();
      await c.post('/auth/forgot', { email: p.email });
      await api.settle();
      const token = mail.token(mailTo(p.email).at(-1), 'reset')!;
      const s = (await (await c.login(p.email)).json()) as Login;
      expect((await c.post('/auth/password', { currentPassword: PW, newPassword: 'brand-new-skyline-7' }, bearer(s.accessToken))).status).toBe(200);
      expect((await c.post('/auth/reset', { token, password: 'fresh-start-runway-9' })).status).toBe(400);
    });

    it('sends at most 3 emails an hour to one address, still answering 202', async () => {
      const p = await confirmed();
      const before = mailTo(p.email).length;
      for (let i = 0; i < 5; i++) expect((await c.post('/auth/forgot', { email: p.email })).status).toBe(202);
      await api.settle();
      expect(mailTo(p.email).length - before).toBe(3);
    });

    it(`is rate-limited per IP (${LIMITS.forgot.limit} per 10 minutes)`, async () => {
      const ip = '198.51.100.120';
      for (let i = 0; i < LIMITS.forgot.limit; i++) expect((await c.post('/auth/forgot', { email: newEmail() }, { 'x-forwarded-for': ip })).status).toBe(202);
      expect((await c.post('/auth/forgot', { email: newEmail() }, { 'x-forwarded-for': ip })).status).toBe(429);
      await api.settle();
    });
  });
});

describe('the audit trail', () => {
  it('logs every account event with no password, email or token in it', async () => {
    const lines: string[] = [];
    const log = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) });
    const mail = fakeEmail();
    const api = await createTestApi({}, { log, email: mail.sender });
    try {
      const c = client(api);
      const email = newEmail();
      const guest = await createGuest(api);
      await c.save(guest, email);
      await api.settle();
      const confirmToken = mail.token(mail.sent.at(-1), 'confirm')!;
      await c.post('/auth/confirm', { token: confirmToken });
      await c.login(email, 'not-the-password-1');
      const s = (await (await c.login(email)).json()) as Login;
      await c.post('/auth/password', { currentPassword: PW, newPassword: 'brand-new-skyline-7' }, bearer(s.accessToken));
      await c.post('/auth/forgot', { email });
      await api.settle();
      const resetToken = mail.token(mail.sent.at(-1), 'reset')!;
      await c.post('/auth/reset', { token: resetToken, password: 'fresh-start-runway-9' });
      const s2 = (await (await c.login(email, 'fresh-start-runway-9')).json()) as Login;
      await c.post('/auth/logout-all', {}, bearer(s2.accessToken));

      const audit = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.audit);
      expect(audit.map((l) => l.audit)).toEqual([
        'save_requested',
        'account_saved',
        'login_failed',
        'login',
        'password_changed',
        'reset_requested',
        'password_reset',
        'login',
        'logout_everywhere',
      ]);
      for (const l of audit) expect(l).toMatchObject({ kind: 'audit', reqId: expect.any(String) });
      const all = lines.join('\n');
      for (const secret of [PW, 'brand-new-skyline-7', 'fresh-start-runway-9', 'not-the-password-1', email, confirmToken.split('.')[1]!, resetToken.split('.')[1]!, s.refreshToken, s.accessToken]) {
        expect(all).not.toContain(secret);
      }
    } finally {
      await api.close();
    }
  });
});

describe('errors in account routes', () => {
  it("log only the error's kind, never the query's parameters (an email, a hash)", async () => {
    const lines: string[] = [];
    const log = pino({ level: 'info' }, { write: (s: string) => void lines.push(s) });
    const api = await createTestApi({ DATABASE_URL: '' }, { log });
    const email = newEmail();
    try {
      await api.database.close(); // every query now fails, inside Drizzle
      const res = await client(api).login(email);
      expect(res.status).toBe(500);
      expect((await errorOf(res)).code).toBe('internal_error');
      expect(lines.some((l) => l.includes('account route failed'))).toBe(true);
      expect(lines.join('\n')).not.toContain(email);
    } finally {
      await api.kv.close();
      await api.bus.close();
    }
  });
});

describe('migration 0004_accounts', () => {
  it('creates the tables with their keys, and cascades from users', async () => {
    const api = await createTestApi();
    try {
      const cols = await api.database.db.execute<{ table_name: string; column_name: string }>(
        sql`select table_name, column_name from information_schema.columns where table_name in ('password_credentials', 'email_tokens') order by table_name, ordinal_position`,
      );
      const rows = ((cols as { rows?: unknown }).rows ?? cols) as { table_name: string; column_name: string }[];
      const by = (t: string) => rows.filter((r) => r.table_name === t).map((r) => r.column_name);
      expect(by('password_credentials')).toEqual(['user_id', 'password_hash', 'created_at', 'updated_at']);
      expect(by('email_tokens')).toEqual(['id', 'user_id', 'purpose', 'token_hash', 'email', 'password_hash', 'created_at', 'expires_at', 'used_at']);
      // one password per user; a purpose outside the list is refused
      const p = await savedPlayer(api);
      const at = new Date(api.clock.now());
      await expect(api.database.db.insert(passwordCredentials).values({ userId: p.user.id, passwordHash: 'x', createdAt: at, updatedAt: at })).rejects.toThrow();
      await expect(
        api.database.db.execute(sql`insert into email_tokens (id, user_id, purpose, token_hash, created_at, expires_at) values ('t_x', ${p.user.id}, 'other', 'h', now(), now())`),
      ).rejects.toThrow();
    } finally {
      await api.close();
    }
  });
});
