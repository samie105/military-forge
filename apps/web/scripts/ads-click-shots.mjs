/* global process */
/**
 * Tap-to-save, end to end in the app (the owner's ask, 23 Oct 2026): a laptop (1280 × 720, mouse:
 * point at a billboard and press E) and a phone in landscape (812 × 375, touch: tap the billboard).
 * Each saves two ads in a training match on the Street Market, shows the quiet toast, then the
 * results screen's "Saved ads" cards, then Home's.
 *   cd apps/web && pnpm exec vite --port 5311 --strictPort        # in another shell
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/ads-click-shots.mjs [--base http://localhost:5311] [--out docs/screenshots/ads-click]
 *
 * The boards are given a manifest (AdBoards.setManifest) with one sponsored creative per surface, so
 * the shots don't wait on the rotation; every frame carries its click-through exactly as the house
 * rotation's do (clickOf). The gestures are real: a mouse move and the E key, a touchscreen tap.
 * Exits non-zero if a save didn't happen, a gun shot registered as a save, or the cards are missing.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5311');
const out = resolve(arg('out', 'docs/screenshots/ads-click'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const problems = [];

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'ads-click-shots-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

async function shot(page, name) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  ${name}.png`);
}

const SET = {
  'street-market/S1': 'house:ws-academy-motion',
  'street-market/S2': 'house:deet-napkin-motion',
  'street-market/S3': 'house:ws-xtream-motion',
  'street-market/S4': 'house:deet-friday-motion',
  'street-market/H1': 'house:ws-ecosystem-wide-motion',
  'street-market/H2': 'house:deet-release-wide-motion',
};

async function open(phone) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  if (phone) {
    await page.emulate({ viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: PHONE_UA });
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  } else await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${base}/?app&notitle&map=street-market&time=45`, { waitUntil: 'load' });
  await page.evaluate((phone) => {
    localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ mode: phone ? 'on' : 'off', fireChosen: true }));
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.setItem('mf.touch.hints.v1', JSON.stringify(['dash-swipe', 'grenade-types', 'swap-radial', 'take', 'shield-hold']));
    localStorage.setItem('mf.ads.hint.v1', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.removeItem('mf.ads.saved.v1');
  }, phone);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await sleep(1200);
  await page.click('button[type=submit]');
  // the character creator's first visit: skip it
  for (let i = 0; i < 20; i++) {
    const skip = await page.$('xpath/.//button[contains(normalize-space(.), "Skip for now")]');
    if (skip) {
      await skip.click();
      break;
    }
    if (await page.$('xpath/.//button[contains(normalize-space(.), "Training")]')) break;
    await sleep(500);
  }
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Training")]', { timeout: 30_000 })).click();
  await page.waitForFunction(() => window.__game?.view3d?.env?.boards && window.__ads, { timeout: 120_000 });
  for (let i = 0; i < 16; i++) {
    const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
    if (got) {
      await got.click();
      break;
    }
    await sleep(500);
  }
  // one sponsored creative per surface, with its click-through, as the rotation gives them
  await page.evaluate(async (set) => {
    const ads = await import('/src/render3d/ads/index.ts');
    const b = window.__game.view3d.env.boards;
    const entries = ads.poolEntries(b.pool);
    const frame = (id) => {
      const e = entries.find((x) => x.id === id);
      const f = e.keys?.length ? { c: id, k: e.keys.length + 1, paid: false } : { c: id, paid: false };
      const click = ads.clickOf(b.pool, e);
      return click ? { ...f, click } : f;
    };
    b.setManifest({ id: 'shots', map: 'street-market', geo: 'XX', slots: b.slots.map((s) => ({ slot: s.slotId, frames: Array.from({ length: s.frames }, () => frame(set[s.slotId])) })) });
  }, SET);
  await sleep(2500);
  return page;
}

/** The local player at (x, y), the camera settled, the mouse resting on (mx, my) (screen px). */
async function place(page, x, y) {
  await page.evaluate(
    ({ x, y }) => {
      const m = window.__game.mode;
      m.me.spawn(x, y, m.game.tuning);
    },
    { x, y },
  );
  await sleep(1200);
}

/** A savable board on screen: its centre (screen px) and creative, or null. */
const findBoard = (page, not = []) =>
  page.evaluate((not) => {
    const game = (el) => el instanceof HTMLCanvasElement || (!!el?.closest('.mf-touch') && !el.closest('[data-mf-control], button'));
    const pts = [];
    for (let y = 8; y < innerHeight; y += 8) for (let x = 8; x < innerWidth; x += 8) {
      const h = window.__ads.pickScreen(x, y);
      // only where the game itself is on top (a HUD plate over the board takes the click)
      if (h && !not.includes(h.frame.click.advertiser) && game(document.elementFromPoint(x, y))) pts.push([x, y, h.frame.c, h.frame.click.advertiser]);
    }
    if (pts.length < 12) return null;
    const best = pts.filter((p) => p[2] === pts[0][2]);
    const cx = best.reduce((a, p) => a + p[0], 0) / best.length;
    const cy = best.reduce((a, p) => a + p[1], 0) / best.length;
    // the probed point nearest the middle: on the board and on the game
    const at = best.reduce((a, p) => (Math.hypot(p[0] - cx, p[1] - cy) < Math.hypot(a[0] - cx, a[1] - cy) ? p : a));
    return { x: at[0], y: at[1], c: at[2], adv: at[3] };
  }, not);

const saved = (page) => page.evaluate(() => window.__ads.queue.list().map((a) => a.advertiser));

async function laptop() {
  console.log('laptop');
  const page = await open(false);
  // S1 (the west junction)
  await place(page, -50, 8.05);
  let board = await findBoard(page);
  if (!board) throw new Error('laptop: no savable board in view');
  await page.mouse.move(board.x, board.y);
  await sleep(300);
  // a shot on the board saves nothing
  await page.mouse.down();
  await sleep(250);
  await page.mouse.up();
  await sleep(400);
  if ((await saved(page)).length) problems.push('laptop: a shot registered as a save');
  await sleep(800);
  await page.keyboard.press('KeyE');
  await sleep(350);
  await shot(page, 'laptop-toast');
  // a second advertiser's board
  await place(page, 50, 8.05);
  board = await findBoard(page, (await saved(page)).slice());
  if (board) {
    await page.mouse.move(board.x, board.y);
    await sleep(900);
    await page.mouse.click(board.x, board.y, { button: 'middle' });
    await sleep(350);
    await shot(page, 'laptop-toast-middle-click');
  }
  const list = await saved(page);
  console.log('  saved:', list.join(', '));
  if (list.length < 2) problems.push(`laptop: ${list.length} saves, wanted 2`);
  await page.waitForSelector('[data-screen="results"]', { timeout: 120_000 });
  await sleep(3500);
  await shot(page, 'laptop-results');
  if (!(await page.$('.mf-saved[data-where="results"]'))) problems.push('laptop: no Saved ads on the results screen');
  const home = await page.$('xpath/.//section[@data-screen="results"]//button[contains(normalize-space(.), "Home")]');
  await home?.click();
  await page.waitForSelector('[data-screen="home"]', { timeout: 30_000 });
  await sleep(2500);
  await shot(page, 'laptop-home');
  if (!(await page.$('.mf-saved[data-where="home"]'))) problems.push('laptop: no Saved ads on Home');
  await page.close();
}

async function phone() {
  console.log('phone');
  const page = await open(true);
  await place(page, -50, 8.05);
  let board = await findBoard(page);
  if (!board) throw new Error('phone: no savable board in view');
  await page.touchscreen.tap(board.x, board.y);
  await sleep(400);
  await shot(page, 'phone-toast');
  await place(page, 50, 8.05);
  board = await findBoard(page, (await saved(page)).slice());
  if (board) {
    await sleep(800);
    await page.touchscreen.tap(board.x, board.y);
    await sleep(400);
  }
  const list = await saved(page);
  console.log('  saved:', list.join(', '));
  if (list.length < 2) problems.push(`phone: ${list.length} saves, wanted 2`);
  await page.waitForSelector('[data-screen="m-results"]', { timeout: 120_000 });
  await sleep(6000);
  await shot(page, 'phone-results');
  // the debrief's layout with and without the strip: the strip must not widen anything
  const box = (sel) => page.evaluate((sel) => {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    return r ? [Math.round(r.left), Math.round(r.width), Math.round(r.top), Math.round(r.height)] : null;
  }, sel);
  const withStrip = { mvp: await box('.pm-mvp'), res: await box('.pm-res'), saved: await box('.mf-saved') };
  await page.evaluate(() => document.querySelector('.mf-saved')?.style.setProperty('display', 'none'));
  await sleep(300);
  const without = { mvp: await box('.pm-mvp'), res: await box('.pm-res') };
  await page.evaluate(() => document.querySelector('.mf-saved')?.style.removeProperty('display'));
  console.log('  debrief boxes', JSON.stringify({ withStrip, without }));
  if (!(await page.$('.mf-saved[data-where="results"]'))) problems.push('phone: no Saved ads on the results screen');
  const quit = await page.$('xpath/.//section[@data-screen="m-results"]//button[contains(normalize-space(.), "Quit")]');
  await quit?.click();
  await page.waitForSelector('[data-screen="m-home"]', { timeout: 30_000 });
  await sleep(2500);
  await shot(page, 'phone-home');
  if (!(await page.$('.mf-saved[data-where="home"]'))) problems.push('phone: no Saved ads on Home');
  await page.close();
}

try {
  await laptop();
  await phone();
} catch (e) {
  problems.push(String(e?.stack ?? e));
}
await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
