/* global process */
/**
 * The launchers' projectiles in 3D (render3d/vfx/projectiles.ts), frame by frame on the stepped
 * clock, cropped around each projectile: the Thumper's rocket and its trail, the Popper's shell, the
 * Ripper's charge and blade, the Pulse's charge, orb and burst, the Dragon's stream and a burning
 * dummy.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-projectile-shots.mjs [--base http://localhost:5192] [--out <dir>] [--hw] [--gfx high] [--art <dir>]
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
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-proj-')),
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


/** The first live projectile of `type` (x, y), or null. */
const projectile = (page, type) => page.evaluate((t) => window.__game.mode.game.grenades.find((g) => g.alive && g.type === t) ?? null, type).then((g) => (g ? { x: g.x, y: g.y } : null));

/** Weapon `index` in hand at x on the range's floor, aiming at world (ax, ay). */
async function arm(s, index, x, ax, ay) {
  await s.page.evaluate(
    ([index, x]) => {
      const { game, me } = window.__game.mode;
      game.setLoadout(me, [index, 1]);
      Object.assign(me, { x, y: 0.01, vx: 0, vy: 0, swapTicks: 0 });
    },
    [index, x],
  );
  await s.step(40);
  await s.cursorAt(ax - x, ay);
}

/** Holds fire until a projectile of `type` is out (at most `max` frames). */
async function fireUntil(s, type, max = 120) {
  await s.page.mouse.down();
  for (let i = 0; i < max && !(await projectile(s.page, type)); i++) await s.step(1);
  await s.page.mouse.up();
}

const s = await open(`sandbox&gfx=${gfx}`);
// the first press only focuses the canvas
await s.page.mouse.click(640, 300);
await s.step(10);

// the Thumper's rocket: in flight, smoke trailing
await arm(s, 14, 148, 160, 1.2);
await fireUntil(s, 8);
for (const [i, f] of [3, 6].entries()) {
  await s.step(f - (i ? 3 : 0));
  await s.shot(`proj-rocket-${i + 1}`, await projectile(s.page, 8));
}
await s.step(90);

// the Popper's shell, lobbed and tumbling
await arm(s, 15, 148, 156, 3);
await fireUntil(s, 9);
for (const [i, f] of [4, 12, 22].entries()) {
  await s.step(f - [0, 4, 12][i]);
  await s.shot(`proj-shell-${i + 1}`, (await projectile(s.page, 9)) ?? { x: 152, y: 2 });
}
await s.step(90);

// the Ripper: the charge's sparks, then the blade
await arm(s, 16, 148, 160, 1.1);
await s.page.mouse.down();
await s.step(14);
await s.shot('proj-ripper-charge');
for (let i = 0; i < 90 && !(await projectile(s.page, 10)); i++) await s.step(1);
await s.page.mouse.up();
for (const [i, f] of [4, 14].entries()) {
  await s.step(f - (i ? 4 : 0));
  await s.shot(`proj-blade-${i + 1}`, (await projectile(s.page, 10)) ?? { x: 155, y: 1.1 });
}
await s.step(300);

// the Pulse: its charge, the orb, its burst
await arm(s, 17, 152, 160, 1.4);
await s.page.mouse.down();
await s.step(24);
await s.shot('proj-pulse-charge');
for (let i = 0; i < 90 && !(await projectile(s.page, 11)); i++) await s.step(1);
await s.page.mouse.up();
await s.step(12);
await s.shot('proj-orb', (await projectile(s.page, 11)) ?? { x: 155, y: 1.4 });
let last = (await projectile(s.page, 11)) ?? { x: 158, y: 1.4 };
for (let i = 0; i < 200; i++) {
  const p = await projectile(s.page, 11);
  if (!p) break;
  last = p;
  await s.step(1);
}
await s.step(3);
await s.shot('proj-orb-burst', last);
await s.step(200);

// the Dragon: its stream on the Idle dummy, then the dummy burning
await arm(s, 18, 162.5, 165.5, 1.1);
await s.page.mouse.down();
await s.step(30);
await s.shot('proj-flames', { x: 164, y: 1.1 });
await s.page.mouse.up();
await s.step(20);
await s.shot('proj-burning', { x: 165.5, y: 1 });

await browser.close();
