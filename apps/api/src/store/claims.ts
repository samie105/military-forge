/**
 * The launch gift (the owner, 28 Oct: "make it claimable, for now"; docs/17 §9): the store items in STORE_CLAIMABLE
 * can be claimed free, once per account, until STORE_CLAIM_UNTIL, whether or not Flutterwave's keys are set. A
 * claim is an `inventory` row (source `promo`) plus a `store_audit` line, written together; it never moves currency.
 * Claiming again, or claiming what the account already owns (bought, granted, or included in a higher tier), changes
 * nothing.
 *
 * The 18+ rule is #311's: a saved account answered it when it was saved (users.adult_confirmed_at); a guest (or an
 * account saved before the rule) sends the answer its device gave (shell/age.ts), checked here the same way
 * auth/accountRoutes.ts checks a save, and kept on the account. A guest's claim stays on the guest account, and
 * saving the account keeps it (the same user id).
 */
import { birthYearAnswer } from '@military-forge/shared';
import { grantedItems } from '@military-forge/content';
import { eq } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { inventory, users } from '../db/schema';
import { ApiError } from '../http/errors';
import type { WalletService } from './wallet';

export class ClaimService {
  constructor(
    private readonly db: Db,
    private readonly wallet: WalletService,
    private readonly config: Config['claims'],
    private readonly now: () => number,
  ) {}

  /** Claims are open: some item is claimable and the end date (if any) hasn't passed. */
  open(): boolean {
    return this.config.items.length > 0 && (this.config.until === null || this.now() < this.config.until);
  }

  /** When claims end (ISO), or null for no end date. */
  until(): string | null {
    return this.config.until === null ? null : new Date(this.config.until).toISOString();
  }

  claimable(itemId: string): boolean {
    return this.open() && this.config.items.includes(itemId);
  }

  /**
   * Claims `itemId` for the account. `age`: the device's 18+ answer, needed when the account hasn't given one.
   * Returns what the account owns after, and whether it owned the item already (nothing written then).
   */
  async claim(userId: string, itemId: string, age: { birthYear?: number; adult?: boolean }): Promise<{ owned: string[]; already: boolean }> {
    if (!this.config.items.includes(itemId)) throw new ApiError(404, 'not_claimable', 'That item can’t be claimed');
    if (!this.open()) throw new ApiError(410, 'claim_ended', 'The launch gift has ended');
    const [user] = await this.db.select({ status: users.status, adult: users.adultConfirmedAt }).from(users).where(eq(users.id, userId));
    if (!user || user.status !== 'active') throw new ApiError(403, 'store_closed', 'The store is closed for this account');
    if (!user.adult) await this.confirmAdult(userId, age);

    const already = await this.db.transaction(async (tx) => {
      if (grantedItems(await this.wallet.owned(userId, tx)).has(itemId)) return true;
      const ref = `promo:${itemId}`;
      const added = await tx.insert(inventory).values({ userId, itemId, source: 'promo', ref, acquiredAt: new Date(this.now()) }).onConflictDoNothing().returning({ itemId: inventory.itemId });
      if (!added.length) return true;
      await this.wallet.audit(tx, 'player', 'promo_claim', userId, 'launch gift', { itemId, ref });
      return false;
    });
    return { owned: await this.wallet.owned(userId), already };
  }

  /** #311's check of the 18+ answer (auth/accountRoutes.ts requireAdult), kept on the account once it passes. */
  private async confirmAdult(userId: string, age: { birthYear?: number; adult?: boolean }): Promise<void> {
    if (age.adult !== true || age.birthYear === undefined) throw new ApiError(400, 'age_required', 'Confirm you are 18 or older, with the year you were born');
    const answer = birthYearAnswer(age.birthYear, new Date(this.now()).getUTCFullYear());
    if (answer === 'invalid') throw new ApiError(400, 'invalid_birth_year', "That year doesn't look right");
    if (answer === 'minor') throw new ApiError(403, 'underage', 'Military Forge is for players 18 and over');
    await this.db.update(users).set({ adultConfirmedAt: new Date(this.now()), birthYear: age.birthYear }).where(eq(users.id, userId));
  }
}
