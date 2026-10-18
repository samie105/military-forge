/* global process */
/**
 * Gun mechanisms (owner, 18 Oct): frame strips on the stepped clock, cropped around the shooter.
 *   casings-buzz      a Buzz burst: a case a shot, flung out of the port, bouncing, lying, fading
 *   casings-breacher  one Breacher shot: the shell comes out on the pump's back stroke (0.25 s)
 *   casings-widow     one Widow shot: the big case comes out on the bolt's back stroke (0.35 s)
 *   casings-hammer    the Hammer .44 fires (no casing), then reloads: its spent rounds drop out
 *   parts-breacher    the pump's cycle after a shot, close up (needs guns with part_* nodes)
 *   parts-widow       the bolt's cycle
 *   parts-hammer      the cylinder's turn
 * Each frame is saved as <out>/mech-<scene>-<n>.png (a crop around the shooter at 2×), to lay side
 * by side. `--art <dir>` serves weapon GLBs, sockets.json, casings.glb and weapons.vfx.json from
 * <dir> instead of the build (art from a Forge branch that isn't on main yet).
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-mechanisms-shots.mjs [--base http://localhost:5192] [--out <dir>] [--hw] [--art <dir>] [--only casings-buzz,…]
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
const only = arg('only', 'casings-buzz,casings-breacher,casings-widow,casings-hammer,parts-breacher,parts-widow,parts-hammer').split(',');
const art = arg('art', null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-mech-')),
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
  /** a crop around the player: (dx, dy) m from its feet at the centre, w × h CSS px (facing right) */
  const shot = async (name, { dx = 0.4, dy = 0.95, w = 230, h = 150 } = {}) => {
    mkdirSync(out, { recursive: true });
    const c = await page.evaluate(
      ({ dx, dy }) => {
        const g = window.__game;
        const me = g.mode.me;
        return { x: g.camera.toScreenX(me.x + dx), y: g.camera.toScreenY(me.y + dy) };
      },
      { dx, dy },
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

/** A sandbox shooter on open floor (x 117) with `loadout` [active, other], aiming right and a little up. */
async function shooter(loadout) {
  const s = await open('sandbox&gfx=high');
  await s.page.evaluate((l) => {
    const m = window.__game.mode;
    m.setLoadout(l);
    m.me.spawn(117, 0, m.game.tuning);
  }, loadout);
  await s.step(60);
  await s.cursorAt(6, 1.4);
  return s;
}

const casingsOut = (page) => page.evaluate(() => window.__game.view3d.vfx.casings.count);

if (only.includes('casings-buzz')) {
  const s = await shooter([1, 0]);
  await s.page.mouse.down();
  await s.step(14); // a short burst
  await s.shot('mech-buzz-1');
  await s.page.mouse.up();
  await s.step(10);
  await s.shot('mech-buzz-2');
  await s.step(25);
  await s.shot('mech-buzz-3');
  console.log(`  buzz: ${await casingsOut(s.page)} casings out`);
  await s.step(50);
  await s.shot('mech-buzz-4');
  await s.page.close();
}

for (const [scene, loadout, frames] of [
  ['casings-breacher', [3, 0], [2, 12, 20, 40]],
  ['casings-widow', [4, 0], [2, 18, 27, 50]],
]) {
  if (!only.includes(scene)) continue;
  const s = await shooter(loadout);
  await s.fire(1);
  let at = 1;
  for (const [i, f] of frames.entries()) {
    await s.step(f - at);
    at = f;
    await s.shot(`mech-${scene.slice(8)}-${i + 1}`);
    console.log(`  ${scene} +${f} frames: ${await casingsOut(s.page)} casings out`);
  }
  await s.page.close();
}

if (only.includes('casings-hammer')) {
  const s = await shooter([0, 1]);
  for (let i = 0; i < 3; i++) {
    await s.fire(1);
    await s.step(40); // the Hammer's 0.6 s interval
  }
  await s.shot('mech-hammer-1');
  console.log(`  hammer after 3 shots: ${await casingsOut(s.page)} casings out`);
  await s.page.keyboard.down('KeyR');
  await s.step(2);
  await s.page.keyboard.up('KeyR');
  await s.step(6);
  await s.shot('mech-hammer-2');
  await s.step(14);
  await s.shot('mech-hammer-3');
  console.log(`  hammer reloading: ${await casingsOut(s.page)} casings out`);
  await s.step(40);
  await s.shot('mech-hammer-4');
  await s.page.close();
}

// the moving parts close up: frames through one cycle after a single shot
for (const [scene, loadout, frames] of [
  ['parts-breacher', [3, 0], [0, 8, 15, 22, 30]],
  ['parts-widow', [4, 0], [0, 10, 16, 21, 27, 34]],
  ['parts-hammer', [0, 1], [0, 3, 6, 10]],
]) {
  if (!only.includes(scene)) continue;
  const s = await shooter(loadout);
  const parts = await s.page.evaluate((def) => window.__game.view3d.kit.weapon(def).parts?.map((p) => p.kind) ?? [], loadout[0]);
  console.log(`  ${scene}: parts ${JSON.stringify(parts)}`);
  await s.step(30);
  await s.fire(1);
  let at = 1;
  for (const [i, f] of frames.entries()) {
    await s.step(Math.max(0, f - at));
    at = Math.max(at, f);
    await s.shot(`mech-${scene}-${i + 1}`, { dx: 0.45, dy: 1.05, w: 120, h: 80 });
  }
  await s.page.close();
}

await browser.close();
