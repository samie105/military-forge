/* global process */
/**
 * The Store's cards at every width (the owner, 28 Oct: on the live Store at ~800×600 "Claim free" sat on top of the
 * big FREE label): the built game in headless Chrome, GET /api/store answered here with fixed states (the launch
 * gift unclaimed, claimed, the paid prices, the owner's upgrade price), at desktop widths 640–1440 (heights 600 and
 * 860) and on phones held sideways (740×360, 780×360, 844×390) or upright and turned by the game (360×740, 390×844). In every Galaxy Relic card and Brass bundle row, the
 * parts a player reads or taps (the tier, the tag, the name, the price, the money line, the buttons) must not overlap
 * one another, and each must sit inside its card.
 *
 *   pnpm --filter @military-forge/web build && cd apps/web && pnpm exec vite preview --port 5231 --strictPort
 *   node apps/web/scripts/store-layout.mjs http://localhost:5231 [out-dir]     # out-dir: screenshots at 800×600, 740×360, 1440×860, 390×844
 *
 * Exits 1 with the list of problems. No API or account is needed.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5231').replace(/\/$/, '');
const out = process.argv[3] ? resolve(process.argv[3]) : null;
if (out) mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const DESKTOP = [];
for (const height of [600, 860]) for (let width = 640; width <= 1440; width += 80) DESKTOP.push({ width, height });
// sideways, and upright (the game turns an upright phone's page to landscape: ui/landscape.ts, html.mf-rotated)
const PHONES = [
  { width: 740, height: 360, ua: ANDROID },
  { width: 780, height: 360, ua: ANDROID },
  { width: 844, height: 390, ua: IPHONE },
  { width: 360, height: 740, ua: ANDROID },
  { width: 390, height: 844, ua: IPHONE },
];
const SHOTS = new Set(['800x600', '740x360', '1440x860', '390x844']);

// --- the states GET /api/store answers (the API's shape: apps/api src/store/routes.ts) ---
const item = (itemId, name, tier, over = {}) => ({
  itemId, line: 'k47_galaxy_relic', name, tier, weaponId: 'k47', killEffect: tier === 'forged_kill_effect' ? 'stardust' : null,
  includes: tier === 'forged_kill_effect' ? ['skin_k47_galaxy_relic'] : [], price: tier === 'forged' ? 1050 : 2200, fullPrice: tier === 'forged' ? 1050 : 2200,
  upgrade: false, money: { bundleId: tier === 'forged' ? 'brass_1050' : 'brass_2200', price: tier === 'forged' ? { NGN: 990_000, USD: 999 } : { NGN: 1_990_000, USD: 1999 } },
  owned: false, claimable: false, ...over,
});
const bundles = [
  [250, 0, 249, 250_000], [500, 0, 499, 500_000], [1050, 5, 999, 990_000], [2200, 10, 1999, 1_990_000], [5750, 15, 4999, 4_990_000],
].map(([brass, bonusPct, USD, NGN]) => ({ id: `brass_${brass}`, brass, bonusPct, price: { USD, NGN } }));
const account = (over = {}) => ({
  canBuy: false, reason: 'guest', adult: false, balance: { paid: 0, earned: 0, total: 0 }, owned: [],
  limits: null, ...over,
});
const view = (over) => ({ enabled: true, payments: false, mode: null, claim: { until: null }, currency: { name: 'Brass', walletCap: 20000 }, bundles, account: account(), ...over });
const STATES = {
  gift: view({ items: [item('skin_k47_galaxy_relic', 'Galaxy Relic', 'forged'), item('skin_k47_galaxy_relic_fx', 'Galaxy Relic + Stardust Shatter', 'forged_kill_effect', { claimable: true })] }),
  claimed: view({
    items: [item('skin_k47_galaxy_relic', 'Galaxy Relic', 'forged', { owned: true }), item('skin_k47_galaxy_relic_fx', 'Galaxy Relic + Stardust Shatter', 'forged_kill_effect', { owned: true, claimable: true })],
    account: account({ adult: true, owned: ['skin_k47_galaxy_relic_fx'] }),
  }),
  paid: view({
    payments: true, mode: 'test', claim: null,
    items: [item('skin_k47_galaxy_relic', 'Galaxy Relic', 'forged'), item('skin_k47_galaxy_relic_fx', 'Galaxy Relic + Stardust Shatter', 'forged_kill_effect')],
    account: account({ canBuy: true, reason: null, adult: true, balance: { paid: 18_750, earned: 1200, total: 19_950 }, limits: { monthlyCapCents: 10_000, spentCents: 4999, leftCents: 5001, pendingRaise: null, coolOffUntil: null } }),
  }),
  // the widest price: the owner's upgrade, struck through and new
  upgrade: view({
    payments: true, mode: 'live', claim: null,
    items: [item('skin_k47_galaxy_relic', 'Galaxy Relic', 'forged', { owned: true }), item('skin_k47_galaxy_relic_fx', 'Galaxy Relic + Stardust Shatter', 'forged_kill_effect', { price: 1050, upgrade: true })],
    account: account({ canBuy: true, reason: null, adult: true, balance: { paid: 1050, earned: 0, total: 1050 }, owned: ['skin_k47_galaxy_relic'], limits: { monthlyCapCents: 10_000, spentCents: 999, leftCents: 9001, pendingRaise: null, coolOffUntil: null } }),
  }),
};

/** Runs in the page: overlaps and spills inside each card and bundle row. */
function audit() {
  const problems = [];
  const label = (el) => `${el.className.split(' ')[0]} "${(el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28)}"`;
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
  };
  const PARTS = '.eyebrow, .tag, .mf-st__tier-name, .mf-st__tier-line, .mf-st__price, .mf-st__money, .mf-st__acts .btn, .mf-st__amount, .mf-st__why, .mf-st__pay .btn';
  // what a part draws: its box, and its content where that overflows the box (text that doesn't wrap); a box squeezed
  // by its layout while its text runs on is exactly the bug this looks for
  const extent = (el) => {
    const r = el.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(el);
    const c = range.getBoundingClientRect();
    if (c.width < 1) return r;
    return { left: Math.min(r.left, c.left), right: Math.max(r.right, c.right), top: Math.min(r.top, c.top), bottom: Math.max(r.bottom, c.bottom), width: 0, height: 0 };
  };
  for (const card of document.querySelectorAll('.mf-st__tier, .mf-st__bundle')) {
    const box = card.getBoundingClientRect();
    const parts = [...card.querySelectorAll(PARTS)].filter((el) => shown(el) && (el.textContent ?? '').trim());
    for (const el of parts) {
      const r = extent(el);
      if (r.left < box.left - 1 || r.right > box.right + 1) problems.push(`${label(el)} spills out of its card (${Math.round(r.left - box.left)}…${Math.round(r.right - box.left)} of ${Math.round(box.width)} px)`);
      // the text inside cut by its own box (nowrap text wider than the element)
      if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible') problems.push(`${label(el)} is cut (${el.scrollWidth} > ${el.clientWidth} px)`);
    }
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const a = parts[i];
        const b = parts[j];
        if (a.contains(b) || b.contains(a)) continue;
        const p = extent(a);
        const q = extent(b);
        const w = Math.min(p.right, q.right) - Math.max(p.left, q.left);
        const h = Math.min(p.bottom, q.bottom) - Math.max(p.top, q.top);
        if (w > 1 && h > 1) problems.push(`${label(a)} overlaps ${label(b)} (${Math.round(w)}×${Math.round(h)} px)`);
      }
    }
  }
  if (!document.querySelector('.mf-st__tier')) problems.push('the Store drew no cards');
  return problems;
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'store-layout-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const failures = [];
let checks = 0;
try {
  for (const [state, body] of Object.entries(STATES)) {
    for (const group of ['desktop', 'phone']) {
      const page = await browser.newPage();
      page.on('pageerror', (e) => console.error(`[page] ${e.message}`));
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const url = new URL(req.url());
        if (url.pathname === '/api/store') return void req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname.startsWith('/api/')) return void req.respond({ status: 503, contentType: 'application/json', body: '{"error":{"code":"down","message":"no API in this check"}}' });
        return void req.continue();
      });
      const sizes = group === 'desktop' ? DESKTOP : PHONES;
      for (const [i, size] of sizes.entries()) {
        if (group === 'phone') {
          await page.setUserAgent(size.ua);
          await page.setViewport({ width: size.width, height: size.height, isMobile: true, hasTouch: true, isLandscape: size.width > size.height, deviceScaleFactor: 2 });
        } else await page.setViewport({ width: size.width, height: size.height });
        // a phone's layout is chosen at load (touch, landscape); a desktop width just refits
        if (group === 'phone' || i === 0) {
          await page.goto(`${base}/?title=off#/store`, { waitUntil: 'domcontentloaded' });
          await page.waitForSelector('.mf-st__tier', { timeout: 60_000 });
        }
        await sleep(group === 'phone' || i === 0 ? 1500 : 250);
        const name = `${size.width}x${size.height}`;
        const problems = await page.evaluate(audit);
        checks++;
        for (const p of problems) failures.push(`${state} @ ${name}${group === 'phone' ? ' (phone)' : ''}: ${p}`);
        if (out && SHOTS.has(name)) {
          for (const top of [0, 1]) {
            // the phone's cards are below its header: a second shot scrolled to them
            if (top && group !== 'phone') continue;
            if (top) await page.evaluate(() => document.querySelector('.mf-st__tier-buy')?.scrollIntoView({ block: 'center' }));
            await sleep(300);
            await page.screenshot({ path: join(out, `${state}-${name}${top ? '-cards' : ''}.png`) });
          }
        }
      }
      await page.close();
    }
  }
} finally {
  await browser.close();
}
console.log(`${checks} layouts checked (${Object.keys(STATES).length} states × ${DESKTOP.length} desktop sizes and ${PHONES.length} phones)`);
if (failures.length) {
  console.log(`${failures.length} problems:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('no overlaps, nothing spills out of a card');
