/* global process */
/**
 * Every billboard on the Street Market, checked in a training match (the owner, 24 Oct: "I can't see
 * the ads on the street markets, some billboards aren't even showing"): a laptop (1280 × 720, Auto
 * graphics) and a phone (812 × 375, touch, 4× CPU slowdown, Low graphics). The player is placed at
 * each board in turn; the script records, per board on screen, whether it is lit, whether its
 * creatives are uploaded, which creative it shows and whose it is, and screenshots each view.
 *   cd apps/web && pnpm exec vite --port 5312 --strictPort        # in another shell (a dev server: the hooks)
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/ads-board-audit.mjs [--base …] [--out docs/screenshots/ads-boards] [--label after] [--stale house.json]
 *
 * `--stale <file>` serves that file for every request to the pool's house.json without a query
 * string, as a browser holding a week-old cached copy would (the live server sent `/assets/*` with
 * max-age=604800 and no revalidation). Exits non-zero when any board in view is dark, not uploaded,
 * or shows something that isn't a sponsor's creative.
 */
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://127.0.0.1:5312');
const out = resolve(arg('out', 'docs/screenshots/ads-boards'));
const label = arg('label', 'after');
const stale = arg('stale', null);
/** a production site (no dev hooks): read only, offline (every /api request refused), screenshots only */
const live = process.argv.includes('--live');
const staleBody = stale ? readFileSync(stale) : null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const problems = [];

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'ads-board-audit-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 240_000,
});

// S1 west junction, H1 flyover, S3 danfo park, S2 central tower, S4 east gantry, H2 east roof
const VIEWS = [
  { name: 'west', at: [-50, 8.05] },
  { name: 'flyover', at: [-57, 12.05] },
  { name: 'centre', at: [-12, 0.05] },
  { name: 'tower', at: [20, 12.05] },
  { name: 'east', at: [50, 8.05] },
  { name: 'gantry', at: [56, 12.05] },
];

async function open(phone) {
  const page = await browser.newPage();
  const missing = [];
  page.on('pageerror', (e) => problems.push(`${phone ? 'phone' : 'laptop'}: page error: ${e.message}`));
  page.on('response', (r) => {
    if (r.status() >= 400 && r.url().includes('/assets/ads/')) missing.push(`${r.status()} ${new URL(r.url()).pathname}`);
  });
  if (staleBody || live) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (staleBody && u.pathname.endsWith('/ads/street_market/house.json') && !u.search) return void req.respond({ status: 200, contentType: 'application/json', body: staleBody });
      if (u.pathname.startsWith('/api/')) return void req.abort(); // offline: training only, nothing written anywhere
      void req.continue();
    });
  }
  if (phone) {
    await page.emulate({ viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: PHONE_UA });
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  } else await page.setViewport({ width: 1280, height: 720 });
  const gfx = phone ? '&gfx=low' : '';
  await page.goto(`${base}/?app&notitle&map=street-market&time=600${gfx}`, { waitUntil: 'load', timeout: 120_000 });
  await page.evaluate((phone) => {
    localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ mode: phone ? 'on' : 'off', fireChosen: true }));
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.setItem('mf.touch.hints.v1', JSON.stringify(['dash-swipe', 'grenade-types', 'swap-radial', 'take', 'shield-hold']));
    localStorage.setItem('mf.ads.hint.v1', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('profile.offlineName.v1', 'Auditor');
  }, phone);
  await page.reload({ waitUntil: 'load', timeout: 120_000 });
  for (let i = 0; i < 60; i++) {
    const name = await page.$('input[aria-label="Your name"]');
    if (name) {
      await name.type(`Aud${Math.floor(Math.random() * 900 + 100)}`);
      await sleep(800);
      await page.click('button[type=submit]');
    }
    // first run: the creator, then the briefing (onboarding): skip both
    for (const words of ['Skip for now', 'Skip all training', 'Not now']) {
      const skip = await page.$(`xpath/.//button[contains(normalize-space(.), "${words}")]`);
      if (skip) await skip.click();
    }
    // in a match (or its poster) already: done; else (re)try Training, whatever covered it before
    if (await page.$('#hud[data-active-state~="match"], [data-screen="vs-poster"], [data-screen="vs-strip"]')) break;
    const training = await page.$('xpath/.//button[contains(normalize-space(.), "Training")]');
    if (training) await training.click().catch(() => {});
    await sleep(2500);
  }
  if (live) {
    await page.waitForSelector('#hud[data-active-state~="match"], [data-screen="vs-poster"]', { timeout: 180_000 }).catch(async (e) => {
      mkdirSync(out, { recursive: true });
      await page.screenshot({ path: join(out, `${label}-${phone ? 'phone' : 'laptop'}-stuck.png`) });
      throw e;
    });
    return { page, missing };
  }
  await page.waitForFunction(() => window.__game?.mode?.me && window.__game?.view3d?.env?.boards, { timeout: 180_000 });
  // every creative of the set in (uploads are async)
  await page.waitForFunction(() => window.__game.view3d.env.boards.formats.every((f) => f.layers.size > 0), { timeout: 120_000 }).catch(() => problems.push(`${phone ? 'phone' : 'laptop'}: the boards' creatives never finished uploading`));
  // the VS poster before the countdown: any key (a tap on a phone) skips it; then the countdown runs out
  for (let i = 0; i < 20 && (await page.$('[data-screen="vs-poster"]')); i++) {
    if (phone) await page.touchscreen.tap(400, 200);
    else await page.keyboard.press('KeyK');
    await sleep(800);
  }
  await page.waitForFunction(() => !document.querySelector('[data-screen="vs-poster"], [data-screen="vs-strip"]'), { timeout: 60_000 }).catch(() => {});
  await sleep(1500);
  return { page, missing };
}

/** Per board in view: lit, uploaded, the creative shown and its advertiser. */
const boards = (page) =>
  page.evaluate(() => {
    const b = window.__game.view3d.env.boards;
    const entries = new Map([...b.pool.screens, ...b.pool.hoardings, ...(b.pool.sponsored?.screens ?? []), ...(b.pool.sponsored?.hoardings ?? []), ...(b.pool.studio?.screens ?? []), ...(b.pool.studio?.hoardings ?? [])].map((e) => [e.id, e]));
    const pose = b.pose;
    const out = [];
    b.slots.forEach((slot, i) => {
      const halfH = Math.tan((35 / 2) * (Math.PI / 180)) * (pose.z - slot.pos[2]);
      const halfW = halfH * pose.aspect;
      const cy = pose.y - (pose.z - slot.pos[2]) * Math.tan((5 * Math.PI) / 180);
      const inView = Math.abs(slot.pos[0] - pose.x) < halfW + slot.size[0] / 2 && Math.abs(slot.pos[1] - cy) < halfH + slot.size[1] / 2;
      if (!inView) return;
      const f = b.formats.find((x) => x.slots.includes(slot));
      const frames = b.manifest.slots.find((s) => s.slot === slot.slotId)?.frames ?? [];
      const n = Math.max(1, slot.frames);
      const frame = frames[(((Math.floor(b.matchTimeMs / slot.dwellMs) + slot.phaseIdx) % n) + n) % n];
      const e = frame ? entries.get(frame.c) : undefined;
      out.push({ slot: slot.slotId, lit: +b.limiter.lit[i].toFixed(2), uploaded: (f?.layers.size ?? 0) > 0, creative: frame?.c ?? null, advertiser: e?.advertiser ?? null, frames: frames.length });
    });
    return out;
  });

async function audit(phone) {
  const who = phone ? 'phone' : 'laptop';
  console.log(who);
  const { page, missing } = await open(phone);
  if (live) {
    // no hooks: the spawn view, then zoomed out (more boards in view), 20 s apart (two beats)
    for (let i = 0; i < 20 && (await page.$('[data-screen="vs-poster"]')); i++) {
      if (phone) await page.touchscreen.tap(400, 200);
      else await page.keyboard.press('KeyK');
      await sleep(800);
    }
    await sleep(8000);
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: join(out, `${label}-${who}-spawn.png`) });
    for (let i = 0; i < 6; i++) await page.mouse.wheel({ deltaY: 120 });
    await sleep(2500);
    await page.screenshot({ path: join(out, `${label}-${who}-wide.png`) });
    await sleep(20000);
    await page.screenshot({ path: join(out, `${label}-${who}-wide-later.png`) });
    if (missing.length) problems.push(`${who}: ad files failed: ${[...new Set(missing)].join(', ')}`);
    console.log(`  ${who}: screenshots taken; failed ad files: ${missing.length}`);
    await page.close();
    return;
  }
  const seen = new Map();
  for (const v of VIEWS) {
    await page.evaluate(({ x, y }) => {
      const m = window.__game.mode;
      m.me.spawn(x, y, m.game.tuning);
    }, { x: v.at[0], y: v.at[1] });
    await sleep(phone ? 3500 : 1800);
    mkdirSync(out, { recursive: true });
    await page.screenshot({ path: join(out, `${label}-${who}-${v.name}.png`) });
    for (const b of await boards(page)) {
      seen.set(b.slot, b);
      const bad = b.lit < 0.5 ? 'dark' : !b.uploaded ? 'not uploaded' : !b.creative ? 'no creative' : !b.advertiser ? `not a sponsor (${b.creative})` : '';
      console.log(`  ${v.name.padEnd(8)} ${b.slot.padEnd(18)} lit ${b.lit} ${b.creative ?? '-'} ${b.advertiser ?? ''}${bad ? `  << ${bad}` : ''}`);
      if (bad) problems.push(`${who} ${v.name}: ${b.slot} ${bad}`);
    }
  }
  // zoomed out as far as the gun allows: more boards in view at once, every one must be lit
  await page.evaluate(() => {
    const c = document.getElementById('game');
    for (let i = 0; i < 8; i++) c.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));
  });
  for (const v of [VIEWS[0], VIEWS[2], VIEWS[4]]) {
    await page.evaluate(({ x, y }) => {
      const m = window.__game.mode;
      m.me.spawn(x, y, m.game.tuning);
    }, { x: v.at[0], y: v.at[1] });
    await sleep(phone ? 3500 : 1800);
    await page.screenshot({ path: join(out, `${label}-${who}-${v.name}-wide.png`) });
    const inView = await boards(page);
    for (const b of inView) {
      const bad = b.lit < 0.5 ? 'dark' : !b.advertiser ? `not a sponsor (${b.creative})` : '';
      console.log(`  ${(v.name + '+').padEnd(8)} ${b.slot.padEnd(18)} lit ${b.lit} ${b.creative ?? '-'} ${b.advertiser ?? ''}${bad ? `  << ${bad}` : ''}`);
      if (bad) problems.push(`${who} ${v.name} zoomed out: ${b.slot} ${bad}`);
    }
  }
  const all = await page.evaluate(() => window.__game.view3d.env.boards.slots.map((s) => s.slotId));
  for (const s of all) if (!seen.has(s)) problems.push(`${who}: ${s} never came into view`);
  if (missing.length) problems.push(`${who}: ad files failed: ${[...new Set(missing)].join(', ')}`);
  await page.close();
}

try {
  await audit(false);
  await audit(true);
} catch (e) {
  problems.push(String(e?.stack ?? e));
}
await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('every board lit with a sponsor’s creative');
