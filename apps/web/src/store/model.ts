/**
 * The Store screen's logic without a DOM (screen.ts draws it): the API's view (apps/api store/routes.ts), money and
 * currency in words, what each answer means to the player, and the way back from Flutterwave's page. Every price
 * and balance comes from the API; nothing here makes one up.
 */
import { getCosmetic, getKillEffect } from '@military-forge/content';
import art from './art.json';

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
  /** the launch gift: free to claim now (STORE_CLAIMABLE) */
  claimable: boolean;
}

export interface StoreAccount {
  canBuy: boolean;
  reason: 'guest' | 'age' | 'banned' | null;
  /** the account gave its 18+ answer (saved with it, or with a claim): a claim needs no birth year */
  adult: boolean;
  balance: { paid: number; earned: number; total: number };
  owned: string[];
  /** the spending limit; null while payments are off */
  limits: { monthlyCapCents: number; spentCents: number; leftCents: number; pendingRaise: { capCents: number; at: string } | null; coolOffUntil: string | null } | null;
}

export type StoreView =
  | { enabled: false }
  | {
      enabled: true;
      /** Flutterwave's keys are set: currency can be bought */
      payments: boolean;
      mode: 'test' | 'live' | null;
      /** the launch gift is open (until: its end, or null) */
      claim: { until: string | null } | null;
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
  // nothing to buy while payments are off: the launch gift has its own rule (claimRule)
  if (!view.enabled || !view.payments) return null;
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
    case 'not_claimable':
      return 'That item isn’t part of the launch gift.';
    case 'claim_ended':
      return 'The launch gift has ended.';
    case 'age_required':
    case 'invalid_birth_year':
      return 'Pick the year you were born to claim it.';
    case 'underage':
      return 'Military Forge is for players 18 and older.';
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
export function limitLine(l: NonNullable<StoreAccount['limits']>): string {
  const left = formatMoney(l.leftCents, 'USD');
  const cap = formatMoney(l.monthlyCapCents, 'USD').replace(/\.00$/, '');
  return `${left} of ${cap} left in your monthly limit`;
}

/** A bundle the limit or the wallet cap would refuse now (shown disabled, with why). */
export function bundleBlocked(b: StoreBundle, account: StoreAccount | null, walletCap: number): string | null {
  if (!account?.limits) return null;
  if (account.limits.coolOffUntil && Date.parse(account.limits.coolOffUntil) > Date.now()) return 'Store break: back within the hour';
  if (b.price.USD > account.limits.leftCents) return 'Over your monthly limit';
  if (account.balance.total + b.brass > walletCap) return 'Your wallet would be full';
  return null;
}

/** A kill effect's baked frame strip (scripts/store-art.mjs): the loop and the frame shown still. */
export interface EffectArt {
  image: string;
  frames: number;
  still: number;
  ms: number;
  name: string;
}

/**
 * What a store item looks like on its card: its gun rendered side on, and the kill effect it carries as a looping
 * strip, both baked from the game's renderer (scripts/store-art.mjs → src/store/art.json, the images under
 * /assets/store/). null where nothing was baked (the card shows the gun's glyph).
 */
export function storeArt(itemId: string, base: string = import.meta.env.BASE_URL): { gun: string | null; fx: EffectArt | null } {
  const def = getCosmetic(itemId);
  const gun = def?.assets.model ? (art.guns as Record<string, { image: string } | undefined>)[def.assets.model] : undefined;
  const effect = def?.killEffect ? (art.killEffects as Record<string, Omit<EffectArt, 'name'> | undefined>)[def.killEffect] : undefined;
  return {
    gun: gun ? `${base}assets/${gun.image}` : null,
    fx: effect && def?.killEffect ? { ...effect, image: `${base}assets/${effect.image}`, name: getKillEffect(def.killEffect)?.name ?? def.killEffect } : null,
  };
}

/**
 * The launch gift for `item` (docs/17 §9): the item itself when it's claimable, or the claimable tier that includes it
 * (the Forged skin comes with "+ Stardust"); null when there's nothing to claim for it.
 */
export function giftFor(item: Pick<StoreItemView, 'itemId' | 'claimable' | 'owned'>, items: readonly StoreItemView[]): StoreItemView | null {
  if (item.owned) return null;
  if (item.claimable) return items.find((i) => i.itemId === item.itemId) ?? null;
  return items.find((i) => i.claimable && !i.owned && i.includes.includes(item.itemId)) ?? null;
}

/**
 * What stands between this player and a claim: nothing ('ok'), the 18+ question still to answer on this device
 * ('ask'), or an under-18 answer ('minor'). An account that answered (saved, or claimed before) needs nothing more.
 */
export function claimRule(account: StoreAccount | null, device: 'adult' | 'minor' | null): 'ok' | 'ask' | 'minor' | 'signin' {
  if (!account) return 'signin';
  if (account.adult) return 'ok';
  if (device === 'minor') return 'minor';
  return device === 'adult' ? 'ok' : 'ask';
}
