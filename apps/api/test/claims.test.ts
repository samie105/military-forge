/**
 * The launch gift (store/claims.ts, docs/17 §9): STORE_CLAIMABLE items claimed free, once per account, with or
 * without Flutterwave's keys; #311's 18+ rule (the device's answer for a guest, the account's once saved); kept when
 * a guest saves the account; owned like a bought or granted item; refused for other items and after STORE_CLAIM_UNTIL.
 */
import { DEFAULT_COSMETIC_LOADOUT } from '@military-forge/content';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventory, ledger, storeAudit, users } from '../src/db/schema';
import { START, bearer, createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';
import { TEST_KEYS, fakeFlutterwave } from './fakeFlutterwave';

const FX = 'skin_k47_galaxy_relic_fx';
const FORGED = 'skin_k47_galaxy_relic';
const PW = 'jetpack-sunrise-42';
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error;
let mail = 0;

/** What these tests read of GET /store. */
interface StoreBody {
  enabled: boolean;
  items: { itemId: string; claimable: boolean; owned: boolean }[];
  account: { adult: boolean } & Record<string, unknown>;
  [key: string]: unknown;
}

function client(api: TestApi) {
  const post = (path: string, body: unknown, s?: SessionBody) => api.app.request(path, json(body, { 'x-forwarded-for': api.ip(), ...(s ? bearer(s.accessToken) : {}) }));
  return {
    post,
    claim: (s: SessionBody, body: Record<string, unknown>) => post('/store/claim', body, s),
    store: async (s?: SessionBody) => (await (await api.app.request('/store', { headers: s ? bearer(s.accessToken) : {} })).json()) as StoreBody,
    me: async (s: SessionBody) => (await (await api.app.request('/me', { headers: bearer(s.accessToken) })).json()) as { grants?: string[] },
    save: (s: SessionBody) => post('/auth/save', { email: `gift${++mail}@example.com`, password: PW, birthYear: 1992, adult: true }, s),
  };
}

describe('the launch gift, with the store off (no Flutterwave keys)', () => {
  let api: TestApi;
  let c: ReturnType<typeof client>;
  beforeAll(async () => {
    api = await createTestApi({ STORE_CLAIMABLE: FX });
    c = client(api);
  });
  afterAll(() => api.close());

  it('GET /store opens for the gift: the line, which items are claimable, no payments', async () => {
    const g = await createGuest(api);
    const v = await c.store(g);
    expect(v).toMatchObject({ enabled: true, payments: false, mode: null, claim: { until: null } });
    expect(v.items.map((i) => [i.itemId, i.claimable])).toEqual([
      [FORGED, false],
      [FX, true],
    ]);
    expect(v.account).toMatchObject({ canBuy: false, reason: 'guest', adult: false, limits: null });
    // buying still needs the payment provider
    expect((await errorOf(await c.post('/store/checkout', { bundleId: 'brass_250', currency: 'NGN' }, g))).code).toBe('store_off');
  });

  it('a guest claims with the device’s 18+ answer; once; owned like a grant (/me, the loadout); never currency', async () => {
    const g = await createGuest(api);
    expect((await errorOf(await c.claim(g, { itemId: FX }))).code).toBe('age_required');
    let res = await c.claim(g, { itemId: FX, birthYear: 1994, adult: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ owned: [FX], already: false });
    // again: nothing changes
    res = await c.claim(g, { itemId: FX });
    expect(await res.json()).toEqual({ owned: [FX], already: true });
    const rows = await api.database.db.select().from(inventory).where(eq(inventory.userId, g.user.id));
    expect(rows).toEqual([expect.objectContaining({ itemId: FX, source: 'promo', ref: `promo:${FX}` })]);
    expect(await api.database.db.select().from(storeAudit).where(and(eq(storeAudit.userId, g.user.id), eq(storeAudit.action, 'promo_claim')))).toHaveLength(1);
    expect(await api.database.db.select().from(ledger).where(eq(ledger.userId, g.user.id))).toEqual([]);
    // the answer is kept on the account
    const [u] = await api.database.db.select({ adult: users.adultConfirmedAt, year: users.birthYear }).from(users).where(eq(users.id, g.user.id));
    expect(u).toMatchObject({ year: 1994 });
    expect(u!.adult).not.toBeNull();

    expect((await c.me(g)).grants).toEqual([FX]);
    const v = await c.store(g);
    expect(v.items.map((i) => i.owned)).toEqual([true, true]); // the effect tier includes the Forged skin
    expect(v.account.adult).toBe(true);
    const look = { items: { ...DEFAULT_COSMETIC_LOADOUT.items, skin_k47: FX }, dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes } };
    res = await api.app.request('/me/loadout/0', { method: 'PUT', headers: { 'content-type': 'application/json', ...bearer(g.accessToken) }, body: JSON.stringify({ look, guns: ['k47', 'widow'] }) });
    expect(res.status).toBe(200);
  });

  it('refuses an under-18 answer, a nonsense year, and items that aren’t claimable', async () => {
    const g = await createGuest(api);
    const year = new Date(START).getUTCFullYear();
    let res = await c.claim(g, { itemId: FX, birthYear: year - 15, adult: true });
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('underage');
    expect((await errorOf(await c.claim(g, { itemId: FX, birthYear: year + 3, adult: true }))).code).toBe('invalid_birth_year');
    expect((await c.me(g)).grants).toBeUndefined();
    res = await c.claim(g, { itemId: FORGED, birthYear: 1990, adult: true });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('not_claimable');
    expect((await errorOf(await c.claim(g, { itemId: 'skin_k47_standard', birthYear: 1990, adult: true }))).code).toBe('not_claimable');
  });

  it('a saved account claims on its own 18+ answer; a guest’s claim is kept when it saves the account', async () => {
    const saved = await createGuest(api);
    expect((await c.save(saved)).status).toBe(200);
    expect((await c.claim(saved, { itemId: FX })).status).toBe(200);
    expect((await c.me(saved)).grants).toEqual([FX]);

    const g = await createGuest(api);
    await c.claim(g, { itemId: FX, birthYear: 1990, adult: true });
    expect((await c.save(g)).status).toBe(200);
    expect(await c.me(g)).toMatchObject({ isGuest: false, grants: [FX] });
  });

  it('anyone signed out still sees the catalogue; claiming needs an account', async () => {
    expect(await c.store()).toMatchObject({ enabled: true, account: null });
    expect((await api.app.request('/store/claim', json({ itemId: FX }))).status).toBe(401);
  });
});

describe('the launch gift’s end date', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi({ STORE_CLAIMABLE: FX, STORE_CLAIM_UNTIL: new Date(START + 3_600_000).toISOString() });
  });
  afterAll(() => api.close());

  it('claims until STORE_CLAIM_UNTIL, then 410 claim_ended (and the store, with nothing to buy, is off again)', async () => {
    const c = client(api);
    const a = await createGuest(api);
    expect(await c.store(a)).toMatchObject({ claim: { until: new Date(START + 3_600_000).toISOString() } });
    expect((await c.claim(a, { itemId: FX, birthYear: 1990, adult: true })).status).toBe(200);
    api.clock.advance(2 * 3_600_000);
    const b = await createGuest(api);
    const res = await c.claim(b, { itemId: FX, birthYear: 1990, adult: true });
    expect(res.status).toBe(410);
    expect((await errorOf(res)).code).toBe('claim_ended');
    expect(await c.store(b)).toEqual({ enabled: false });
    // what was claimed stays (a fresh access token: the clock moved past the old one)
    const fresh = (await (await c.post('/auth/refresh', { refreshToken: a.refreshToken })).json()) as SessionBody;
    expect((await c.me(fresh)).grants).toEqual([FX]);
  });
});

describe('the launch gift with payments on', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi({ ...TEST_KEYS, STORE_CLAIMABLE: FX }, { flutterwaveFetch: fakeFlutterwave().fetch });
  });
  afterAll(() => api.close());

  it('the paid path is there as before, and the claimable tier still claims; a bought item can’t be claimed twice over', async () => {
    const c = client(api);
    const s = await createGuest(api);
    await c.save(s);
    const v = await c.store(s);
    expect(v).toMatchObject({ enabled: true, payments: true, mode: 'test', account: { canBuy: true, adult: true, limits: { monthlyCapCents: 10_000 } } });
    expect(v.items.map((i) => i.claimable)).toEqual([false, true]);
    expect(await (await c.claim(s, { itemId: FX })).json()).toEqual({ owned: [FX], already: false });
    expect(await (await c.claim(s, { itemId: FX })).json()).toMatchObject({ already: true });
  });
});
