/**
 * Money in and out (docs/17 §2.3, §2.5, §2.6) through Flutterwave:
 *
 *   checkout  the server picks the bundle's price, opens a payment row whose id is the tx_ref, and asks Flutterwave
 *             for a hosted page. Refused before any money moves: not a saved 18+ account, the monthly limit, the
 *             cool-off after 5 purchases in 24 h, or a balance that would pass the wallet cap.
 *   settle    a payment is credited only after a verify call made here says it's `successful`, with our tx_ref, the
 *             currency we asked for and at least the amount. The redirect, the webhook and the sweep all end here,
 *             and the payment row's created → paid step plus the ledger's unique (purchase, paid, tx_ref) make it
 *             credit once however many of them arrive.
 *   refund    unspent paid currency, within 14 days: the currency comes off first (so it can't be spent while the
 *             money is on its way back), then Flutterwave's refund; if Flutterwave refuses, a reversal puts it back.
 *   sweep     every few minutes: payments still `created` after 2 minutes are looked up by tx_ref (paid but not
 *             delivered → credited, docs/17 §2.5's make-good), and abandoned ones are closed after a day (a closed
 *             one still settles if a webhook later proves it paid).
 */
import { and, desc, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { identities, payments, profiles, users, type PaymentStatus } from '../db/schema';
import { ApiError } from '../http/errors';
import { newId } from '../ids';
import type { Logger } from '../log';
import { CAP_WINDOW_MS, CHECKOUT_TTL_MS, COOL_OFF, CURRENCY_NAME, REFUND_WINDOW_MS, WALLET_CAP, formatMoney, getBundle, type Money } from './catalog';
import { FlutterwaveError, type Flutterwave, type FlwTransaction } from './flutterwave';
import type { WalletService } from './wallet';

export interface Eligibility {
  canBuy: boolean;
  /** why not: a guest (save the account first), or the 18+ step not done */
  reason: 'guest' | 'age' | 'banned' | null;
  email: string | null;
}

export interface PaymentView {
  id: string;
  bundleId: string;
  brass: number;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  createdAt: string;
  paidAt: string | null;
  /** the player may send it back now (unspent, within 14 days) */
  refundable: boolean;
}

type PaymentRow = typeof payments.$inferSelect;

/** Whether an account may buy (a saved account that passed the 18+ step, not banned), and its email for the provider. */
export async function accountEligibility(db: Db, userId: string): Promise<Eligibility> {
  const [u] = await db
    .select({
      status: users.status,
      adult: users.adultConfirmedAt,
      email: sql<string | null>`(select ${identities.providerUid} from ${identities} where ${identities.userId} = ${users.id} and ${identities.provider} = 'email' limit 1)`,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.status !== 'active') return { canBuy: false, reason: 'banned', email: null };
  if (!u.email) return { canBuy: false, reason: 'guest', email: null };
  if (!u.adult) return { canBuy: false, reason: 'age', email: u.email };
  return { canBuy: true, reason: null, email: u.email };
}

/** How long a `created` payment waits for its redirect or webhook before the sweep asks Flutterwave itself. */
const SWEEP_AFTER_MS = 2 * 60_000;
/** After this, a payment Flutterwave never saw is closed as failed. */
const ABANDON_AFTER_MS = 24 * 3_600_000;

export class PaymentService {
  constructor(
    private readonly db: Db,
    private readonly wallet: WalletService,
    private readonly flw: Flutterwave,
    private readonly now: () => number,
    private readonly log: Logger,
  ) {}

  /** The store is for saved accounts that passed the 18+ step (docs/17 §2.6, red line 9). */
  eligibility(userId: string): Promise<Eligibility> {
    return accountEligibility(this.db, userId);
  }

  async requireEligible(userId: string): Promise<Eligibility & { email: string }> {
    const e = await this.eligibility(userId);
    if (e.reason === 'guest') throw new ApiError(403, 'save_account_first', 'Save your account to buy');
    if (e.reason === 'age') throw new ApiError(403, 'adult_required', 'The store is for players 18 and older');
    if (!e.canBuy || !e.email) throw new ApiError(403, 'store_closed', 'The store is closed for this account');
    return e as Eligibility & { email: string };
  }

  /** USD-tier cents counted against the monthly limit: paid payments in the last 30 days, and checkouts still open. */
  async spentCents(userId: string): Promise<number> {
    const t = this.now();
    const [row] = await this.db
      .select({ n: sql<number>`coalesce(sum(${payments.capCents}), 0)::int` })
      .from(payments)
      .where(
        and(
          eq(payments.userId, userId),
          or(
            and(inArray(payments.status, ['paid', 'refund_pending']), gt(payments.paidAt, new Date(t - CAP_WINDOW_MS))),
            and(eq(payments.status, 'created'), gt(payments.createdAt, new Date(t - CHECKOUT_TTL_MS))),
          ),
        ),
      );
    return row?.n ?? 0;
  }

  /** When the cool-off ends (null: none now): 5 paid in 24 h, the last of them under an hour ago. */
  async coolOffUntil(userId: string): Promise<number | null> {
    const t = this.now();
    const recent = await this.db
      .select({ paidAt: payments.paidAt })
      .from(payments)
      .where(and(eq(payments.userId, userId), inArray(payments.status, ['paid', 'refund_pending', 'refunded']), gt(payments.paidAt, new Date(t - COOL_OFF.windowMs))))
      .orderBy(desc(payments.paidAt));
    if (recent.length < COOL_OFF.purchases) return null;
    const until = recent[0]!.paidAt!.getTime() + COOL_OFF.pauseMs;
    return until > t ? until : null;
  }

  /** Opens a checkout for `bundleId` in `currency`; returns the hosted page. `returnTo` is the site to come back to. */
  async checkout(userId: string, bundleId: string, currency: Money, returnTo: string): Promise<{ txRef: string; link: string }> {
    const bundle = getBundle(bundleId);
    if (!bundle) throw new ApiError(404, 'unknown_bundle', 'No such bundle');
    const who = await this.requireEligible(userId);
    const [limits, spent, until, balance] = await Promise.all([this.wallet.limits(userId), this.spentCents(userId), this.coolOffUntil(userId), this.wallet.balance(userId)]);
    if (spent + bundle.capCents > limits.monthlyCapCents) {
      throw new ApiError(409, 'spending_limit', 'This would pass your monthly spending limit', { capCents: limits.monthlyCapCents, spentCents: spent });
    }
    if (until) throw new ApiError(429, 'cool_off', 'Five purchases today: the store pauses for an hour', { until: new Date(until).toISOString() });
    if (balance.total + bundle.brass > WALLET_CAP) throw new ApiError(409, 'wallet_full', `A wallet holds at most ${WALLET_CAP.toLocaleString('en')} ${CURRENCY_NAME}`, { cap: WALLET_CAP });

    const [profile] = await this.db.select({ nickname: profiles.nickname }).from(profiles).where(eq(profiles.userId, userId));
    const t = this.now();
    const txRef = newId('pay', t);
    const amountMinor = bundle.price[currency];
    await this.db.insert(payments).values({ id: txRef, userId, provider: 'flutterwave', bundleId, brass: bundle.brass, amountMinor, currency, capCents: bundle.capCents, status: 'created', createdAt: new Date(t) });
    try {
      const link = await this.flw.createPayment({
        txRef,
        amountMinor,
        currency,
        redirectUrl: `${returnTo}/?store=return`,
        email: who.email,
        name: profile?.nickname ?? 'Player',
        title: 'Military Forge',
        description: `${bundle.brass.toLocaleString('en')} ${CURRENCY_NAME} (${formatMoney(amountMinor, currency)})`,
      });
      this.log.info({ store: 'checkout', userId, txRef, bundleId, currency, amountMinor }, 'checkout opened');
      return { txRef, link };
    } catch (e) {
      await this.db.update(payments).set({ status: 'failed' }).where(and(eq(payments.id, txRef), eq(payments.status, 'created')));
      this.log.error({ store: 'checkout', txRef, err: (e as Error).message }, 'checkout not opened');
      throw new ApiError(502, 'provider_error', 'The payment provider is not answering: nothing was charged. Try again in a minute');
    }
  }

  async payment(txRef: string): Promise<PaymentRow | null> {
    const [p] = await this.db.select().from(payments).where(eq(payments.id, txRef));
    return p ?? null;
  }

  /**
   * Settles a payment from what Flutterwave says (transaction id from a redirect or webhook, else a lookup by
   * tx_ref). Credits once; refuses anything that doesn't match what was asked for. Returns the payment's status.
   */
  async settle(txRef: string, transactionId: string | null, source: 'redirect' | 'webhook' | 'sweep'): Promise<PaymentStatus> {
    const p = await this.payment(txRef);
    if (!p) throw new ApiError(404, 'unknown_payment', 'No such payment');
    // a payment closed as failed (abandoned, or its page never opened) still settles if Flutterwave says it was paid
    if (p.status !== 'created' && p.status !== 'failed') return p.status;
    let tx: FlwTransaction | null;
    try {
      tx = transactionId ? await this.flw.verify(transactionId) : await this.flw.verifyByRef(txRef);
    } catch (e) {
      if (e instanceof FlutterwaveError) {
        this.log.warn({ store: 'settle', txRef, source, err: e.message }, 'verify failed: left as it was');
        return p.status;
      }
      throw e;
    }
    if (!tx) return p.status;
    const problem = mismatch(p, tx);
    if (problem) {
      // nothing is credited, and nothing is closed either: a failed try on the checkout page can be followed by a
      // good one under the same tx_ref (only the sweep closes a checkout, after a day)
      if (tx.status !== 'failed' && tx.status !== 'pending') {
        this.log.warn({ store: 'settle', alarm: 'payment_mismatch', txRef, source, transactionId: tx.id, problem, got: { status: tx.status, amount: tx.amount, currency: tx.currency, tx_ref: tx.tx_ref } }, 'payment refused');
      }
      return p.status;
    }
    if (tx.amount > p.amountMinor / 100) this.log.warn({ store: 'settle', txRef, paid: tx.amount, asked: p.amountMinor / 100 }, 'paid more than asked: credited the bundle (refund the difference by hand)');

    if (!p.userId) return p.status;
    const userId = p.userId;
    const r = await this.wallet.locked(userId, async (dbtx, w) => {
      const claimed = await dbtx
        .update(payments)
        .set({ status: 'paid', paidAt: new Date(this.now()), providerTxId: String(tx.id) })
        .where(and(eq(payments.id, p.id), inArray(payments.status, ['created', 'failed'])))
        .returning({ id: payments.id });
      if (!claimed.length) return false;
      await this.wallet.write(dbtx, w, [{ pool: 'paid', delta: p.brass, kind: 'purchase', ref: p.id, note: p.bundleId, actor: 'flutterwave' }]);
      return true;
    });
    if (!r.replay && r.value) this.log.info({ store: 'settle', userId, txRef, source, brass: p.brass, transactionId: tx.id }, 'payment credited');
    return (await this.payment(txRef))!.status;
  }

  /** A webhook's body (already authenticated): charge events settle their payment; anything else is noted. */
  async webhook(body: unknown): Promise<void> {
    const b = body as { event?: unknown; data?: { id?: unknown; tx_ref?: unknown } } | null;
    const id = b?.data?.id;
    const ref = b?.data?.tx_ref;
    if (b?.event !== 'charge.completed' || (typeof id !== 'number' && typeof id !== 'string') || typeof ref !== 'string') {
      this.log.info({ store: 'webhook', event: typeof b?.event === 'string' ? b.event : null }, 'webhook ignored');
      return;
    }
    if (!(await this.payment(ref))) {
      this.log.warn({ store: 'webhook', txRef: ref }, 'webhook for a payment we never opened');
      return;
    }
    await this.settle(ref, String(id), 'webhook');
  }

  /** A player's payments, newest first, with whether each can be refunded now. */
  async list(userId: string, limit = 50): Promise<PaymentView[]> {
    const rows = await this.db.select().from(payments).where(eq(payments.userId, userId)).orderBy(desc(payments.createdAt)).limit(limit);
    const balance = await this.wallet.balance(userId);
    return rows.map((p) => this.view(p, balance.paid));
  }

  view(p: PaymentRow, paidBalance: number): PaymentView {
    return {
      id: p.id,
      bundleId: p.bundleId,
      brass: p.brass,
      amountMinor: p.amountMinor,
      currency: p.currency,
      status: p.status,
      createdAt: p.createdAt.toISOString(),
      paidAt: p.paidAt?.toISOString() ?? null,
      refundable: this.refundIssue(p, paidBalance) === null,
    };
  }

  /** Why a payment can't go back now, or null if it can. */
  private refundIssue(p: PaymentRow, paidBalance: number): ApiError | null {
    if (p.status !== 'paid' || !p.paidAt || !p.providerTxId) return new ApiError(409, 'not_refundable', `This payment is ${p.status}`);
    if (this.now() - p.paidAt.getTime() > REFUND_WINDOW_MS) return new ApiError(409, 'refund_window', 'Refunds are for 14 days after a purchase');
    if (paidBalance < p.brass) return new ApiError(409, 'brass_spent', `Only unspent ${CURRENCY_NAME} can be refunded`, { paid: paidBalance, needed: p.brass });
    return null;
  }

  /**
   * Sends a payment's money back for its unspent currency (docs/17 §2.6). `force`: the owner's refund, which may
   * pass the 14 days (never the unspent rule: the balance can't go below zero).
   */
  async refund(txRef: string, actor: 'player' | 'owner', reason: string, opts: { userId?: string; force?: boolean } = {}): Promise<PaymentStatus> {
    const p = await this.payment(txRef);
    if (!p || !p.userId || (opts.userId && p.userId !== opts.userId)) throw new ApiError(404, 'unknown_payment', 'No such payment');
    const userId = p.userId;
    let attempt = 0;
    const r = await this.wallet.locked(userId, async (tx, w) => {
      const [fresh] = await tx.select().from(payments).where(eq(payments.id, txRef)).for('update');
      const issue = this.refundIssue(fresh!, w.paid);
      if (issue && !(opts.force && issue.code === 'refund_window')) throw issue;
      attempt = fresh!.refundAttempts + 1;
      await tx.update(payments).set({ status: 'refund_pending', refundAttempts: attempt }).where(eq(payments.id, txRef));
      await this.wallet.write(tx, w, [{ pool: 'paid', delta: -fresh!.brass, kind: 'refund', ref: `${txRef}/${attempt}`, note: reason, actor }]);
      if (actor === 'owner') await this.wallet.audit(tx, 'owner', 'refund', userId, reason, { txRef, brass: fresh!.brass, amountMinor: fresh!.amountMinor, currency: fresh!.currency });
    });
    if (r.replay) return (await this.payment(txRef))!.status;
    try {
      const out = await this.flw.refund(p.providerTxId!, p.amountMinor, `${reason} (${txRef})`.slice(0, 200));
      await this.db.update(payments).set({ status: 'refunded', refundedAt: new Date(this.now()), refundRef: out.id }).where(eq(payments.id, txRef));
      this.log.info({ store: 'refund', userId, txRef, actor, refund: out }, 'refund sent');
      return 'refunded';
    } catch (e) {
      // the money didn't go: the currency comes back
      await this.wallet.locked(userId, async (tx, w) => {
        await this.wallet.write(tx, w, [{ pool: 'paid', delta: p.brass, kind: 'reversal', ref: `${txRef}/${attempt}`, note: 'refund refused by the provider', actor: 'system' }]);
        await tx.update(payments).set({ status: 'paid' }).where(eq(payments.id, txRef));
      });
      this.log.error({ store: 'refund', userId, txRef, err: (e as Error).message }, 'refund refused by the provider: reversed');
      throw new ApiError(502, 'refund_failed', 'The payment provider refused the refund: your Brass is back. Try again later or contact support');
    }
  }

  /** The make-good pass (index.ts runs it every 5 minutes). Returns how many payments it settled or closed. */
  async sweep(): Promise<{ credited: number; failed: number; looked: number }> {
    const t = this.now();
    const open = await this.db
      .select({ id: payments.id, createdAt: payments.createdAt })
      .from(payments)
      .where(and(eq(payments.status, 'created'), lt(payments.createdAt, new Date(t - SWEEP_AFTER_MS))))
      .orderBy(payments.createdAt)
      .limit(100);
    let credited = 0;
    let failed = 0;
    for (const p of open) {
      const status = await this.settle(p.id, null, 'sweep').catch((e: unknown): PaymentStatus => {
        this.log.warn({ store: 'sweep', txRef: p.id, err: (e as Error).message }, 'sweep: settle failed');
        return 'created';
      });
      if (status === 'paid') credited++;
      else if (status === 'created' && t - p.createdAt.getTime() > ABANDON_AFTER_MS) {
        await this.db.update(payments).set({ status: 'failed' }).where(and(eq(payments.id, p.id), eq(payments.status, 'created')));
        failed++;
      }
    }
    return { credited, failed, looked: open.length };
  }
}

/** What's wrong with a verified transaction for payment `p` (null: it's the payment, paid in full). */
export function mismatch(p: Pick<PaymentRow, 'id' | 'amountMinor' | 'currency'>, tx: FlwTransaction): string | null {
  if (tx.tx_ref !== p.id) return `tx_ref ${tx.tx_ref} is not ${p.id}`;
  if (tx.status !== 'successful') return `status ${tx.status}`;
  if (tx.currency !== p.currency) return `currency ${tx.currency}, asked ${p.currency}`;
  if (typeof tx.amount !== 'number' || Math.round(tx.amount * 100) < p.amountMinor) return `amount ${tx.amount}, asked ${p.amountMinor / 100}`;
  return null;
}
