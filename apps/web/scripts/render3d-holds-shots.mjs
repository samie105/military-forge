/* global process */
/**
 * The Rookie holding each weapon (render3d/holds.ts), on the stepped clock: a lineup sheet.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-holds-shots.mjs [--base http://localhost:5192] [--out docs/screenshots/render3d-b] [--gfx medium] [--hw]
 * Crops at 2× device pixels around the player on the range's flat floor, aiming right and a little up.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5192');
const out = resolve(arg('out', 'docs/screenshots/render3d-b'));
const hw = process.argv.includes('--hw');
const gfx = arg('gfx', 'medium');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-holds-')),
  args: hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 900_000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument(() => {
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  let virtual = false;
  let now = 0;
  const queue = [];
  performance.now = () => (virtual ? now : realNow());
  window.requestAnimationFrame = (cb) => (virtual ? (queue.push(cb), queue.length) : realRaf(cb));
  window.__clock = {
    stop() {
      now = realNow();
      virtual = true;
      return new Promise((resolve) => realRaf(() => resolve()));
    },
    flush: () => new Promise((resolve) => realRaf(() => resolve())),
    step(frames = 1) {
      for (let i = 0; i < frames; i++) {
        now += 1000 / 60;
        for (const cb of queue.splice(0)) cb(now);
      }
    },
  };
});
await page.goto(`${base}/?sandbox&gfx=${gfx}`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 120 && !(await page.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
await page.evaluate(() => {
  document.getElementById('panel').style.display = 'none';
  document.getElementById('perf3d')?.remove();
  window.__game.view3d.pinScale(1);
});
await page.evaluate(() => window.__clock.stop());
const step = (n) => page.evaluate((k) => window.__clock.step(k), n);

mkdirSync(out, { recursive: true });
for (const [name, def] of [['hammer', 0], ['buzz', 1], ['k47', 2], ['breacher', 3], ['widow', 4], ['machete', 5]]) {
  await page.evaluate((d) => {
    const m = window.__game.mode;
    m.setLoadout([d, d === 0 ? 1 : 0]);
    m.me.spawn(119.5, 0, m.game.tuning); // flat floor, open sky (between the overhang and the one-way platforms)
  }, def);
  await step(60);
  // aim right and a little up, then let the camera's look-ahead settle before framing the shot
  for (let i = 0; i < 3; i++) {
    const at = await page.evaluate(() => {
      const g = window.__game;
      const me = g.mode.me;
      return { x: g.camera.toScreenX(me.x + 6), y: g.camera.toScreenY(me.y + 1.9) };
    });
    await page.mouse.move(at.x, at.y);
    await page.evaluate(() => window.__clock.flush());
    await step(30);
  }
  const me = await page.evaluate(() => {
    const g = window.__game;
    const p = g.mode.me;
    return { x: g.camera.toScreenX(p.x), y: g.camera.toScreenY(p.y + 0.75) };
  });
  const file = join(out, `hold-${name}.png`);
  await page.screenshot({ path: file, clip: { x: Math.round(me.x - 60), y: Math.round(me.y - 55), width: 150, height: 100 } });
  console.log(`  hold-${name}.png`);
}
await browser.close();
