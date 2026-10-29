/**
 * The pre-launch safeguards on saving an account: the 18+ rule (shared/age.ts, auth/accountRoutes.ts)
 * and the Turnstile bot check on save and "Forgot password?" (auth/botCheck.ts), off without
 * TURNSTILE_SECRET and on with it.
 */
import { eq, sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SITEVERIFY_URL, botCheckFor, turnstileCheck, type BotCheck } from '../src/auth/botCheck';
import { loadConfig } from '../src/config';
import { users } from '../src/db/schema';
import { bearer, createGuest, createTestApi, fakeEmail, json, type TestApi } from './helpers';

const PW = 'jetpack-sunrise-42';
const silent = pino({ level: 'silent' });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; [k: string]: unknown } }).error;
let mailCount = 0;
const newEmail = () => `adult${++mailCount}.${Date.now()}@example.com`;

function client(api: TestApi) {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => api.app.request(path, json(body, { 'x-forwarded-for': api.ip(), ...headers }));
  return {
    post,
    save: (s: { accessToken: string }, body: Record<string, unknown>) => post('/auth/save', { email: newEmail(), password: PW, ...body }, bearer(s.accessToken)),
  };
}

async function userRow(api: TestApi, id: string) {
  const [row] = await api.database.db.select({ adultConfirmedAt: users.adultConfirmedAt, birthYear: users.birthYear }).from(users).where(eq(users.id, id));
  return row!;
}

describe('18+ only: saving an account (the test clock is in 2026)', () => {
  let api: TestApi;
  let c: ReturnType<typeof client>;
  beforeAll(async () => {
    api = await createTestApi();
    c = client(api);
  });
  afterAll(() => api.close());

  it('needs the age step\'s answer, sent with the save: a birth year and "adult" (the web asks it once, never a second box)', async () => {
    for (const body of [{}, { adult: true }, { birthYear: 1995 }, { birthYear: 1995, adult: false }, { birthYear: 2008, adult: false }]) {
      const guest = await createGuest(api);
      const res = await c.save(guest, body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('age_required');
      expect((await userRow(api, guest.user.id)).adultConfirmedAt).toBeNull();
    }
  });

  it('refuses a minor, politely, and keeps nothing', async () => {
    for (const birthYear of [2009, 2015]) {
      const guest = await createGuest(api);
      const res = await c.save(guest, { birthYear, adult: true });
      expect(res.status).toBe(403);
      expect(await errorOf(res)).toMatchObject({ code: 'underage', message: 'Military Forge is for players 18 and over' });
      expect(await userRow(api, guest.user.id)).toEqual({ adultConfirmedAt: null, birthYear: null });
      expect(((await (await api.app.request('/me', { headers: bearer(guest.accessToken) })).json()) as { isGuest: boolean }).isGuest).toBe(true);
    }
  });

  it('refuses a year that is not a player', async () => {
    for (const birthYear of [2027, 1850, 1990.5]) {
      const res = await c.save(await createGuest(api), { birthYear, adult: true });
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('invalid_birth_year');
    }
    const text = await c.save(await createGuest(api), { birthYear: '1995', adult: true });
    expect(text.status).toBe(400);
  });

  it('keeps when they said so and the year only (no date of birth)', async () => {
    const guest = await createGuest(api);
    const res = await c.save(guest, { birthYear: 2008, adult: true }); // turns 18 this year: their word on the birthday counts
    expect(res.status).toBe(200);
    expect(await userRow(api, guest.user.id)).toEqual({ adultConfirmedAt: new Date(api.clock.now()), birthYear: 2008 });
  });

  it('migration 0006_age_gate adds the two columns and nothing else', async () => {
    const cols = await api.database.db.execute<{ column_name: string; data_type: string }>(
      sql`select column_name, data_type from information_schema.columns where table_name = 'users' and column_name in ('adult_confirmed_at', 'birth_year') order by column_name`,
    );
    const rows = ((cols as { rows?: unknown }).rows ?? cols) as { column_name: string; data_type: string }[];
    expect(rows).toEqual([
      { column_name: 'adult_confirmed_at', data_type: 'timestamp with time zone' },
      { column_name: 'birth_year', data_type: 'smallint' },
    ]);
  });
});

describe('the bot check is off without TURNSTILE_SECRET', () => {
  it('config: null when unset (or blank), the secret when set', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).turnstileSecret).toBeNull();
    expect(loadConfig({ NODE_ENV: 'test', TURNSTILE_SECRET: '  ' }).turnstileSecret).toBeNull();
    expect(loadConfig({ NODE_ENV: 'test', TURNSTILE_SECRET: '0x4AAAAAAAtest-secret' }).turnstileSecret).toBe('0x4AAAAAAAtest-secret');
    expect(botCheckFor({ turnstileSecret: null }, silent)).toBeNull();
    expect(botCheckFor({ turnstileSecret: '0x4AAAAAAAtest-secret' }, silent)).toBeTypeOf('function');
  });

  it('save and forgot need no token', async () => {
    const api = await createTestApi({}, { email: fakeEmail().sender });
    try {
      const c = client(api);
      expect((await c.save(await createGuest(api), { birthYear: 1995, adult: true })).status).toBe(202);
      expect((await c.post('/auth/forgot', { email: newEmail() })).status).toBe(202);
      await api.settle();
    } finally {
      await api.close();
    }
  });
});

/** Cloudflare's siteverify, faked: `answer` decides; every request is kept. */
function fakeSiteverify(answer: (form: URLSearchParams) => Response | Promise<Response>) {
  const calls: { url: string; form: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const form = new URLSearchParams(init!.body as URLSearchParams);
    calls.push({ url: String(url), form });
    return answer(form);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const verdict = (body: Record<string, unknown>) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

describe('the bot check is on with TURNSTILE_SECRET', () => {
  // the token "pass" passes, anything else fails
  const site = fakeSiteverify((form) => verdict(form.get('response') === 'pass' ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }));
  let api: TestApi;
  let c: ReturnType<typeof client>;
  beforeAll(async () => {
    api = await createTestApi({}, { email: fakeEmail().sender, botCheck: turnstileCheck('0x4AAAAAAAtest-secret', silent, site.fetchImpl) });
    c = client(api);
  });
  afterAll(async () => {
    await api.settle();
    await api.close();
  });

  it('save: no token → 400, a failing one → 403, a passing one → saved', async () => {
    const adult = { birthYear: 1995, adult: true };
    const none = await c.save(await createGuest(api), adult);
    expect(none.status).toBe(400);
    expect((await errorOf(none)).code).toBe('bot_check_required');
    const bad = await c.save(await createGuest(api), { ...adult, turnstileToken: 'nope' });
    expect(bad.status).toBe(403);
    expect((await errorOf(bad)).code).toBe('bot_check_failed');
    const good = await createGuest(api);
    expect((await c.save(good, { ...adult, turnstileToken: 'pass' })).status).toBe(202);
    expect((await userRow(api, good.user.id)).birthYear).toBe(1995);
  });

  it('asks Cloudflare with the secret, the token and the client IP', async () => {
    const before = site.calls.length;
    await c.post('/auth/forgot', { email: newEmail(), turnstileToken: 'pass' }, { 'x-forwarded-for': '198.51.100.7' });
    const call = site.calls[before]!;
    expect(call.url).toBe(SITEVERIFY_URL);
    expect(Object.fromEntries(call.form)).toEqual({ secret: '0x4AAAAAAAtest-secret', response: 'pass', remoteip: '198.51.100.7' });
  });

  it('forgot: no token → 400, a failing one → 403, a passing one → 202', async () => {
    expect((await c.post('/auth/forgot', { email: newEmail() })).status).toBe(400);
    expect((await c.post('/auth/forgot', { email: newEmail(), turnstileToken: 'nope' })).status).toBe(403);
    expect((await c.post('/auth/forgot', { email: newEmail(), turnstileToken: 'pass' })).status).toBe(202);
  });

  it('the cheap checks come first, so a minor or a typo never spends the token', async () => {
    const before = site.calls.length;
    expect((await c.save(await createGuest(api), { birthYear: 2012, adult: true, turnstileToken: 'pass' })).status).toBe(403);
    expect((await c.save(await createGuest(api), { birthYear: 1995, adult: true, email: 'not an email', turnstileToken: 'pass' })).status).toBe(400);
    expect(site.calls.length).toBe(before);
  });

  it('sign-in and the emailed links are not asked', async () => {
    expect((await c.post('/auth/login', { email: newEmail(), password: PW })).status).toBe(401);
    expect((await c.post('/auth/reset', { token: 'x', password: PW })).status).toBe(400);
  });
});

describe('turnstileCheck', () => {
  const run = (check: BotCheck, token = 'tok') => check(token, 'unknown', 'save');
  const codeOf = (p: Promise<void>) => p.then(() => 'ok', (e: { status: number; code: string }) => `${e.status} ${e.code}`);

  it('fails closed when Cloudflare is down, answers with an error, or refuses our secret', async () => {
    expect(await codeOf(run(turnstileCheck('secret-123', silent, fakeSiteverify(() => Promise.reject(new TypeError('fetch failed'))).fetchImpl)))).toBe('503 bot_check_unavailable');
    expect(await codeOf(run(turnstileCheck('secret-123', silent, fakeSiteverify(() => new Response('bad gateway', { status: 502 })).fetchImpl)))).toBe('503 bot_check_unavailable');
    expect(await codeOf(run(turnstileCheck('secret-123', silent, fakeSiteverify(() => verdict({ success: false, 'error-codes': ['invalid-input-secret'] })).fetchImpl)))).toBe('503 bot_check_unavailable');
  });

  it("refuses a token made for the other form (the widget's action)", async () => {
    const site = fakeSiteverify(() => verdict({ success: true, action: 'forgot' }));
    expect(await codeOf(run(turnstileCheck('secret-123', silent, site.fetchImpl)))).toBe('403 bot_check_failed');
    expect(await codeOf(turnstileCheck('secret-123', silent, site.fetchImpl)('tok', 'unknown', 'forgot'))).toBe('ok');
  });

  it("leaves remoteip out when the client's IP is unknown", async () => {
    const site = fakeSiteverify(() => verdict({ success: true }));
    await run(turnstileCheck('secret-123', silent, site.fetchImpl));
    expect(site.calls[0]!.form.has('remoteip')).toBe(false);
  });
});
