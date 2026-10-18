/* global process, Buffer */
/**
 * Visual recoil (render3d/recoil.ts), frame by frame on the stepped clock: one shot per weapon,
 * a strip of crops at the shot's frame and after it (+1, +2, +4, +8, +16 frames).
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-recoil-shots.mjs [--base http://localhost:5192] [--out docs/screenshots/render3d-b] [--gfx medium] [--hw] [--off]
 * --off draws the same strips with the recoil turned off (the build before it: the gun never moves).
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
const off = process.argv.includes('--off');
const gfx = arg('gfx', 'medium');
const FRAMES = [0, 1, 2, 4, 8, 16];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-recoil-')),
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
await page.evaluate((recoilOff) => {
  document.getElementById('panel').style.display = 'none';
  document.getElementById('perf3d')?.remove();
  const v = window.__game.view3d;
  v.pinScale(1);
  if (recoilOff) {
    v.kit.recoilScale = 0;
    v.vfx.shake.kick = () => {};
  }
}, off);
await page.evaluate(() => window.__clock.stop());
const step = (n) => page.evaluate((k) => window.__clock.step(k), n);

/** Crops around the player (the gun side), at 2x. */
async function crop() {
  const me = await page.evaluate(() => {
    const g = window.__game;
    const p = g.mode.me;
    return { x: g.camera.toScreenX(p.x + 0.4), y: g.camera.toScreenY(p.y + 0.8) };
  });
  return page.screenshot({ clip: { x: Math.round(me.x - 65), y: Math.round(me.y - 45), width: 130, height: 80 }, encoding: 'base64' });
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
for (const [name, def] of [['hammer', 0], ['buzz', 1], ['breacher', 3], ['widow', 4]]) {
  await page.evaluate((d) => {
    const m = window.__game.mode;
    m.setLoadout([d, d === 0 ? 1 : 0]);
    m.me.spawn(119.5, 0, m.game.tuning); // flat floor, open sky
  }, def);
  await step(60);
  for (let i = 0; i < 3; i++) {
    const at = await page.evaluate(() => {
      const g = window.__game;
      const me = g.mode.me;
      return { x: g.camera.toScreenX(me.x + 6), y: g.camera.toScreenY(me.y + 1.6) };
    });
    await page.mouse.move(at.x, at.y);
    await page.evaluate(() => window.__clock.flush());
    await step(30);
  }
  // one shot: step until the magazine drops (that frame draws the flash, the gun still as aimed)
  const mag = () => page.evaluate(() => window.__game.mode.me.weapons[window.__game.mode.me.active].mag);
  const before = await mag();
  await page.mouse.down();
  for (let i = 0; i < 10 && (await mag()) === before; i++) await step(1);
  await page.mouse.up();
  const pngs = [];
  let at = 0;
  for (const f of FRAMES) {
    await step(f - at);
    at = f;
    pngs.push(await crop());
  }
  const file = join(out, `recoil-${name}${off ? '-off' : ''}.png`);
  writeFileSync(file, await strip(pngs));
  console.log(`  ${file}`);
  await step(60);
}
await browser.close();
