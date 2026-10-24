/**
 * Home shows the player's own soldier (the owner, 24 Oct: "isn't the player avatar supposed to be here").
 * Opens the app the way a player does (the title on: `?title`, as the installed app opens), presses past
 * it, waits on Home, and checks the stage holds a rendered soldier: the portrait's picture is loaded and
 * has real pixels (drawn into a canvas: opaque pixels in the figure's colours, not the helmet glyph, which
 * is an SVG and never an <img>). Then a second visit: the picture comes from this device's cache. Desktop
 * (1920×1080) and phone (812×375, touch). Exits 1 on a failure.
 *
 *   cd apps/web && pnpm exec vite --port 8240 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/home-soldier-check.mjs http://127.0.0.1:8240 [out dir]
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8240').replace(/\/$/, '');
const out = process.argv[3] ? resolve(process.argv[3]) : null;
if (out) mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
/** how long Home may take to show the soldier (software WebGL in CI is slow; a real GPU takes well under 2 s) */
const LIMIT_MS = Number(process.env.SOLDIER_MS ?? 60_000);
const LOOK = { items: { bodyType: 'body_female', skinTone: 'skin_10', headgear: 'headgear_bandana', eyewear: 'eyewear_aviators', top: 'top_fatigues', gloves: 'gloves_tactical', legs: 'legs_fatigues', boots: 'boots_jungle', jetpack: 'jetpack_drum', exhaust: 'exhaust_plasma', trail: 'trail_smoke', hair: 'hair_braids' }, dyes: { primary: 'dye_red', secondary: 'dye_white', accent: 'dye_yellow' } };
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);
const failures = [];

/** On the page: the stage's picture, measured (null until it has loaded). */
function measure() {
  const img = document.querySelector('.mf-soldier .pt__img');
  if (!img || !img.complete || !img.naturalWidth) return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 96;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, c.width, c.height);
  const px = g.getImageData(0, 0, c.width, c.height).data;
  let opaque = 0;
  const colours = new Set();
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 200) continue;
    opaque++;
    colours.add(((px[i] >> 4) << 8) | ((px[i + 1] >> 4) << 4) | (px[i + 2] >> 4));
  }
  const mark = document.querySelector('.mf-soldier__mark');
  return { w: img.naturalWidth, h: img.naturalHeight, opaque: opaque / (c.width * c.height), colours: colours.size, helmetOpacity: mark ? Number(getComputedStyle(mark).opacity) : null };
}

async function run(form) {
  const phone = form === 'phone';
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    userDataDir: mkdtempSync(join(tmpdir(), 'home-soldier-')),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: phone ? { width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: true } : { width: 1920, height: 1080 },
    protocolTimeout: 300_000,
  });
  const errors = [];
  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    if (phone) await page.setUserAgent(PHONE_UA);
    await page.goto(`${base}/?app&notitle`, { waitUntil: 'load', timeout: 180_000 });
    await page.evaluate((look) => {
      localStorage.setItem('mf-creator-seen', '1');
      localStorage.setItem('tips.seen.v1', '1');
      localStorage.setItem('mf.name', 'Beas');
      localStorage.setItem('locker.loadout.v1', JSON.stringify({ version: 1, loadout: look }));
    }, LOOK);
    for (const visit of ['first', 'cached']) {
      // the title on, as a player (and the installed app) opens the game
      await page.goto(`${base}/?app&title`, { waitUntil: 'load', timeout: 180_000 });
      await new Promise((r) => setTimeout(r, 1500));
      if (phone) await page.touchscreen.tap(400, 200);
      else await page.keyboard.press('Enter');
      // the name screen the first time (after the title's push), else Home
      await page.waitForSelector('input[aria-label="Your name"], .mf-soldier, .mf-orders__later, .mf-orders__x', { timeout: 60_000 }).catch(() => null);
      const name = await page.$('input[aria-label="Your name"]');
      if (name) {
        await name.type('Beas');
        // with no API (offline dev) the first Continue may only say it couldn't check the name: again
        for (let i = 0; i < 5 && (await page.$('input[aria-label="Your name"]')); i++) {
          await page.click('button[type=submit]').catch(() => {});
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      // the phone's Next orders take the soldier's column while there's a card: "Not now" on each
      for (let i = 0; phone && i < 8 && !(await page.$('.mf-soldier')); i++) {
        const later = await page.waitForSelector('.mf-orders__later, .mf-orders__x', { timeout: 10_000 }).catch(() => null);
        if (!later) break;
        await later.click();
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!(await page.waitForSelector('.mf-soldier', { timeout: 60_000 }).catch(() => null))) {
        if (out) await page.screenshot({ path: join(out, `${form}-home-soldier-${visit}-nohome.png`) });
        failures.push(`${form} ${visit}: Home's stage never showed`);
        continue;
      }
      const shown = Date.now();
      log(form, visit, 'home');
      let m = null;
      while (Date.now() - shown < LIMIT_MS) {
        m = await page.evaluate(measure);
        if (m && m.helmetOpacity !== null && m.helmetOpacity < 0.05) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      const ms = Date.now() - shown;
      log(form, visit, m ? `soldier in ${ms} ms: ${m.w}×${m.h}, ${(m.opaque * 100).toFixed(0)}% opaque, ${m.colours} colours, helmet ${m.helmetOpacity}` : `no soldier after ${ms} ms`);
      if (!m) failures.push(`${form} ${visit}: no rendered soldier on Home within ${LIMIT_MS} ms`);
      else if (m.opaque < 0.08 || m.colours < 12) failures.push(`${form} ${visit}: the stage's picture is nearly empty (${(m.opaque * 100).toFixed(0)}% opaque, ${m.colours} colours)`);
      else if (m.helmetOpacity > 0.05) failures.push(`${form} ${visit}: the helmet still covers the soldier`);
      if (out) await page.screenshot({ path: join(out, `${form}-home-soldier-${visit}.png`) });
    }
  } finally {
    await browser.close();
  }
  if (errors.length) failures.push(`${form}: page errors: ${errors.join(' | ')}`);
}

for (const form of (process.env.FORMS ?? 'desktop,phone').split(',')) await run(form);
console.log(JSON.stringify({ failures }, null, 2));
process.exit(failures.length ? 1 : 0);
