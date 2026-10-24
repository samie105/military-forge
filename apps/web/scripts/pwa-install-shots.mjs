/**
 * Install app, end to end (the owner, 24 Oct: "make it a PWA so people can download the app"): the
 * permanent button (Home's top bar, Settings, the pause menu), the suggestion toast on the first Home
 * visit, the browser's prompt taken or turned down, the Installed confirmation, the on-device counts.
 * Android Chrome and Samsung Internet as a landscape phone (780×360, touch, 4× CPU), desktop Chrome at
 * 1440×900. The browser's prompt can't be driven headless: a stand-in `beforeinstallprompt` (prompt(),
 * userChoice) plays the browser's part, then `appinstalled`. iPhone Safari is checked in the iOS
 * Simulator (no beforeinstallprompt there: the guide). Needs the dev server:
 *
 *   cd apps/web && pnpm exec vite --port 5223 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/pwa-install-shots.mjs http://localhost:5223 docs/screenshots/pwa-install
 *
 * Exits 1 when a check fails, on a page error or a console error.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5223').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/pwa-install');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const UA = {
  chrome: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  desktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const problems = [];
const check = (ok, what) => (ok ? console.log(`ok: ${what}`) : problems.push(what));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'pwa-install-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });

async function open(kind, phone) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${kind}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|\/api\/|WebSocket/.test(m.text())) problems.push(`${kind}: console error: ${m.text()}`);
  });
  // a returning player (the soldier made, the Briefing and Home's stops done): straight to Home
  await page.evaluateOnNewDocument(() => {
    if (location.protocol === 'about:') return;
    const now = Date.now();
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.setItem('mf.facts.v1', JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }));
  });
  if (phone) {
    await page.emulate({ viewport: { width: 780, height: 360, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: UA[kind] });
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'orientation', value: 'landscape' }] });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  } else {
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent(UA[kind]);
  }
  return page;
}

/** The browser says it can install us (its event), with a prompt that answers `outcome`. */
const offer = (page, outcome) =>
  page.evaluate((o) => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = async () => void (window.__prompted = (window.__prompted ?? 0) + 1);
    e.userChoice = new Promise((r) => (window.__answer = () => r({ outcome: o })));
    window.dispatchEvent(e);
  }, outcome);
/** The player answers the browser's prompt; accepted: the browser says it's installed. */
const answer = (page, installed) =>
  page.evaluate((i) => {
    window.__answer?.();
    if (i) setTimeout(() => window.dispatchEvent(new Event('appinstalled')), 50);
  }, installed);

async function home(page, phone) {
  await page.goto(`${base}/?app`, { waitUntil: 'load' });
  const name = phone ? '[data-screen="m-name"] input[aria-label="Your name"]' : '[data-screen="name-entry"] input';
  const homeSel = phone ? '[data-screen="m-home"]' : '[data-screen="home"]';
  await page.waitForSelector(`${name}, ${homeSel}`, { timeout: 90_000 });
  if (!(await page.$(homeSel))) {
    await page.type(name, `Ade${Math.floor(Math.random() * 900 + 100)}`);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 12 && !(await page.$(homeSel)); i++) {
      await sleep(1200);
      await page.$eval('button[type=submit]', (b) => b.click()).catch(() => {});
    }
  }
  await page.waitForSelector(homeSel, { timeout: 30_000 });
}
const visible = (page, sel) => page.$$eval(sel, (els) => els.some((e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden'));
const stats = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('mf.install.v1') ?? '{}').stats ?? null);
const shot = async (page, name, settle = 600) => {
  await sleep(settle);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};
const clickText = async (page, scope, text) => (await page.waitForSelector(`xpath/.//${scope}//button[contains(normalize-space(.), "${text}")]`, { timeout: 10_000 })).click();

try {
  // ---- Android Chrome: no button until the browser says it can install; then the toast on the first Home visit ----
  {
    const page = await open('chrome', true);
    await home(page, true);
    check(!(await visible(page, '.mf-install-btn')), 'chrome: no Install app before the browser can install');
    await offer(page, 'accepted');
    await sleep(600);
    check(await visible(page, '.pm-top .mf-install-btn'), "chrome: Install app in Home's top bar");
    check(await visible(page, '.mf-install--home'), 'chrome: the suggestion on the first Home visit (no match played)');
    await shot(page, 'chrome-home-toast-and-button');
    await clickText(page, 'aside', 'Not now');
    await sleep(400);
    check(!(await visible(page, '.mf-install--home')), 'chrome: Not now closes the suggestion');
    check(await visible(page, '.pm-top .mf-install-btn'), 'chrome: the button stays after Not now');
    await shot(page, 'chrome-home-button');
    // 150 % text and Reduce motion: the top bar still holds it
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1.5'));
    await page.evaluate(() => document.documentElement.classList.add('reduce-motion'));
    await shot(page, 'chrome-home-button-text150');
    const off = await page.$eval('.pm-top .mf-install-btn', (b) => {
      const r = b.getBoundingClientRect();
      return r.right > innerWidth || r.top < 0 || r.height < 40;
    });
    check(!off, 'chrome 150%: the button is on screen, a full target');
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
    await page.evaluate(() => document.documentElement.classList.remove('reduce-motion'));
    // Settings
    await clickText(page, 'nav', 'Settings');
    await page.waitForSelector('[data-screen="m-settings"]', { timeout: 10_000 });
    check(await visible(page, '[data-screen="m-settings"] .mf-install-btn'), 'chrome: Install app in Settings');
    await shot(page, 'chrome-settings-button');
    await clickText(page, 'header', 'Done');
    // the pause menu, in Training
    await clickText(page, '*[contains(@class,"pm-col")]', 'Training');
    await sleep(4000);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-screen="m-pause"]', { timeout: 15_000 });
    check(await visible(page, '.pm-pause__row .mf-install-btn'), "chrome: Install app in the pause menu's quick row");
    await shot(page, 'chrome-pause-button');
    // install from there: the browser's prompt, accepted
    await clickText(page, 'nav', 'Install app');
    await sleep(300);
    check((await page.evaluate(() => window.__prompted)) === 1, "chrome: the button opens the browser's prompt");
    await answer(page, true);
    await sleep(800);
    check(await visible(page, '.mf-pwa-host .mf-install--done'), 'chrome: Installed confirmation');
    check(!(await visible(page, '.mf-install-btn')), 'chrome: the buttons are gone once installed');
    await shot(page, 'chrome-installed', 200);
    const s = await stats(page);
    check(s && s.offered === 1 && s.prompted === 1 && s.accepted === 1 && s.dismissed === 1, `chrome: counts on the device ${JSON.stringify(s)}`);
    await page.close();
  }
  // ---- Samsung Internet: the prompt turned down ----
  {
    const page = await open('samsung', true);
    await home(page, true);
    await offer(page, 'dismissed');
    await sleep(600);
    check(await visible(page, '.pm-top .mf-install-btn'), "samsung: Install app in Home's top bar");
    await shot(page, 'samsung-home-toast-and-button');
    await page.click('.pm-top .mf-install-btn');
    await sleep(300);
    await answer(page, false);
    await sleep(600);
    check(!(await visible(page, '.mf-install-btn')), "samsung: turned down, the button goes (the browser can't ask twice)");
    check(!(await visible(page, '.mf-install--home')), 'samsung: and the suggestion with it');
    const s = await stats(page);
    check(s && s.prompted === 1 && s.dismissed === 1 && s.accepted === 0, `samsung: counts ${JSON.stringify(s)}`);
    await page.close();
  }
  // ---- desktop Chrome / Edge: the top bar's button, the real prompt ----
  {
    const page = await open('desktop', false);
    await home(page, false);
    await offer(page, 'accepted');
    await sleep(600);
    check(await visible(page, '.menu-top .mf-install-btn'), "desktop: Install app in Home's top bar");
    await shot(page, 'desktop-home-button');
    await page.click('.menu-top .mf-install-btn');
    await sleep(300);
    check((await page.evaluate(() => window.__prompted)) === 1, "desktop: the button opens the browser's prompt");
    await page.close();
  }
} catch (e) {
  problems.push(`run: ${e.message}`);
} finally {
  await browser.close();
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nall install checks passed');
