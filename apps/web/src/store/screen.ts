/**
 * The Store (#/store; docs/17): the balance, the Brass bundles at their money prices, and the K-47 Galaxy Relic line
 * at its Brass prices with the money next to them. Buy → a confirm with the price in Brass and naira → owned →
 * Wear it (the Locker). Bundles go through Flutterwave's page and come back here (`?store=return`), where the API
 * verifies the payment before anything is credited. Only saved 18+ accounts buy; everyone else sees why and how.
 * The launch gift (docs/17 §9): claimable items show "Claim free" instead of Buy, for guests too (the device's 18+
 * answer, asked in the claim's dialog if this device hasn't given one), and work with payments off, when "Get Brass"
 * says it's coming soon.
 * No countdowns, no "only N left", no random items (docs/17 red line 8).
 *
 * Plain DOM like the Briefing: storeMarkup() is the whole screen as a string for a state (tested without a DOM),
 * mountStore() keeps the state and wires the buttons.
 */
import { escapeHtml, ic } from '../locker/tiles';
import { ageOnDevice, answerAge, asksBirthday, birthYears } from '../shell/age';
import { startFitting } from '../ui/fit';
import { mountSprite } from '../ui/sprite';
import {
  blockedText,
  bundleBlocked,
  claimRule,
  giftFor,
  errorText,
  formatBrass,
  formatMoney,
  limitLine,
  moneyLine,
  storeArt,
  tierLabel,
  tierLine,
  type CheckoutReturn,
  type Money,
  type PaymentView,
  type StoreBundle,
  type StoreItemView,
  type StoreView,
} from './model';
import css from './store.css?inline';

/** What the Store asks the API (shell/api.ts behind it). Errors carry `code` and `extra` (the API's error contract). */
export interface StoreApi {
  load(): Promise<StoreView>;
  checkout(bundleId: string, currency: Money): Promise<{ txRef: string; link: string }>;
  confirm(txRef: string, transactionId: string | null): Promise<{ status: string; brass: number }>;
  buy(itemId: string, expectedPrice: number, key: string): Promise<{ owned: string[] }>;
  history(): Promise<{ payments: PaymentView[] }>;
  refund(txRef: string): Promise<{ status: string }>;
  /** the launch gift; `birthYear`: the device's 18+ answer, when the account has none yet */
  claim(itemId: string, birthYear: number | null): Promise<{ owned: string[]; already: boolean }>;
}

export interface StoreOptions {
  api: StoreApi;
  /** the player came back from Flutterwave's page with this (main.ts read it off the address) */
  back: CheckoutReturn | null;
  onExit(): void;
  /** "Save your account": Settings → Account */
  onSaveAccount(): void;
  /** "Wear it": put the item on and open the Locker */
  onWear(itemId: string): void;
  /** the account's items changed (the Locker and the look learn at once) */
  onOwned(owned: string[]): void;
  /** to Flutterwave's page */
  go(url: string): void;
}

export type Confirm = { kind: 'item'; item: StoreItemView } | { kind: 'bundle'; bundle: StoreBundle; currency: Money } | { kind: 'claim'; item: StoreItemView };

export interface StoreState {
  view: StoreView | null;
  /** couldn't load the store at all */
  failed: string | null;
  /** a line at the top: what just happened */
  notice: { text: string; tone: 'ok' | 'warn'; wear?: string } | null;
  confirm: Confirm | null;
  /** a request is on its way: buttons wait */
  busy: boolean;
  /** Purchases & refunds, when open */
  payments: PaymentView[] | null;
  /** this device's 18+ answer (shell/age.ts): what a guest's claim sends */
  deviceAge: 'adult' | 'minor' | null;
}

const casing = (cls = 'ic mf-st__casing') => ic('mech-casing', cls);

function itemCard(item: StoreItemView, view: Extract<StoreView, { enabled: true }>, blocked: boolean, busy: boolean): string {
  const gift = giftFor(item, view.items);
  const action = item.owned
    ? `<button type="button" class="btn btn--paper btn--sm m-p8" data-wear="${escapeHtml(item.itemId)}">${ic('shirt')} Wear it</button>`
    : gift
      ? `<button type="button" class="btn btn--volt m-p8" data-claim="${escapeHtml(gift.itemId)}"${busy ? ' disabled' : ''}>${ic('gem')} Claim free</button>`
      : view.payments
        ? `<button type="button" class="btn btn--volt m-p8" data-buy="${escapeHtml(item.itemId)}"${blocked || busy ? ' disabled' : ''}>Buy</button>`
        : '<button type="button" class="btn btn--ghost btn--sm m-p8" disabled>Coming soon</button>';
  const tag = item.owned
    ? `<span class="tag tag--ok">${ic('check')} Owned</span>`
    : gift
      ? '<span class="tag mf-st__gift">Launch gift</span>'
      : item.upgrade
        ? '<span class="tag tag--brass">Upgrade price</span>'
        : '';
  const was = item.upgrade && !item.owned && !gift ? `<s class="mf-st__was">${formatBrass(item.fullPrice)}</s>` : '';
  const price = item.owned
    ? `<p class="mf-st__price">${ic('check')} In your Locker</p><p class="mf-st__money"></p>`
    : gift
    ? `<p class="mf-st__price mf-st__price--free"><b>Free</b></p>
        <p class="mf-st__money">${gift.itemId === item.itemId ? 'For now: a launch gift, yours to keep' : `For now: comes free with ${escapeHtml(gift.name)}`}</p>`
    : `<p class="mf-st__price">${casing()}${was}<b>${formatBrass(item.price)}</b> Brass</p>
        <p class="mf-st__money">${escapeHtml(view.payments ? moneyLine(item) : '')}</p>`;
  return `
    <li class="mf-st__tier${item.owned ? ' is-owned' : ''}${item.killEffect ? ' is-fx' : ''}${gift ? ' is-gift' : ''}">
      ${tierArt(item)}
      <div class="mf-st__tier-head">
        <span class="mf-st__tier-top"><span class="eyebrow">${escapeHtml(tierLabel(item))}</span>${tag}</span>
        <b class="display mf-st__tier-name">${escapeHtml(item.name)}</b>
        <p class="mf-st__tier-line">${escapeHtml(tierLine(item))}</p>
      </div>
      <div class="mf-st__tier-buy">
        ${price}
        <div class="mf-st__acts">${action}</div>
      </div>
    </li>`;
}

/**
 * The card's picture: the skin's gun, baked from the game's renderer, and on the kill-effect tier a small window
 * looping the effect as it plays in a match (a still frame under Reduce motion). Images, not a 3D view: phones
 * draw two small pictures, never a second WebGL context.
 */
function tierArt(item: StoreItemView): string {
  const art = storeArt(item.itemId);
  const gun = art.gun
    ? `<img class="mf-st__gun" src="${escapeHtml(art.gun)}" alt="" width="480" height="180" decoding="async">`
    : ic(item.weaponId ? `wpn-${item.weaponId}` : 'gem', 'ic mf-st__gun mf-st__gun--glyph');
  const fx = art.fx
    ? `<figure class="mf-st__fx" style="--fx-frames:${art.fx.frames};--fx-still:${art.fx.still};--fx-ms:${art.fx.ms}ms">
        <span class="mf-st__fx-win"><img src="${escapeHtml(art.fx.image)}" alt="" decoding="async" loading="lazy"></span>
        <figcaption>${escapeHtml(art.fx.name)}</figcaption>
      </figure>`
    : '';
  return `<div class="mf-st__tier-art${art.fx ? ' has-fx' : ''}" aria-hidden="true">${gun}${fx}</div>`;
}

function bundleRow(b: StoreBundle, why: string | null, blocked: boolean, busy: boolean): string {
  const off = blocked || busy || why !== null ? ' disabled' : '';
  return `
    <li class="mf-st__bundle">
      <span class="mf-st__what">
        <span class="mf-st__amount">${casing()}<b>${formatBrass(b.brass)}</b>${b.bonusPct ? `<span class="tag tag--brass">+${b.bonusPct}% bonus</span>` : ''}</span>
        ${why ? `<span class="mf-st__why">${escapeHtml(why)}</span>` : ''}
      </span>
      <span class="mf-st__pay">
        <button type="button" class="btn btn--paper btn--sm m-p8" data-bundle="${b.id}" data-currency="NGN"${off}>${formatMoney(b.price.NGN, 'NGN')}</button>
        <button type="button" class="btn btn--ghost btn--sm m-p8" data-bundle="${b.id}" data-currency="USD"${off}>${formatMoney(b.price.USD, 'USD')}</button>
      </span>
    </li>`;
}

/**
 * The claim's dialog: what it is, and the 18+ question when neither the account nor this device has answered it:
 * the age gate's own (shell/screens/AgeQuestion.tsx), the year and, only for the year a player turns 18, whether
 * they've had that birthday (shown by the year's change listener in mountStore). Never a separate "18 or older" box.
 */
function claimMarkup(item: StoreItemView, view: Extract<StoreView, { enabled: true }>, device: StoreState['deviceAge'], busy: boolean): string {
  const rule = claimRule(view.account, device);
  const until = view.claim?.until ? ` The gift is open until ${new Date(view.claim.until).toLocaleDateString()}.` : '';
  const guest = view.account?.reason === 'guest' ? '<p class="mf-st__dlg-line">It stays on this account. Save your account to keep it on every device.</p>' : '';
  const ask =
    rule === 'ask'
      ? `<div class="mf-st__age">
          <label class="mf-st__age-l" for="mf-st-year">Year you were born</label>
          <select id="mf-st-year" data-age-year><option value="">Choose…</option>${birthYears().map((y) => `<option value="${y}">${y}</option>`).join('')}</select>
          <div class="mf-st__age-b" role="radiogroup" aria-labelledby="mf-st-bday" data-age-birthday hidden>
            <span class="mf-st__age-l" id="mf-st-bday">Have you had your 18th birthday yet?</span>
            <label class="mf-st__age-c"><input type="radio" name="mf-st-bday" value="yes" data-age-turned> Yes</label>
            <label class="mf-st__age-c"><input type="radio" name="mf-st-bday" value="no" data-age-turned> Not yet</label>
          </div>
        </div>`
      : '';
  const body =
    rule === 'minor'
      ? '<p class="mf-st__dlg-line"><b>Military Forge is for players 18 and older.</b> This device’s answer says otherwise, so the gift can’t be claimed here.</p>'
      : rule === 'signin'
        ? '<p class="mf-st__dlg-line">The gift needs your account: check your connection, then open the store again.</p>'
        : `<p class="mf-st__dlg-line">A launch gift: free for now, and yours to keep after the gift ends.${until} It changes the look only: the same gun, the same stats.</p>${guest}${ask}`;
  const canClaim = rule === 'ok' || rule === 'ask';
  return `
    <div class="mf-st__scrim" data-action="cancel"></div>
    <div class="mf-st__dlg" role="dialog" aria-modal="true" aria-labelledby="mf-st-dlg-t">
      <h2 class="display mf-st__dlg-t" id="mf-st-dlg-t">Claim ${escapeHtml(item.name)}</h2>
      <p class="mf-st__dlg-price mf-st__price--free"><b>Free</b>${item.includes.length ? ` · includes ${item.includes.length === 1 ? 'the Forged skin' : `${item.includes.length} items`}` : ''}</p>
      ${body}
      <div class="mf-st__dlg-acts">
        ${canClaim ? `<button type="button" class="btn btn--volt m-p8" data-action="confirm"${busy ? ' disabled' : ''}>${busy ? 'Claiming…' : 'Claim it'}</button>` : ''}
        <button type="button" class="btn btn--ghost m-p8" data-action="cancel">${canClaim ? 'Cancel' : 'Close'}</button>
      </div>
    </div>`;
}

function confirmMarkup(c: Confirm, view: Extract<StoreView, { enabled: true }>, device: StoreState['deviceAge'], busy: boolean): string {
  if (c.kind === 'claim') return claimMarkup(c.item, view, device, busy);
  const balance = view.account?.balance.total ?? 0;
  if (c.kind === 'item') {
    const short = c.item.price - balance;
    const body =
      short > 0
        ? `<p class="mf-st__dlg-line">You have ${formatBrass(balance)} Brass: ${formatBrass(short)} more needed. Get Brass on the right, then come back.</p>`
        : `<p class="mf-st__dlg-line">Your balance after: <b>${formatBrass(balance - c.item.price)} Brass</b>. It’s yours for good, and it changes the look only.</p>
           <p class="mf-st__dlg-line mf-st__dlg-ack">You get it straight away, so it can’t be returned for Brass or money.</p>`;
    return `
      <div class="mf-st__scrim" data-action="cancel"></div>
      <div class="mf-st__dlg" role="dialog" aria-modal="true" aria-labelledby="mf-st-dlg-t">
        <h2 class="display mf-st__dlg-t" id="mf-st-dlg-t">Buy ${escapeHtml(c.item.name)}?</h2>
        <p class="mf-st__dlg-price">${casing()}<b>${formatBrass(c.item.price)} Brass</b></p>
        <p class="mf-st__money">${escapeHtml(moneyLine(c.item))}</p>
        ${body}
        <div class="mf-st__dlg-acts">
          ${short > 0 ? '' : `<button type="button" class="btn btn--volt m-p8" data-action="confirm"${busy ? ' disabled' : ''}>${busy ? 'Buying…' : `Buy for ${formatBrass(c.item.price)} Brass`}</button>`}
          <button type="button" class="btn btn--ghost m-p8" data-action="cancel">Cancel</button>
        </div>
      </div>`;
  }
  const price = formatMoney(c.bundle.price[c.currency], c.currency);
  return `
    <div class="mf-st__scrim" data-action="cancel"></div>
    <div class="mf-st__dlg" role="dialog" aria-modal="true" aria-labelledby="mf-st-dlg-t">
      <h2 class="display mf-st__dlg-t" id="mf-st-dlg-t">${formatBrass(c.bundle.brass)} Brass for ${price}</h2>
      <p class="mf-st__dlg-line">You’ll pay on Flutterwave’s secure page, then come back here. Brass is added as soon as the payment is confirmed. It can’t be cashed out or sent to anyone.</p>
      <p class="mf-st__dlg-line mf-st__dlg-ack">You can refund this purchase for 14 days while all of its Brass is unspent. Once you spend any of it, this purchase can’t be refunded.</p>
      ${view.mode === 'test' ? '<p class="mf-st__dlg-line"><span class="tag tag--warn">Test mode</span> No real money is taken.</p>' : ''}
      <div class="mf-st__dlg-acts">
        <button type="button" class="btn btn--volt m-p8" data-action="confirm"${busy ? ' disabled' : ''}>${busy ? 'Opening…' : `Continue to pay ${price}`}</button>
        <button type="button" class="btn btn--ghost m-p8" data-action="cancel">Cancel</button>
      </div>
    </div>`;
}

const STATUS_WORDS: Record<PaymentView['status'], string> = { created: 'not finished', paid: 'paid', failed: 'not paid', refund_pending: 'refund on its way', refunded: 'refunded' };

function paymentsMarkup(list: PaymentView[], busy: boolean): string {
  if (!list.length) return '<p class="mf-st__note">No purchases yet.</p>';
  return `<ul class="mf-st__pays">${list
    .map(
      (p) => `<li>
        <span>${new Date(p.createdAt).toLocaleDateString()}</span>
        <b>${formatBrass(p.brass)} Brass</b>
        <span>${formatMoney(p.amountMinor, p.currency)}</span>
        <span class="mf-st__status">${STATUS_WORDS[p.status]}</span>
        ${p.refundable ? `<button type="button" class="btn btn--ghost btn--sm m-p8" data-refund="${p.id}"${busy ? ' disabled' : ''}>Refund</button>` : '<span></span>'}
      </li>`,
    )
    .join('')}</ul><p class="mf-st__note">Unspent Brass from a purchase can go back to how you paid for 14 days. Refunds take 3–15 working days to arrive.</p>`;
}

/** The screen's body for a state (everything under the header). */
export function storeBody(s: StoreState): string {
  if (s.failed) {
    return `<div class="mf-st__state" role="alert">${ic('unplug', 'ic ic--lg')}<p class="display mf-st__head">Couldn’t open the store</p><p class="mf-st__note">${escapeHtml(s.failed)}</p><button type="button" class="btn btn--volt m-p8" data-action="retry">${ic('refresh')} Try again</button></div>`;
  }
  const v = s.view;
  if (!v) return `<div class="mf-st__state" role="status"><p class="mf-st__note">Loading the store…</p></div>`;
  if (!v.enabled) {
    return `<div class="mf-st__state" role="status">${ic('gem', 'ic ic--lg')}<p class="display mf-st__head">The store opens soon</p><p class="mf-st__note">Everything you’ve earned is in the Locker.</p></div>`;
  }
  const blocked = blockedText(v);
  const notice = s.notice
    ? `<div class="mf-st__notice is-${s.notice.tone}" role="status">${ic(s.notice.tone === 'ok' ? 'ok' : 'warn')}<span>${escapeHtml(s.notice.text)}</span>${s.notice.wear ? `<button type="button" class="btn btn--paper btn--sm m-p8" data-wear="${escapeHtml(s.notice.wear)}">${ic('shirt')} Wear it</button>` : ''}</div>`
    : '';
  const gate = blocked
    ? `<div class="mf-st__gate" role="note">${ic('lock')}<div><b>${escapeHtml(blocked.title)}</b><p>${escapeHtml(blocked.line)}</p></div>${blocked.action === 'save' ? '<button type="button" class="btn btn--volt btn--sm m-p8" data-action="save">Save your account</button>' : ''}</div>`
    : '';
  const relic = v.items.filter((i) => i.line === 'k47_galaxy_relic');
  const a = v.account;
  return `
    ${notice}${gate}
    <div class="mf-st__grid">
      <article class="mf-st__line" aria-labelledby="mf-st-relic">
        <div class="mf-st__line-text">
          <span class="eyebrow">K-47 skin line</span>
          <h2 class="display mf-st__line-name" id="mf-st-relic">Galaxy Relic</h2>
          <p class="mf-st__note">Looks only: the K-47 shoots exactly the same whatever it wears.</p>
        </div>
        <ul class="mf-st__tiers">${relic.map((i) => itemCard(i, v, !!blocked, s.busy)).join('')}</ul>
      </article>
      ${
        v.payments
          ? `<section class="mf-st__get" aria-labelledby="mf-st-get">
        <h2 class="display mf-st__get-t" id="mf-st-get">Get Brass</h2>
        <p class="mf-st__note">Pay in naira or dollars. Brass never expires; it can’t be cashed out or traded.</p>
        <ul class="mf-st__bundles">${v.bundles.map((b) => bundleRow(b, bundleBlocked(b, a, v.currency.walletCap), !!blocked, s.busy)).join('')}</ul>
        ${a?.limits && !blocked ? `<p class="mf-st__limit">${escapeHtml(limitLine(a.limits))}</p>` : ''}
        ${a && !blocked ? `<button type="button" class="mf-st__link" data-action="history" aria-expanded="${s.payments !== null}">Purchases &amp; refunds</button>` : ''}
        ${s.payments ? paymentsMarkup(s.payments, s.busy) : ''}
      </section>`
          : `<section class="mf-st__get mf-st__get--soon" aria-labelledby="mf-st-get">
        <h2 class="display mf-st__get-t" id="mf-st-get">Get Brass</h2>
        <span class="tag tag--soon">Coming soon</span>
        <p class="mf-st__note">Buying Brass opens soon, in naira and dollars. Until then, the Galaxy Relic is a launch gift: claim it free.</p>
      </section>`
      }
    </div>
    ${s.confirm ? confirmMarkup(s.confirm, v, s.deviceAge, s.busy) : ''}`;
}

/** The balance chip in the header ('' before the store has loaded, or for nobody). */
export function balanceChip(s: StoreState): string {
  const v = s.view;
  if (!v?.enabled) return '';
  const test = v.mode === 'test' ? '<span class="tag tag--warn" title="Flutterwave test keys: no real money">Test mode</span>' : '';
  // no payments: a balance only if the owner gave some
  if (!v.account || (!v.payments && v.account.balance.total === 0)) return test;
  return `${test}<span class="mf-st__bal" aria-label="Your balance">${casing()}<b>${formatBrass(v.account.balance.total)}</b> Brass</span>`;
}

function apiError(e: unknown): string {
  const err = e as { code?: string; extra?: Record<string, unknown> };
  return errorText(err.code ?? '', err.extra ?? {});
}

function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function mountStore(container: HTMLElement, o: StoreOptions): { unmount(): void } {
  mountSprite();
  startFitting();
  const style = document.createElement('style');
  style.textContent = css;
  const fit = document.createElement('div');
  fit.className = 'mf mf-fit mf-st-fit kit-v2';
  fit.innerHTML = `
  <section class="screen screen--menu" data-screen="store" aria-label="Store">
    <div class="bg" aria-hidden="true"><div class="bg__scrim"></div><div class="bg__camo"></div><div class="bg__grid"></div><div class="bg__dots"></div><div class="bg__word">STORE</div></div>
    <div class="menu mf-st">
      <header class="menu-top">
        <button type="button" class="btn btn--ghost btn--icon btn--sm m-p8" aria-label="Back" data-action="exit">${ic('back')}</button>
        <h1 class="menu-top__title">Store</h1>
        <span class="menu-top__spacer"></span>
        <span class="mf-st__chip" data-chip></span>
      </header>
      <div class="mf-st__body" data-body></div>
    </div>
  </section>`;
  container.append(style, fit);
  const body = fit.querySelector<HTMLElement>('[data-body]')!;
  const chip = fit.querySelector<HTMLElement>('[data-chip]')!;
  const deviceAge = (): StoreState['deviceAge'] => {
    const a = ageOnDevice();
    return a ? (a.adult ? 'adult' : 'minor') : null;
  };
  const s: StoreState = { view: null, failed: null, notice: null, confirm: null, busy: false, payments: null, deviceAge: deviceAge() };
  let gone = false;
  // the buy that's open: one key per confirm, so a double tap or a retry after a lost answer charges once
  let buyKey = newKey();

  const paint = () => {
    if (gone) return;
    const focused = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? document.activeElement.dataset : null;
    body.innerHTML = storeBody(s);
    chip.innerHTML = balanceChip(s);
    const again = s.confirm ? body.querySelector<HTMLElement>('[data-action="confirm"], [data-action="cancel"].btn') : focused?.buy ? body.querySelector<HTMLElement>(`[data-buy="${focused.buy}"]`) : null;
    again?.focus({ preventScroll: true });
  };

  const load = async () => {
    try {
      s.view = await o.api.load();
      s.failed = null;
      if (s.view.enabled && s.view.account) o.onOwned(s.view.account.owned);
    } catch (e) {
      s.failed = apiError(e);
    }
    paint();
  };

  const loadPayments = async () => {
    try {
      s.payments = (await o.api.history()).payments;
    } catch (e) {
      s.notice = { text: apiError(e), tone: 'warn' };
    }
  };

  // back from Flutterwave's page: the API checks the payment with Flutterwave before anything is added
  const settleReturn = async (r: CheckoutReturn) => {
    s.notice = { text: 'Checking your payment…', tone: 'ok' };
    paint();
    try {
      const out = await o.api.confirm(r.txRef, r.transactionId);
      s.notice =
        out.status === 'paid'
          ? { text: `${formatBrass(out.brass)} Brass added to your wallet.`, tone: 'ok' }
          : r.status === 'cancelled' || r.status === 'failed'
            ? { text: 'The payment wasn’t finished. Nothing was charged.', tone: 'warn' }
            : { text: 'Your payment is still being confirmed. Brass is added as soon as it is (usually within minutes).', tone: 'warn' };
    } catch (e) {
      s.notice = { text: apiError(e), tone: 'warn' };
    }
    await load();
  };

  const confirm = async () => {
    const c = s.confirm;
    const v = s.view;
    if (!c || !v?.enabled || s.busy) return;
    let birthYear: number | null = null;
    if (c.kind === 'claim' && !v.account?.adult) {
      // the 18+ answer: this device's, or the one just picked in the dialog (kept on the device as the 18+ step keeps it)
      const kept = ageOnDevice();
      if (kept?.adult) birthYear = kept.birthYear;
      else {
        const year = Number(body.querySelector<HTMLSelectElement>('[data-age-year]')?.value ?? '');
        const turned = body.querySelector<HTMLInputElement>('[data-age-turned]:checked')?.value;
        const turned18 = turned === undefined ? undefined : turned === 'yes';
        if (!year || (asksBirthday(year) && turned18 === undefined)) {
          s.notice = { text: year ? 'Say whether you’ve had your 18th birthday yet.' : 'Pick the year you were born.', tone: 'warn' };
          paint();
          return;
        }
        const answer = answerAge(year, Date.now(), turned18);
        s.deviceAge = deviceAge();
        if (answer === 'invalid' || !answer.adult) {
          s.notice = answer === 'invalid' ? { text: 'That year doesn’t look right.', tone: 'warn' } : null;
          paint();
          return;
        }
        birthYear = answer.birthYear;
      }
    }
    s.busy = true;
    paint();
    try {
      if (c.kind === 'claim') {
        const r = await o.api.claim(c.item.itemId, birthYear);
        o.onOwned(r.owned);
        s.confirm = null;
        s.notice = { text: r.already ? `You already have ${c.item.name}.` : `${c.item.name} is yours: a launch gift.`, tone: 'ok', wear: c.item.itemId };
        s.busy = false;
        await load();
        return;
      }
      if (c.kind === 'bundle') {
        const { link } = await o.api.checkout(c.bundle.id, c.currency);
        o.go(link);
        return; // leaving for the payment page
      }
      const r = await o.api.buy(c.item.itemId, c.item.price, buyKey);
      buyKey = newKey();
      o.onOwned(r.owned);
      s.confirm = null;
      s.notice = { text: `${c.item.name} is yours.`, tone: 'ok', wear: c.item.itemId };
      s.busy = false;
      await load();
      return;
    } catch (e) {
      const code = (e as { code?: string }).code;
      s.notice = { text: apiError(e), tone: 'warn' };
      s.confirm = null;
      // a stale price: look again (the answer has the new one)
      if (code === 'price_changed' || code === 'already_owned') void load();
    }
    s.busy = false;
    paint();
  };

  // the claim's 18+ question: the birthday line shows only for the year a player turns 18
  fit.addEventListener('change', (e) => {
    const sel = (e.target as Element).closest<HTMLSelectElement>('[data-age-year]');
    const birthday = sel && body.querySelector<HTMLElement>('[data-age-birthday]');
    if (!sel || !birthday) return;
    birthday.hidden = !(sel.value && asksBirthday(Number(sel.value)));
    for (const r of birthday.querySelectorAll<HTMLInputElement>('[data-age-turned]')) r.checked = false;
  });
  fit.addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('button, [data-action="cancel"]');
    if (!b || (b as HTMLButtonElement).disabled) return;
    const v = s.view?.enabled ? s.view : null;
    if (b.dataset.action === 'exit') o.onExit();
    else if (b.dataset.action === 'retry') {
      s.failed = null;
      paint();
      void load();
    } else if (b.dataset.action === 'save') o.onSaveAccount();
    else if (b.dataset.action === 'cancel') {
      if (s.busy) return;
      s.confirm = null;
      paint();
    } else if (b.dataset.action === 'confirm') void confirm();
    else if (b.dataset.action === 'history') {
      if (s.payments) {
        s.payments = null;
        paint();
      } else void loadPayments().then(paint);
    } else if (b.dataset.wear) o.onWear(b.dataset.wear);
    else if (b.dataset.claim && v) {
      const item = v.items.find((i) => i.itemId === b.dataset.claim);
      if (item) {
        s.confirm = { kind: 'claim', item };
        s.notice = null;
        s.deviceAge = deviceAge();
        paint();
      }
    }
    else if (b.dataset.buy && v) {
      const item = v.items.find((i) => i.itemId === b.dataset.buy);
      if (item) {
        s.confirm = { kind: 'item', item };
        s.notice = null;
        paint();
      }
    } else if (b.dataset.bundle && v) {
      const bundle = v.bundles.find((x) => x.id === b.dataset.bundle);
      if (bundle) {
        s.confirm = { kind: 'bundle', bundle, currency: b.dataset.currency === 'USD' ? 'USD' : 'NGN' };
        s.notice = null;
        paint();
      }
    } else if (b.dataset.refund) {
      const id = b.dataset.refund;
      s.busy = true;
      paint();
      void o.api
        .refund(id)
        .then(
          () => (s.notice = { text: 'Refund sent. The Brass from that purchase is gone, and the money is on its way back.', tone: 'ok' }),
          (err: unknown) => (s.notice = { text: apiError(err), tone: 'warn' }),
        )
        .then(async () => {
          s.busy = false;
          await loadPayments();
          await load();
        });
    }
  });
  const onKey = (e: KeyboardEvent) => {
    // Escape closes the confirm first (the route itself closes on Escape when none is open)
    if (e.code === 'Escape' && s.confirm && !s.busy) {
      e.stopImmediatePropagation();
      s.confirm = null;
      paint();
    }
  };
  window.addEventListener('keydown', onKey, true);

  paint();
  if (o.back) void settleReturn(o.back);
  else void load();
  fit.querySelector<HTMLButtonElement>('[data-action="exit"]')!.focus({ preventScroll: true });

  return {
    unmount() {
      gone = true;
      window.removeEventListener('keydown', onKey, true);
      fit.remove();
      style.remove();
    },
  };
}
