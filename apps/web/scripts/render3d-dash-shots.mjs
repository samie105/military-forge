/* global process, Buffer */
/**
 * Dashes in 3D (render3d/vfx/dash.ts, dashGhosts.ts) on the stepped clock: a strip of crops through
 * a dash (its start, then +2, +4, +6, +8, +12 frames), sideways and up.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-dash-shots.mjs [--base http://localhost:5192] [--out docs/screenshots/render3d-b] [--gfx high] [--hw]
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
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
const gfx = arg('gfx', 'high');
const FRAMES = [0, 2, 4, 6, 8, 12];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-dash-')),
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

/** Crops around a world point (the dash's start, so the strip shows it travel), at 2x. */
async function crop(wx, wy) {
  const at = await page.evaluate(
    ({ wx, wy }) => {
      const g = window.__game;
      return { x: g.camera.toScreenX(wx), y: g.camera.toScreenY(wy) };
    },
    { wx, wy },
  );
  // captureBeyondViewport would resize the page for the capture, and a resized WebGL canvas comes out blank
  return page.screenshot({ clip: { x: Math.round(at.x - 70), y: Math.round(at.y - 75), width: 170, height: 110 }, encoding: 'base64', captureBeyondViewport: false });
}

/** Side by side, in the page (no image tools needed). */
async function strip(pngs) {
  const b64 = await page.evaluate(async (list) => {
    const imgs = await Promise.all(
      list.map(
        (s) =>
          new Promise((done) => {
            const img = new Image();
            img.onload = () => done(img);
            img.src = `data:image/png;base64,${s}`;
          }),
      ),
    );
    const gap = 4;
    const c = document.createElement('canvas');
    c.width = imgs.reduce((w, img) => w + img.width + gap, -gap);
    c.height = imgs[0].height;
    const g = c.getContext('2d');
    g.fillStyle = '#111';
    g.fillRect(0, 0, c.width, c.height);
    let x = 0;
    for (const img of imgs) {
      g.drawImage(img, x, 0);
      x += img.width + gap;
    }
    return c.toDataURL('image/png').split(',')[1];
  }, pngs);
  return Buffer.from(b64, 'base64');
}

mkdirSync(out, { recursive: true });
for (const [name, keys, dx, dy] of [
  ['dash-right', ['KeyD'], 1.2, 0.9],
  ['dash-up', ['KeyW', 'KeyD'], 0.9, 1.6],
]) {
  await page.evaluate(() => {
    const m = window.__game.mode;
    m.me.spawn(116.5, 0, m.game.tuning); // flat floor, open sky
  });
  await step(90);
  // aim right (the reticle well out of the crops), so the dash and the aim agree
  const aim = await page.evaluate(() => {
    const g = window.__game;
    const me = g.mode.me;
    return { x: g.camera.toScreenX(me.x + 12), y: g.camera.toScreenY(me.y + 4) };
  });
  await page.mouse.move(aim.x, aim.y);
  await page.evaluate(() => window.__clock.flush());
  await step(30);
  const start = await page.evaluate(() => ({ x: window.__game.mode.me.x, y: window.__game.mode.me.y }));
  const idle = await page.evaluate(() => window.__game.view3d.stats().calls);
  for (const k of keys) await page.keyboard.down(k);
  await page.keyboard.down('ShiftLeft');
  // the dash starts on the tick the sim sees Shift: step until it does
  for (let i = 0; i < 10 && !(await page.evaluate(() => window.__game.mode.me.dashTicks > 0)); i++) await step(1);
  await page.keyboard.up('ShiftLeft');
  const pngs = [];
  let at = 0;
  const calls = [];
  for (const f of FRAMES) {
    await step(f - at);
    at = f;
    pngs.push(await crop(start.x + dx, start.y + dy));
    calls.push(await page.evaluate(() => `${window.__game.view3d.stats().calls}/${window.__game.view3d.vfx.ghosts.count}g/${window.__game.view3d.vfx.particles}p`));
  }
  console.log(`  ${name}: draw calls before ${idle}, through the dash ${calls.join(' ')} (${gfx})`);
  for (const k of keys) await page.keyboard.up(k);
  const file = join(out, `${name}.png`);
  writeFileSync(file, await strip(pngs));
  console.log(`  ${file}`);
  await step(90);
}
await browser.close();
