/** /auth routes end to end, in-process: guest accounts, refresh rotation + reuse detection, logout, rate limits. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REUSE_GRACE_MS } from '../src/auth/sessions';
import { LIMITS } from '../src/http/rateLimit';
import { skeleton } from '../src/nickname/normalize';
import { NicknamePolicy } from '../src/nickname/rules';
import { bearer, createGuest, createTestApi, json, refreshCookie, type SessionBody, type TestApi } from './helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(() => api.close());

const refresh = (body: unknown, headers: Record<string, string> = {}) => api.app.request('/auth/refresh', json(body, { 'x-forwarded-for': api.ip(), ...headers }));
const me = (token: string) => api.app.request('/me', { headers: bearer(token) });

describe('POST /auth/guest', () => {
  it('creates a guest with a generated nickname, tokens and the refresh cookie', async () => {
    const res = await api.app.request('/auth/guest', { method: 'POST', headers: { 'x-forwarded-for': api.ip() } });
    expect(res.status).toBe(201);
    const body = (await res.json()) as SessionBody;
    expect(body.user).toMatchObject({ isGuest: true, level: 1, xp: 0, nicknameChangeableAt: null });
    expect(body.user.id).toMatch(/^u_[0-9a-z]{26}$/);
    expect(new NicknamePolicy().check(body.user.nickname).ok).toBe(true);
    expect(Date.parse(body.accessTokenExpiresAt) - api.clock.now()).toBe(900_000);
    expect(Date.parse(body.refreshTokenExpiresAt) - api.clock.now()).toBe(60 * 86_400_000);

    const cookie = refreshCookie(res);
    expect(cookie?.value).toBe(body.refreshToken);
    expect(cookie?.attributes).toContain('HttpOnly');
    expect(cookie?.attributes).toContain('Path=/auth');
    expect(cookie?.attributes).toContain('SameSite=Lax');

    const meRes = await me(body.accessToken);
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual(body.user);
  });

  it('accepts a chosen nickname, which counts as the first change (cooldown starts)', async () => {
    const s = await createGuest(api, { nickname: '  Tunde   Ace ' });
    expect(s.user.nickname).toBe('Tunde Ace');
    expect(Date.parse(s.user.nicknameChangeableAt!) - api.clock.now()).toBe(7 * 86_400_000);
  });

  it('rejects an invalid nickname with the reason', async () => {
    const res = await api.app.request('/auth/guest', json({ nickname: 'Admin' }, { 'x-forwarded-for': api.ip() }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: 'invalid_nickname', message: 'Nickname rejected: reserved', reason: 'reserved' } });
  });

  it('rejects a nickname that looks like a taken one, with free suggestions', async () => {
    await createGuest(api, { nickname: 'Kemi_99' });
    const res = await api.app.request('/auth/guest', json({ nickname: 'KEMI.99' }, { 'x-forwarded-for': api.ip() }));
    expect(res.status).toBe(409);
    const { error } = (await res.json()) as { error: { code: string; suggestions: string[] } };
    expect(error.code).toBe('nickname_taken');
    expect(error.suggestions.length).toBeGreaterThan(0);
    for (const s of error.suggestions) expect(skeleton(s)).not.toBe(skeleton('Kemi_99'));
  });

  it('rejects malformed bodies', async () => {
    const res = await api.app.request('/auth/guest', { method: 'POST', body: '{nope', headers: { 'x-forwarded-for': api.ip() } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_json');
    const wrongType = await api.app.request('/auth/guest', json({ nickname: 42 }, { 'x-forwarded-for': api.ip() }));
    expect(wrongType.status).toBe(400);
    expect(((await wrongType.json()) as { error: { code: string; issues: unknown[] } }).error).toMatchObject({ code: 'invalid_request', issues: [{ path: 'nickname' }] });
  });

  it(`rate-limits account creation per IP (${LIMITS.guestCreate.limit} per window)`, async () => {
    const ip = '198.51.100.7';
    const create = () => api.app.request('/auth/guest', { method: 'POST', headers: { 'x-forwarded-for': ip } });
    for (let i = 0; i < LIMITS.guestCreate.limit; i++) expect((await create()).status).toBe(201);
    const limited = await create();
    expect(limited.status).toBe(429);
    // Valkey counts real time, so its window has run on a little: about the full window
    expect(Math.abs(Number(limited.headers.get('retry-after')) - LIMITS.guestCreate.windowMs / 1000)).toBeLessThanOrEqual(api.kv.kind === 'memory' ? 0 : 5);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    // other IPs are unaffected, and the window resets
    expect((await api.app.request('/auth/guest', { method: 'POST', headers: { 'x-forwarded-for': api.ip() } })).status).toBe(201);
    if (api.kv.kind !== 'memory') return; // a real Valkey's window can't be fast-forwarded
    api.clock.advance(LIMITS.guestCreate.windowMs);
    expect((await create()).status).toBe(201);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates via the cookie or the body; each refresh token works once', async () => {
    const s = await createGuest(api);
    const viaCookie = await refresh({}, { cookie: `refresh_token=${s.refreshToken}` });
    expect(viaCookie.status).toBe(200);
    const r1 = (await viaCookie.json()) as SessionBody;
    expect(r1.user.id).toBe(s.user.id);
    expect(r1.refreshToken).not.toBe(s.refreshToken);
    expect(refreshCookie(viaCookie)?.value).toBe(r1.refreshToken);
    expect((await me(r1.accessToken)).status).toBe(200);

    const viaBody = await refresh({ refreshToken: r1.refreshToken });
    expect(viaBody.status).toBe(200);
  });

  it('slides the refresh expiry and issues a fresh access token', async () => {
    const s = await createGuest(api);
    api.clock.advance(20 * 60_000);
    expect((await me(s.accessToken)).status).toBe(401); // 15 min access token expired
    const r = (await (await refresh({ refreshToken: s.refreshToken })).json()) as SessionBody;
    expect(Date.parse(r.refreshTokenExpiresAt)).toBe(api.clock.now() + 60 * 86_400_000);
    expect((await me(r.accessToken)).status).toBe(200);
  });

  it('two tabs racing with the same token both get the same new token, and neither is logged out later', async () => {
    const s = await createGuest(api);
    const [ra, rb] = await Promise.all([refresh({ refreshToken: s.refreshToken }), refresh({ refreshToken: s.refreshToken })]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const a = (await ra.json()) as SessionBody;
    const b = (await rb.json()) as SessionBody;
    expect(b.refreshToken).toBe(a.refreshToken);
    expect(refreshCookie(rb)?.value).toBe(a.refreshToken);

    // a slower tab, late inside the window, converges on the same token too
    api.clock.advance(REUSE_GRACE_MS - 1000);
    const late = (await (await refresh({ refreshToken: s.refreshToken })).json()) as SessionBody;
    expect(late.refreshToken).toBe(a.refreshToken);

    // 15 minutes on, the race winner's token (whichever tab's write landed last) still refreshes
    api.clock.advance(15 * 60_000);
    const next = await refresh({ refreshToken: a.refreshToken });
    expect(next.status).toBe(200);
    const n = (await next.json()) as SessionBody;
    expect((await me(n.accessToken)).status).toBe(200);
    // the other tab, refreshing at the same moment with the same token, joins it again
    const other = await refresh({ refreshToken: b.refreshToken });
    expect(other.status).toBe(200);
    expect(((await other.json()) as SessionBody).refreshToken).toBe(n.refreshToken);
  });

  it('the grace window starts at the real rotation; a race reply does not extend it', async () => {
    const s = await createGuest(api);
    const a = (await (await refresh({ refreshToken: s.refreshToken })).json()) as SessionBody;
    api.clock.advance(REUSE_GRACE_MS - 1000);
    expect((await refresh({ refreshToken: s.refreshToken })).status).toBe(200);
    api.clock.advance(2000);
    const replay = await refresh({ refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('session_revoked');
    expect((await refresh({ refreshToken: a.refreshToken })).status).toBe(401);
  });

  it('a replayed old token after the grace window revokes the whole session', async () => {
    const s = await createGuest(api);
    const r1 = (await (await refresh({ refreshToken: s.refreshToken })).json()) as SessionBody;
    api.clock.advance(REUSE_GRACE_MS + 1000);
    const replay = await refresh({ refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { error: { code: string } }).error.code).toBe('session_revoked');
    expect(refreshCookie(replay)?.attributes).toMatch(/Max-Age=0/);
    // the legitimate holder is signed out too: access token and refresh token
    expect((await me(r1.accessToken)).status).toBe(401);
    expect((await refresh({ refreshToken: r1.refreshToken })).status).toBe(401);
  });

  it('rejects missing, malformed, unknown and expired tokens', async () => {
    expect((await refresh({})).status).toBe(401);
    expect((await refresh({ refreshToken: 'garbage' })).status).toBe(401);
    const s = await createGuest(api);
    const forged = s.refreshToken.slice(0, -4) + 'AAAA';
    const res = await refresh({ refreshToken: forged });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_refresh_token');
    // the forgery didn't hurt the real session
    expect((await refresh({ refreshToken: s.refreshToken })).status).toBe(200);

    const old = await createGuest(api);
    api.clock.advance(61 * 86_400_000);
    expect((await refresh({ refreshToken: old.refreshToken })).status).toBe(401);
  });
});

describe('logout', () => {
  it('POST /auth/logout ends the session: cookie cleared, tokens dead', async () => {
    const s = await createGuest(api);
    const res = await api.app.request('/auth/logout', { method: 'POST', headers: { cookie: `refresh_token=${s.refreshToken}` } });
    expect(res.status).toBe(204);
    expect(refreshCookie(res)?.attributes).toMatch(/Max-Age=0/);
    expect((await me(s.accessToken)).status).toBe(401);
    expect((await refresh({ refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('portal iframes (SameSite=None): the clear carries the same attributes as the set', async () => {
    const portal = await createTestApi({ COOKIE_SAMESITE: 'None', COOKIE_SECURE: 'true' });
    const created = await portal.app.request('/auth/guest', { method: 'POST', headers: { 'x-forwarded-for': portal.ip() } });
    const s = (await created.json()) as SessionBody;
    expect(refreshCookie(created)?.attributes).toContain('SameSite=None');
    const res = await portal.app.request('/auth/logout', { method: 'POST', headers: { cookie: `refresh_token=${s.refreshToken}` } });
    expect(res.status).toBe(204);
    const cleared = refreshCookie(res);
    expect(cleared?.value).toBe('');
    for (const attr of ['Max-Age=0', 'Path=/auth', 'HttpOnly', 'Secure', 'SameSite=None']) expect(cleared?.attributes).toContain(attr);
    await portal.close();
  });

  it('logout with only the access token (localStorage clients) also works', async () => {
    const s = await createGuest(api);
    expect((await api.app.request('/auth/logout', { method: 'POST', headers: bearer(s.accessToken) })).status).toBe(204);
    expect((await refresh({ refreshToken: s.refreshToken })).status).toBe(401);
  });

  it('POST /auth/logout-all revokes every device of that user only', async () => {
    const s = await createGuest(api);
    const other = await createGuest(api);
    const secondDevice = (await (await refresh({ refreshToken: s.refreshToken })).json()) as SessionBody;
    expect((await api.app.request('/auth/logout-all', { method: 'POST', headers: bearer(secondDevice.accessToken) })).status).toBe(204);
    expect((await me(secondDevice.accessToken)).status).toBe(401);
    expect((await refresh({ refreshToken: secondDevice.refreshToken })).status).toBe(401);
    expect((await me(other.accessToken)).status).toBe(200);
  });
});

describe('access tokens', () => {
  it('401s without, with a malformed, or with a foreign token', async () => {
    const none = await api.app.request('/me');
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    expect(((await none.json()) as { error: { code: string } }).error.code).toBe('unauthorized');
    expect((await me('abc.def.ghi')).status).toBe(401);
    const otherApi = await createTestApi();
    const foreign = await createGuest(otherApi);
    await otherApi.close();
    const res = await me(foreign.accessToken);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('invalid_token');
  });
});
