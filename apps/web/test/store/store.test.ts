/**
 * The Store screen (src/store/): what it shows for each account (a guest, no 18+ answer, a buyer), prices in Brass
 * with naira and dollars beside them, the confirm, Owned → Wear it, the API's answers in words, the way back from
 * Flutterwave's page, Wear it putting the skin on; and the admin page's Store helpers.
 */
import { DEFAULT_COSMETIC_LOADOUT, type CosmeticLoadout } from '@military-forge/content';
import { describe, expect, it } from 'vitest';
import { GRANTABLE, ledgerLine, money, signed, storeAdmin, StoreAdminError } from '../../src/admin/store';
import { blockedText, bundleBlocked, claimRule, errorText, giftFor, formatMoney, limitLine, moneyLine, readReturn, withoutReturn, type StoreAccount, type StoreView } from '../../src/store/model';
import { wearItem } from '../../src/store/route';
import { balanceChip, storeBody, type StoreState } from '../../src/store/screen';

const ITEMS = [
  { itemId: 'skin_k47_galaxy_relic', line: 'k47_galaxy_relic', name: 'Galaxy Relic', tier: 'forged', weaponId: 'k47', killEffect: null, includes: [], price: 1050, fullPrice: 1050, upgrade: false, money: { bundleId: 'brass_1050', price: { NGN: 990_000, USD: 999 } }, owned: false, claimable: false },
  { itemId: 'skin_k47_galaxy_relic_fx', line: 'k47_galaxy_relic', name: 'Galaxy Relic + Stardust Shatter', tier: 'forged_kill_effect', weaponId: 'k47', killEffect: 'stardust', includes: ['skin_k47_galaxy_relic'], price: 2200, fullPrice: 2200, upgrade: false, money: { bundleId: 'brass_2200', price: { NGN: 1_990_000, USD: 1999 } }, owned: false, claimable: false },
];
const BUNDLES = [
  { id: 'brass_250', brass: 250, bonusPct: 0, price: { NGN: 250_000, USD: 249 } },
  { id: 'brass_5750', brass: 5750, bonusPct: 15, price: { NGN: 4_990_000, USD: 4999 } },
];

const account = (over: Partial<StoreAccount> = {}): StoreAccount => ({
  canBuy: true,
  reason: null,
  adult: true,
  balance: { paid: 1200, earned: 50, total: 1250 },
  owned: [],
  limits: { monthlyCapCents: 10_000, spentCents: 999, leftCents: 9001, pendingRaise: null, coolOffUntil: null },
  ...over,
});
const view = (acc: StoreAccount | null, items = ITEMS): StoreView => ({ enabled: true, payments: true, mode: 'test', claim: null, currency: { name: 'Brass', walletCap: 20_000 }, bundles: BUNDLES, items, account: acc });
const state = (v: StoreView | null, over: Partial<StoreState> = {}): StoreState => ({ view: v, failed: null, notice: null, confirm: null, busy: false, payments: null, deviceAge: null, ...over });

describe('the Store screen', () => {
  it('shows the line in Brass with the money beside it, and the bundles at their naira and dollar prices', () => {
    const html = storeBody(state(view(account())));
    expect(html).toContain('Galaxy Relic');
    expect(html).toContain('<b>1,050</b> Brass');
    expect(html).toContain('≈ ₦9,900 · $9.99');
    expect(html).toContain('<b>2,200</b> Brass');
    expect(html).toContain('₦2,500');
    expect(html).toContain('$49.99');
    expect(html).toContain('+15% bonus');
    expect(html).toContain('$90.01 of $100 left in your monthly limit');
    // no fake urgency
    expect(html).not.toMatch(/only \d+ left|ends in|hurry|limited time/i);
    expect(balanceChip(state(view(account())))).toContain('<b>1,250</b> Brass');
    expect(balanceChip(state(view(account())))).toContain('Test mode');
  });

  it('a guest sees the store and "Save your account to buy"; buttons wait; no 18+ answer says so', () => {
    const guest = storeBody(state(view(account({ canBuy: false, reason: 'guest' }))));
    expect(guest).toContain('Save your account to buy');
    expect(guest).toContain('data-action="save"');
    expect(guest).toMatch(/data-buy="skin_k47_galaxy_relic" disabled/);
    expect(guest).toMatch(/data-bundle="brass_250" data-currency="NGN" disabled/);
    expect(guest).not.toContain('monthly limit');
    expect(blockedText(view(account({ canBuy: false, reason: 'age' })))?.title).toBe('The store is for players 18 and older');
    expect(blockedText(view(account()))).toBeNull();
    // no promise of a support contact that doesn't exist: the way to reach us is the in-game report (audit 28 Oct)
    expect(blockedText(view(account({ canBuy: false, reason: 'banned' })))?.line).toMatch(/Settings → Network/);
    expect(blockedText(view(null))?.title).not.toMatch(/Sign in/);
    expect(storeBody(state({ enabled: false }))).toContain('The store opens soon');
  });

  it('the confirm shows the price in Brass and naira and the balance after; short of Brass it says how much more', () => {
    let html = storeBody(state(view(account()), { confirm: { kind: 'item', item: ITEMS[0]! } }));
    expect(html).toContain('Buy Galaxy Relic?');
    expect(html).toContain('≈ ₦9,900 · $9.99');
    expect(html).toContain('<b>200 Brass</b>');
    expect(html).toContain('Buy for 1,050 Brass');
    html = storeBody(state(view(account()), { confirm: { kind: 'item', item: ITEMS[1]! } }));
    expect(html).toContain('950 more needed');
    expect(html).not.toContain('data-action="confirm"');
    html = storeBody(state(view(account()), { confirm: { kind: 'bundle', bundle: BUNDLES[0]!, currency: 'NGN' } }));
    expect(html).toContain('250 Brass for ₦2,500');
    expect(html).toContain('Continue to pay ₦2,500');
    expect(html).toContain('No real money is taken');
  });

  it('each confirm says, before the button, what can and can’t be refunded (the legal review, 29 Oct: digital content supplied at once)', () => {
    let html = storeBody(state(view(account()), { confirm: { kind: 'item', item: ITEMS[0]! } }));
    expect(html).toContain('can’t be returned for Brass or money');
    expect(html.indexOf('can’t be returned')).toBeLessThan(html.indexOf('data-action="confirm"'));
    html = storeBody(state(view(account()), { confirm: { kind: 'bundle', bundle: BUNDLES[0]!, currency: 'NGN' } }));
    expect(html).toContain('refund this purchase for 14 days while all of its Brass is unspent');
    expect(html).toContain('Once you spend any of it, this purchase can’t be refunded');
    expect(html.indexOf('Once you spend any of it')).toBeLessThan(html.indexOf('data-action="confirm"'));
  });

  it('owned items say so and offer Wear it; the effect tier at the upgrade price (players own the base, so not "owner’s price": audit 28 Oct) shows what it was', () => {
    const items = [
      { ...ITEMS[0]!, owned: true },
      { ...ITEMS[1]!, price: 1050, upgrade: true, money: ITEMS[0]!.money },
    ];
    const html = storeBody(state(view(account({ owned: ['skin_k47_galaxy_relic'] }), items)));
    expect(html).toContain('Owned');
    expect(html).toContain('data-wear="skin_k47_galaxy_relic"');
    expect(html).toContain('<s class="mf-st__was">2,200</s>');
    expect(html).toContain('Upgrade price');
    expect(html).not.toContain('Owner’s price');
    // the effect has one name everywhere: the content's (kill-effects.json)
    expect(html).toContain('Adds the Stardust Shatter kill effect');
  });

  it('a bundle the limit, the cool-off or the wallet cap would refuse is shown off, with why', () => {
    expect(bundleBlocked(BUNDLES[1]!, account({ limits: { ...account().limits!, leftCents: 4000 } }), 20_000)).toBe('Over your monthly limit');
    expect(bundleBlocked(BUNDLES[0]!, account({ balance: { paid: 19_900, earned: 0, total: 19_900 } }), 20_000)).toBe('Your wallet would be full');
    expect(bundleBlocked(BUNDLES[0]!, account({ limits: { ...account().limits!, coolOffUntil: new Date(Date.now() + 60_000).toISOString() } }), 20_000)).toMatch(/break/);
    expect(bundleBlocked(BUNDLES[0]!, account(), 20_000)).toBeNull();
    expect(limitLine({ ...account().limits!, leftCents: 0 })).toBe('$0.00 of $100 left in your monthly limit');
  });

  it('the API’s answers in words; money formats', () => {
    expect(errorText('price_changed', { price: 2200 })).toBe('The price changed to 2,200 Brass. Check it and try again.');
    expect(errorText('provider_error')).toContain('Nothing was charged');
    expect(errorText('something_new')).toContain('Nothing was charged');
    expect(formatMoney(4_990_000, 'NGN')).toBe('₦49,900');
    expect(formatMoney(249, 'USD')).toBe('$2.49');
    expect(moneyLine({ money: null })).toBe('');
  });

  it('reads the way back from Flutterwave and takes it off the address', () => {
    const back = readReturn('?store=return&status=successful&tx_ref=pay_01jbxyz0000000000000000000&transaction_id=9000001');
    expect(back).toEqual({ txRef: 'pay_01jbxyz0000000000000000000', transactionId: '9000001', status: 'successful' });
    expect(readReturn('?store=return&status=cancelled&tx_ref=pay_01jbxyz0000000000000000000')).toMatchObject({ transactionId: null, status: 'cancelled' });
    expect(readReturn('?store=return&tx_ref=../../evil')).toBeNull();
    expect(readReturn('?app')).toBeNull();
    expect(withoutReturn('https://play.example.com/?store=return&status=successful&tx_ref=pay_x&transaction_id=1&app#/x')).toBe('/?app=#/x');
  });

  it('Wear it puts the skin in its gun’s slot and saves it', async () => {
    let saved: CosmeticLoadout | null = null;
    const store = { label: 'test', load: async () => DEFAULT_COSMETIC_LOADOUT, save: async (l: CosmeticLoadout) => void (saved = l) };
    await wearItem(store, 'skin_k47_galaxy_relic_fx');
    expect(saved!.items.skin_k47).toBe('skin_k47_galaxy_relic_fx');
    expect(saved!.items.bodyType).toBe(DEFAULT_COSMETIC_LOADOUT.items.bodyType);
  });
});

describe('the launch gift on the Store screen (docs/17 §9)', () => {
  const gift = (over: Partial<Extract<StoreView, { enabled: true }>> = {}, items = ITEMS.map((i) => ({ ...i, claimable: i.itemId === 'skin_k47_galaxy_relic_fx' }))): StoreView => ({
    ...(view(account({ canBuy: false, reason: 'guest', adult: false, limits: null, balance: { paid: 0, earned: 0, total: 0 } }), items) as Extract<StoreView, { enabled: true }>),
    payments: false,
    mode: null,
    claim: { until: null },
    ...over,
  });

  it('payments off: both cards offer "Claim free" (the Forged skin comes with + Stardust), Get Brass is coming soon, no gate for a guest', () => {
    const html = storeBody(state(gift()));
    expect(html.match(/data-claim="skin_k47_galaxy_relic_fx"/g)).toHaveLength(2);
    expect(html).toContain('Launch gift');
    expect(html).toContain('<b>Free</b>');
    expect(html).toContain('For now: a launch gift, yours to keep');
    expect(html).toContain('For now: comes free with Galaxy Relic + Stardust Shatter');
    expect(html).not.toContain('data-buy=');
    expect(html).not.toContain('data-bundle=');
    expect(html).toContain('Coming soon');
    expect(html).not.toContain('Save your account to buy');
    expect(balanceChip(state(gift()))).toBe('');
  });

  it('the claim dialog asks the 18+ question (the age gate’s, no “18 or older” box) only when neither the account nor the device answered; under 18 can’t claim', () => {
    const item = { ...ITEMS[1]!, claimable: true };
    let html = storeBody(state(gift(), { confirm: { kind: 'claim', item } }));
    expect(html).toContain('Claim Galaxy Relic + Stardust Shatter');
    expect(html).toContain('data-age-year');
    expect(html).not.toContain('I am 18 or older');
    expect(html).not.toContain('type="checkbox"');
    // the birthday line waits for the year they turn 18 (mountStore's change listener shows it)
    expect(html).toMatch(/data-age-birthday hidden/);
    expect(html).toContain('Have you had your 18th birthday yet?');
    expect(html).toContain('Save your account to keep it on every device');
    html = storeBody(state(gift(), { confirm: { kind: 'claim', item }, deviceAge: 'adult' }));
    expect(html).not.toContain('data-age-year');
    expect(html).toContain('data-action="confirm"');
    html = storeBody(state(gift(), { confirm: { kind: 'claim', item }, deviceAge: 'minor' }));
    expect(html).toContain('for players 18 and older');
    expect(html).not.toContain('data-action="confirm"');
    expect(claimRule(account({ adult: true }), null)).toBe('ok');
    expect(claimRule(account({ adult: false }), 'adult')).toBe('ok');
    expect(claimRule(account({ adult: false }), null)).toBe('ask');
    expect(claimRule(null, 'adult')).toBe('signin');
  });

  it('claimed: Owned and Wear it; payments on: the paid path is back and the gift still shows Claim', () => {
    const owned = ITEMS.map((i) => ({ ...i, claimable: i.itemId === 'skin_k47_galaxy_relic_fx', owned: true }));
    let html = storeBody(state(gift({}, owned)));
    expect(html.match(/data-wear=/g)).toHaveLength(2);
    expect(html).toContain('In your Locker');
    expect(html).not.toContain('<b>1,050</b> Brass');
    expect(html).not.toContain('data-claim=');
    expect(giftFor(owned[0]!, owned)).toBeNull();

    const on = gift({ payments: true, mode: 'test', account: account() });
    html = storeBody(state(on));
    expect(html).toContain('data-claim="skin_k47_galaxy_relic_fx"');
    expect(html).toContain('data-bundle="brass_250"');
    expect(html).toContain('left in your monthly limit');
    expect(errorText('claim_ended')).toBe('The launch gift has ended.');
    expect(errorText('underage')).toContain('18 and older');
  });
});

describe('the admin page’s Store', () => {
  it('formats the ledger and calls the API with the token', async () => {
    expect(signed(1050)).toBe('+1,050');
    expect(signed(-500)).toBe('−500');
    expect(money(990_000, 'NGN')).toBe('₦9,900');
    expect(ledgerLine({ id: 1, at: '2026-10-28T12:00:00Z', pool: 'paid', kind: 'purchase', delta: 1050, balanceAfter: 1050, ref: 'pay_x', note: 'brass_1050', actor: 'flutterwave' })).toContain('purchase · paid +1,050 → 1,050 · flutterwave · brass_1050 · pay_x');
    expect(GRANTABLE.map(([id]) => id)).toEqual(['skin_k47_galaxy_relic', 'skin_k47_galaxy_relic_fx']);

    const seen: { url: string; auth: string; body: string | undefined }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).Authorization!, body: init.body as string | undefined });
      return url.endsWith('/flags') ? new Response(JSON.stringify({ flagged: [] })) : new Response(JSON.stringify({ error: { code: 'invalid_request', message: 'x', issues: [{ message: 'grant either brass or itemId' }] } }), { status: 400 });
    }) as unknown as typeof fetch;
    expect(await storeAdmin(TOKEN, 'GET', '/flags', undefined, fetcher)).toEqual({ flagged: [] });
    await expect(storeAdmin(TOKEN, 'POST', '/accounts/u_1/grant', { reason: 'x' }, fetcher)).rejects.toThrow(new StoreAdminError(400, 'invalid_request', 'grant either brass or itemId'));
    expect(seen[0]).toMatchObject({ url: '/api/admin/store/flags', auth: `Bearer ${TOKEN}` });
    expect(seen[1]!.body).toBe('{"reason":"x"}');
  });
});

const TOKEN = 'admin-token-0123456789';
