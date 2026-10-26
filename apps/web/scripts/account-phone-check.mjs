/**
 * Saved accounts on a phone, end to end against a running dev server and API (the API with
 * EMAIL_PROVIDER=log, so the confirm link lands in its log): two fresh phones (Galaxy S23 profile,
 * held sideways, real touch events).
 *
 *   1. Phone A, a new player: Home → Settings → Account → "Save your account" → email + password →
 *      "Check your email"; the link from the API log opens the app at #confirm=…, and
 *      "Save my account" saves it. The token is gone from the address bar.
 *   2. Phone B, a new phone: the first-visit name screen's "Sign in" → the form (with "Forgot
 *      password?", as email is on) → signs in → Home as phone A's player (same name).
 *   3. Layout: the Account forms fit the phone (no sideways scroll, fields at least 40 px tall, 16 px
 *      text so iOS doesn't zoom), and screenshots of each step.
 *
 *   node apps/web/scripts/account-phone-check.mjs <dev server> <API log file> <screenshot dir>
 *
 * Exits 1 on any failed check. The browser always closes (finally).
 */
/* global process */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const apiLog = process.argv[3];
const out = process.argv[4] ?? join(tmpdir(), 'account-phone');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const PHONE = { width: 780, height: 360, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true };
const EMAIL = `phone.check.${Date.now()}@example.com`;
const PASSWORD = 'jetpack-sunrise-42';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (page, fn, ms = 30_000, arg) => {
  try {
    await page.waitForFunction(fn, { timeout: ms, polling: 200 }, arg);
    return true;
  } catch {
    return false;
  }
};

/** Taps (a real touch) the first visible element matching `sel` whose text includes `text`. */
async function tap(page, sel, text = '') {
  const at = await page.evaluate(
    (s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => (!t || (e.textContent ?? '').toLowerCase().includes(t.toLowerCase())) && e.getClientRects().length && !e.disabled);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    sel,
    text,
  );
  if (!at) return false;
  await page.touchscreen.tap(at.x, at.y);
  return true;
}

/** Taps a field and types into it, as a thumb on the phone keyboard would. */
async function fill(page, sel, value) {
  if (!(await tap(page, sel))) return false;
  await page.keyboard.type(value, { delay: 5 });
  return true;
}

async function shot(page, name) {
  await page.screenshot({ path: join(out, `${name}.png`) });
}

/** A fresh phone: its own profile (no storage shared with the other), the app's title passed. */
async function phone(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setUserAgent(UA);
  await page.setViewport(PHONE);
  page.setDefaultNavigationTimeout(120_000);
  await page.evaluateOnNewDocument(() => {
    if (typeof navigator.getGamepads === 'function') navigator.getGamepads = () => [];
  });
  page.on('pageerror', (e) => check('no page error', false, e.message));
  return page;
}

async function openApp(page, path = '/?app') {
  await page.goto(`${base}${path}`, { waitUntil: 'load' });
  await sleep(1500);
  await page.evaluate(() => document.querySelector('.pm-turn__card button')?.click());
  if (await until(page, () => !!document.querySelector('[data-screen="title"]'), 15_000)) await page.touchscreen.tap(PHONE.width / 2, PHONE.height / 2);
}

/** Name screen → Home (Pick one for me; then the creator's Skip or the briefing). */
async function toHome(page) {
  await until(page, () => !!document.querySelector('input[aria-label="Your name"], [data-screen="m-home"]'), 90_000);
  if (await page.$('input[aria-label="Your name"]')) {
    await fill(page, 'input[aria-label="Your name"]', `Acct${Math.floor(Math.random() * 900 + 100)}`);
    await page.keyboard.press('Enter');
  }
  for (let i = 0; i < 3; i++) {
    await until(page, () => !!document.querySelector('[data-screen="creator"] [data-action="skip"], [data-screen="briefing"], [data-screen="m-home"]'), 20_000);
    if (await page.$('[data-screen="creator"] [data-action="skip"]')) {
      await sleep(800);
      await tap(page, '[data-screen="creator"] [data-action="skip"]');
      await sleep(600);
    } else if (await page.$('[data-screen="briefing"]')) {
      await sleep(600);
      await tap(page, '[data-answer="veteran"]');
      await sleep(600);
    } else break;
  }
  return until(page, () => !!document.querySelector('[data-screen="m-home"]'), 20_000);
}

/** The Account section's layout on this phone. */
async function layout(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.acct');
    const inputs = [...document.querySelectorAll('.acct input')];
    const sideways = document.documentElement.scrollWidth > window.innerWidth + 1;
    const r = panel?.getBoundingClientRect();
    return {
      panel: !!panel,
      sideways,
      insideScreen: !!r && r.left >= 0 && r.right <= window.innerWidth + 1,
      minInputHeight: Math.min(...inputs.map((i) => i.getBoundingClientRect().height)),
      fontSizes: [...new Set(inputs.map((i) => getComputedStyle(i).fontSize))],
    };
  });
}

const nickname = (page) => page.evaluate(() => window.__game?.shell?.store?.getState().profile?.nickname ?? null);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: mkdtempSync(join(tmpdir(), 'acct-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  // ---- phone A: a new player saves their soldier
  const a = await phone(browser);
  await openApp(a);
  check('A: a new player reaches Home', await toHome(a));
  const name = await nickname(a);
  await tap(a, '.pm-nav__i', 'Settings');
  await until(a, () => !!document.querySelector('[data-screen="m-settings"]'), 10_000);
  await tap(a, '[role="tab"]', 'Account');
  check('A: Settings → Account says "Save your account" and why', await until(a, () => /Save your account/.test(document.querySelector('.acct')?.textContent ?? '') && /Sign in on another phone or computer and keep your soldier/.test(document.querySelector('.acct')?.textContent ?? ''), 10_000));
  await shot(a, '1-account-guest');
  await tap(a, '.acct button', 'Save');
  await until(a, () => !!document.querySelector('.acct input[type="email"]'), 5_000);
  await fill(a, '.acct input[type="email"]', EMAIL);
  await fill(a, '.acct input[autocomplete="new-password"]', PASSWORD);
  const formLayout = await layout(a);
  check('A: the save form fits the phone', formLayout.panel && !formLayout.sideways && formLayout.insideScreen, JSON.stringify(formLayout));
  check('A: fields are at least 40 px tall, with 16 px text', formLayout.minInputHeight >= 40 && formLayout.fontSizes.every((f) => f === '16px'), JSON.stringify(formLayout));
  await shot(a, '2-save-form');
  await tap(a, '.acct button[type="submit"]', 'Save account');
  check('A: "Check your email" (email is on)', await until(a, (e) => (document.querySelector('.acct')?.textContent ?? '').includes(`We sent a link to ${e}`), 15_000, EMAIL));
  await shot(a, '3-check-email');

  // the confirm link, from the API's log (EMAIL_PROVIDER=log)
  let token = null;
  for (let i = 0; i < 20 && !token; i++) {
    await sleep(500);
    const log = apiLog ? readFileSync(apiLog, 'utf8') : '';
    token = [...log.matchAll(/#confirm=([A-Za-z0-9_.-]+)/g)].at(-1)?.[1] ?? null;
  }
  check('A: the confirm link reached the (log) mailbox', !!token);
  await openApp(a, `/?app#confirm=${token}`);
  check('A: the link opens Account on "Finish saving your account"', await until(a, () => /Finish saving your account/.test(document.querySelector('.acct')?.textContent ?? ''), 60_000));
  check('A: the token is off the address bar', !(await a.evaluate(() => location.href)).includes(token ?? '#none'));
  await shot(a, '4-confirm');
  await tap(a, '.acct button[type="submit"]', 'Save my account');
  check('A: saved', await until(a, (e) => (document.querySelector('.acct')?.textContent ?? '').includes(e) && /Saved account/.test(document.querySelector('.acct')?.textContent ?? ''), 15_000, EMAIL));
  await shot(a, '5-saved');

  // ---- phone B: a new phone signs in
  const b = await phone(browser);
  await openApp(b);
  await until(b, () => !!document.querySelector('input[aria-label="Your name"]'), 90_000);
  check('B: the first-visit name screen offers Sign in', await tap(b, 'button[data-act="sign-in"]'));
  check('B: the sign-in form opens, with "Forgot password?"', await until(b, () => !!document.querySelector('.acct input[autocomplete="current-password"]') && /Forgot password\?/.test(document.querySelector('.acct')?.textContent ?? ''), 10_000));
  const forgot = await b.evaluate(() => {
    const link = [...document.querySelectorAll('.acct button')].find((e) => e.textContent?.includes('Forgot password?'));
    const panel = document.querySelector('.pm-set-panel');
    if (!link || !panel) return null;
    const r = link.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return r.top >= p.top && r.bottom <= p.bottom && r.left >= p.left && r.right <= p.right;
  });
  check('B: "Forgot password?" is fully on screen', forgot === true);
  await fill(b, '.acct input[type="email"]', `  ${EMAIL.toUpperCase()} `);
  await fill(b, '.acct input[autocomplete="current-password"]', 'not-the-password');
  await tap(b, '.acct button[type="submit"]');
  check('B: a wrong password says so, generically', await until(b, () => /The email or password is wrong/.test(document.querySelector('.acct')?.textContent ?? ''), 15_000));
  const signLayout = await layout(b);
  check('B: the sign-in form fits the phone', signLayout.panel && !signLayout.sideways && signLayout.insideScreen, JSON.stringify(signLayout));
  await shot(b, '6-signin-wrong');
  await b.evaluate(() => {
    const pw = document.querySelector('.acct input[autocomplete="current-password"]');
    pw?.select();
  });
  await fill(b, '.acct input[autocomplete="current-password"]', '');
  await b.keyboard.down('Control');
  await b.keyboard.press('KeyA');
  await b.keyboard.up('Control');
  await b.keyboard.type(PASSWORD, { delay: 5 });
  await tap(b, '.acct button[type="submit"]');
  // signed in from the name screen: it carries on (creator / briefing / Home) as phone A's player
  await toHome(b);
  check('B: Home as the saved player', (await nickname(b)) === name, `${await nickname(b)} vs ${name}`);
  await shot(b, '7-home-signed-in');
  await tap(b, '.pm-nav__i', 'Settings');
  await tap(b, '[role="tab"]', 'Account');
  check('B: Account shows the saved email with Sign out', await until(b, (e) => (document.querySelector('.acct')?.textContent ?? '').includes(e) && /Sign out/.test(document.querySelector('.acct')?.textContent ?? ''), 10_000, EMAIL));
  await shot(b, '8-account-saved');
} catch (e) {
  check('the walk ran', false, e instanceof Error ? e.stack : String(e));
} finally {
  await browser.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
