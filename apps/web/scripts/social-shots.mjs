/**
 * The social screens (friends, invites, voice: board "SOCIAL · friends, invites, voice") in headless
 * Chrome, desktop 1920×1080 and a landscape phone 812×375, signed in as a seeded test player. Needs the
 * dev API with seeded test accounts (scratch seed: guests, friendships, a request, presence beats)
 * and the dev server pointed at it:
 *
 *   API_PORT=8895 PGLITE_DIR=memory:// pnpm --filter @military-forge/api exec tsx src/index.ts
 *   DEV_API=http://127.0.0.1:8895 pnpm --filter @military-forge/web exec vite --port 5195 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/social-shots.mjs http://127.0.0.1:5195 <seed.json> docs/screenshots/social
 *
 * seed.json: `{ refresh: { [nickname]: refreshToken }, room }`; the player is `SOCIAL_PLAYER` (Ade_07).
 * One browser profile all the way: refresh tokens rotate on every use, so the token is set once, and
 * the rotated one is written back to seed.json at the end (the next run signs in with it).
 * Exits 1 on a page error, a console error or a missing #icon-* reference.
 */
/* global process */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5195').replace(/\/$/, '');
const seedFile = process.argv[3] ?? 'seed.json';
const seed = JSON.parse(readFileSync(seedFile, 'utf8'));
/** the other seeded players' access tokens (kept fresh by the seed): `{ access: { [nickname]: token }, ids, room }` */
const tokensFile = process.env.SOCIAL_TOKENS ?? join(dirname(resolve(seedFile)), 'tokens.json');
const others = () => JSON.parse(readFileSync(tokensFile, 'utf8'));
/** An API call as another seeded player (through the dev server's /api proxy). */
async function as(name, method, path, body) {
  const t = others();
  const res = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t.access[name]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) throw new Error(`${name} ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}
/** Kemi (in her own room, seeded) invites the player. */
const kemiInvites = () => as('Kemi', 'POST', '/invites', { to: others().ids[PLAYER], room: others().room });
const out = resolve(process.argv[4] ?? 'docs/screenshots/social');
/** only these shots (comma-separated), when given */
const only = process.argv[5] ? new Set(process.argv[5].split(',')) : null;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PLAYER = process.env.SOCIAL_PLAYER ?? 'Ade_07';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const problems = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'social-shots-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  // the game server isn't running for menu shots: its socket and probes fail by design
  if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|WebSocket|\/ws\/|9895/.test(m.text())) problems.push(`console error: ${m.text()}`);
});
const cdp = await page.createCDPSession();

const desktop = async () => {
  await page.emulate({ viewport: { width: 1920, height: 1080, deviceScaleFactor: 1 }, userAgent: (await browser.userAgent()).replace('Headless', '') });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'fine' }, { name: 'hover', value: 'hover' }] });
};
const phone = async () => {
  await page.emulate({
    viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'pointer', value: 'coarse' },
      { name: 'any-pointer', value: 'coarse' },
      { name: 'hover', value: 'none' },
      { name: 'orientation', value: 'landscape' },
    ],
  });
};

const want = (name) => !only || only.has(name);
const shot = async (name, settle = 900) => {
  if (!want(name)) return;
  await sleep(settle);
  await iconsResolve(name);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};
async function iconsResolve(where) {
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('use')]
      .map((u) => u.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('#') && !document.getElementById(h.slice(1)))
      .filter((h, i, a) => a.indexOf(h) === i),
  );
  for (const h of missing) problems.push(`${where}: missing ${h || '(empty href)'}`);
}
const button = (text, timeout = 20_000) => page.waitForSelector(`xpath/.//button[contains(normalize-space(.), "${text}")]`, { timeout, visible: true });
const click = async (text) => (await button(text)).click();
const tab = async (text) => (await page.waitForSelector(`xpath/.//button[@role="tab"][contains(normalize-space(.), "${text}")]`, { visible: true })).click();

// signed in as the seeded player: the refresh token goes in once, before the app boots
await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded' });
await page.evaluate((token) => localStorage.setItem('session.refreshToken.v1', token), seed.refresh[PLAYER]);
// the controls card and first-run screens stay out of the way
await page.evaluate(() => {
  localStorage.setItem('tips.seen.v1', '1');
  localStorage.setItem('mf-creator-seen', '1');
});

// the rotated refresh token goes back into seed.json as soon as there is one (and again at the end),
// so a run that stops half way doesn't leave a spent token behind
const saveToken = async () => {
  const t = await page.evaluate(() => localStorage.getItem('session.refreshToken.v1'));
  if (t) {
    seed.refresh[PLAYER] = t;
    writeFileSync(seedFile, JSON.stringify(seed, null, 1));
  }
};

// SOCIAL_PARTS=phone: the phone half only (the desktop half plays a match: slow on a busy machine)
const parts = new Set((process.env.SOCIAL_PARTS ?? 'desktop,phone').split(','));

// ---- desktop ----
if (parts.has('desktop')) {
await desktop();
await page.goto(`${base}/?app`, { waitUntil: 'networkidle2' });
await page.waitForSelector('.sx-squad', { timeout: 60_000 });
await saveToken();
await page.waitForFunction(() => !document.querySelector('.sx-squad__count')?.textContent?.includes('…'), { timeout: 30_000 });
await shot('d1-home-squad');

await page.click('.sx-squad__open');
await page.waitForSelector('.sx-drawer');
await shot('d2-friends-panel');
await tab('Requests');
await shot('d3-friends-requests');
await tab('Friends');
await page.type('.sx-add__input', 'Musa');
await page.click('.sx-add__send');
await page.waitForSelector('.sx-add__out');
await shot('d4-friends-add-result');
// a friend's ⋯ menu, then its confirm
await page.click('.sx-row--online .sx-menu .btn');
await shot('d5-friends-row-menu', 400);
await page.click('.sx-menu__item--bad');
await shot('d6-friends-block-confirm', 400);
await click('Keep');
await page.keyboard.press('Escape');

// ---- invites: a friend's invite on Home, your room's picker, a toast mid-match ----
await page.waitForFunction(() => !document.querySelector('.sx-drawer'));
await kemiInvites();
await page.waitForSelector('.sx-toast', { timeout: 15_000 });
await shot('d7-invite-toast-home');
await page.click('.sx-toast [aria-label^="Later"]');
await page.click('.home__create');
await page.waitForSelector('.sx-invblock', { timeout: 90_000 });
await shot('d8-lobby-invite-friends', 1500);
await page.click('.sx-invblock');
await page.waitForSelector('.sx-picker');
await page.click('.sx-picker .btn--volt');
await page.waitForSelector('.sx-picker .sx-sent');
await shot('d9-invite-picker-sent');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !document.querySelector('.sx-picker'));
// bots fill the room, so the host can start
await click('Fill to 4');
await (await page.waitForSelector('xpath/.//button[@title="Start the countdown now"][not(@disabled)]', { visible: true, timeout: 30_000 })).click();
await page.waitForFunction(() => !document.querySelector('[data-screen="lobby"]'), { timeout: 60_000 });
await sleep(6000); // the countdown, then play
await as('Kemi', 'POST', '/invites', { to: others().ids[PLAYER], room: others().room }).catch(async () => {
  await sleep(5500); // the same invite again waits a few seconds
  await kemiInvites();
});
await page.waitForSelector('.sx-toast--play', { timeout: 15_000 });
await shot('d10-invite-toast-match');
await page.keyboard.press('Escape'); // the pause menu
await click('Invite friends');
await page.waitForSelector('.sx-picker');
await shot('d11-pause-invite-picker');
await page.keyboard.press('Escape');

}

// ---- phone ----
if (parts.has('phone')) {
await phone();
await page.goto(`${base}/?app`, { waitUntil: 'networkidle2' });
await page.waitForSelector('.sx-psquad', { timeout: 60_000 });
await saveToken();
await page.waitForFunction(() => !document.querySelector('.sx-psquad .sx-squad__count')?.textContent?.includes('…'), { timeout: 30_000 });
await shot('p1-home-squad');
await page.click('.sx-fbtn');
await page.waitForSelector('.sx-drawer');
await shot('p2-friends-sheet');
await page.evaluate(() => document.querySelector('.sx-list')?.scrollBy(0, 400));
await shot('p3-friends-list');
await page.click('.sx-close');
await page.waitForFunction(() => !document.querySelector('.sx-drawer'));
await sleep(5500);
await kemiInvites();
await page.waitForSelector('.sx-toast', { timeout: 15_000 });
await shot('p4-invite-toast-home');
await page.click('.sx-toast [aria-label^="Later"]');
await page.click('.pm-create');
await page.waitForSelector('.sx-invblock', { timeout: 90_000 });
await shot('p5-lobby-invite-friends', 1500);
await page.click('.sx-invblock');
await page.waitForSelector('.sx-picker');
await shot('p6-invite-picker');
await page.keyboard.press('Escape');
}

await saveToken();
await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
