/**
 * The Store screen's logic without a DOM (screen.ts draws it): the API's view (apps/api store/routes.ts), money and
 * currency in words, what each answer means to the player, and the way back from Flutterwave's page. Every price
 * and balance comes from the API; nothing here makes one up.
 */

export type Money = 'NGN' | 'USD';

export interface StoreBundle {
  id: string;
  brass: number;
  bonusPct: number;
  /** minor units (kobo, cents) */
  price: Record<Money, number>;
}

export interface StoreItemView {
  itemId: string;
  line: string;
  name: string;
  tier: string | null;
  weaponId: string | null;
  killEffect: string | null;
  includes: string[];
  /** what it costs this player now (the upgrade price when they own its base) */
  price: number;
  fullPrice: number;
  upgrade: boolean;
  /** the cheapest bundle that covers the price: the money shown next to it (≈) */
  money: { bundleId: string; price: Record<Money, number> } | null;
  owned: boolean;
}

export interface StoreAccount {
  canBuy: boolean;
  reason: 'guest' | 'age' | 'banned' | null;
  balance: { paid: number; earned: number; total: number };
  owned: string[];
  limits: { monthlyCapCents: number; spentCents: number; leftCents: number; pendingRaise: { capCents: number; at: string } | null; coolOffUntil: string | null };
}

export type StoreView =
  | { enabled: false }
  | {
      enabled: true;
      mode: 'test' | 'live';
      currency: { name: string; walletCap: number };
      bundles: StoreBundle[];
      items: StoreItemView[];
      account: StoreAccount | null;
    };

export interface PaymentView {
  id: string;
  bundleId: string;
  brass: number;
  amountMinor: number;
  currency: string;
  status: 'created' | 'paid' | 'failed' | 'refund_pending' | 'refunded';
  createdAt: string;
  paidAt: string | null;
  refundable: boolean;
}

/** `₦9,900` / `$9.99` */
export function formatMoney(minor: number, currency: Money | string): string {
  const major = minor / 100;
  if (currency === 'NGN') return `₦${major.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
  if (currency === 'USD') return `$${major.toFixed(2)}`;
  return `${major.toFixed(2)} ${currency}`;
}

/** `1,050` */
export function formatBrass(n: number): string {
  return n.toLocaleString('en');
}

/** The money line under a currency price (docs/17 §2.2): `≈ ₦9,900 · $9.99`, or '' when no bundle covers it. */
export function moneyLine(item: Pick<StoreItemView, 'money'>): string {
  return item.money ? `≈ ${formatMoney(item.money.price.NGN, 'NGN')} · ${formatMoney(item.money.price.USD, 'USD')}` : '';
}

/** A tier's name for people: what the player gets, in a few words. */
export function tierLabel(item: Pick<StoreItemView, 'tier' | 'killEffect'>): string {
  if (item.tier === 'forged_kill_effect') return 'Forged + kill effect';
  if (item.tier === 'forged') return 'Forged blueprint';
  return item.tier ? item.tier[0]!.toUpperCase() + item.tier.slice(1) : 'Item';
}

/** What each tier is, in one line (docs/17 §3.3, §3.7): same gun, same stats, said plainly. */
export function tierLine(item: Pick<StoreItemView, 'tier' | 'killEffect' | 'upgrade'>): string {
  if (item.tier === 'forged_kill_effect') return item.upgrade ? 'Adds the stardust kill effect to the Galaxy Relic you own. Same gun, same stats.' : 'The Galaxy Relic plus its stardust kill effect, seen by everyone. Same gun, same stats.';
  if (item.tier === 'forged') return 'A reshaped K-47, blueprint style: carved parts and a subtle glow. Same gun, same stats.';
  return 'A look for your gun. Same gun, same stats.';
}

/** Why the player can't buy, in their words (and what to do), or null when they can. */
export function blockedText(view: StoreView): { title: string; line: string; action: 'save' | null } | null {
  if (!view.enabled) return null;
  const a = view.account;
  if (!a) return { title: 'Sign in to buy', line: 'The store needs your account. Check your connection, then open the store again.', action: null };
  if (a.reason === 'guest') return { title: 'Save your account to buy', line: 'Purchases belong to a saved account, so they’re never lost with a device. It takes a minute.', action: 'save' };
  if (a.reason === 'age') return { title: 'The store is for players 18 and older', line: 'Save your account with your year of birth to use the store.', action: 'save' };
  if (!a.canBuy) return { title: 'The store is closed for this account', line: 'Contact support if you think this is a mistake.', action: null };
  return null;
}

/** The API's error codes in the player's words. */
export function errorText(code: string, extra: Record<string, unknown> = {}): string {
  switch (code) {
    case 'not_enough_brass':
      return 'Not enough Brass for this yet.';
    case 'price_changed':
      return `The price changed to ${formatBrass(Number(extra.price))} Brass. Check it and try again.`;
    case 'already_owned':
      return 'You own this already.';
    case 'spending_limit':
      return 'That would pass your monthly spending limit.';
    case 'cool_off':
      return 'You’ve made 5 purchases today, so the store takes a 1-hour break. Nothing is lost.';
    case 'wallet_full':
      return 'Your wallet is full. Spend some Brass first.';
    case 'save_account_first':
      return 'Save your account to buy.';
    case 'adult_required':
      return 'The store is for players 18 and older.';
    case 'provider_error':
      return 'The payment provider isn’t answering. Nothing was charged. Try again in a minute.';
    case 'brass_spent':
      return 'Only unspent Brass can be refunded.';
    case 'refund_window':
      return 'Refunds are for 14 days after a purchase.';
    case 'refund_failed':
      return 'The refund didn’t go through. Your Brass is back. Try again later.';
    case 'store_off':
      return 'The store isn’t open yet.';
    case 'password_required':
      return 'Enter your password to raise the limit.';
    case 'rate_limited':
      return 'Too many tries. Wait a minute.';
    case 'network':
      return 'Can’t reach the server. Check your connection.';
    default:
      return 'Something went wrong. Nothing was charged.';
  }
}

/** Flutterwave sends the player back to `/?store=return&status=…&tx_ref=…&transaction_id=…`: what came back, or null. */
export interface CheckoutReturn {
  txRef: string;
  transactionId: string | null;
  status: string | null;
}

export function readReturn(search: string): CheckoutReturn | null {
  const p = new URLSearchParams(search);
  if (p.get('store') !== 'return') return null;
  const txRef = p.get('tx_ref');
  if (!txRef || !/^pay_[0-9a-z]{26}$/.test(txRef)) return null;
  const id = p.get('transaction_id');
  return { txRef, transactionId: id && /^\d{1,20}$/.test(id) ? id : null, status: p.get('status') };
}

/** The address without the return's parameters (so a reload doesn't confirm again, and nothing lingers in history). */
export function withoutReturn(href: string): string {
  const u = new URL(href);
  for (const k of ['store', 'status', 'tx_ref', 'transaction_id']) u.searchParams.delete(k);
  return `${u.pathname}${u.search}${u.hash}`;
}

/** The limit line: `$50.02 of $100 left this month`. */
export function limitLine(l: StoreAccount['limits']): string {
  const left = formatMoney(l.leftCents, 'USD');
  const cap = formatMoney(l.monthlyCapCents, 'USD').replace(/\.00$/, '');
  return `${left} of ${cap} left in your monthly limit`;
}

/** A bundle the limit or the wallet cap would refuse now (shown disabled, with why). */
export function bundleBlocked(b: StoreBundle, account: StoreAccount | null, walletCap: number): string | null {
  if (!account) return null;
  if (account.limits.coolOffUntil && Date.parse(account.limits.coolOffUntil) > Date.now()) return 'Store break: back within the hour';
  if (b.price.USD > account.limits.leftCents) return 'Over your monthly limit';
  if (account.balance.total + b.brass > walletCap) return 'Your wallet would be full';
  return null;
}
