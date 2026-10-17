/* global process */
/**
 * render3d screenshots + frame-time measurement in headless Chrome (throwaway profile).
 *   pnpm --filter @military-forge/web exec vite --port 5181 --strictPort        # in another shell
 *   node apps/web/scripts/render3d-shots.mjs [--base http://localhost:5181] [--out docs/screenshots/render3d]
 *   node apps/web/scripts/render3d-shots.mjs --gpu [--size 1920x1080] [--gfx low]
 * Default is SwiftShader (software GL: deterministic but slow, so its frame times mean nothing);
 * --gpu uses the machine's GPU and only measures: 8 s of jet-running, then the last 240 frames.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5181');
const out = resolve(arg('out', 'docs/screenshots/render3d'));
const gpu = process.argv.includes('--gpu');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-shots-')),
  args: gpu ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 720 },
});

async function open(query = '', viewport = { width: 1280, height: 720 }) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  if (gpu) await page.evaluateOnNewDocument(() => (window.__gpu = true));
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 90 && !(await page.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
  // hide the tuning panel and the perf panel (SwiftShader timings are meaningless), pin full resolution
  await page.evaluate(() => {
    document.getElementById('panel').style.display = 'none';
    if (!window.__gpu) document.getElementById('perf3d')?.remove();
    window.__game.view3d.pinScale(1);
  });
  return page;
}

/** Mouse to the right of the local player at chest height (screen space from the 2D camera). */
async function aimRight(page, dx = 260, dy = -40) {
  const at = await page.evaluate(() => {
    const g = window.__game;
    const me = g.mode.me;
    return { x: g.camera.toScreenX(me.x), y: g.camera.toScreenY(me.y + 1) };
  });
  await page.mouse.move(at.x + dx, at.y + dy);
}

async function hold(page, keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
}

async function release(page, keys) {
  for (const k of keys) await page.keyboard.up(k);
}

async function shot(page, name) {
  await sleep(gpu ? 0 : 1500); // a few SwiftShader frames
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  ${name}.png`);
}

const stats = (page) => page.evaluate(() => window.__game.view3d.stats());

if (gpu) {
  const [w, h] = (arg('size', '1920x1080')).split('x').map(Number);
  const page = await open(`?gfx=${arg('gfx', 'low')}`, { width: w, height: h });
  await page.evaluate(() => window.__game.view3d.pinScale(null));
  // GPU time per frame, where EXT_disjoint_timer_query_webgl2 exists (ANGLE/Metal has it)
  await page.evaluate(() => {
    const v = window.__game.view3d;
    const gl = v.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    window.__gpuMs = [];
    if (!ext) return;
    const render = v.renderer.render.bind(v.renderer);
    const pending = [];
    v.renderer.render = (scene, camera) => {
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      render(scene, camera);
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
  // jet-run right and back past the ledges for 8 s, then read the last 240 frames
  await aimRight(page);
  for (const keys of [['KeyD'], ['KeyD', 'KeyW'], ['KeyA'], ['KeyA', 'KeyW']]) {
    await hold(page, keys, 2000);
    await release(page, keys);
  }
  const gpuMs = await page.evaluate(() => {
    const t = window.__gpuMs.slice(-240).sort((a, b) => a - b);
    return t.length ? { gpuP50: t[Math.floor(t.length / 2)], gpuP90: t[Math.floor(t.length * 0.9)], samples: t.length } : null;
  });
  console.log(JSON.stringify({ renderer: info, viewport: `${w}x${h}`, ...(await stats(page)), ...gpuMs }, null, 1));
} else {
  const page = await open();
  await aimRight(page);
  await shot(page, 'spawn-idle');
  await hold(page, ['KeyD'], 700);
  await shot(page, 'run');
  await hold(page, ['KeyW'], 450);
  await shot(page, 'jet');
  await release(page, ['KeyD', 'KeyW']);
  await sleep(1500);
  await page.keyboard.press('KeyH');
  await shot(page, 'debug-overlay-hitboxes');
  await page.keyboard.press('KeyH');

  // the shooting range: four scripted dummies (strafe, jet, idle, crouch), LOD1 on Low
  await page.evaluate(() => window.__game.mode.me.spawn(151, 0, window.__game.mode.game.tuning));
  await sleep(1000);
  await aimRight(page, 300, 0);
  await shot(page, 'range-low');
  await page.evaluate(() => window.__game.view3d.setPreset('high'));
  await shot(page, 'range-high');
  console.log(JSON.stringify(await stats(page)));

  // a screen taller than 4:3: the sides are cropped, never more height than the AOI (VIEW_MAX_ASPECT)
  const tall = await open('', { width: 720, height: 900 });
  await aimRight(tall, 150);
  await shot(tall, 'tall-screen-crop');
}
await browser.close();
