/* global process */
/**
 * Graphics Auto on a phone (the owner, 19 Oct): a local match with three bots at 812×375, 3×,
 * touch, with the GPU's name faked (WEBGL_debug_renderer_info) as a given phone's, optionally CPU
 * throttled. Prints what Auto starts on and, every 5 s of real time, the tier, pixel ratio, render
 * scale and frame times from the 3D view's stats; saves the screen (the ?perf overlay included) at
 * the end, and a crop around the player.
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-mobile-quality.mjs [--base http://localhost:5192] [--out <dir>] [--gpu "Adreno (TM) 740"] [--cpu 4] [--hw] [--seconds 30] [--name tag]
 * Headless Chrome can't throttle the GPU: with --hw it renders on this machine's GPU, without it in
 * software (SwiftShader), the slowest case. The frame times say how Auto adapts, not what a phone
 * would measure.
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
const out = resolve(arg('out', '.'));
const gpu = arg('gpu', 'Adreno (TM) 740');
const cpu = Number(arg('cpu', '1'));
const seconds = Number(arg('seconds', '30'));
const name = arg('name', 'phone');
const hw = process.argv.includes('--hw');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-mobile-')),
  args: hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 300_000,
});
const page = await browser.newPage();
await page.setViewport({ width: 812, height: 375, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36');
await page.evaluateOnNewDocument((name) => {
  // the phone's GPU name, as WEBGL_debug_renderer_info would give it
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const get = C.prototype.getParameter;
    C.prototype.getParameter = function (p) {
      return p === 0x9246 || p === 0x1f01 ? name : get.call(this, p);
    };
  }
}, gpu);
page.on('pageerror', (e) => console.error('[page]', e.message));
if (cpu > 1) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
}
await page.goto(`${base}/?bots=3&perf`, { waitUntil: 'domcontentloaded' });
for (let i = 0; i < 120 && !(await page.evaluate(() => !!window.__game?.view3d?.ready)); i++) await sleep(1000);
const start = await page.evaluate(() => window.__game.view3d.stats());
console.log(`${name}: GPU "${gpu}"${cpu > 1 ? `, CPU ×${cpu} slower` : ''}, ${hw ? "this machine's GPU" : 'software GL'}`);
console.log(`  start: ${start.auto ? `Auto ${start.preset}` : start.preset}${start.touch ? ', touch' : ''}, ${start.width}×${start.height} (dpr ${start.pixelRatio.toFixed(2)})`);
for (let t = 5; t <= seconds; t += 5) {
  await sleep(5000);
  const s = await page.evaluate(() => window.__game.view3d.stats());
  console.log(`  ${String(t).padStart(3)} s: ${s.preset} · dpr ${s.pixelRatio.toFixed(2)} · scale ${s.scale.toFixed(2)} · ${s.width}×${s.height} · frame p50 ${s.frameP50.toFixed(1)} / p90 ${s.frameP90.toFixed(1)} ms`);
}
await page.screenshot({ path: join(out, `${name}.png`) });
const me = await page.evaluate(() => {
  const g = window.__game;
  return { x: g.camera.toScreenX(g.mode.me.x), y: g.camera.toScreenY(g.mode.me.y + 0.8) };
});
await page.screenshot({ path: join(out, `${name}-player.png`), clip: { x: Math.max(0, me.x - 80), y: Math.max(0, me.y - 55), width: 160, height: 110 } });
console.log(`  ${join(out, `${name}.png`)}`);
await browser.close();
