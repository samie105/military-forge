/* global process */
/**
 * The six grenade types in 3D (render3d/grenades.ts, #91's models), on the stepped clock: each one
 * thrown and cropped in flight, the same lobbed short and cropped at rest just before it goes off,
 * and the six grenade pairs (map pickups) side by side. `--gfx low` also prints the draw calls with
 * every type in flight at once.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-grenade-shots.mjs [--base http://localhost:5192] [--out <dir>] [--hw] [--gfx high]
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
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-gren-')),
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



const NAMES = ['frag', 'smoke', 'gas', 'flash', 'mine', 'emp'];

/** The newest live grenade of `type` (x, y), or null. */
const grenade = (page, type) =>
  page
    .evaluate((t) => {
      const gs = window.__game.mode.game.grenades.filter((g) => g.alive && g.type === t);
      const g = gs[gs.length - 1];
      return g ? { x: g.x, y: g.y } : null;
    }, type);

/** The player at x on the range's floor, `type` selected (T cycles the belt), aiming at (ax, ay) from its feet. */
async function ready(s, type, x, ax, ay) {
  await s.page.evaluate((x) => Object.assign(window.__game.mode.me, { x, y: 0.01, vx: 0, vy: 0 }), x);
  await s.step(20);
  for (let i = 0; i < 8 && (await s.page.evaluate(() => window.__game.mode.me.grenadeType)) !== type; i++) {
    await s.page.keyboard.down('KeyT');
    await s.step(2);
    await s.page.keyboard.up('KeyT');
    await s.step(2);
  }
  await s.cursorAt(ax, ay);
}

/** Throws (G: aimed while held, thrown on release) and steps until one of `type` is out; its position, or null. */
async function toss(s, type) {
  await s.page.keyboard.down('KeyG');
  await s.step(3);
  await s.page.keyboard.up('KeyG');
  let g = null;
  for (let i = 0; i < 40 && !(g = await grenade(s.page, type)); i++) await s.step(1);
  return g;
}

const gfxLow = gfx === 'low';
const s = await open(`sandbox&grenades&gfx=${gfx}`);
await s.page.mouse.click(640, 300);
await s.step(10);

if (gfxLow) {
  // every type in the air at once: the draw calls
  const calls = () => s.page.evaluate(() => window.__game.view3d.renderer.info.render.calls);
  /** the fewest draw calls over the next `frames` frames (a throw's dust and other passing effects left out) */
  const fewest = async (frames = 12) => {
    let n = Infinity;
    for (let i = 0; i < frames; i++) {
      await s.step(1);
      n = Math.min(n, await calls());
    }
    return n;
  };
  await ready(s, 0, 148, 4, 3);
  const idle = await fewest();
  // one frag thrown, then the other five copied from it into free slots beside it (a throw's cooldown
  // won't let six go up before the first fuse ends), each on a long fuse
  await toss(s, 0);
  await s.step(6);
  await s.page.evaluate(() => (window.__game.mode.game.grenades.find((g) => g.alive && g.type === 0).fuse = 600));
  const oneFrag = await fewest();
  await s.page.evaluate(() => {
    const gs = window.__game.mode.game.grenades;
    const frag = gs.find((g) => g.alive && g.type === 0);
    frag.fuse = 600;
    let k = 0;
    for (const type of [1, 2, 3, 4, 5]) {
      const slot = gs.find((g) => !g.alive);
      Object.assign(slot, { ...frag, id: slot.id, type, state: 0, x: frag.x + 0.7 * ++k });
    }
  });
  await s.step(2);
  const inAir = await s.page.evaluate(() => window.__game.mode.game.grenades.filter((g) => g.alive).map((g) => g.type));
  const programs = await s.page.evaluate(() => window.__game.view3d.renderer.info.programs.length);
  console.log(`low: ${idle} draw calls idle, ${oneFrag} with a frag in flight, ${await fewest()} with ${JSON.stringify(inAir)} in flight; ${programs} shader programs`);
  await browser.close();
  process.exit(0);
}

// in flight: thrown up and out from the range floor, cropped 14 frames after leaving the hand
// (smoke last: its cloud drifts over the range and would hide the next throw)
for (const type of [0, 3, 5, 4, 2, 1]) {
  await ready(s, type, 148, 4, 3);
  if (!(await toss(s, type))) console.log(`  no ${NAMES[type]} came out`);
  await s.step(14);
  await s.shot(`gren-${NAMES[type]}-flight`, await grenade(s.page, type), { w: 160, h: 120 });
  await s.step(type === 1 || type === 2 ? 30 : 160);
  // clouds drift over the range: the next throws go from further along
}

// at rest: lobbed a couple of metres, cropped just before its fuse runs out (the mine: armed, stuck to the floor)
const clouds = await s.page.evaluate(() => window.__game.mode.game.clouds?.filter?.((c) => c.alive).length ?? 0);
console.log(`  clouds on the range: ${clouds}`);
// flat floor away from the range: x 2–16, 83–88 and 145–154 (smoke and gas apart, so neither cloud hides another)
const REST_AT = { 0: 3, 3: 5.5, 5: 8, 4: 10.5, 1: 84, 2: 146 };
for (const type of [0, 3, 5, 4, 1, 2]) {
  const x = REST_AT[type];
  await ready(s, type, x, 1.4, -0.4); // a soft lob at the floor ahead: it lands, rolls a little and settles
  if (!(await toss(s, type))) console.log(`  no ${NAMES[type]} came out`);
  const fuse = { 0: 1.8, 1: 1.6, 2: 1.6, 3: 1.7, 4: 2.6, 5: 1.35 }[type];
  await s.step(Math.round((fuse - 0.2) * 60));
  await s.shot(`gren-${NAMES[type]}-rest`, (await grenade(s.page, type)) ?? { x: x + 1.5, y: 0.2 }, { w: 160, h: 120 });
  await s.step(240);
}

// the six pairs (map pickups), in a row on the range floor
await s.page.evaluate(() => {
  const game = window.__game.mode.game;
  const me = window.__game.mode.me;
  Object.assign(me, { x: 116.2, y: 0.01, vx: 0, vy: 0 });
  game.pickups.forEach((p, i) => {
    if (i < 6) Object.assign(p, { alive: true, def: 1 + i, x: 117.6 + i * 1.1, y: 0, hp: 0 });
  });
});
await s.step(30);
await s.cursorAt(4, 0.5);
await s.shot('gren-pairs', { x: 120.35, y: 0.4 }, { w: 380, h: 110 });

await browser.close();
