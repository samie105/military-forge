/**
 * Round two's gear screens (UI v2 phase 6), shot in headless Chrome (throwaway profile): the Locker
 * (the app's #/locker route), the Armory (armory.html) and the world tags over the items on the map
 * (training, by the test armory's rack and a lone crate). One browser per window size; `strips` adds
 * 16 ms frame strips of the Locker's tab change and the Armory's gun change (every animation paused
 * and stepped, as menus-v2.mjs does), and their Reduce motion variants.
 *
 *   cd apps/web && DEV_API=http://127.0.0.1:8791 pnpm exec vite --port 5191 --strictPort
 *   node apps/web/scripts/gear-v2.mjs [http://127.0.0.1:5191] [out dir] [1920x1080] [text scale 1] [strips] [phone]
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5191').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'gear-v2-shots');
const [w, h] = (process.argv[4] ?? '1920x1080').split('x').map(Number);
const textScale = Number(process.argv[5] ?? 1);
const flags = new Set(process.argv.slice(6));
const phone = flags.has('phone');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAME_MS = 16;
const tag = `${w}x${h}${textScale !== 1 ? `-text${Math.round(textScale * 100)}` : ''}`;
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'gear-v2-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: phone ? { width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true } : { width: w, height: h },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
const cdp = await page.createCDPSession();
await cdp.send('Animation.enable');
const shot = async (name, settle = 700) => {
  await sleep(settle);
  await page.screenshot({ path: join(out, `${name}-${tag}.png`) });
  console.log('wrote', `${name}-${tag}`);
};
const click = async (selector) => (await page.waitForSelector(selector, { timeout: 30_000 })).click();
const settings = (s) =>
  page.evaluate((s) => {
    const key = 'settings.v1';
    const was = JSON.parse(localStorage.getItem(key) ?? '{}');
    localStorage.setItem(key, JSON.stringify({ ...was, ...s, rev: 2 }));
  }, s);

/** One move, 16 ms a frame (menus-v2.mjs's strip, short form): the animations the trigger starts, paused and stepped. */
async function strip(name, ms, trigger, clipSel) {
  const dir = join(out, 'strips', name);
  mkdirSync(dir, { recursive: true });
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
  await page.evaluate(() => (window.__trigAt = document.timeline.currentTime));
  await trigger();
  await page.evaluate(() => {
    window.__strip = document.getAnimations().map((a) => {
      const fresh = a.startTime === null || a.startTime >= window.__trigAt - 1;
      const t0 = fresh ? 0 : Number(a.currentTime) || 0;
      a.pause();
      return { a, t0 };
    });
  });
  const clip = clipSel
    ? await page.$eval(clipSel, (el) => {
        const r = el.getBoundingClientRect();
        return { x: Math.max(0, r.left - 30), y: Math.max(0, r.top - 30), width: Math.min(innerWidth, r.width + 60), height: Math.min(innerHeight, r.height + 60) };
      })
    : undefined;
  for (let k = 0; k <= Math.floor(ms / FRAME_MS); k++) {
    await page.evaluate((t) => {
      for (const { a, t0 } of window.__strip) a.currentTime = t0 + t;
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }, k * FRAME_MS);
    await page.screenshot({ path: join(dir, `${String(k * FRAME_MS).padStart(4, '0')}ms.png`), clip });
  }
  await page.evaluate(() => {
    for (const { a } of window.__strip) {
      try {
        a.finish();
      } catch {
        a.play();
      }
    }
  });
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  console.log('strip', name);
}

try {
  // ---- a name, so the app's routes open
  await page.goto(`${base}/?app`, { waitUntil: 'load' });
  await settings({ textScale, reduceMotion: false });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await page.waitForSelector('button[type=submit]:not([disabled])', { timeout: 60_000 });
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-screen="home"], [data-screen="m-home"]', { timeout: 30_000 });

  // ---- the Locker (the app's route)
  await page.evaluate(() => (location.hash = '#/locker'));
  await page.waitForSelector('.mm-locker', { timeout: 30_000 });
  await page.waitForSelector('.mm-overlay[hidden]', { timeout: 300_000 });
  await shot('60-locker-outfit', 1500);
  if (!phone) {
    await click('[data-tab="1"]');
    // a locked helmet, tried on
    const locked = await page.$('[data-tab-panel], .mm-panel .item.is-locked');
    if (locked) await locked.click();
    await shot('61-locker-helmet-try-locked');
    await click('[data-tab="4"]');
    await shot('62-locker-dyes');
    if (flags.has('strips')) {
      await strip('locker-tab', 304, async () => (await click('[data-tab="0"]'), await page.waitForSelector('[data-tab="0"][aria-selected="true"]')), '.mm-tabs');
      await settings({ reduceMotion: true });
      await page.evaluate(() => document.documentElement.classList.add('reduce-motion'));
      await strip('locker-tab-reduce-motion', 304, async () => (await click('[data-tab="5"]'), await page.waitForSelector('[data-tab="5"][aria-selected="true"]')), '.mm-tabs');
      await page.evaluate(() => document.documentElement.classList.remove('reduce-motion'));
      await settings({ reduceMotion: false });
    }
  }
  if (phone) {
    await browser.close();
    process.exit(0);
  }

  // ---- the Armory (its page)
  await page.goto(`${base}/armory.html?weapon=breacher`, { waitUntil: 'load' });
  await page.waitForSelector('.mf-overlay[hidden]', { timeout: 300_000 });
  const chrome = await page.$('[data-camo]:not([data-camo=""]):not([disabled])');
  if (chrome) await chrome.click();
  const att = await page.$('[data-attach]');
  if (att) await att.click();
  await shot('70-armory-breacher', 2500);
  if (flags.has('strips')) {
    await strip('armory-gun', 320, async () => (await click('[data-weapon="k47"]'), await page.waitForSelector('[data-weapon="k47"][aria-pressed="true"]')), '.ar__stage');
  }

  // ---- the world tags: training by the rack, then by a lone crate
  await page.goto(`${base}/?app&time=600`, { waitUntil: 'load' });
  await page.waitForSelector('[data-screen="home"]', { timeout: 30_000 });
  await page.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
  await page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 60_000 });
  await sleep(1500);
  const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
  if (got) await got.click();
  // stand by the rack's middle (the first armory crates), held alive
  await page.evaluate(() => {
    const mode = window.__game.mode;
    const update = mode.update.bind(mode);
    mode.update = (dt) => {
      const f = update(dt);
      const me = f.players.find((p) => p.id === f.localId);
      const rack = (f.pickups ?? []).filter((k) => k.def >= 7).sort((a, b) => a.x - b.x);
      const at = rack[Math.min(rack.length - 1, 6)];
      if (me && at && window.__standAt === 'rack') Object.assign(me, { x: at.x, y: at.y, vx: 0, vy: 0, alive: true, hp: 100 });
      return f;
    };
    window.__standAt = 'rack';
  });
  await page.mouse.move(w * 0.7, h * 0.3);
  await shot('80-world-rack', 2000);
  await browser.close();
} catch (e) {
  console.error('FAILED', e.message);
  await page.screenshot({ path: join(out, `fail-${tag}.png`) }).catch(() => {});
  await browser.close();
  process.exitCode = 1;
}
