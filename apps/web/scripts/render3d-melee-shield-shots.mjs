/* global process */
/**
 * The melee and riot-shield audit (19 Oct) on the stepped clock: the machete held, its swing
 * (windup, landing on the Idle dummy, follow-through) and slung after a swap; the shield slung,
 * raised, struck by fire and broken; then a local match with three bots, the whole screen.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-melee-shield-shots.mjs [--base http://localhost:5192] [--out <dir>] [--phone] [--gfx high]
 * `--phone`: 812×375 at 3×, touch.
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
const out = resolve(arg('out', '.'));
const phone = process.argv.includes('--phone');
const hw = process.argv.includes('--hw');
const gfx = arg('gfx', 'high');
/** serve weapon/vfx files from this folder instead of the build (art not on main yet) */
const art = arg('art', null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-proj-')),
  args: hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 900_000,
});

/** A sandbox page on the stepped clock (window.__clock), ready to play. */
async function open(query) {
  const page = await browser.newPage();
  await page.setViewport(phone ? { width: 812, height: 375, deviceScaleFactor: 3, isMobile: true, hasTouch: true } : { width: 1280, height: 720, deviceScaleFactor: 2 });
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
    const panel = document.getElementById('panel');
    if (panel) panel.style.display = 'none';
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



const s = await open(`sandbox&gfx=${gfx}`);
await s.page.mouse.click(400, 200);
await s.step(10);
const tap = async (key, frames = 2) => {
  await s.page.keyboard.down(key);
  await s.step(frames);
  await s.page.keyboard.up(key);
};
const crop = { dx: 0.4, dy: 1, w: 260, h: 170 };
const shotAt = (name, x, y) => s.shot(name, { x, y }, { w: crop.w, h: crop.h });
const meAt = () => s.page.evaluate(() => ({ x: window.__game.mode.me.x, y: window.__game.mode.me.y }));
/** the player at x with `loadout`, the Idle dummy at dx ahead (a shield up facing back when `shield`) */
async function stage(x, loadout, dummyDx, dummyShield = false) {
  await s.page.evaluate(
    ([x, loadout, dummyDx, dummyShield]) => {
      const g = window.__game.mode.game;
      const me = window.__game.mode.me;
      g.setLoadout(me, loadout);
      Object.assign(me, { x, y: 0.01, vx: 0, vy: 0, swapTicks: 0, shieldHp: 0, shieldTicks: 0, hp: 100 });
      for (const p of g.players) if (p && p.isBot && p.name !== 'Idle') Object.assign(p, { x: 135, homeX: 135, y: 0.01, vx: 0, vy: 0, script: { kind: 'idle' } }); // the other dummies off the range
      const q = g.players.find((p) => p && p.name === 'Idle');
      Object.assign(q, { x: x + dummyDx, homeX: x + dummyDx, y: 0.01, vx: 0, vy: 0, hp: 100, shieldHp: dummyShield ? 300 : 0, shieldStowed: false, shieldTicks: 0 });
      g.setLoadout(q, [0, 0]);
      q.input.aim = 32768; // facing left, at the player
      window.__dummy = q;
    },
    [x, loadout, dummyDx, dummyShield],
  );
  await s.step(40);
  await s.cursorAt(dummyDx, 1.1);
}

// 1. machete: held, the swing (windup, strike, follow-through) onto the dummy, slung after a swap
await stage(163, [5, 2], 1.1);
let me = await meAt();
await shotAt('machete-held', me.x + 0.5, me.y + 1);
await tap('KeyV', 2);
for (const [i, f] of [4, 9, 12, 20].entries()) {
  await s.step(f - [0, 4, 9, 12][i]);
  await shotAt(`machete-swing-${i + 1}`, me.x + 0.5, me.y + 1);
}
await s.step(40);
await tap('KeyQ', 2);
await s.step(60);
await s.cursorAt(-3, 1.2);
me = await meAt();
await shotAt('machete-slung', me.x, me.y + 0.9);

// 2. riot shield: slung, raised, struck by fire, broken
await stage(163, [2, 0], 3.2);
await s.page.evaluate(() => Object.assign(window.__game.mode.me, { shieldHp: 300, shieldStowed: false, shieldTicks: 0 }));
await s.step(30);
await s.cursorAt(-3, 1.2);
me = await meAt();
await shotAt('shield-slung', me.x, me.y + 0.9);
await s.cursorAt(3, 1.2);
await tap('KeyX', 2);
await s.step(30);
await shotAt('shield-raised', me.x + 0.3, me.y + 0.9);
// fire into the dummy's raised shield
await stage(162, [2, 0], 3.5, true);
const dummy = await s.page.evaluate(() => ({ x: window.__dummy.x, y: window.__dummy.y, ticks: window.__dummy.shieldTicks }));
console.log('dummy', JSON.stringify(dummy));
await s.page.mouse.down();
await s.step(5);
await shotAt('shield-struck', dummy.x - 0.6, dummy.y + 1);
await s.page.mouse.up();
await s.step(30);
await s.page.evaluate(() => (window.__dummy.shieldHp = 10));
await s.page.mouse.down();
let broke = -1;
for (let i = 0; i < 30; i++) {
  await s.step(1);
  if ((await s.page.evaluate(() => window.__dummy.shieldHp)) <= 0) {
    broke = i;
    break;
  }
}
await s.page.mouse.up();
console.log('broke at', broke);
await s.step(1);
await shotAt('shield-break-1', dummy.x - 0.4, dummy.y + 1);
await s.step(6);
await shotAt('shield-break-2', dummy.x - 0.4, dummy.y + 1);

// 3. a real local match (three bots, the round-two UI): the whole screen after 8 s
const m = await open(`bots=3&gfx=${gfx}`);
await m.page.mouse.click(400, 200);
await m.step(480);
await m.page.screenshot({ path: join(out, 'match.png') });
console.log(`  ${join(out, 'match.png')}`);
await browser.close();
