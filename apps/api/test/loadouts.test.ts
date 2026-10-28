/** /me/loadout/:slot: saved looks and gun pairs, checked against the game's content, per account. */
import { DEFAULT_COSMETIC_LOADOUT, DEFAULT_LOADOUT, weapons } from '@military-forge/content';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { profiles } from '../src/db/schema';
import { LIMITS } from '../src/http/rateLimit';
import { LOADOUT_GUNS } from '../src/loadouts/validate';
import { bearer, createGuest, createTestApi, type TestApi } from './helpers';

let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
});
afterAll(() => api.close());

const gunIds = [weapons[DEFAULT_LOADOUT[0]]!.id, weapons[DEFAULT_LOADOUT[1]]!.id] as const;
const valid = () => ({ look: structuredClone(DEFAULT_COSMETIC_LOADOUT) as { items: Record<string, string>; dyes: Record<string, string> }, guns: [...gunIds] as string[] });
const put = (token: string, body: unknown, slot: number | string = 0) =>
  api.app.request(`/me/loadout/${slot}`, { method: 'PUT', headers: { ...bearer(token), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (token: string, slot: number | string = 0) => api.app.request(`/me/loadout/${slot}`, { headers: bearer(token) });
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; issues?: { path: string; message: string }[] } }).error;

describe('GET/PUT /me/loadout/:slot', () => {
  it('stores a look and two guns per account, and reads them back on another device', async () => {
    const s = await createGuest(api);
    // nothing saved yet: an empty answer, not an error (audit 28 Oct)
    const empty = await get(s.accessToken);
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');

    const body = valid();
    body.look.items.headgear = 'headgear_bandana';
    body.look.dyes.primary = DEFAULT_COSMETIC_LOADOUT.dyes.secondary;
    body.guns = ['k47', 'widow'];
    const saved = await put(s.accessToken, body);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ slot: 0, ...body, updatedAt: new Date(api.clock.now()).toISOString() });

    // "another device": a second session of the same account
    const other = await api.app.request('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: s.refreshToken }) });
    const token = ((await other.json()) as { accessToken: string }).accessToken;
    expect(await (await get(token)).json()).toMatchObject({ look: body.look, guns: ['k47', 'widow'] });

    // a later save replaces it; other slots and other players are separate
    api.clock.advance(1000);
    expect((await put(token, valid())).status).toBe(200);
    expect(await (await get(token)).json()).toMatchObject({ guns: [...gunIds], updatedAt: new Date(api.clock.now()).toISOString() });
    expect((await get(token, 2)).status).toBe(204);
    expect((await get((await createGuest(api)).accessToken)).status).toBe(204);
  });

  it('refuses ids the game does not know, items in the wrong slot, locked items and bad gun pairs', async () => {
    const s = await createGuest(api);
    const body = valid();
    body.look.items.headgear = 'headgear_crown_of_lies';
    body.look.items.boots = 'top_fatigues';
    body.look.dyes.accent = 'boots_combat';
    body.look.items.legs = 'legs_cargo_shorts'; // level 15
    body.guns = ['machete', 'nope'];
    const res = await put(s.accessToken, body);
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.code).toBe('invalid_loadout');
    expect(err.issues!.map((i) => i.path).sort()).toEqual(['guns.0', 'guns.1', 'look.dyes.accent', 'look.items.boots', 'look.items.headgear', 'look.items.legs']);

    const same = valid();
    same.guns = ['k47', 'k47'];
    expect((await errorOf(await put(s.accessToken, same))).issues).toEqual([{ path: 'guns.1', message: 'the two guns must differ' }]);
    expect((await get(s.accessToken)).status).toBe(204); // nothing was stored (an empty answer)
  });

  it('takes a look saved before the hair slot (it stores the body\'s own hair), and refuses a part made for another body', async () => {
    const s = await createGuest(api);
    const old = valid();
    delete old.look.items.hair;
    const res = await put(s.accessToken, old);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { look: { items: Record<string, string> } }).look.items.hair).toBe(DEFAULT_COSMETIC_LOADOUT.items.hair);

    const female = valid();
    female.look.items.bodyType = 'body_female';
    female.look.items.hair = 'hair_braids';
    expect((await put(s.accessToken, female)).status).toBe(200);
    const onMale = valid();
    onMale.look.items.hair = 'hair_braids';
    const bad = await put(s.accessToken, onMale);
    expect(bad.status).toBe(400);
    expect((await errorOf(bad)).issues).toEqual([{ path: 'look.items.hair', message: '"hair_braids" is made for the female body' }]);
  });

  it('refuses a malformed body: missing slots, extra fields, wrong types', async () => {
    const s = await createGuest(api);
    const missing = valid();
    delete missing.look.items.top;
    for (const body of [missing, { ...valid(), extra: 1 }, { ...valid(), guns: ['k47'] }, { look: 'x', guns: [1, 2] }]) {
      const res = await put(s.accessToken, body);
      expect(res.status).toBe(400);
      expect((await errorOf(res)).code).toBe('invalid_request');
    }
    expect((await put(s.accessToken, valid(), 3)).status).toBe(404);
    expect((await put(s.accessToken, valid(), 'x')).status).toBe(404);
  });

  it('unlocks level items once the profile reaches the level', async () => {
    const s = await createGuest(api);
    const body = valid();
    body.look.items.headgear = 'headgear_beret'; // level 10
    expect((await put(s.accessToken, body)).status).toBe(400);
    await api.database.db.update(profiles).set({ level: 10 }).where(eq(profiles.userId, s.user.id));
    expect((await put(s.accessToken, body)).status).toBe(200);
  });

  it('a store skin only with an owner grant (COSMETIC_GRANTS), which GET /me lists; the kill-effect tier includes the plain skin', async () => {
    const s = await createGuest(api);
    const body = valid();
    body.look.items.skin_k47 = 'skin_k47_galaxy_relic_fx';
    const refused = await put(s.accessToken, body);
    expect(refused.status).toBe(400);
    expect((await errorOf(refused)).issues).toEqual([{ path: 'look.items.skin_k47', message: '"skin_k47_galaxy_relic_fx" isn\'t unlocked' }]);
    expect(await (await api.app.request('/me', { headers: bearer(s.accessToken) })).json()).not.toHaveProperty('grants');

    (api.config.cosmeticGrants as Map<string, string[]>).set(s.user.id, ['skin_k47_galaxy_relic_fx']);
    try {
      expect((await put(s.accessToken, body)).status).toBe(200);
      body.look.items.skin_k47 = 'skin_k47_galaxy_relic';
      expect((await put(s.accessToken, body)).status).toBe(200);
      expect(await (await api.app.request('/me', { headers: bearer(s.accessToken) })).json()).toMatchObject({ grants: ['skin_k47_galaxy_relic_fx'] });
      // another account is not granted
      expect((await put((await createGuest(api)).accessToken, body)).status).toBe(400);
    } finally {
      (api.config.cosmeticGrants as Map<string, string[]>).delete(s.user.id);
    }
  });

  it('takes a look saved before the weapon skin slot (it stores the K-47 as it ships)', async () => {
    const s = await createGuest(api);
    const body = valid();
    delete body.look.items.skin_k47;
    expect((await put(s.accessToken, body)).status).toBe(200);
    expect(((await (await get(s.accessToken)).json()) as { look: { items: Record<string, string> } }).look.items.skin_k47).toBe('skin_k47_standard');
  });

  it('needs a signed-in player, is rate limited, and goes with the account', async () => {
    expect((await api.app.request('/me/loadout/0')).status).toBe(401);
    const s = await createGuest(api);
    for (let i = 0; i < LIMITS.loadoutSave.limit; i++) expect((await put(s.accessToken, valid())).status).toBe(200);
    expect((await put(s.accessToken, valid())).status).toBe(429);

    expect((await api.app.request('/me', { method: 'DELETE', headers: bearer(s.accessToken) })).status).toBe(204);
    const fresh = await createGuest(api);
    expect((await get(fresh.accessToken)).status).toBe(204);
  });

  it('allows every non-melee gun and no melee one', () => {
    expect(LOADOUT_GUNS.has('machete')).toBe(false);
    expect(LOADOUT_GUNS.size).toBe(weapons.filter((w) => w.fireMode !== 'melee').length);
  });
});
