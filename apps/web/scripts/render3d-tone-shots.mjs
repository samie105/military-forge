/* global process */
/**
 * The war tone (the owner, 19 Oct), on the stepped clock in the sandbox: a K-47 burst into the thin
 * wall (flash, gun smoke, tracers, chips and dust), a burst into the Idle dummy (the thud, the
 * flinch), a frag going off (flash, fireball, shockwave, smoke) and a dash (the green streak and
 * its embers). Crops at 2×, to lay main and a branch side by side.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-tone-shots.mjs [--base http://localhost:5192] [--out <dir>] [--hw] [--gfx high]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
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
/** serve weapon/vfx files from this folder instead of the build (art not on main yet) */
const art = arg('art', null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-tone-')),
  args: hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 900_000,
});

/** A sandbox page on the stepped clock (window.__clock), ready to play. */
async function open(query) {
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
  page.on('pageerror', (e) => console.error('[page]', e.message));
  if (art) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const m = /\/assets\/(weapons|vfx)\/([\w.]+\.(?:glb|json))$/.exec(new URL(req.url()).pathname);
      const file = m && join(art, m[2]);
      if (file && existsSync(file)) void req.respond({ status: 200, contentType: file.endsWith('.json') ? 'application/json' : 'model/gltf-binary', body: readFileSync(file) });
      else void req.continue();
    });
  }
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
  /** a crop w × h CSS px around world (x, y) (null: the player's chest) */
  const shot = async (name, at = null, { w = 300, h = 170 } = {}) => {
    mkdirSync(out, { recursive: true });
    const c = await page.evaluate(
      (at) => {
        const g = window.__game;
        const me = g.mode.me;
        const p = at ?? { x: me.x + 0.5, y: me.y + 1 };
        return { x: g.camera.toScreenX(p.x), y: g.camera.toScreenY(p.y) };
      },
      at,
    );
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file, captureBeyondViewport: false, clip: { x: c.x - w / 2, y: c.y - h / 2, width: w, height: h } });
    console.log(`  ${file}`);
  };
  /** one trigger pull of `frames` frames */
  const fire = async (frames = 1) => {
    await page.mouse.down();
    await step(frames);
    await page.mouse.up();
  };
  return { page, step, flush, cursorAt, shot, fire };
}



const s = await open(`sandbox&grenades&gfx=${gfx}`);
await s.page.mouse.click(640, 300);
await s.step(10);
const meAt = () => s.page.evaluate(() => ({ x: window.__game.mode.me.x, y: window.__game.mode.me.y }));
async function place(x, loadout, dummyDx = 4) {
  await s.page.evaluate(
    ([x, loadout, dummyDx]) => {
      const g = window.__game.mode.game;
      const me = window.__game.mode.me;
      g.setLoadout(me, loadout);
      Object.assign(me, { x, y: 0.01, vx: 0, vy: 0, swapTicks: 0, hp: 100 });
      for (const p of g.players) if (p && p.isBot && p.name !== 'Idle') Object.assign(p, { x: 135, homeX: 135, y: 0.01, vx: 0, vy: 0, script: { kind: 'idle' } });
      const q = g.players.find((p) => p && p.name === 'Idle');
      Object.assign(q, { x: x + dummyDx, homeX: x + dummyDx, y: 0.01, vx: 0, vy: 0, hp: 100 });
    },
    [x, loadout, dummyDx],
  );
  await s.step(40);
}

// 1. a K-47 burst into the thin wall at x 160
await place(156.5, [2, 0], 8);
await s.cursorAt(3.5, 1.1);
await s.page.mouse.down();
await s.step(3);
let me = await meAt();
await s.shot('tone-burst-1', { x: me.x + 1.8, y: me.y + 1.1 }, { w: 300, h: 160 });
await s.step(4);
await s.shot('tone-burst-2', { x: me.x + 1.8, y: me.y + 1.1 }, { w: 300, h: 160 });
await s.page.mouse.up();
await s.step(10);
await s.shot('tone-burst-after', { x: me.x + 1.8, y: me.y + 1.1 }, { w: 300, h: 160 });
await s.step(60);

// 2. into the Idle dummy: the thud and the flinch
await place(162, [2, 0], 3);
await s.cursorAt(3, 1.1);
await s.page.mouse.down();
await s.step(4);
me = await meAt();
await s.shot('tone-hit', { x: me.x + 2, y: me.y + 1 }, { w: 300, h: 160 });
await s.page.mouse.up();
await s.step(90);

// 3. a frag: lobbed onto the range floor
await place(150, [2, 0], 15);
await s.cursorAt(3, 0.5);
await s.page.keyboard.down('KeyG');
await s.step(3);
await s.page.keyboard.up('KeyG');
let g = null;
for (let i = 0; i < 300; i++) {
  const n = await s.page.evaluate(() => window.__game.mode.game.grenades.find((q) => q.alive && q.type === 0) ?? null);
  if (n) g = { x: n.x, y: n.y };
  else if (g) break;
  await s.step(1);
}
let at = 0;
for (const f of [3, 12, 40]) {
  await s.step(f - at);
  at = f;
  await s.shot(`tone-blast-${f}`, { x: g.x, y: g.y + 1.4 }, { w: 380, h: 260 });
}
await s.step(120);

// 4. a dash along the range floor
await place(146, [2, 0], 20);
await s.cursorAt(4, 1);
await s.page.keyboard.down('KeyD');
await s.step(2);
await s.page.keyboard.down('ShiftLeft');
await s.step(2);
await s.page.keyboard.up('ShiftLeft');
await s.step(6);
me = await meAt();
await s.page.keyboard.up('KeyD');
await s.shot('tone-dash', { x: me.x - 1, y: me.y + 0.9 }, { w: 320, h: 160 });
await browser.close();
