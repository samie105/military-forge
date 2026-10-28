/**
 * The store's routes (docs/17 §6). Prices and balances come from here only; the client never states either
 * (a buy names the price it was shown, and a stale one is refused).
 *
 *   GET  /store                              optional Bearer: { enabled, mode, currency, bundles, items, account }
 *   POST /store/checkout {bundleId, currency} Bearer, saved 18+: { txRef, link } (Flutterwave's hosted page)
 *   POST /store/checkout/:txRef/confirm {transactionId?}   back from the page: { status, balance }
 *   POST /store/buy {itemId, expectedPrice}  Bearer, saved 18+, Idempotency-Key header: { balance, owned }
 *   GET  /store/history                      Bearer: { ledger, payments }
 *   POST /store/payments/:txRef/refund       Bearer: unspent paid currency within 14 days → { status }
 *   GET  /store/limits · PUT /store/limits {monthlyCapCents, password?}   the monthly spending limit
 *   POST /webhooks/flutterwave               Flutterwave (verif-hash): settles the payment it names, always 200
 *
 * The owner (Authorization: Bearer ADMIN_TOKEN, the admin page's Store):
 *   GET  /admin/store/accounts?q=            find an account by id, nickname or email
 *   GET  /admin/store/accounts/:id           its wallet, ledger, payments, items, audit and reconciliation
 *   POST /admin/store/accounts/:id/grant {brass? | itemId?, reason}     earned currency or an item
 *   POST /admin/store/accounts/:id/adjust {pool, delta, reason}         ± currency (never below zero)
 *   POST /admin/store/accounts/:id/clear-flag {reason}
 *   POST /admin/store/payments/:txRef/refund {reason}
 *   GET  /admin/store/flags · GET /admin/store/reconcile
 */
import { randomUUID } from 'node:crypto';
import { grantedItems, getCosmetic } from '@military-forge/content';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { optionalAuth, requireAuth } from '../auth/middleware';
import type { AuthService } from '../auth/sessions';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { LEDGER_POOLS, identities, inventory, payments, profiles, storeAudit, users } from '../db/schema';
import type { AppEnv } from '../http/context';
import { ApiError, readJson } from '../http/errors';
import { LIMITS, enforceRateLimit } from '../http/rateLimit';
import type { Kv } from '../kv/kv';
import { ownerOnly } from '../reports/routes';
import { BUNDLES, CURRENCY_NAME, MAX_CAP_CENTS, MONEY, STORE_ITEMS, WALLET_CAP, moneyFor, priceFor } from './catalog';
import type { Flutterwave } from './flutterwave';
import type { PaymentService } from './payments';
import type { WalletService } from './wallet';

export interface StoreDeps {
  config: Config;
  db: Db;
  kv: Kv;
  auth: AuthService;
  wallet: WalletService;
  /** null: Flutterwave's keys are unset and the store is off */
  payments: PaymentService | null;
  flutterwave: Flutterwave | null;
  /** the account's password, for raising the spending limit */
  checkPassword(userId: string, password: string): Promise<boolean>;
}

const Checkout = z.object({ bundleId: z.string().max(40), currency: z.enum(MONEY) });
const Confirm = z.object({ transactionId: z.union([z.string().max(24), z.number().int().nonnegative()]).optional() });
const Buy = z.object({ itemId: z.string().max(64), expectedPrice: z.number().int().nonnegative() });
const SetLimits = z.object({ monthlyCapCents: z.number().int().min(0).max(MAX_CAP_CENTS), password: z.string().max(200).optional() });
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

export function storeRoutes(deps: StoreDeps): Hono<AppEnv> {
  const { config, kv, auth, wallet, payments: pay, flutterwave } = deps;
  const app = new Hono<AppEnv>();
  const need = (): PaymentService => {
    if (!pay) throw new ApiError(503, 'store_off', 'The store is not open');
    return pay;
  };

  app.get('/', optionalAuth(auth), async (c) => {
    if (!pay || !flutterwave) return c.json({ enabled: false });
    const userId = c.get('auth')?.userId ?? null;
    // a token from a session that has ended still reads the catalogue, never an account
    const live = userId && (await auth.sessionActive(c.get('auth')!.sessionId, userId));
    const owned = live ? await wallet.owned(userId) : [];
    const has = grantedItems(owned);
    let account = null;
    if (live) {
      const [eligibility, balance, limits, spentCents] = await Promise.all([pay.eligibility(userId), wallet.balance(userId), wallet.limits(userId), pay.spentCents(userId)]);
      const until = await pay.coolOffUntil(userId);
      account = {
        canBuy: eligibility.canBuy,
        reason: eligibility.reason,
        balance,
        owned,
        limits: { ...limits, spentCents, leftCents: Math.max(0, limits.monthlyCapCents - spentCents), coolOffUntil: until ? new Date(until).toISOString() : null },
      };
    }
    return c.json({
      enabled: true,
      mode: flutterwave.mode,
      currency: { name: CURRENCY_NAME, walletCap: WALLET_CAP },
      bundles: BUNDLES.map((b) => ({ id: b.id, brass: b.brass, bonusPct: b.bonusPct, price: b.price })),
      items: STORE_ITEMS.map((i) => {
        const price = priceFor(i, has);
        const def = getCosmetic(i.itemId)!;
        return {
          itemId: i.itemId,
          line: i.line,
          name: def.name,
          tier: def.tier ?? null,
          weaponId: def.weaponId ?? null,
          killEffect: def.killEffect ?? null,
          includes: def.includes ?? [],
          price,
          fullPrice: i.price,
          upgrade: price !== i.price,
          money: moneyFor(price),
          owned: has.has(i.itemId),
        };
      }),
      account,
    });
  });

  const authed = new Hono<AppEnv>();
  authed.use(requireAuth(auth));

  authed.post('/checkout', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.storeWrite, userId);
    const body = await readJson(c, Checkout);
    // the CSRF guard let this origin through, so it's one of ours: come back to the site the player is on
    const origin = c.req.header('origin');
    const returnTo = origin && /^https?:\/\/[^/]+$/.test(origin) ? origin : config.appUrl;
    return c.json(await need().checkout(userId, body.bundleId, body.currency, returnTo), 201);
  });

  authed.post('/checkout/:txRef/confirm', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.storeWrite, userId);
    const body = await readJson(c, Confirm);
    const p = await need().payment(c.req.param('txRef'));
    if (!p || p.userId !== userId) throw new ApiError(404, 'unknown_payment', 'No such payment');
    const status = await need().settle(p.id, body.transactionId === undefined ? null : String(body.transactionId), 'redirect');
    return c.json({ status, brass: p.brass, balance: await wallet.balance(userId) });
  });

  authed.post('/buy', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.storeWrite, userId);
    const body = await readJson(c, Buy);
    await need().requireEligible(userId);
    const key = c.req.header('idempotency-key') ?? randomUUID();
    if (!IDEMPOTENCY_KEY.test(key)) throw new ApiError(400, 'invalid_idempotency_key', 'Idempotency-Key: 8–64 letters, digits, _ or -');
    const r = await wallet.buy(userId, body.itemId, body.expectedPrice, key);
    c.get('log').info({ store: 'buy', userId, itemId: body.itemId, price: body.expectedPrice, replay: r.replay }, 'item bought');
    return c.json({ balance: r.balance, owned: r.owned, replay: r.replay });
  });

  authed.get('/history', async (c) => {
    const { userId } = c.get('auth')!;
    return c.json({ ledger: await wallet.history(userId), payments: pay ? await pay.list(userId) : [] });
  });

  authed.post('/payments/:txRef/refund', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.storeWrite, userId);
    const status = await need().refund(c.req.param('txRef'), 'player', 'refund asked by the player', { userId });
    return c.json({ status, balance: await wallet.balance(userId) });
  });

  authed.get('/limits', async (c) => {
    const { userId } = c.get('auth')!;
    return c.json(await wallet.limits(userId));
  });

  authed.put('/limits', async (c) => {
    const { userId } = c.get('auth')!;
    await enforceRateLimit(kv, LIMITS.storeWrite, userId);
    const body = await readJson(c, SetLimits);
    const now = await wallet.limits(userId);
    if (body.monthlyCapCents > now.monthlyCapCents) {
      // a raise: the account's password again, and it takes 72 h (docs/17 §2.6)
      if (!body.password || !(await deps.checkPassword(userId, body.password))) throw new ApiError(403, 'password_required', 'Enter your password to raise the limit');
    }
    return c.json(await wallet.setCap(userId, body.monthlyCapCents));
  });

  app.route('/', authed);
  return app;
}

/** POST /webhooks/flutterwave: the secret hash checked, then always 200 (Flutterwave retries anything else). */
export function flutterwaveWebhook(deps: { payments: PaymentService; flutterwave: Flutterwave }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post('/flutterwave', async (c) => {
    if (!deps.flutterwave.webhookAuthentic(c.req.header('verif-hash'))) {
      c.get('log').warn({ store: 'webhook' }, 'webhook without the right verif-hash: dropped');
      throw new ApiError(401, 'unauthorized', 'Bad webhook signature');
    }
    const body: unknown = await c.req.json().catch(() => null);
    try {
      await deps.payments.webhook(body);
    } catch (e) {
      // a failure here is retried by the sweep from our side; Flutterwave needn't send it again
      c.get('log').error({ store: 'webhook', err: (e as Error).message }, 'webhook not settled');
    }
    return c.json({ ok: true });
  });
  return app;
}

const Reason = z.string().trim().min(3).max(300);
const Grant = z.object({ brass: z.number().int().min(1).max(WALLET_CAP).optional(), itemId: z.string().max(64).optional(), reason: Reason }).refine((b) => (b.brass === undefined) !== (b.itemId === undefined), 'grant either brass or itemId');
const Adjust = z.object({ pool: z.enum(LEDGER_POOLS), delta: z.number().int().min(-WALLET_CAP).max(WALLET_CAP).refine((d) => d !== 0, 'delta must not be 0'), reason: Reason });
const WithReason = z.object({ reason: Reason });

/** The owner's store tools: every write carries a reason and lands in store_audit (and the ledger's note). */
export function adminStoreRoutes(deps: { config: Config; db: Db; wallet: WalletService; payments: PaymentService | null }): Hono<AppEnv> {
  const { config, db, wallet, payments: pay } = deps;
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    ownerOnly(c, config.adminToken);
    await next();
  });

  const account = async (id: string) => {
    const [u] = await db
      .select({ id: users.id, status: users.status, adult: users.adultConfirmedAt, createdAt: users.createdAt, nickname: profiles.nickname, level: profiles.level })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, id));
    if (!u) throw new ApiError(404, 'not_found', 'No such account');
    return u;
  };

  app.get('/accounts', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length < 2) return c.json({ accounts: [] });
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = await db
      .selectDistinct({ id: users.id, nickname: profiles.nickname, level: profiles.level })
      .from(users)
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .leftJoin(identities, and(eq(identities.userId, users.id), eq(identities.provider, 'email')))
      .where(or(eq(users.id, q), ilike(profiles.nickname, like), eq(identities.providerUid, q.toLowerCase())))
      .limit(20);
    return c.json({ accounts: rows });
  });

  app.get('/accounts/:id', async (c) => {
    const id = c.req.param('id');
    const u = await account(id);
    const [w, ledgerRows, pays, items, audit, issues] = await Promise.all([
      wallet.wallet(id),
      wallet.history(id, 500),
      pay ? pay.list(id, 200) : Promise.resolve([]),
      db.select().from(inventory).where(eq(inventory.userId, id)),
      db.select().from(storeAudit).where(eq(storeAudit.userId, id)).orderBy(desc(storeAudit.id)).limit(200),
      wallet.reconcile(id),
    ]);
    const eligibility = pay ? await pay.eligibility(id) : null;
    return c.json({
      account: { ...u, adult: u.adult !== null, createdAt: u.createdAt.toISOString(), saved: eligibility ? eligibility.reason !== 'guest' : null },
      wallet: { paid: w?.paid ?? 0, earned: w?.earned ?? 0, total: (w?.paid ?? 0) + (w?.earned ?? 0), flaggedAt: w?.flaggedAt?.toISOString() ?? null, flagReason: w?.flagReason ?? null, monthlyCapCents: w?.monthlyCapCents ?? null },
      ledger: ledgerRows,
      payments: pays,
      inventory: items.map((i) => ({ itemId: i.itemId, name: getCosmetic(i.itemId)?.name ?? i.itemId, source: i.source, ref: i.ref, at: i.acquiredAt.toISOString() })),
      grants: config.cosmeticGrants.get(id) ?? [],
      audit: audit.map((a) => ({ id: a.id, at: a.at.toISOString(), actor: a.actor, action: a.action, reason: a.reason, detail: a.detail })),
      reconciled: issues.length === 0,
      issues,
    });
  });

  app.post('/accounts/:id/grant', async (c) => {
    const id = c.req.param('id');
    await account(id);
    const body = await readJson(c, Grant);
    const ref = `adm_${randomUUID()}`;
    if (body.itemId !== undefined) {
      const def = getCosmetic(body.itemId);
      if (!def) throw new ApiError(400, 'unknown_item', 'No such item');
      const added = await db.transaction(async (tx) => {
        const ok = await wallet.grantItem(tx, id, body.itemId!, ref);
        if (ok) await wallet.audit(tx, 'owner', 'grant_item', id, body.reason, { itemId: body.itemId, ref });
        return ok;
      });
      if (!added) throw new ApiError(409, 'already_owned', 'The account owns this already');
    } else {
      const r = await wallet.locked(id, async (tx, w) => {
        await wallet.write(tx, w, [{ pool: 'earned', delta: body.brass!, kind: 'grant', ref, note: body.reason, actor: 'owner' }]);
        await wallet.audit(tx, 'owner', 'grant_brass', id, body.reason, { brass: body.brass, ref });
      });
      if (r.replay) throw new Error('a fresh grant ref was a replay');
    }
    c.get('log').warn({ audit: 'store_grant', userId: id, itemId: body.itemId ?? null, brass: body.brass ?? null, reason: body.reason }, 'owner grant');
    return c.json({ ok: true, ref, balance: await wallet.balance(id) }, 201);
  });

  app.post('/accounts/:id/adjust', async (c) => {
    const id = c.req.param('id');
    await account(id);
    const body = await readJson(c, Adjust);
    const ref = `adm_${randomUUID()}`;
    await wallet.locked(id, async (tx, w) => {
      await wallet.write(tx, w, [{ pool: body.pool, delta: body.delta, kind: 'adjust', ref, note: body.reason, actor: 'owner' }]);
      await wallet.audit(tx, 'owner', 'adjust', id, body.reason, { pool: body.pool, delta: body.delta, ref });
    });
    c.get('log').warn({ audit: 'store_adjust', userId: id, pool: body.pool, delta: body.delta, reason: body.reason }, 'owner adjustment');
    return c.json({ ok: true, ref, balance: await wallet.balance(id) }, 201);
  });

  app.post('/accounts/:id/clear-flag', async (c) => {
    const id = c.req.param('id');
    const body = await readJson(c, WithReason);
    if (!(await wallet.clearFlag(id))) throw new ApiError(404, 'not_flagged', 'The account is not flagged');
    await wallet.audit(db, 'owner', 'clear_flag', id, body.reason, {});
    return c.json({ ok: true });
  });

  app.post('/payments/:txRef/refund', async (c) => {
    if (!pay) throw new ApiError(503, 'store_off', 'The store is not open');
    const body = await readJson(c, WithReason);
    const status = await pay.refund(c.req.param('txRef'), 'owner', body.reason, { force: true });
    const [p] = await db.select({ userId: payments.userId }).from(payments).where(eq(payments.id, c.req.param('txRef')));
    return c.json({ status, balance: p?.userId ? await wallet.balance(p.userId) : null });
  });

  app.get('/flags', async (c) => c.json({ flagged: await wallet.flagged() }));
  app.get('/reconcile', async (c) => {
    const issues = await wallet.reconcile();
    return c.json({ ok: issues.length === 0, issues });
  });

  return app;
}
