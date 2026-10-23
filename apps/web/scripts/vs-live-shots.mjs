/**
 * The VS poster in the real flow: a training match against bots in the app (dev server), from the title
 * through the name screen to Training, then the countdown: the poster, the strip at 3, and the HUD's
 * scoreboard with the avatars. Desktop (1920×1080) or phone (812×375, touch).
 *
 *   cd apps/web && pnpm exec vite --port 8234 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/vs-live-shots.mjs http://127.0.0.1:8234 <out dir> [desktop|phone]
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8234').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/match-presentation');
const form = process.argv[4] ?? 'desktop';
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const phone = form === 'phone';
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'vs-live-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: phone ? { width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: true } : { width: 1920, height: 1080 },
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
if (phone) await page.setUserAgent(PHONE_UA);
try {
  await page.goto(`${base}/?app`, { waitUntil: 'load', timeout: 180_000 });
  await page.evaluate(() => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.name', 'Ade');
    localStorage.setItem('locker.loadout.v1', JSON.stringify({ version: 1, loadout: { items: { bodyType: 'body_female', skinTone: 'skin_10', headgear: 'headgear_bandana', eyewear: 'eyewear_aviators', top: 'top_fatigues', gloves: 'gloves_tactical', legs: 'legs_fatigues', boots: 'boots_jungle', jetpack: 'jetpack_drum', exhaust: 'exhaust_plasma', trail: 'trail_smoke', hair: 'hair_braids' }, dyes: { primary: 'dye_red', secondary: 'dye_white', accent: 'dye_yellow' } } }));
  });
  await page.goto(`${base}/?app&bots=7${process.env.TEAMS ? `&teams=${process.env.TEAMS}` : ''}`, { waitUntil: 'load', timeout: 180_000 });
  // the title: any key / tap
  await new Promise((r) => setTimeout(r, 3000));
  await page.keyboard.press('Enter');
  const name = await page.waitForSelector('input[aria-label="Your name"]', { timeout: 30_000 }).catch(() => null);
  if (name) {
    await name.type('Ade');
    await page.waitForSelector('button[type=submit]:not([disabled])', { timeout: 30_000 });
    await page.click('button[type=submit]');
  }
  const training = await page.waitForSelector('xpath/.//button[.//b[normalize-space(.)="Training"]]', { timeout: 60_000 });
  await training.click();
  log('training');
  // as the flood uncovers it (training goes straight into its countdown: portraits render under the poster
  // and cross-fade in as they land; on a software rasteriser most won't be in yet)
  await page.waitForSelector('.vs:not(.is-held)', { timeout: 120_000 });
  log('poster up');
  await page.screenshot({ path: join(out, `${form}-live-01-poster.png`) });
  log('poster shot');
  await page.waitForSelector('[data-screen="vs-strip"], [data-screen="m-vs-strip"]', { timeout: 30_000 });
  await page.screenshot({ path: join(out, `${form}-live-02-strip.png`) });
  log('strip shot');
  if (!phone) {
    await page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 30_000 });
    await new Promise((r) => setTimeout(r, 1500));
    await page.keyboard.down('Tab');
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: join(out, `${form}-live-03-scoreboard.png`) });
    await page.keyboard.up('Tab');
    log('scoreboard shot');
  }
  console.log(JSON.stringify({ errors }, null, 2));
} catch (e) {
  log('FAILED', e.message);
  await page.screenshot({ path: join(out, `${form}-live-99-fail.png`) }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
