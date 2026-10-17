/** /me and /nicknames/check: profile reads, nickname changes with cooldown + uniqueness, deletion. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS } from '../src/http/rateLimit';
import { NICKNAME_COOLDOWN_MS } from '../src/me/profiles';
import { bearer, createGuest, createTestApi, type SessionBody, type TestApi } from './helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi({ RESERVED_NICKNAMES: 'Richie' });
});
afterAll(() => api.close());

const patchMe = (token: string, body: unknown) =>
  api.app.request('/me', { method: 'PATCH', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; [k: string]: unknown } }).error;

/** After moving the clock past the 15-min access token: refresh, like a client would. */
async function renew(s: SessionBody): Promise<SessionBody> {
  const res = await api.app.request('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: s.refreshToken }) });
  expect(res.status).toBe(200);
  return (await res.json()) as SessionBody;
}

describe('PATCH /me nickname', () => {
  it('the first change from a generated name is free, then one change per 7 days', async () => {
    let s = await createGuest(api);
    const first = await patchMe(s.accessToken, { nickname: 'Bolaji' });
    expect(first.status).toBe(200);
    const changed = (await first.json()) as SessionBody['user'];
    expect(changed.nickname).toBe('Bolaji');
    expect(Date.parse(changed.nicknameChangeableAt!)).toBe(api.clock.now() + NICKNAME_COOLDOWN_MS);

    const again = await patchMe(s.accessToken, { nickname: 'Bolaji2' });
    expect(again.status).toBe(429);
    expect(await errorOf(again)).toMatchObject({ code: 'nickname_cooldown', nicknameChangeableAt: changed.nicknameChangeableAt });

    // re-sending the current name is a no-op, not a change
    expect((await patchMe(s.accessToken, { nickname: ' Bolaji ' })).status).toBe(200);

    api.clock.advance(NICKNAME_COOLDOWN_MS);
    s = await renew(s);
    const later = await patchMe(s.accessToken, { nickname: 'Bolaji2' });
    expect(later.status).toBe(200);
    expect(((await later.json()) as SessionBody['user']).nickname).toBe('Bolaji2');
  });

  it('concurrent changes cannot all slip through the cooldown', async () => {
    const s = await createGuest(api);
    const results = await Promise.all(['RaceOne', 'RaceTwo', 'RaceThree'].map((nickname) => patchMe(s.accessToken, { nickname })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 429, 429]);
    for (const r of results.filter((r) => r.status === 429)) expect((await errorOf(r)).code).toBe('nickname_cooldown');
  });

  it('frees the old name and blocks lookalikes of names in use', async () => {
    let a = await createGuest(api);
    let b = await createGuest(api);
    expect((await patchMe(a.accessToken, { nickname: 'Funmi' })).status).toBe(200);
    for (const lookalike of ['FUNMI', 'Funm1', 'Fünmi', 'Fu_nmi', 'FUNM1']) {
      const res = await patchMe(b.accessToken, { nickname: lookalike });
      expect(res.status, lookalike).toBe(409);
      expect((await errorOf(res)).code).toBe('nickname_taken');
    }
    // a's own lookalike change (case only) is allowed once the cooldown passes
    api.clock.advance(NICKNAME_COOLDOWN_MS);
    a = await renew(a);
    expect((await patchMe(a.accessToken, { nickname: 'FUNMI' })).status).toBe(200);
    api.clock.advance(NICKNAME_COOLDOWN_MS);
    [a, b] = [await renew(a), await renew(b)];
    expect((await patchMe(a.accessToken, { nickname: 'Funmilayo' })).status).toBe(200);
    expect((await patchMe(b.accessToken, { nickname: 'Funmi' })).status).toBe(200);
  });

  it('validates names (filter, reserved staff names from env) and the body', async () => {
    const s = await createGuest(api);
    for (const [nickname, reason] of [
      ['ab', 'too_short'],
      ['R1chie', 'reserved'],
      ['Sh1tHead', 'profanity'],
      ['Аdmin', 'mixed_scripts'],
    ] as const) {
      const res = await patchMe(s.accessToken, { nickname });
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toMatchObject({ code: 'invalid_nickname', reason });
    }
    expect((await patchMe(s.accessToken, {})).status).toBe(400);
    expect((await patchMe(s.accessToken, { nickname: 'x'.repeat(65) })).status).toBe(400);
  });

  it(`is rate-limited per user (${LIMITS.profileUpdate.limit} per window)`, async () => {
    const s = await createGuest(api);
    for (let i = 0; i < LIMITS.profileUpdate.limit; i++) await patchMe(s.accessToken, { nickname: 'no' });
    const res = await patchMe(s.accessToken, { nickname: 'no' });
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('rate_limited');
  });
});

describe('DELETE /me', () => {
  it('deletes the account, its sessions and frees the nickname', async () => {
    const s = await createGuest(api, { nickname: 'Temporary' });
    const res = await api.app.request('/me', { method: 'DELETE', headers: bearer(s.accessToken) });
    expect(res.status).toBe(204);
    expect(res.headers.getSetCookie().join()).toMatch(/refresh_token=; .*Max-Age=0/);
    expect((await api.app.request('/me', { headers: bearer(s.accessToken) })).status).toBe(401);
    expect((await api.app.request('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: s.refreshToken }) })).status).toBe(401);
    expect((await createGuest(api, { nickname: 'Temporary' })).user.nickname).toBe('Temporary');
  });
});

describe('GET /nicknames/check', () => {
  const check = async (nickname: string, headers: Record<string, string> = {}) => {
    const res = await api.app.request(`/nicknames/check?nickname=${encodeURIComponent(nickname)}`, { headers: { 'x-forwarded-for': api.ip(), ...headers } });
    expect(res.status).toBe(200);
    return res.json();
  };

  it('reports validity, availability and suggestions', async () => {
    const s = await createGuest(api, { nickname: 'Chidi' });
    expect(await check('Ngozi')).toEqual({ nickname: 'Ngozi', valid: true, available: true });
    expect(await check('admin')).toEqual({ nickname: 'admin', valid: false, available: false, reason: 'reserved' });
    const taken = (await check('CHIDI')) as { available: boolean; suggestions: string[] };
    expect(taken.available).toBe(false);
    expect(taken.suggestions.length).toBeGreaterThan(0);
    // your own name is available to you
    expect(await check('chidi', bearer(s.accessToken))).toMatchObject({ valid: true, available: true });
  });

  it('needs the nickname parameter', async () => {
    const res = await api.app.request('/nicknames/check', { headers: { 'x-forwarded-for': api.ip() } });
    expect(res.status).toBe(400);
  });
});
