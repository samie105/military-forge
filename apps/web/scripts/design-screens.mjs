/**
 * Every screen of the owner's design kit as the app shows it, at 1920×1080 (the phone HUD at
 * 812×375, 2×), from real flows: two headless Chromes (separate profiles, like two friends) make
 * and join a room, play a one-minute match and vote; one also trains against the bots. Run it
 * against the dev stack (the dev hook lets it hold a connection open for the reconnect banner):
 *
 *   API on :8791, game server on :9201, then in apps/web:
 *   DEV_API=http://127.0.0.1:8791 DEV_GAME_SERVER=http://127.0.0.1:9201 pnpm exec vite --port 5191 --strictPort
 *   node apps/web/scripts/design-screens.mjs [http://127.0.0.1:5191] [out dir]
 *   SIZE=1280x720 node apps/web/scripts/design-screens.mjs …   (a small laptop: the menus' 0.8 zoom floor)
 *
 * The production build works too (pnpm playtest's local address); the reconnect and connection-lost
 * shots need the dev hook and are skipped there.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5191').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/ui-design/after');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);
const suffix = () => Math.floor(Math.random() * 900 + 100);
mkdirSync(out, { recursive: true });

// SIZE=1280x720 shoots the desktop screens in a smaller window (the menus' zoom floor, ui/fit.ts)
const [sizeW, sizeH] = (process.env.SIZE ?? '1920x1080').split('x').map(Number);

async function launch(label, viewport = { width: sizeW || 1920, height: sizeH || 1080 }) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    userDataDir: mkdtempSync(join(tmpdir(), `design-${label}-`)),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: viewport,
  });
  const ctx = browser.defaultBrowserContext();
  await ctx.overridePermissions(base, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { browser, page, label, errors };
}

const shot = async (p, name) => {
  await sleep(350);
  await p.page.screenshot({ path: join(out, `${name}.png`) });
  log('wrote', name);
};
const button = (p, text, timeout = 30_000) => p.page.waitForSelector(`xpath/.//button[contains(normalize-space(.), "${text}")]`, { timeout });
const click = async (p, text) => (await button(p, text)).click();
const screen = (p, name, timeout = 60_000) => p.page.waitForSelector(`[data-screen="${name}"]`, { timeout });

/** Empties a text box the way a player would: select everything, then delete it. */
async function clear(p, selector) {
  await p.page.$eval(selector, (el) => el.select());
  await p.page.keyboard.press('Backspace');
}

/** The API's live check says a name is free (Continue is on). */
const nameFree = (p) => p.page.waitForSelector('[data-screen="name-entry"][data-active-state~="available"]', { timeout: 60_000 });

async function enterName(p, name) {
  await p.page.waitForSelector('#ne-input', { timeout: 120_000 });
  await p.page.type('#ne-input', name);
  await nameFree(p);
  await p.page.keyboard.press('Enter');
  await p.page.waitForSelector('[data-screen="home"], [data-screen="lobby"]', { timeout: 60_000 });
}

const a = await launch('A');
const b = await launch('B');
try {
  // ---- loading: the page's own screen, before the app's script runs
  await a.page.setRequestInterception(true);
  const hold = (r) => (/\/(src\/main\.ts|assets\/main-[^/]+\.js)(\?|$)/.test(r.url()) ? setTimeout(() => r.continue(), 5000) : r.continue());
  a.page.on('request', hold);
  void a.page.goto(`${base}/r/KMTXRA`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(2500);
  await shot(a, '00-loading');
  await sleep(4000);
  a.page.off('request', hold);
  await a.page.setRequestInterception(false);

  // ---- names: B takes a name first, so A can see it taken
  const kemi = `Kemi${suffix()}`;
  await b.page.goto(`${base}/?app`, { waitUntil: 'load' });
  await enterName(b, kemi);
  await a.page.goto(`${base}/?app`, { waitUntil: 'load' });
  await a.page.waitForSelector('#ne-input', { timeout: 120_000 });
  await shot(a, '01-name-entry');
  await a.page.type('#ne-input', 'Ad');
  await shot(a, '02-name-too-short');
  await clear(a, '#ne-input');
  await a.page.type('#ne-input', kemi);
  await a.page.waitForSelector('[data-screen="name-entry"][data-active-state~="taken"]', { timeout: 60_000 });
  await shot(a, '03-name-taken');
  await clear(a, '#ne-input');
  const ade = `Ade${suffix()}`;
  await a.page.type('#ne-input', ade);
  await nameFree(a);
  await shot(a, '04-name-available');
  await a.page.keyboard.press('Enter');
  await screen(a, 'home');
  await sleep(1500);
  await shot(a, '05-home');

  // ---- settings, every tab
  await click(a, 'Settings');
  await screen(a, 'settings');
  for (const [i, tab] of ['Graphics', 'Audio', 'Controls', 'Accessibility', 'Network', 'Touch'].entries()) {
    await (await a.page.waitForSelector(`xpath/.//button[@role="tab"][contains(normalize-space(.), "${tab}")]`)).click();
    await shot(a, `${10 + i}-settings-${tab.toLowerCase()}`);
  }
  await click(a, 'Done');

  // ---- a room: A makes it, B joins with the code
  await click(a, 'Play with friends');
  await screen(a, 'lobby');
  const link = a.page.url();
  const code = /\/r\/([A-Z]{6})/.exec(link)[1];
  log('room', code);
  await sleep(1200);
  await shot(a, '20-lobby-host');
  await click(a, 'Copy link');
  await shot(a, '21-lobby-link-copied');

  // join with code: typing, a wrong code, then a pasted link
  await screen(b, 'home');
  await click(b, 'Join with code');
  await screen(b, 'join');
  await shot(b, '22-join-empty');
  await b.page.keyboard.type(code.slice(0, 3));
  await shot(b, '23-join-typing');
  const wrong = code.slice(0, 5) + (code[5] === 'Z' ? 'Y' : 'Z');
  await b.page.keyboard.type(wrong.slice(3));
  await b.page.keyboard.press('Enter');
  await b.page.waitForSelector('[data-screen="join"][data-active-state~="error"]', { timeout: 15_000 });
  await shot(b, '24-join-error');
  await b.page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data }));
  }, `Room's up: ${link}`);
  await shot(b, '25-join-pasted');
  // connecting: B opens the room link with the API's answer held back a moment
  await b.page.keyboard.press('Escape');
  await b.page.setRequestInterception(true);
  const slowJoin = (r) => (/\/rooms\/[A-Z]{6}\/join$/.test(r.url()) ? setTimeout(() => r.continue(), 4000) : r.continue());
  b.page.on('request', slowJoin);
  await b.page.goto(link, { waitUntil: 'load' });
  await b.page.waitForSelector('[data-screen="connection"][data-active-state~="connecting"]', { timeout: 15_000 });
  await shot(b, '26-connecting');
  await screen(b, 'lobby');
  b.page.off('request', slowJoin);
  await b.page.setRequestInterception(false);
  await a.page.waitForFunction(() => document.querySelectorAll('.player-list .player-row:not(.player-row--open) .avatar:not(.avatar--bot)').length === 2, { timeout: 30_000 });
  await (await a.page.waitForSelector('xpath/.//*[@aria-labelledby="tl-label"]/button[normalize-space(.)="1"]')).click();
  await b.page.waitForFunction(() => document.querySelector('[data-bind="room.timeLimit"]')?.textContent === '1 min', { timeout: 15_000 });
  await shot(a, '27-lobby-host-two');
  await shot(b, '28-lobby-guest');
  await click(b, 'Warm up');
  await shot(b, '29-lobby-folded-controls-card');
  await click(b, 'Got it');
  await click(b, 'Lobby');

  // ---- the match
  for (const p of [a, b]) await (await p.page.waitForSelector('xpath/.//footer//button[normalize-space(.)="Ready"]')).click();
  await screen(a, 'countdown');
  await shot(a, '30-countdown');
  await a.page.waitForSelector('[data-screen="countdown"][data-active-state~="go"]', { timeout: 15_000 }).catch(() => {});
  await shot(a, '31-countdown-go');
  await a.page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 30_000 });
  for (const p of [a, b]) {
    const got = await p.page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
    if (got) await got.click();
  }
  await a.page.keyboard.down('KeyD');
  await a.page.mouse.move(1500, 420);
  await sleep(1500);
  await a.page.keyboard.up('KeyD');
  await a.page.keyboard.press('KeyN'); // the net plate
  await sleep(1200);
  await shot(a, '32-hud-online');
  await a.page.keyboard.down('Tab');
  await sleep(800);
  await shot(a, '33-scoreboard');
  await a.page.keyboard.up('Tab');
  await a.page.keyboard.press('Escape');
  await screen(a, 'pause');
  await shot(a, '34-pause');
  await click(a, 'Leave match');
  await shot(a, '35-pause-confirm-leave');
  await click(a, 'Stay');
  await a.page.keyboard.press('Escape');

  // the reconnect banner and the connection-lost alert (dev builds: the dev hook holds the socket shut)
  const devHook = await b.page.evaluate(() => !!window.__game?.mode);
  if (devHook) {
    await b.page.evaluate(() => {
      const mode = window.__game.mode;
      window.__open = mode.open;
      mode.open = () => {};
      mode.transport?.close?.(3000, 'screenshot'); // 3000: not a fatal close, so it tries again
    });
    await b.page.waitForSelector('[data-screen="connection"][data-active-state~="reconnecting"]', { timeout: 15_000 });
    await shot(b, '36-reconnecting');
    await b.page.evaluate(() => {
      const mode = window.__game.mode;
      mode.open = window.__open;
      mode.open();
    });
  }

  // ---- results: the minute runs out
  await screen(a, 'results', 120_000);
  await sleep(1500);
  await shot(a, '37-results-host');
  await shot(b, '38-results-guest');
  await click(b, 'Play again');
  await shot(b, '39-results-voted');

  if (devHook) {
    await b.page.evaluate(() => {
      const mode = window.__game.mode;
      mode.open = () => {};
      mode.droppedAt = performance.now() - 61_000;
      mode.transport?.close?.(3000, 'screenshot'); // 3000: not a fatal close, so it tries again
    });
    await b.page.waitForSelector('[data-screen="connection"][data-active-state~="connection-lost"]', { timeout: 15_000 });
    await shot(b, '40-connection-lost');
  }

  // a room that isn't there
  await a.page.goto(`${base}/r/QQQQQQ`, { waitUntil: 'load' });
  await a.page.waitForSelector('[data-screen="connection"][data-active-state~="room-not-found"]', { timeout: 30_000 });
  await shot(a, '41-room-not-found');

  // ---- training against the bots, then the phone HUD
  await a.page.goto(`${base}/?app&time=30`, { waitUntil: 'load' });
  await screen(a, 'home');
  await click(a, 'Training');
  await a.page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 30_000 });
  await a.page.mouse.move(1300, 400);
  await sleep(2500);
  await shot(a, '42-training-hud');

  await b.browser.close();
  const phone = await launch('phone', { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true });
  await phone.page.goto(`${base}/?app&time=40`, { waitUntil: 'load' });
  await enterName(phone, `Raja${suffix()}`);
  await shot(phone, '50-phone-home');
  await (await button(phone, 'Training')).tap();
  await sleep(2000);
  const got = await phone.page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
  if (got) await got.tap();
  await phone.page.waitForSelector('html[data-touch-controls]', { timeout: 30_000 });
  await sleep(3000);
  await shot(phone, '51-phone-hud');
  await phone.browser.close();
  log('done; page errors:', JSON.stringify({ A: a.errors, B: b.errors }));
} catch (e) {
  log('FAILED', e.message);
  await shot(a, '99-fail-A').catch(() => {});
  await shot(b, '99-fail-B').catch(() => {});
  process.exitCode = 1;
} finally {
  await a.browser.close();
  await b.browser.close().catch(() => {});
}
