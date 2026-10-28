/**
 * The store's money path end to end, in-process, against a fake Flutterwave (test/fakeFlutterwave.ts): the 18+
 * saved-account gate, checkouts, crediting only on a verify that matches (once, however many redirects and webhooks
 * arrive), buying the Galaxy Relic line with currency, the spending limit and cool-off, refunds, the owner's tools,
 * the mint alarm, and the ledger's invariants (never negative, rows sum to the balance, append-only).
 */
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rowsOf } from '../src/analytics/partitions';
import { ledger, users } from '../src/db/schema';
import { DEFAULT_COSMETIC_LOADOUT } from '@military-forge/content';
import { bearer, createGuest, createTestApi, json, type SessionBody, type TestApi } from './helpers';
import { TEST_KEYS, fakeFlutterwave, type FakeFlutterwave } from './fakeFlutterwave';

const PW = 'jetpack-sunrise-42';
const ADMIN = 'owner-admin-token-0123456789';
const ORIGIN = 'http://localhost:5173';
const errorOf = async (res: Response) => ((await res.json()) as { error: { code: string; [k: string]: unknown } }).error;
let mail = 0;

interface StoreView {
  enabled: boolean;
  mode?: string;
  bundles: { id: string; brass: number; price: { NGN: number; USD: number } }[];
  items: { itemId: string; price: number; fullPrice: number; upgrade: boolean; owned: boolean; money: { bundleId: string } | null }[];
  account: null | { canBuy: boolean; reason: string | null; balance: { paid: number; earned: number; total: number }; owned: string[]; limits: { monthlyCapCents: number; spentCents: number; leftCents: number } };
}

describe('the store', () => {
  let api: TestApi;
  let flw: FakeFlutterwave;

  beforeAll(async () => {
    flw = fakeFlutterwave();
    api = await createTestApi({ ...TEST_KEYS, ADMIN_TOKEN: ADMIN }, { flutterwaveFetch: flw.fetch });
  });
  afterAll(() => api.close());

  const post = (path: string, body: unknown, s?: SessionBody, headers: Record<string, string> = {}) => api.app.request(path, json(body, { 'x-forwarded-for': api.ip(), origin: ORIGIN, ...(s ? bearer(s.accessToken) : {}), ...headers }));
  const get = (path: string, s?: SessionBody) => api.app.request(path, { headers: s ? bearer(s.accessToken) : {} });
  const admin = (path: string, body?: unknown) => api.app.request(`/admin/store${path}`, body === undefined ? { headers: bearer(ADMIN) } : json(body, bearer(ADMIN)));
  const store = async (s?: SessionBody) => (await (await get('/store', s)).json()) as StoreView;
  const balance = async (s: SessionBody) => (await store(s)).account!.balance;

  /** A guest saved with an email and the 18+ answer: may buy. */
  async function buyer(): Promise<SessionBody> {
    const s = await createGuest(api);
    const res = await post('/auth/save', { email: `buyer${++mail}@example.com`, password: PW, birthYear: 1990, adult: true }, s);
    expect(res.status).toBe(200);
    return s;
  }

  /** The clock moved past the access token: a new one from the refresh token (as the client does). */
  async function renew(s: SessionBody): Promise<SessionBody> {
    const res = await post('/auth/refresh', { refreshToken: s.refreshToken });
    expect(res.status).toBe(200);
    return Object.assign(s, (await res.json()) as SessionBody);
  }

  async function checkout(s: SessionBody, bundleId = 'brass_1050', currency: 'NGN' | 'USD' = 'NGN'): Promise<string> {
    const res = await post('/store/checkout', { bundleId, currency }, s);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { txRef: string; link: string };
    expect(body.link).toMatch(/^https:\/\/checkout\.flutterwave\.com\//);
    return body.txRef;
  }

  /** Checkout, pay, come back: the bundle credited. */
  async function topUp(s: SessionBody, bundleId = 'brass_1050'): Promise<string> {
    const txRef = await checkout(s, bundleId);
    const t = flw.pay(txRef);
    const res = await post(`/store/checkout/${txRef}/confirm`, { transactionId: t.id }, s);
    expect(((await res.json()) as { status: string }).status).toBe('paid');
    return txRef;
  }

  async function invariants(): Promise<void> {
    expect(await api.store.wallet.reconcile()).toEqual([]);
    const [neg] = rowsOf<{ n: number }>(await api.database.db.execute(sql`select count(*)::int as n from ledger where balance_after < 0`));
    expect(neg?.n).toBe(0);
  }

  // ---------------------------------------------------------------- the catalogue and the 18+ gate

  it('GET /store: bundles with money prices and the Galaxy Relic line in currency, from the server; anyone may look', async () => {
    const v = await store();
    expect(v).toMatchObject({ enabled: true, mode: 'test', account: null });
    expect(v.bundles.map((b) => b.brass)).toEqual([250, 500, 1050, 2200, 5750]);
    expect(v.bundles[2]!.price).toEqual({ USD: 999, NGN: 990_000 });
    expect(v.items.map((i) => [i.itemId, i.price])).toEqual([
      ['skin_k47_galaxy_relic', 1050],
      ['skin_k47_galaxy_relic_fx', 2200],
    ]);
    // the money shown is the cheapest bundle that covers the price (docs/17 §2.2)
    expect(v.items.map((i) => i.money?.bundleId)).toEqual(['brass_1050', 'brass_2200']);
  });

  it('a guest sees the store but must save the account to buy; a saved account without the 18+ answer can’t either', async () => {
    const g = await createGuest(api);
    expect((await store(g)).account).toMatchObject({ canBuy: false, reason: 'guest' });
    let res = await post('/store/checkout', { bundleId: 'brass_250', currency: 'NGN' }, g);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('save_account_first');
    res = await post('/store/buy', { itemId: 'skin_k47_galaxy_relic', expectedPrice: 1050 }, g);
    expect((await errorOf(res)).code).toBe('save_account_first');

    const s = await buyer();
    await api.database.db.update(users).set({ adultConfirmedAt: null }).where(eq(users.id, s.user.id));
    expect((await store(s)).account).toMatchObject({ canBuy: false, reason: 'age' });
    res = await post('/store/checkout', { bundleId: 'brass_250', currency: 'NGN' }, s);
    expect(res.status).toBe(403);
    expect((await errorOf(res)).code).toBe('adult_required');
    expect(flw.checkouts.some((c) => c.customer.email.includes(`buyer${mail}@`))).toBe(false);
  });

  // ---------------------------------------------------------------- paying

  it('a checkout asks Flutterwave for the server’s price in naira (or dollars), with a server-made tx_ref and the way back', async () => {
    const s = await buyer();
    const txRef = await checkout(s, 'brass_500', 'NGN');
    const c = flw.checkouts.find((x) => x.tx_ref === txRef)!;
    expect(c).toMatchObject({ amount: 5000, currency: 'NGN', redirect_url: `${ORIGIN}/?store=return` });
    expect(txRef).toMatch(/^pay_[0-9a-z]{26}$/);
    const usd = await checkout(s, 'brass_500', 'USD');
    expect(flw.checkouts.find((x) => x.tx_ref === usd)).toMatchObject({ amount: 4.99, currency: 'USD' });
    expect((await post('/store/checkout', { bundleId: 'brass_999999', currency: 'NGN' }, s)).status).toBe(404);
    expect((await post('/store/checkout', { bundleId: 'brass_500', currency: 'EUR' }, s)).status).toBe(400);
  });

  it('credits only after a verify, once: the redirect twice, the webhook, its replay and the sweep move it once', async () => {
    const s = await buyer();
    const txRef = await checkout(s);
    // not paid yet: nothing
    let res = await post(`/store/checkout/${txRef}/confirm`, {}, s);
    expect(await res.json()).toMatchObject({ status: 'created', balance: { total: 0 } });

    const t = flw.pay(txRef);
    for (let i = 0; i < 2; i++) {
      res = await post(`/store/checkout/${txRef}/confirm`, { transactionId: t.id }, s);
      expect(await res.json()).toMatchObject({ status: 'paid', balance: { paid: 1050, earned: 0, total: 1050 } });
    }
    const hook = { event: 'charge.completed', data: { id: t.id, tx_ref: txRef, status: 'successful', amount: t.amount, currency: 'NGN' } };
    for (let i = 0; i < 3; i++) {
      res = await api.app.request('/webhooks/flutterwave', json(hook, { 'verif-hash': TEST_KEYS.FLUTTERWAVE_WEBHOOK_HASH }));
      expect(res.status).toBe(200);
    }
    await api.store.payments!.sweep();
    expect(await balance(s)).toEqual({ paid: 1050, earned: 0, total: 1050 });
    const rows = await api.database.db.select().from(ledger).where(eq(ledger.userId, s.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'purchase', pool: 'paid', delta: 1050, balanceAfter: 1050, ref: txRef, actor: 'flutterwave' });
    await invariants();
  });

  it('the webhook alone credits (the player closed the tab); a wrong or missing verif-hash is refused; unknown refs are ignored', async () => {
    const s = await buyer();
    const txRef = await checkout(s, 'brass_250');
    const t = flw.pay(txRef);
    const hook = { event: 'charge.completed', data: { id: t.id, tx_ref: txRef, status: 'successful', amount: t.amount, currency: 'NGN' } };
    expect((await api.app.request('/webhooks/flutterwave', json(hook))).status).toBe(401);
    expect((await api.app.request('/webhooks/flutterwave', json(hook, { 'verif-hash': 'not-the-hash-0123456789' }))).status).toBe(401);
    expect((await balance(s)).total).toBe(0);
    expect((await api.app.request('/webhooks/flutterwave', json(hook, { 'verif-hash': TEST_KEYS.FLUTTERWAVE_WEBHOOK_HASH }))).status).toBe(200);
    expect((await balance(s)).total).toBe(250);
    // a payment we never opened, and other events: 200, nothing moves
    const other = { event: 'charge.completed', data: { id: 1, tx_ref: 'pay_nope', status: 'successful', amount: 1, currency: 'NGN' } };
    expect((await api.app.request('/webhooks/flutterwave', json(other, { 'verif-hash': TEST_KEYS.FLUTTERWAVE_WEBHOOK_HASH }))).status).toBe(200);
    expect((await api.app.request('/webhooks/flutterwave', json({ event: 'transfer.completed', data: {} }, { 'verif-hash': TEST_KEYS.FLUTTERWAVE_WEBHOOK_HASH }))).status).toBe(200);
  });

  it('refuses a payment whose amount, currency, status or tx_ref isn’t what was asked, whatever the webhook claims', async () => {
    const s = await buyer();
    const txRef = await checkout(s, 'brass_1050', 'NGN');
    const short = flw.pay(txRef, { amount: 99 });
    const dollars = flw.pay(txRef, { currency: 'USD' });
    const failed = flw.pay(txRef, { status: 'failed' });
    for (const t of [short, dollars, failed]) {
      const res = await post(`/store/checkout/${txRef}/confirm`, { transactionId: t.id }, s);
      expect(((await res.json()) as { status: string }).status).toBe('created');
      // the webhook's body says it's all fine: the verify says otherwise, and the verify wins
      const lie = { event: 'charge.completed', data: { id: t.id, tx_ref: txRef, status: 'successful', amount: 9900, currency: 'NGN' } };
      await api.app.request('/webhooks/flutterwave', json(lie, { 'verif-hash': TEST_KEYS.FLUTTERWAVE_WEBHOOK_HASH }));
    }
    // another checkout's real payment can't pay for this one
    const other = await checkout(s, 'brass_250');
    const theirs = flw.pay(other);
    expect(((await (await post(`/store/checkout/${txRef}/confirm`, { transactionId: theirs.id }, s)).json()) as { status: string }).status).toBe('created');
    expect((await balance(s)).total).toBe(0);
    // a failed try then a good one under the same tx_ref: credited
    const good = flw.pay(txRef);
    expect(((await (await post(`/store/checkout/${txRef}/confirm`, { transactionId: good.id }, s)).json()) as { status: string }).status).toBe('paid');
    expect((await balance(s)).total).toBe(1050);
    // somebody else's checkout can't be confirmed from this account
    const t2 = await buyer();
    expect((await post(`/store/checkout/${txRef}/confirm`, { transactionId: good.id }, t2)).status).toBe(404);
  });

  it('the sweep credits a payment nobody came back from (paid, never confirmed), by its tx_ref', async () => {
    const s = await buyer();
    const txRef = await checkout(s, 'brass_500');
    flw.pay(txRef);
    api.clock.advance(3 * 60_000);
    const r = await api.store.payments!.sweep();
    expect(r.credited).toBeGreaterThanOrEqual(1);
    expect((await balance(s)).total).toBe(500);
    expect(flw.calls.some((c) => c === `GET /v3/transactions/verify_by_reference?tx_ref=${txRef}`)).toBe(true);
  });

  // ---------------------------------------------------------------- buying items

  it('buys the Galaxy Relic with currency (earned first), then its kill-effect tier at the upgrade price; it unlocks like a grant', async () => {
    const s = await buyer();
    await topUp(s, 'brass_2200');
    expect((await admin(`/accounts/${s.user.id}/grant`, { brass: 100, reason: 'test: a level reward' })).status).toBe(201);

    // a stale price and too little currency are refused, nothing moves
    let res = await post('/store/buy', { itemId: 'skin_k47_galaxy_relic', expectedPrice: 999 }, s);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: 'price_changed', price: 1050 });
    expect((await post('/store/buy', { itemId: 'skin_unknown', expectedPrice: 1 }, s)).status).toBe(404);

    res = await post('/store/buy', { itemId: 'skin_k47_galaxy_relic', expectedPrice: 1050 }, s, { 'idempotency-key': 'buy-relic-0001' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ balance: { earned: 0, paid: 2200 + 100 - 1050, total: 1250 }, owned: ['skin_k47_galaxy_relic'], replay: false });
    // the same key again: the same answer, nothing charged twice; a new key: already owned
    res = await post('/store/buy', { itemId: 'skin_k47_galaxy_relic', expectedPrice: 1050 }, s, { 'idempotency-key': 'buy-relic-0001' });
    expect(await res.json()).toMatchObject({ balance: { total: 1250 }, replay: true });
    res = await post('/store/buy', { itemId: 'skin_k47_galaxy_relic', expectedPrice: 1050 }, s, { 'idempotency-key': 'buy-relic-0002' });
    expect((await errorOf(res)).code).toBe('already_owned');

    // the effect tier now costs the upgrade price (1,050, not 2,200)
    const v = await store(s);
    expect(v.items.find((i) => i.itemId === 'skin_k47_galaxy_relic_fx')).toMatchObject({ price: 1050, fullPrice: 2200, upgrade: true, owned: false });
    res = await post('/store/buy', { itemId: 'skin_k47_galaxy_relic_fx', expectedPrice: 1050 }, s);
    expect(await res.json()).toMatchObject({ balance: { total: 200 } });

    // owned like a grant: /me lists it, the loadout takes it
    expect(await (await get('/me', s)).json()).toMatchObject({ grants: expect.arrayContaining(['skin_k47_galaxy_relic', 'skin_k47_galaxy_relic_fx']) });
    const look = { items: { ...DEFAULT_COSMETIC_LOADOUT.items, skin_k47: 'skin_k47_galaxy_relic_fx' }, dyes: { ...DEFAULT_COSMETIC_LOADOUT.dyes } };
    res = await api.app.request('/me/loadout/0', { method: 'PUT', headers: { 'content-type': 'application/json', ...bearer(s.accessToken) }, body: JSON.stringify({ look, guns: ['k47', 'widow'] }) });
    expect(res.status).toBe(200);
    await invariants();
  });

  it('not enough currency: 409 and nothing moves (a balance never goes below zero)', async () => {
    const s = await buyer();
    await topUp(s, 'brass_500');
    const res = await post('/store/buy', { itemId: 'skin_k47_galaxy_relic', expectedPrice: 1050 }, s);
    expect(res.status).toBe(409);
    expect((await errorOf(res)).code).toBe('not_enough_brass');
    expect(await balance(s)).toEqual({ paid: 500, earned: 0, total: 500 });
    // the owner can't push it below zero either
    expect((await admin(`/accounts/${s.user.id}/adjust`, { pool: 'paid', delta: -501, reason: 'test: too far' })).status).toBe(409);
    expect((await api.app.request('/me', { headers: bearer(s.accessToken) })).status).toBe(200);
    await invariants();
  });

  // ---------------------------------------------------------------- limits

  it('the monthly spending limit ($100 by default) refuses a checkout that would pass it; lowering is instant, raising waits 72 h with the password', async () => {
    const s = await buyer();
    await topUp(s, 'brass_5750');
    // the second Crate is $99.98 in all: just inside
    const second = await checkout(s, 'brass_5750', 'NGN');
    let res = await post('/store/checkout', { bundleId: 'brass_250', currency: 'USD' }, s);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toMatchObject({ code: 'spending_limit', capCents: 10_000, spentCents: 9998 });
    // an open checkout stops counting after an hour unpaid
    api.clock.advance(61 * 60_000);
    await renew(s);
    expect((await store(s)).account!.limits).toMatchObject({ monthlyCapCents: 10_000, spentCents: 4999, leftCents: 5001 });
    void second;

    // lower: at once
    res = await api.app.request('/store/limits', { method: 'PUT', headers: { 'content-type': 'application/json', ...bearer(s.accessToken) }, body: JSON.stringify({ monthlyCapCents: 5000 }) });
    expect(await res.json()).toMatchObject({ monthlyCapCents: 5000, pendingRaise: null });
    expect((await errorOf(await post('/store/checkout', { bundleId: 'brass_250', currency: 'NGN' }, s))).code).toBe('spending_limit');
    // raise: the password, then 72 h
    const put = (body: unknown) => api.app.request('/store/limits', { method: 'PUT', headers: { 'content-type': 'application/json', ...bearer(s.accessToken) }, body: JSON.stringify(body) });
    expect((await errorOf(await put({ monthlyCapCents: 20_000 }))).code).toBe('password_required');
    expect((await errorOf(await put({ monthlyCapCents: 20_000, password: 'wrong-password-123' }))).code).toBe('password_required');
    res = await put({ monthlyCapCents: 20_000, password: PW });
    expect(await res.json()).toMatchObject({ monthlyCapCents: 5000, pendingRaise: { capCents: 20_000 } });
    expect((await put({ monthlyCapCents: 60_000, password: PW })).status).toBe(400);
    api.clock.advance(72 * 3_600_000 + 1000);
    await renew(s);
    expect(await (await get('/store/limits', s)).json()).toMatchObject({ monthlyCapCents: 20_000, pendingRaise: null });
    expect((await post('/store/checkout', { bundleId: 'brass_250', currency: 'NGN' }, s)).status).toBe(201);
  });

  it('after 5 purchases in 24 h the store pauses for an hour', async () => {
    const s = await buyer();
    for (let i = 0; i < 5; i++) await topUp(s, 'brass_250');
    const res = await post('/store/checkout', { bundleId: 'brass_250', currency: 'NGN' }, s);
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('cool_off');
    api.clock.advance(61 * 60_000);
    await renew(s);
    expect((await post('/store/checkout', { bundleId: 'brass_250', currency: 'NGN' }, s)).status).toBe(201);
  });

  // ---------------------------------------------------------------- refunds

  it('refunds unspent paid currency within 14 days through Flutterwave; spent or late is refused; a refused refund is reversed', async () => {
    const s = await buyer();
    const a = await topUp(s, 'brass_1050');
    const b = await topUp(s, 'brass_500');
    const hist = (await (await get('/store/history', s)).json()) as { payments: { id: string; refundable: boolean }[] };
    expect(hist.payments.find((p) => p.id === a)?.refundable).toBe(true);

    // the provider refuses: the currency comes back, and the payment can be tried again
    flw.state.refuseRefunds = true;
    let res = await post(`/store/payments/${b}/refund`, {}, s);
    expect(res.status).toBe(502);
    expect(await balance(s)).toMatchObject({ paid: 1550 });
    flw.state.refuseRefunds = false;

    res = await post(`/store/payments/${b}/refund`, {}, s);
    expect(await res.json()).toMatchObject({ status: 'refunded', balance: { paid: 1050 } });
    expect(flw.refunds.at(-1)).toMatchObject({ amount: 5000 });
    expect((await errorOf(await post(`/store/payments/${b}/refund`, {}, s))).code).toBe('not_refundable');

    // spend part of it: a's 1,050 is no longer all there
    await api.app.request(`/admin/store/accounts/${s.user.id}/adjust`, json({ pool: 'paid', delta: -1, reason: 'test: spend one' }, bearer(ADMIN)));
    res = await post(`/store/payments/${a}/refund`, {}, s);
    expect((await errorOf(res)).code).toBe('brass_spent');

    const c = await topUp(s, 'brass_250');
    api.clock.advance(15 * 86_400_000);
    await renew(s);
    expect((await errorOf(await post(`/store/payments/${c}/refund`, {}, s))).code).toBe('refund_window');
    // the owner may refund past the window (never below zero)
    res = await admin(`/payments/${c}/refund`, { reason: 'test: support ticket 12' });
    expect(await res.json()).toMatchObject({ status: 'refunded' });
    // someone else's payment: not theirs to refund
    expect((await post(`/store/payments/${a}/refund`, {}, await buyer())).status).toBe(404);

    const kinds = (await api.database.db.select().from(ledger).where(eq(ledger.userId, s.user.id))).map((r) => `${r.kind}:${r.delta}`);
    expect(kinds).toEqual(['purchase:1050', 'purchase:500', 'refund:-500', 'reversal:500', 'refund:-500', 'adjust:-1', 'purchase:250', 'refund:-250']);
    await invariants();
  });

  // ---------------------------------------------------------------- the owner's tools and the ledger's rules

  it('the owner looks an account up, grants (currency or an item) and adjusts with a reason, all audited; a big credit raises the mint alarm', async () => {
    const s = await buyer();
    expect((await api.app.request(`/admin/store/accounts/${s.user.id}`)).status).toBe(401);
    let res = await admin(`/accounts?q=${encodeURIComponent(s.user.nickname)}`);
    expect(((await res.json()) as { accounts: { id: string }[] }).accounts.map((a) => a.id)).toContain(s.user.id);

    expect((await admin(`/accounts/${s.user.id}/grant`, { brass: 50 })).status).toBe(400);
    expect((await admin(`/accounts/${s.user.id}/grant`, { itemId: 'skin_k47_galaxy_relic', reason: 'test: creator thanks' })).status).toBe(201);
    expect((await admin(`/accounts/${s.user.id}/grant`, { itemId: 'skin_k47_galaxy_relic', reason: 'test: again' })).status).toBe(409);
    expect((await admin(`/accounts/${s.user.id}/adjust`, { pool: 'earned', delta: 6000, reason: 'test: an outage make-good, wrong amount' })).status).toBe(201);

    res = await admin(`/accounts/${s.user.id}`);
    const view = (await res.json()) as { wallet: { earned: number; flaggedAt: string | null; flagReason: string }; ledger: { kind: string; note: string }[]; inventory: { itemId: string; source: string }[]; audit: { action: string; reason: string }[]; reconciled: boolean };
    expect(view.wallet).toMatchObject({ earned: 6000, flagReason: expect.stringContaining('adjust of 6000') });
    expect(view.inventory).toEqual([expect.objectContaining({ itemId: 'skin_k47_galaxy_relic', source: 'grant' })]);
    expect(view.audit.map((a) => a.action)).toEqual(['adjust', 'grant_item']);
    expect(view.ledger[0]).toMatchObject({ kind: 'adjust', note: 'test: an outage make-good, wrong amount' });
    expect(view.reconciled).toBe(true);
    expect(((await (await admin('/flags')).json()) as { flagged: { userId: string }[] }).flagged.map((f) => f.userId)).toContain(s.user.id);
    expect((await admin(`/accounts/${s.user.id}/clear-flag`, { reason: 'test: checked, a typo' })).status).toBe(200);
    expect(await (await admin('/reconcile')).json()).toEqual({ ok: true, issues: [] });
    // the granted item is owned like a bought one
    expect((await store(s)).items.find((i) => i.itemId === 'skin_k47_galaxy_relic')?.owned).toBe(true);
  });

  it('the ledger is append-only, and a wallet edited behind its back shows up in reconciliation', async () => {
    const s = await buyer();
    await topUp(s, 'brass_250');
    await expect(api.database.db.update(ledger).set({ delta: 99_999 }).where(eq(ledger.userId, s.user.id))).rejects.toThrow();
    await expect(api.database.db.delete(ledger).where(eq(ledger.userId, s.user.id))).rejects.toThrow();
    await api.database.db.execute(sql`update wallets set paid = paid + 1000 where user_id = ${s.user.id}`);
    expect(await api.store.wallet.reconcile(s.user.id)).toEqual([{ userId: s.user.id, pool: 'paid', wallet: 1250, sum: 250, last: 250 }]);
    await api.database.db.execute(sql`update wallets set paid = paid - 1000 where user_id = ${s.user.id}`);
    // deleting the account takes its ledger with it (the cascade is the one delete allowed)
    expect((await api.app.request('/me', { method: 'DELETE', headers: bearer(s.accessToken) })).status).toBe(204);
    expect(await api.database.db.select().from(ledger).where(eq(ledger.userId, s.user.id))).toEqual([]);
  });

  it('whatever the order of buys, grants, refunds and adjustments, each pool’s rows sum to its balance and never dip below zero', async () => {
    const s = await buyer();
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    await topUp(s, 'brass_2200');
    for (let i = 0; i < 30; i++) {
      const r = rand();
      if (r < 0.3) await admin(`/accounts/${s.user.id}/grant`, { brass: 1 + Math.floor(rand() * 400), reason: 'test: random grant' });
      else if (r < 0.7) await admin(`/accounts/${s.user.id}/adjust`, { pool: rand() < 0.5 ? 'paid' : 'earned', delta: Math.floor(rand() * 800) - 500 || 1, reason: 'test: random adjust' });
      else await post('/store/buy', { itemId: 'skin_k47_galaxy_relic', expectedPrice: 1050 }, s);
    }
    await invariants();
    const b = await balance(s);
    expect(b.paid).toBeGreaterThanOrEqual(0);
    expect(b.earned).toBeGreaterThanOrEqual(0);
  });
});

describe('the store without Flutterwave keys', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await createTestApi({ ADMIN_TOKEN: ADMIN });
  });
  afterAll(() => api.close());

  it('is off: GET /store says so, buying and checkouts answer store_off, there is no webhook', async () => {
    const s = await createGuest(api);
    expect(await (await api.app.request('/store', { headers: bearer(s.accessToken) })).json()).toEqual({ enabled: false });
    const res = await api.app.request('/store/checkout', json({ bundleId: 'brass_250', currency: 'NGN' }, bearer(s.accessToken)));
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe('store_off');
    expect((await api.app.request('/webhooks/flutterwave', json({}))).status).toBe(404);
    // the owner's tools still work (a grant is how the Galaxy Relic is given before the store opens)
    expect((await api.app.request(`/admin/store/accounts/${s.user.id}/grant`, json({ itemId: 'skin_k47_galaxy_relic_fx', reason: 'test: owner grant' }, bearer(ADMIN)))).status).toBe(201);
    expect(await (await api.app.request('/me', { headers: bearer(s.accessToken) })).json()).toMatchObject({ grants: ['skin_k47_galaxy_relic_fx'] });
  });
});
