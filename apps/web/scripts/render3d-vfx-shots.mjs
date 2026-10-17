/* global process */
/**
 * render3d VFX screenshots on a stepped clock, and VFX frame-time / draw-call measurement.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort        # in another shell
 *   node apps/web/scripts/render3d-vfx-shots.mjs [--base http://localhost:5192] [--out docs/screenshots/render3d-b] [--prefix after-] [--gfx low] [--hw]
 *   node apps/web/scripts/render3d-vfx-shots.mjs --gpu [--size 1920x1080] [--gfx low]
 *
 * Screenshots (SwiftShader) run the game on a virtual clock: requestAnimationFrame and
 * performance.now are replaced once the 3D view is ready, and the script steps whole 60 Hz frames.
 * Every run gives the same frames however slow software GL is: a frag in flight, the explosion
 * sequence and gunfire, each at a fixed time after the throw or trigger pull.
 *
 * --gpu uses the machine's GPU on a real clock and only measures: 8 s of frags and gunfire at the
 * shooting range, then frame interval, GPU time (timer query) and draw calls over the last 240 frames.
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
const prefix = arg('prefix', '');
const gpu = process.argv.includes('--gpu');
/** screenshots on the GPU too (`--hw`): High's MSAA and shadow map are too slow on the software rasteriser */
const hw = gpu || process.argv.includes('--hw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-vfx-')),
  args: hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

/** Installed before the page's scripts: a clock the script can stop and step (window.__clock). */
function installClock() {
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  let virtual = false;
  let now = 0;
  const queue = [];
  performance.now = () => (virtual ? now : realNow());
  window.requestAnimationFrame = (cb) => {
    if (!virtual) return realRaf(cb);
    queue.push(cb);
    return queue.length;
  };
  window.__clock = {
    /** stops the clock; resolves once the game loop's pending real frame has moved into the queue */
    stop() {
      now = realNow();
      virtual = true;
      return new Promise((resolve) => realRaf(() => resolve()));
    },
    /** one real browser frame: Chrome dispatches mouse moves with animation frames */
    flush() {
      return new Promise((resolve) => realRaf(() => resolve()));
    },
    /** runs `frames` animation frames of `ms` each, synchronously */
    step(frames = 1, ms = 1000 / 60) {
      for (let i = 0; i < frames; i++) {
        now += ms;
        for (const cb of queue.splice(0)) cb(now);
      }
    },
  };
}

async function open(query, viewport, { clock = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  if (clock) await page.evaluateOnNewDocument(installClock);
  page.on('pageerror', (e) => console.error('[page]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 120 && !(await page.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
  await page.evaluate(() => {
    document.getElementById('panel').style.display = 'none';
    document.getElementById('perf3d')?.remove();
    window.__game.view3d.pinScale(1);
  });
  return page;
}

const step = (page, frames) => page.evaluate((n) => window.__clock.step(n), frames);

/** Puts the local player at (x, y) with full frags, the Buzz in hand, and the camera settled. */
async function place(page, x, y) {
  await page.evaluate(
    ({ x, y }) => {
      const m = window.__game.mode;
      m.setLoadout([1, 0]); // Buzz first: automatic fire for the tracer shots
      m.me.spawn(x, y, m.game.tuning);
      m.me.frags = 3;
    },
    { x, y },
  );
  await step(page, 90);
}

/**
 * Mouse at an offset from the local player's shoulder, in metres. The camera leans toward the
 * mouse (look-ahead), which moves the world under it: aim a few times until it settles.
 */
async function aimAt(page, dx, dy) {
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
    await page.evaluate(() => window.__clock?.flush());
    if (i < 3) await step(page, 30);
  }
}

async function shot(page, name) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, `${prefix}${name}.png`) });
  console.log(`  ${prefix}${name}.png`);
}

if (!gpu) {
  const page = await open(`?sandbox&gfx=${arg('gfx', 'low')}`, { width: 1280, height: 720 });
  await page.evaluate(() => window.__clock.stop());

  // a frag lobbed from the range's left end toward the dummies: sky, mid blocks and the thin wall behind it
  await place(page, 150.5, 0);
  await aimAt(page, 6, 4.2);
  await step(page, 10);
  await page.keyboard.down('KeyG');
  await step(page, 2);
  await page.keyboard.up('KeyG');
  await step(page, 14); // 0.27 s after the throw
  await shot(page, 'frag-flight');
  await step(page, 22); // 0.63 s: falling toward the cover
  await shot(page, 'frag-flight-2');
  // the fuse is 1.6 s (96 ticks): step to just after the blast
  const toBlast = await page.evaluate(() => {
    const g = window.__game.mode.game.grenades.find((x) => x.alive);
    return g ? g.fuse : 0;
  });
  await step(page, toBlast + 2);
  await shot(page, 'explosion-1');
  await step(page, 9); // +0.18 s
  await shot(page, 'explosion-2');
  await step(page, 24); // +0.58 s
  await shot(page, 'explosion-3');
  await step(page, 60); // +1.58 s: smoke and scorch
  await shot(page, 'explosion-4');

  // a frag rolled along the floor: it settles upright, fuse light racing, a wisp from the fuse
  await place(page, 150.5, 0);
  await aimAt(page, 3.2, -0.6);
  await page.keyboard.down('KeyG');
  await step(page, 2);
  await page.keyboard.up('KeyG');
  await step(page, 74); // 1.27 s after the throw
  await shot(page, 'frag-rest');
  await step(page, 60);

  // zoomed all the way out (the Widow allows 7 levels): the frag keeps a readable size
  await page.evaluate(() => window.__game.mode.setLoadout([4, 1]));
  await place(page, 150.5, 0);
  await page.evaluate(() => window.__game.mode.setLoadout([4, 1]));
  await page.evaluate(() => window.__game.camera.setZoom(6, 7));
  await step(page, 40);
  await aimAt(page, 6, 6);
  await page.keyboard.down('KeyG');
  await step(page, 2);
  await page.keyboard.up('KeyG');
  await step(page, 30);
  await shot(page, 'frag-zoomed-out');
  await page.evaluate(() => window.__game.camera.setZoom(0, 7));
  await step(page, 120);

  // gunfire: the Buzz at the dummies (automatic), mid-burst
  await place(page, 151, 0);
  await aimAt(page, 9, 0.2);
  await step(page, 10);
  await page.mouse.down();
  await step(page, 9);
  await shot(page, 'tracers');
  await page.mouse.up();
  await step(page, 30);

  // the debug overlay (H) still draws the 2D grenade, blast and tracers over the 3D view
  await page.keyboard.press('KeyH');
  await page.evaluate(() => (window.__game.mode.me.frags = 3));
  await aimAt(page, 5, 3.5);
  await page.keyboard.down('KeyG');
  await step(page, 2);
  await page.keyboard.up('KeyG');
  await step(page, 16);
  await shot(page, 'debug-overlay-frag');
  await page.keyboard.press('KeyH');
} else {
  const [w, h] = arg('size', '1920x1080').split('x').map(Number);
  const page = await open(`?sandbox&gfx=${arg('gfx', 'low')}`, { width: w, height: h }, { clock: false });
  await page.evaluate(() => window.__game.view3d.pinScale(null));
  // GPU time and draw calls per frame (EXT_disjoint_timer_query_webgl2 where it exists: ANGLE/Metal)
  await page.evaluate(() => {
    const v = window.__game.view3d;
    const gl = v.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    window.__gpuMs = [];
    window.__calls = [];
    window.__particles = [];
    const render = v.renderer.render.bind(v.renderer);
    const pending = [];
    v.renderer.render = (scene, camera) => {
      const q = ext && gl.createQuery();
      if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      render(scene, camera);
      window.__calls.push(v.renderer.info.render.calls);
      window.__particles.push(v.vfx?.particles ?? 0);
      if (!q) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(q);
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const done = pending.shift();
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) window.__gpuMs.push(gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(done);
      }
    };
  });
  const info = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  // at the range: a frag every 0.6 s while the Buzz fires, for 8 s
  await page.evaluate(() => {
    const m = window.__game.mode;
    m.setLoadout([1, 0]);
    m.me.spawn(151, 0, m.game.tuning);
  });
  await sleep(1000);
  const at = await page.evaluate(() => {
    const g = window.__game;
    const me = g.mode.me;
    return { x: g.camera.toScreenX(me.x + 7), y: g.camera.toScreenY(me.y + 3.5) };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await page.evaluate(() => {
      const me = window.__game.mode.me;
      me.frags = 3;
      for (const w of me.weapons) w.reserve = 250;
    });
    await page.keyboard.down('KeyG');
    await sleep(100);
    await page.keyboard.up('KeyG');
    await sleep(500);
  }
  await page.mouse.up();
  const window240 = await page.evaluate(() => {
    const pct = (arr, p) => {
      const t = arr.slice(-240).sort((a, b) => a - b);
      return t.length ? t[Math.min(t.length - 1, Math.floor(t.length * p))] : null;
    };
    const calls = window.__calls.slice(-240);
    return {
      gpuP50: pct(window.__gpuMs, 0.5),
      gpuP90: pct(window.__gpuMs, 0.9),
      callsP50: pct(calls, 0.5),
      callsMax: Math.max(...calls),
      particlesMax: Math.max(...window.__particles.slice(-480)),
    };
  });
  const s = await page.evaluate(() => window.__game.view3d.stats());
  console.log(JSON.stringify({ renderer: info, viewport: `${w}x${h}`, ...s, ...window240 }, null, 1));
}
await browser.close();
