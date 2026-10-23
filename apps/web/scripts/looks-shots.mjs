/**
 * Looks on the wire (protocol v19), seen in the browser: two players in separate headless Chrome
 * profiles through a playtest link. A has saved a look of her own (the female soldier, red and
 * white, bandana, aviators); B has the default. They meet in a match, and B's screen draws A, and the
 * room's bots, each in their own look. Shots of B's screen (and A's) go to the out dir, every
 * 1.2 s of play, to pick from.
 *
 *   lockf -k /tmp/military-forge-heavy.lock pnpm --filter @military-forge/web build
 *   pnpm playtest --local --no-build --port 8177
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/looks-shots.mjs http://127.0.0.1:8177 <out dir> [desktop|phone]
 *
 * Works on the production build (no dev hooks): it only sets the saved look, clicks, types and holds keys.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const [base = 'http://127.0.0.1:8177', outArg = 'docs/screenshots/match-presentation/raw', form = 'desktop'] = process.argv.slice(2);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);

/** A's look: every item a starter item, so the room lets a level-1 guest wear it all */
const HERS = {
  items: {
    bodyType: 'body_female', skinTone: 'skin_10', headgear: 'headgear_bandana', eyewear: 'eyewear_aviators', top: 'top_fatigues',
    gloves: 'gloves_tactical', legs: 'legs_fatigues', boots: 'boots_jungle', jetpack: 'jetpack_drum', exhaust: 'exhaust_plasma', trail: 'trail_smoke', hair: 'hair_braids',
  },
  dyes: { primary: 'dye_red', secondary: 'dye_white', accent: 'dye_yellow' },
};

async function player(label, phone) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    userDataDir: mkdtempSync(join(tmpdir(), `looks-${label}-`)),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: phone ? { width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: true } : { width: 1920, height: 1080 },
  });
  const page = await browser.newPage();
  if (phone) await page.setUserAgent(PHONE_UA);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { browser, page, label, errors };
}

const byText = (page, tag, text, timeout = 60_000) => page.waitForSelector(`xpath/.//${tag}[contains(normalize-space(.), "${text}")]`, { timeout });

async function enter(p, url, name, look) {
  await p.page.goto(base, { waitUntil: 'load', timeout: 180_000 });
  await p.page.evaluate((look) => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    if (look) localStorage.setItem('locker.loadout.v1', JSON.stringify({ version: 1, loadout: look }));
  }, look);
  await p.page.goto(url, { waitUntil: 'load', timeout: 180_000 });
  await p.page.waitForSelector('input[aria-label="Your name"]', { timeout: 180_000 });
  await p.page.type('input[aria-label="Your name"]', name);
  await p.page.waitForSelector('button[type=submit]:not([disabled])', { timeout: 60_000 });
  await p.page.click('button[type=submit]');
}

const phone = form === 'phone';
const a = await player('A', false);
const b = await player('B', phone);
try {
  await enter(a, base, `Ade${Math.floor(Math.random() * 900 + 100)}`, HERS);
  await (await byText(a.page, 'button', 'Create room')).click();
  await a.page.waitForSelector('[data-screen="lobby"]', { timeout: 60_000 });
  const roomLink = a.page.url();
  log('room', roomLink);
  await enter(b, roomLink, `Kemi${Math.floor(Math.random() * 900 + 100)}`, null);
  await sleep(4000);
  await b.page.screenshot({ path: join(out, `${form}-lobby-B.png`) });
  await (await byText(a.page, 'button', 'Start now')).click();
  await a.page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 60_000 });
  log('match on');
  for (const p of [a, b]) {
    const got = await p.page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
    if (got) await got.click();
  }
  // A holds still; B goes looking for her (left, then right), hopping over steps: shots of both, to pick from
  const dirs = ['KeyA', 'KeyD'];
  let dir = 0;
  if (!phone) await b.page.keyboard.down(dirs[dir]);
  for (let i = 0; i < 20; i++) {
    await sleep(1200);
    if (!phone) {
      if (i === 9) {
        await b.page.keyboard.up(dirs[dir]);
        dir = 1;
        await b.page.keyboard.down(dirs[dir]);
      }
      if (i % 2 === 0) await b.page.keyboard.down('KeyW');
      else await b.page.keyboard.up('KeyW');
    }
    await b.page.screenshot({ path: join(out, `${form}-match-B-${String(i).padStart(2, '0')}.png`) });
    if (!phone && i % 4 === 0) await a.page.screenshot({ path: join(out, `${form}-match-A-${String(i).padStart(2, '0')}.png`) });
    log('shot', i);
  }
  console.log(JSON.stringify({ errors: { A: a.errors, B: b.errors } }, null, 2));
} catch (e) {
  log('FAILED', e.message);
  await a.page.screenshot({ path: join(out, '99-fail-A.png') }).catch(() => {});
  await b.page.screenshot({ path: join(out, '99-fail-B.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  await a.browser.close();
  await b.browser.close();
}
