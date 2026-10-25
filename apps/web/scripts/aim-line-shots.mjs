/* global process */
/**
 * The sniper's aim line in headless Chrome (throwaway profile), local sandbox.
 *   pnpm --filter @military-forge/web exec vite --port 5187 --strictPort        # in another shell
 *   node apps/web/scripts/aim-line-shots.mjs [--base http://localhost:5187] [--out <dir>] [--gpu]
 * Shots: desktop 3D and 2D (the Widow at a wall, in the open, airborne), and a phone in landscape
 * (812 × 375, touch). Weapons are given through the dev hook (window.__game). Also times the frame
 * with and without the line (the 3D perf readout's p50/p90).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5187');
const out = resolve(arg('out', 'docs/screenshots/aim-line'));
const gpu = process.argv.includes('--gpu');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'aim-line-shots-')),
  args: gpu ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});

async function open(query, phone) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  if (phone) {
    await page.emulate({
      viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    });
    await page.evaluateOnNewDocument(() => localStorage.setItem('mf.touch.drill.v1', 'done'));
  }
  await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  for (let i = 0; i < 120 && !(await page.evaluate(() => window.__game?.mode?.game !== undefined && (window.__game.view3d?.ready ?? true))); i++) await sleep(1000);
  await page.evaluate(() => {
    const panel = document.getElementById('panel');
    if (panel) panel.style.display = 'none';
    document.getElementById('perf3d')?.remove();
    window.__game.view3d?.pinScale(1);
  });
  return page;
}

/** The Widow in hand, standing at x (y above the floor), aiming at world (ax, ay). */
async function arm(page, x, y, ax, ay) {
  await page.evaluate(
    ([x, y]) => {
      const { game, me } = window.__game.mode;
      game.setLoadout(me, [4, 0]);
      Object.assign(me, { x, y, vx: 0, vy: 0, swapTicks: 0, hp: 100 });
      for (const p of game.players) if (p && p !== me) p.hp = 100;
    },
    [x, y],
  );
  await sleep(500);
  for (let i = 0; i < 4; i++) {
    // held in place (an airborne shot would fall meanwhile)
    await page.evaluate(([x, y]) => Object.assign(window.__game.mode.me, { x, y, vx: 0, vy: 0 }), [x, y]);
    // a mouse on the phone page too: the sampler takes it, and the stick would aim the same
    const at = await page.evaluate(([x, y]) => ({ x: window.__game.camera.toScreenX(x), y: window.__game.camera.toScreenY(y) }), [ax, ay]);
    await page.mouse.move(at.x, at.y);
    await sleep(gpu ? 150 : 400);
  }
}

async function shot(page, name) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, `${name}.png`) });
  const line = await page.evaluate(() => {
    const m = window.__game.mode;
    const f = m.aimLine?.update(m.game, m.me);
    return f ? { hit: f.hit, ready: f.ready, spread: +f.spread.toFixed(2), len: +Math.hypot(f.ex - f.ox, f.ey - f.oy).toFixed(2) } : null;
  });
  console.log(`  ${name}.png`, JSON.stringify(line));
}

async function scene(query, prefix, phone = false) {
  const page = await open(query, phone);
  if (!phone) {
    await page.mouse.move(900, 400);
    await page.mouse.click(900, 400);
    await sleep(800);
  }
  // down at the floor a few metres ahead: the line stops there, with its dot
  await arm(page, 148, 0.01, 156, 0);
  await shot(page, `${prefix}floor`);
  // level down the range: it runs on, fading, to the gun's reach or the first wall
  await arm(page, 148, 0.01, 166, 1.6);
  await shot(page, `${prefix}range`);
  // in the air (jetting): the shot may stray, so the line dims and loses its dot
  await arm(page, 148, 0.01, 158, 0);
  await page.keyboard.down('w');
  await sleep(450);
  await shot(page, `${prefix}airborne`);
  await page.keyboard.up('w');
  await page.close();
}

console.log(`aim line screenshots → ${out}`);
await scene('?sandbox', 'desktop-3d-');
await scene('?sandbox&render=2d', 'desktop-2d-');
await scene('?sandbox', 'phone-3d-', true);
await browser.close();
