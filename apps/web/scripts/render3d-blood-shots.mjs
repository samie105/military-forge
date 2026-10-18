/* global process */
/**
 * Blood (an option, off by default): frame strips of a hit on the Idle dummy, blood off and on.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-blood-shots.mjs [--base http://localhost:5192] [--out docs/screenshots/render3d-b] [--hw] [--gfx high]
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
const gfx = arg('gfx', 'high');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-blood-')),
  args: hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 900_000,
});

/** A page on the stepped clock (window.__clock), ready to play. */
async function open(query, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
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
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`${base}/?${query}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120 && !(await page.evaluate(() => !!window.__game?.mode && (!window.__game.view3d || window.__game.view3d.ready))); i++) await sleep(1000);
  await page.evaluate(() => {
    document.getElementById('panel').style.display = 'none';
    document.getElementById('perf3d')?.remove();
    window.__game.view3d?.pinScale(1);
  });
  await page.evaluate(() => window.__clock.stop());
  const step = (n) => page.evaluate((k) => window.__clock.step(k), n);
  const flush = () => page.evaluate(() => window.__clock.flush());
  /** the cursor at (dx, dy) m from the player's feet; the camera's look-ahead moves the world, so a few passes */
  const cursorAt = async (dx, dy) => {
    for (let i = 0; i < 4; i++) {
      const at = await page.evaluate(
        ({ dx, dy }) => {
          const g = window.__game;
          const me = g.mode.me;
          return { x: g.camera.toScreenX(me.x + dx), y: g.camera.toScreenY(me.y + dy) };
        },
        { dx, dy },
      );
      await page.mouse.move(at.x, at.y);
      await flush();
      await step(20);
    }
  };
  const shot = async (name) => {
    mkdirSync(out, { recursive: true });
    const file = join(out, `${name}.png`);
    const c = await page.evaluate(() => {
      const g = window.__game;
      return { x: g.camera.toScreenX(119.5), y: g.camera.toScreenY(1.1) };
    });
    await page.screenshot({ path: file, captureBeyondViewport: false, clip: { x: c.x - 150, y: c.y - 70, width: 300, height: 140 } });
    console.log(`  ${file}`);
  };
  return { page, step, flush, cursorAt, shot };
}


for (const [blood, weapon] of [
  [false, 4],
  [true, 4],
  [true, 1],
]) {
  const { page, step, cursorAt, shot } = await open(`sandbox&gfx=${gfx}`, { width: 1280, height: 720, deviceScaleFactor: 2 });
  // the Idle dummy on open floor, shield down, 5.5 m to the right
  await page.evaluate(
    ({ blood, weapon }) => {
      const m = window.__game.mode;
      const idle = m.game.players.find((p) => p?.name === 'Idle');
      idle.x = idle.homeX = 121;
      idle.y = idle.homeY = 0;
      idle.vx = idle.vy = 0;
      idle.shieldHp = 0;
      idle.hp = 1000;
      m.setLoadout([weapon, 0]);
      m.me.spawn(115.5, 0, m.game.tuning);
      window.__game.view3d.setBlood(blood);
    },
    { blood, weapon },
  );
  await step(90);
  await cursorAt(5.5, 1.2);
  const name = `blood-${blood ? 'on' : 'off'}-${weapon === 4 ? 'widow' : 'buzz'}`;
  await page.mouse.down();
  await step(weapon === 1 ? 12 : 2);
  await page.mouse.up();
  for (const [i, f] of [2, 8, 30].entries()) {
    await step(i === 0 ? f : f - [2, 8, 30][i - 1]);
    await shot(`${name}-${i + 1}`);
  }
  await page.close();
}
await browser.close();
