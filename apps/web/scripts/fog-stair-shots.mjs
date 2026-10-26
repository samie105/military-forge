/* global process */
/**
 * Fog Stair's tiers and landing pieces on screen (the kit, NOTES §50): the same spots before and
 * after an art change, on a desktop and on a phone-sized screen, on a stepped clock so every run
 * gives the same frames.
 *   cd apps/web && pnpm exec vite --port 5241 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/fog-stair-shots.mjs [--base http://127.0.0.1:5241]
 *     [--out docs/screenshots/fog-stair-kit] [--prefix after-] [--phone] [--hw] [--only riverside,stairs]
 *     [--query '&look=fog']
 * Each spot puts the local player on a surface (every other player removed) at a zoom level, aims a
 * little ahead, and shoots the screen. `--phone` is an 812 × 375 landscape phone (dpr 2, touch).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://127.0.0.1:5241');
const out = resolve(arg('out', 'docs/screenshots/fog-stair-kit'));
const prefix = arg('prefix', '');
const extra = arg('query', '');
const phone = process.argv.includes('--phone');
const hw = process.argv.includes('--hw');
const only = arg('only', '')
  .split(',')
  .filter(Boolean);
const device = phone ? 'phone' : 'desktop';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

/**
 * The spots: x, y on a surface (the west bank; the east bank mirrors it), the zoom level (0 = 1×,
 * 6 = 7×), the close view's scale (phones: < 1), and where the mouse aims from the shoulder.
 */
const SPOTS = [
  // the four tiers
  { name: 'riverside', x: 92, y: 0, zoom: 1, aim: [6, 1] },
  { name: 'stairs', x: 52, y: 20, zoom: 1, aim: [-6, 2] },
  { name: 'monorail', x: 89, y: 38, zoom: 1, aim: [-8, 1] },
  { name: 'rooftops', x: 106, y: 62, zoom: 1, aim: [8, 0] },
  // wide views: a whole bank, and the gorge between the towers
  { name: 'wide-bank', x: 50, y: 38, zoom: 6, aim: [4, 0] },
  { name: 'wide-gorge', x: 120, y: 38, zoom: 6, aim: [0, 2] },
  // close-ups of what players land on and the signs
  { name: 'close-quay', x: 84, y: 0, zoom: 0, scale: 0.6, aim: [4, 2] },
  { name: 'close-lower-stair', x: 64, y: 12, zoom: 0, scale: 0.6, aim: [-4, 2] },
  { name: 'close-shophouse', x: 47, y: 26.5, zoom: 0, scale: 0.6, aim: [-3, 0] },
  { name: 'close-balcony', x: 100, y: 26, zoom: 0, scale: 0.6, aim: [3, 1] },
  { name: 'close-viaduct', x: 40, y: 38, zoom: 0, scale: 0.6, aim: [4, -2] },
  { name: 'close-car', x: 112, y: 38, zoom: 0, scale: 0.6, aim: [6, 1] },
  { name: 'close-roof', x: 88, y: 62, zoom: 0, scale: 0.6, aim: [-4, 1] },
  { name: 'close-pavilion', x: 10, y: 62, zoom: 0, scale: 0.6, aim: [5, -1] },
  { name: 'close-perch', x: 20, y: 50, zoom: 0, scale: 0.6, aim: [-4, -2] },
];

/** Installed before the page's scripts: a clock the script can stop and step (window.__clock). */
function installClock() {
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  let virtual = false;
  let now = 0;
  const queue = [];
  performance.now = () => (virtual ? now : realNow());
  window.requestAnimationFrame = (cb) => {
    if (!virtual) return realRaf(cb);
    queue.push(cb);
    return queue.length;
  };
  window.__clock = {
    stop() {
      now = realNow();
      virtual = true;
      return new Promise((resolve) => realRaf(() => resolve()));
    },
    flush() {
      return new Promise((resolve) => realRaf(() => resolve()));
    },
    step(frames = 1, ms = 1000 / 60) {
      for (let i = 0; i < frames; i++) {
        now += ms;
        for (const cb of queue.splice(0)) cb(now);
      }
    },
  };
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'fog-stair-shots-')),
  args: hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && console.error(`[console.${m.type()}]`, m.text()));
  if (phone) await page.emulate({ viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: PHONE_UA });
  else await page.setViewport({ width: 1920, height: 1080 });
  await page.evaluateOnNewDocument(installClock);
  await page.goto(`${base}/?map=fog-stair&sandbox${extra}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  for (let i = 0; i < 180 && !(await page.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
  // the kit and the art around it (backdrops, billboards) are in before the clock stops
  await page.evaluate(async () => {
    const env = window.__game.view3d.env;
    if (env) await Promise.race([env.ready, new Promise((r) => setTimeout(r, 20_000))]);
    // the art only: the sandbox's debug text and HUD go (everything that holds no canvas)
    const hide = (el) => {
      for (const c of el.children) {
        if (c.tagName === 'CANVAS') continue;
        if (c.querySelector('canvas')) hide(c);
        else c.style.setProperty('visibility', 'hidden');
      }
    };
    hide(document.body);
  });
  await page.evaluate(() => window.__clock.stop());
  const step = (frames) => page.evaluate((n) => window.__clock.step(n), frames);
  mkdirSync(out, { recursive: true });
  for (const s of SPOTS.filter((x) => !only.length || only.includes(x.name))) {
    await page.evaluate(
      ({ x, y, zoom, scale }) => {
        const g = window.__game;
        const m = g.mode;
        for (const p of m.game.players) if (p && p !== m.me) m.game.removePlayer(p.id);
        m.me.spawn(x, y + 0.02, m.game.tuning);
        g.camera.setZoom(zoom, 7);
        g.camera.viewScale = scale ?? 1;
      },
      s,
    );
    for (let i = 0; i < 4; i++) {
      const at = await page.evaluate(
        ([dx, dy]) => {
          const g = window.__game;
          const me = g.mode.me;
          return { x: g.camera.toScreenX(me.x + dx), y: g.camera.toScreenY(me.y + 1.1 + dy) };
        },
        s.aim,
      );
      await page.mouse.move(at.x, at.y);
      await page.evaluate(() => window.__clock.flush());
      await step(30);
    }
    // between the billboards' crossfades (the shared 10 s beat)
    const into = (await page.evaluate(() => window.__game.mode.game.tick)) % 600;
    if (into < 45) await step(45 - into);
    await step(20);
    const file = join(out, `${prefix}${device}-${s.name}.png`);
    await page.screenshot({ path: file });
    console.log(`  ${file}`);
  }
} finally {
  await browser.close();
}
