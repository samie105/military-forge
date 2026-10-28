/**
 * What the store sells and for how much (docs/17 §2.3, §3.1, §3.3). Prices live here, on the server only: the
 * client shows what GET /store says and a buy names the price it was shown, which must still be the price
 * (a stale one is refused, never charged).
 *
 * DRAFT PRICES: the USD tier is docs/17 §2.3's; the naira tier is a placeholder until the local price research
 * (docs/17 Q3). The currency's name is not final either (Q1): "Brass" is the doc's placeholder.
 */
import { getCosmetic } from '@military-forge/content';

export const CURRENCY_NAME = 'Brass';

/** Money the store takes. Amounts are in minor units (kobo, cents). */
export const MONEY = ['NGN', 'USD'] as const;
export type Money = (typeof MONEY)[number];

export interface Bundle {
  id: string;
  brass: number;
  /** the bonus over the base rate, % (shown, never a countdown) */
  bonusPct: number;
  /** price per currency, minor units */
  price: Record<Money, number>;
  /** what the spending limit counts: the USD-tier price in cents, whatever was paid in */
  capCents: number;
}

const bundle = (id: string, brass: number, bonusPct: number, usdCents: number, ngnKobo: number): Bundle => ({ id, brass, bonusPct, price: { USD: usdCents, NGN: ngnKobo }, capCents: usdCents });

/** The bundles (docs/17 §2.3); no bigger bundle than the Crate (§2.6). */
export const BUNDLES: readonly Bundle[] = [
  bundle('brass_250', 250, 0, 249, 2_500_00),
  bundle('brass_500', 500, 0, 499, 5_000_00),
  bundle('brass_1050', 1050, 5, 999, 9_900_00),
  bundle('brass_2200', 2200, 10, 1999, 19_900_00),
  bundle('brass_5750', 5750, 15, 4999, 49_900_00),
];

export function getBundle(id: string): Bundle | undefined {
  return BUNDLES.find((b) => b.id === id);
}

export interface StoreItem {
  /** a cosmetic id in @military-forge/content */
  itemId: string;
  /** the line it belongs to (shown together) */
  line: string;
  price: number;
  /**
   * The kill-effect tier's upgrade (docs/17 §3.7): a player who owns `from` pays `price` instead (1,050 to add the
   * effect to a Forged skin they own).
   */
  upgrade?: { from: string; price: number };
}

/** On sale now: the K-47 Galaxy Relic line (docs/17 §9 step 1), Forged 1,050 and Forged + kill effect 2,200. */
export const STORE_ITEMS: readonly StoreItem[] = [
  { itemId: 'skin_k47_galaxy_relic', line: 'k47_galaxy_relic', price: 1050 },
  { itemId: 'skin_k47_galaxy_relic_fx', line: 'k47_galaxy_relic', price: 2200, upgrade: { from: 'skin_k47_galaxy_relic', price: 1050 } },
];

for (const item of STORE_ITEMS) {
  const def = getCosmetic(item.itemId);
  if (!def || def.source.kind !== 'store') throw new Error(`store/catalog.ts: ${item.itemId} is not a store item in content`);
}

export function getStoreItem(id: string): StoreItem | undefined {
  return STORE_ITEMS.find((i) => i.itemId === id);
}

/** What `item` costs a player who owns `owned` (the upgrade price when they own its base). */
export function priceFor(item: StoreItem, owned: ReadonlySet<string>): number {
  return item.upgrade && owned.has(item.upgrade.from) ? item.upgrade.price : item.price;
}

/**
 * The money an item's price is shown with (docs/17 §2.2): what the cheapest bundle that covers it costs, marked ≈
 * by the client. Null when no single bundle covers it.
 */
export function moneyFor(brass: number): { bundleId: string; price: Record<Money, number> } | null {
  const b = BUNDLES.find((x) => x.brass >= brass);
  return b ? { bundleId: b.id, price: { ...b.price } } : null;
}

/** "₦9,900" / "$9.99" for logs and the provider's description. */
export function formatMoney(minor: number, currency: Money): string {
  const major = minor / 100;
  return currency === 'NGN' ? `₦${major.toLocaleString('en-NG', { maximumFractionDigits: 2 })}` : `$${major.toFixed(2)}`;
}

/** Wallet cap (docs/17 §2.5): a checkout that would take the balance past it is refused. */
export const WALLET_CAP = 20_000;
/** Spending limits (docs/17 §2.6): $100 a month by default, up to $500 (after 72 h, with the password). */
export const DEFAULT_CAP_CENTS = 10_000;
export const MAX_CAP_CENTS = 50_000;
export const CAP_RAISE_DELAY_MS = 72 * 3_600_000;
/** the window the monthly limit counts over: the last 30 days (no month-boundary double) */
export const CAP_WINDOW_MS = 30 * 86_400_000;
/** after 5 purchases in 24 h, a 1 h pause (docs/17 §2.6) */
export const COOL_OFF = { purchases: 5, windowMs: 24 * 3_600_000, pauseMs: 3_600_000 };
/** unspent paid currency can go back to the payment method for 14 days (docs/17 §2.6) */
export const REFUND_WINDOW_MS = 14 * 86_400_000;
/** a checkout not paid within this long is treated as abandoned (no longer counted against the limit) */
export const CHECKOUT_TTL_MS = 60 * 60_000;
/**
 * Mint alarm (store/wallet.ts): credits to one account in 24 h above this, or a single non-purchase credit above
 * MINT_SINGLE, flag the account for the owner. Twice the largest bundle plus change: a big buyer still passes.
 */
export const MINT_DAILY = 12_000;
export const MINT_SINGLE = 5_000;
