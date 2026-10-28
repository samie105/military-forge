/**
 * The wallet and its ledger (docs/17 §2.5, docs/06 §7): every currency movement is ledger rows plus the cached
 * balance, written in one transaction under the wallet row's lock, so
 *
 *   - a pool never goes below zero (a check on the wallet and on every row's balance_after, and a 409 before that),
 *   - the rows of a pool sum to its balance and the latest row's balance_after equals it (reconcile() proves it),
 *   - a movement whose (kind, pool, ref) was written before is a replay: nothing moves twice (a webhook sent again,
 *     a redirect opened twice, a buy retried with the same key).
 *
 * Spending takes earned currency first, then paid, so paid currency stays refundable longest (§2.5). What an account
 * owns is its inventory plus the owner's COSMETIC_GRANTS: a bought item unlocks exactly like a granted one.
 * A credit that looks like minting (MINT_DAILY in 24 h, or a single non-purchase credit over MINT_SINGLE) flags the
 * wallet for the owner and logs `alarm: 'mint'`.
 */
import { grantedItems } from '@military-forge/content';
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import { rowsOf } from '../analytics/partitions';
import type { Db } from '../db/client';
import { inventory, ledger, storeAudit, wallets, type LedgerKind, type LedgerPool } from '../db/schema';
import { ApiError } from '../http/errors';
import type { Logger } from '../log';
import { CAP_RAISE_DELAY_MS, DEFAULT_CAP_CENTS, MAX_CAP_CENTS, MINT_DAILY, MINT_SINGLE, getStoreItem, priceFor } from './catalog';

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type WalletRow = typeof wallets.$inferSelect;

export interface Balance {
  paid: number;
  earned: number;
  total: number;
}

export interface Entry {
  pool: LedgerPool;
  delta: number;
  kind: LedgerKind;
  ref: string;
  note?: string | null;
  /** player, flutterwave, owner, system */
  actor: string;
}

export interface LedgerRow {
  id: number;
  at: string;
  pool: LedgerPool;
  kind: LedgerKind;
  delta: number;
  balanceAfter: number;
  ref: string;
  note: string | null;
  actor: string;
}

export interface Limits {
  monthlyCapCents: number;
  /** a raise asked for, and when it takes effect */
  pendingRaise: { capCents: number; at: string } | null;
}

/** Thrown inside a movement whose rows exist already: the transaction rolls back and the caller sees a replay. */
class Replay extends Error {}

const balanceOf = (w: Pick<WalletRow, 'paid' | 'earned'> | undefined): Balance => ({ paid: w?.paid ?? 0, earned: w?.earned ?? 0, total: (w?.paid ?? 0) + (w?.earned ?? 0) });

export class WalletService {
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
    private readonly log: Logger,
    /** the owner's COSMETIC_GRANTS (config), owned like bought items */
    private readonly configGrants: ReadonlyMap<string, readonly string[]> = new Map(),
  ) {}

  async balance(userId: string): Promise<Balance> {
    const [w] = await this.db.select({ paid: wallets.paid, earned: wallets.earned }).from(wallets).where(eq(wallets.userId, userId));
    return balanceOf(w);
  }

  /** Item ids the account owns, bought or granted (not expanded: content's grantedItems/cosmeticUnlocked do that). */
  async owned(userId: string, tx: Tx | Db = this.db): Promise<string[]> {
    const rows = await tx.select({ itemId: inventory.itemId }).from(inventory).where(eq(inventory.userId, userId));
    return [...new Set([...(this.configGrants.get(userId) ?? []), ...rows.map((r) => r.itemId)])];
  }

  async history(userId: string, limit = 100): Promise<LedgerRow[]> {
    const rows = await this.db.select().from(ledger).where(eq(ledger.userId, userId)).orderBy(desc(ledger.id)).limit(limit);
    return rows.map((r) => ({ id: r.id, at: r.createdAt.toISOString(), pool: r.pool, kind: r.kind, delta: r.delta, balanceAfter: r.balanceAfter, ref: r.ref, note: r.note, actor: r.actor }));
  }

  /**
   * Runs `fn` in a transaction holding the account's wallet row (made on first use) `for update`: every movement of
   * one account's currency goes through here, one at a time. A Replay thrown inside comes back as `replay: true`.
   */
  async locked<T>(userId: string, fn: (tx: Tx, w: WalletRow) => Promise<T>): Promise<{ replay: false; value: T } | { replay: true }> {
    try {
      const value = await this.db.transaction(async (tx) => {
        await tx.insert(wallets).values({ userId, updatedAt: new Date(this.now()) }).onConflictDoNothing();
        const [w] = await tx.select().from(wallets).where(eq(wallets.userId, userId)).for('update');
        return fn(tx, w!);
      });
      return { replay: false, value };
    } catch (e) {
      if (e instanceof Replay) return { replay: true };
      throw e;
    }
  }

  /**
   * Writes `entries` as one movement on the locked wallet `w` (updated in place). Refuses with 409 not_enough_brass
   * when a pool would go below zero; throws Replay when the rows were written before.
   */
  async write(tx: Tx, w: WalletRow, entries: readonly Entry[]): Promise<Balance> {
    const live = entries.filter((e) => e.delta !== 0);
    if (!live.length) return balanceOf(w);
    const seen = await tx
      .select({ kind: ledger.kind, pool: ledger.pool, ref: ledger.ref })
      .from(ledger)
      .where(inArray(ledger.ref, [...new Set(live.map((e) => e.ref))]));
    const written = live.filter((e) => seen.some((s) => s.kind === e.kind && s.pool === e.pool && s.ref === e.ref));
    if (written.length === live.length) throw new Replay();
    if (written.length) throw new Error(`ledger: part of a movement was written before (${written.map((e) => `${e.kind}/${e.pool}/${e.ref}`).join(', ')})`);

    const at = new Date(this.now());
    let { paid, earned } = w;
    const rows = live.map((e) => {
      if (!Number.isSafeInteger(e.delta)) throw new Error(`ledger: delta ${e.delta} is not an integer`);
      const after = e.pool === 'paid' ? (paid += e.delta) : (earned += e.delta);
      if (after < 0) throw new ApiError(409, 'not_enough_brass', 'Not enough Brass for this', { balance: balanceOf(w) });
      return { userId: w.userId, pool: e.pool, kind: e.kind, delta: e.delta, balanceAfter: after, ref: e.ref, note: e.note ?? null, actor: e.actor, createdAt: at };
    });
    await tx.insert(ledger).values(rows);
    await tx
      .update(wallets)
      .set({ paid, earned, version: sql`${wallets.version} + 1`, updatedAt: at })
      .where(eq(wallets.userId, w.userId));
    w.paid = paid;
    w.earned = earned;
    await this.mintCheck(tx, w, live, at);
    return balanceOf(w);
  }

  /** The mint alarm: flags the wallet (once until cleared) and logs, never blocks the credit itself. */
  private async mintCheck(tx: Tx, w: WalletRow, entries: readonly Entry[], at: Date): Promise<void> {
    const credits = entries.filter((e) => e.delta > 0);
    if (!credits.length) return;
    let reason: string | null = null;
    const big = credits.find((e) => e.kind !== 'purchase' && e.delta > MINT_SINGLE);
    if (big) reason = `${big.kind} of ${big.delta} in one go (over ${MINT_SINGLE})`;
    else {
      const [row] = await tx
        .select({ n: sql<number>`coalesce(sum(${ledger.delta}), 0)::int` })
        .from(ledger)
        .where(and(eq(ledger.userId, w.userId), gt(ledger.delta, 0), gt(ledger.createdAt, new Date(at.getTime() - 86_400_000))));
      if ((row?.n ?? 0) > MINT_DAILY) reason = `${row!.n} credited in 24 h (over ${MINT_DAILY})`;
    }
    if (!reason) return;
    this.log.warn({ alarm: 'mint', userId: w.userId, reason, refs: credits.map((e) => `${e.kind}/${e.ref}`) }, 'mint alarm: currency rose abnormally');
    if (w.flaggedAt) return;
    w.flaggedAt = at;
    w.flagReason = reason;
    await tx.update(wallets).set({ flaggedAt: at, flagReason: reason }).where(eq(wallets.userId, w.userId));
  }

  /**
   * Buys a store item with currency: earned first, then paid, and the item into the inventory, in one transaction.
   * `expectedPrice` is the price the player was shown (409 price_changed when it isn't the price now). `key` makes a
   * retry safe: the same key again answers as the first time did.
   */
  async buy(userId: string, itemId: string, expectedPrice: number, key: string): Promise<{ balance: Balance; owned: string[]; replay: boolean }> {
    const item = getStoreItem(itemId);
    if (!item) throw new ApiError(404, 'not_for_sale', 'That item is not in the store');
    const ref = `${userId}:${key}`;
    const r = await this.locked(userId, async (tx, w) => {
      const [again] = await tx
        .select({ itemId: inventory.itemId })
        .from(inventory)
        .where(and(eq(inventory.userId, userId), eq(inventory.ref, ref)));
      if (again) {
        if (again.itemId !== itemId) throw new ApiError(409, 'idempotency_key_reused', 'That key was used for another item');
        throw new Replay();
      }
      const owned = grantedItems(await this.owned(userId, tx));
      if (owned.has(itemId)) throw new ApiError(409, 'already_owned', 'You own this already');
      const price = priceFor(item, owned);
      if (price !== expectedPrice) throw new ApiError(409, 'price_changed', 'The price has changed: look again before buying', { price });
      const fromEarned = Math.min(w.earned, price);
      const balance = await this.write(tx, w, [
        { pool: 'earned', delta: -fromEarned, kind: 'spend', ref, note: itemId, actor: 'player' },
        { pool: 'paid', delta: -(price - fromEarned), kind: 'spend', ref, note: itemId, actor: 'player' },
      ]);
      await tx.insert(inventory).values({ userId, itemId, source: 'purchase', ref, acquiredAt: new Date(this.now()) });
      return balance;
    });
    return { balance: r.replay ? await this.balance(userId) : r.value, owned: await this.owned(userId), replay: r.replay };
  }

  /** An item given (the owner's grant, a make-good): owned like a bought one. False when it was owned already. */
  async grantItem(tx: Tx | Db, userId: string, itemId: string, ref: string): Promise<boolean> {
    const added = await tx.insert(inventory).values({ userId, itemId, source: 'grant', ref, acquiredAt: new Date(this.now()) }).onConflictDoNothing().returning({ itemId: inventory.itemId });
    return added.length > 0;
  }

  /** One line in the owner's store audit (append-only). */
  async audit(tx: Tx | Db, actor: string, action: string, userId: string | null, reason: string, detail: Record<string, unknown>): Promise<void> {
    await tx.insert(storeAudit).values({ at: new Date(this.now()), actor, action, userId, reason, detail });
  }

  // ---------------------------------------------------------------- reconciliation

  /**
   * Accounts whose cached balance isn't what their ledger says (the sum of a pool's rows, and its latest row's
   * balance_after): empty when everything holds. `userId` checks one account.
   */
  async reconcile(userId?: string): Promise<{ userId: string; pool: LedgerPool; wallet: number; sum: number; last: number }[]> {
    const one = userId ? sql`and w.user_id = ${userId}` : sql``;
    type Row = { user_id: string; pool: LedgerPool; wallet: number; sum: number; last: number };
    const rows = rowsOf<Row>(
      await this.db.execute(sql`
      with pools as (
        select w.user_id, p.pool, case p.pool when 'paid' then w.paid else w.earned end as wallet
        from wallets w cross join (values ('paid'), ('earned')) as p(pool)
        where true ${one}
      )
      select p.user_id, p.pool, p.wallet,
        coalesce((select sum(l.delta) from ledger l where l.user_id = p.user_id and l.pool = p.pool), 0)::int as sum,
        coalesce((select l.balance_after from ledger l where l.user_id = p.user_id and l.pool = p.pool order by l.id desc limit 1), 0)::int as last
      from pools p`),
    );
    return rows.filter((r) => r.wallet !== r.sum || r.wallet !== r.last).map((r) => ({ userId: r.user_id, pool: r.pool, wallet: r.wallet, sum: r.sum, last: r.last }));
  }

  async flagged(): Promise<{ userId: string; at: string; reason: string | null; balance: Balance }[]> {
    const rows = await this.db.select().from(wallets).where(isNotNull(wallets.flaggedAt)).orderBy(desc(wallets.flaggedAt)).limit(200);
    return rows.map((w) => ({ userId: w.userId, at: w.flaggedAt!.toISOString(), reason: w.flagReason, balance: balanceOf(w) }));
  }

  async clearFlag(userId: string): Promise<boolean> {
    const r = await this.db.update(wallets).set({ flaggedAt: null, flagReason: null }).where(and(eq(wallets.userId, userId), isNotNull(wallets.flaggedAt))).returning({ userId: wallets.userId });
    return r.length > 0;
  }

  async wallet(userId: string): Promise<WalletRow | null> {
    const [w] = await this.db.select().from(wallets).where(eq(wallets.userId, userId));
    return w ?? null;
  }

  // ---------------------------------------------------------------- spending limits (docs/17 §2.6)

  /** The limit in force now (a raise whose 72 h have passed has taken effect). */
  async limits(userId: string): Promise<Limits> {
    const w = await this.wallet(userId);
    if (!w) return { monthlyCapCents: DEFAULT_CAP_CENTS, pendingRaise: null };
    if (w.capRaiseAt && w.capRaiseCents !== null && w.capRaiseAt.getTime() <= this.now()) {
      await this.db.update(wallets).set({ monthlyCapCents: w.capRaiseCents, capRaiseCents: null, capRaiseAt: null }).where(eq(wallets.userId, userId));
      return { monthlyCapCents: w.capRaiseCents, pendingRaise: null };
    }
    return { monthlyCapCents: w.monthlyCapCents, pendingRaise: w.capRaiseAt && w.capRaiseCents !== null ? { capCents: w.capRaiseCents, at: w.capRaiseAt.toISOString() } : null };
  }

  /** Lower: at once (and any raise waiting is dropped). Higher (up to $500): in 72 h; the caller checked the password. */
  async setCap(userId: string, capCents: number): Promise<Limits> {
    if (!Number.isInteger(capCents) || capCents < 0 || capCents > MAX_CAP_CENTS) throw new ApiError(400, 'invalid_cap', `The monthly limit is $0–$${MAX_CAP_CENTS / 100}`);
    const current = await this.limits(userId);
    const at = new Date(this.now());
    await this.db.insert(wallets).values({ userId, updatedAt: at }).onConflictDoNothing();
    if (capCents <= current.monthlyCapCents) await this.db.update(wallets).set({ monthlyCapCents: capCents, capRaiseCents: null, capRaiseAt: null }).where(eq(wallets.userId, userId));
    else await this.db.update(wallets).set({ capRaiseCents: capCents, capRaiseAt: new Date(at.getTime() + CAP_RAISE_DELAY_MS) }).where(eq(wallets.userId, userId));
    return this.limits(userId);
  }
}
