/* global process */
/**
 * The hold-to-aim throw arc (render3d/vfx/throwArc.ts) on the stepped clock: the grenade key held
 * with `?holdaim`, the cursor near and far, then let go to compare the throw with its preview.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-arc-shots.mjs [--base http://localhost:5192] [--out docs/screenshots/render3d-b] [--gfx medium] [--hw]
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
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-arc-')),
  args: hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 900_000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
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
await page.goto(`${base}/?sandbox&holdaim&gfx=${gfx}`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 120 && !(await page.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
await page.evaluate(() => {
  document.getElementById('panel').style.display = 'none';
  document.getElementById('perf3d')?.remove();
  window.__game.view3d.pinScale(1);
});
await page.evaluate(() => window.__clock.stop());
const step = (n) => page.evaluate((k) => window.__clock.step(k), n);

async function place(x, y) {
  await page.evaluate(
    ({ x, y }) => {
      const m = window.__game.mode;
      m.me.spawn(x, y, m.game.tuning);
      m.me.frags = 3;
    },
    { x, y },
  );
  await step(60);
}

/** The cursor at (dx, dy) m from the player; the camera's look-ahead moves the world, so a few passes. */
async function cursorAt(dx, dy) {
  for (let i = 0; i < 4; i++) {
    const at = await page.evaluate(
      ({ dx, dy }) => {
        const g = window.__game;
        const me = g.mode.me;
        return { x: g.camera.toScreenX(me.x + dx), y: g.camera.toScreenY(me.y + 1.1 + dy) };
      },
      { dx, dy },
    );
    await page.mouse.move(at.x, at.y);
    await page.evaluate(() => window.__clock.flush());
    await step(20);
  }
}

async function shot(name) {
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${file}`);
}

// over the ledges: a long lob (the cursor far: full strength), then a short one (near: 70 %)
await place(8.5, 0);
await page.keyboard.down('KeyG');
await cursorAt(9, 5);
await shot('arc-far');
await cursorAt(2.5, 1.2);
await shot('arc-near');
// let go: the grenade follows the preview it showed
await cursorAt(9, 5);
await page.keyboard.up('KeyG');
await step(24);
await shot('arc-thrown');
await step(120);
// off a wall: the bounce back is fainter, past the ring where it first lands
await place(26, 0);
await page.keyboard.down('KeyG');
await cursorAt(4, 3.5);
await shot('arc-wall');
await page.keyboard.up('KeyG');
await step(120);
await browser.close();
