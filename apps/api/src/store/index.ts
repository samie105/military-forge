/**
 * The store's services, made once per process (app.ts; index.ts also runs the payments sweep): the wallet and
 * ledger always (ownership and the owner's tools need them), the payments only with Flutterwave's keys.
 */
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { Logger } from '../log';
import { Flutterwave } from './flutterwave';
import { PaymentService } from './payments';
import { WalletService } from './wallet';

export interface Store {
  wallet: WalletService;
  flutterwave: Flutterwave | null;
  /** null: the store is off (no Flutterwave keys) */
  payments: PaymentService | null;
}

/** `fetchImpl`: what talks to Flutterwave (tests pass a fake). */
export function createStore(config: Pick<Config, 'flutterwave' | 'cosmeticGrants'>, db: Db, now: () => number, log: Logger, fetchImpl?: typeof fetch): Store {
  const wallet = new WalletService(db, now, log, config.cosmeticGrants);
  const flutterwave = config.flutterwave ? new Flutterwave(config.flutterwave, fetchImpl) : null;
  return { wallet, flutterwave, payments: flutterwave ? new PaymentService(db, wallet, flutterwave, now, log) : null };
}

/** How often the sweep looks for payments that were paid but never credited (docs/17 §2.5: ≤ 15 min). */
export const SWEEP_EVERY_MS = 5 * 60_000;
