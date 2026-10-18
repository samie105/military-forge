/* global process */
/**
 * Launcher and flamethrower screenshots in headless Chrome (throwaway profile), local sandbox.
 *   pnpm --filter @military-forge/web exec vite --port 5198 --strictPort        # in another shell
 *   node apps/web/scripts/launcher-shots.mjs [--base http://localhost:5198] [--out docs/screenshots/launchers] [--gpu]
 * Shots, in 3D and 2D: a rocket in flight down the range, a lobbed shell, a saw blade, an EMP orb,
 * and the flamethrower on a dummy (burning). Weapons are given through the dev hook (window.__game).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5198');
const out = resolve(arg('out', 'docs/screenshots/launchers'));
const gpu = process.argv.includes('--gpu');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'launcher-shots-')),
  args: gpu ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1600, height: 900 },
});

async function open(query) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  for (let i = 0; i < 120 && !(await page.evaluate(() => window.__game?.mode?.game !== undefined && (window.__game.view3d?.ready ?? true))); i++) await sleep(1000);
  await page.evaluate(() => {
    document.getElementById('panel').style.display = 'none';
    document.getElementById('perf3d')?.remove();
    window.__game.view3d?.pinScale(1);
  });
  return page;
}

/** The weapon `index` in hand, standing at x on the range's floor, aiming at world (ax, ay). */
async function arm(page, index, x, ax, ay) {
  await page.evaluate(
    ([index, x]) => {
      const { game, me } = window.__game.mode;
      game.setLoadout(me, [index, 1]);
      Object.assign(me, { x, y: 0.01, vx: 0, vy: 0, swapTicks: 0 });
    },
    [index, x],
  );
  await sleep(500);
  for (let i = 0; i < 4; i++) {
    const at = await page.evaluate(([x, y]) => ({ x: window.__game.camera.toScreenX(x), y: window.__game.camera.toScreenY(y) }), [ax, ay]);
    await page.mouse.move(at.x, at.y);
    await sleep(gpu ? 150 : 400);
  }
}

/** Waits until the sim has a live projectile of `type` (and `more` says so), up to `ms`. */
async function until(page, fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await page.evaluate(fn)) return true;
    await sleep(15);
  }
  return false;
}

async function shot(page, name) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  ${name}.png`);
}

const live = (type) => `window.__game.mode.game.grenades.some((g) => g.alive && g.type === ${type})`;

async function scene(query, prefix) {
  const page = await open(query);
  // the first press only focuses the canvas: spend it on the Hammer
  await page.mouse.move(900, 400);
  await page.mouse.click(900, 400);
  await sleep(800);
  // a rocket down the range, mid-flight
  await arm(page, 14, 148, 160, 1.2);
  await page.mouse.down();
  await until(page, live(8));
  await page.mouse.up();
  await sleep(180);
  await shot(page, `${prefix}rocket`);
  await sleep(1500);
  // a shell, lobbed
  await arm(page, 15, 148, 156, 3);
  await page.mouse.down();
  await until(page, live(9));
  await page.mouse.up();
  await sleep(200);
  await shot(page, `${prefix}shell`);
  await sleep(1500);
  // a saw blade: hold for the charge
  await arm(page, 16, 148, 160, 1.1);
  await page.mouse.down();
  await until(page, live(10), 3000);
  await page.mouse.up();
  await sleep(250);
  await shot(page, `${prefix}blade`);
  await sleep(4000);
  // an EMP orb at the hopping dummy
  await arm(page, 17, 156, 163, 1.5);
  await page.mouse.down();
  await until(page, live(11), 3000);
  await page.mouse.up();
  await sleep(400);
  await shot(page, `${prefix}orb`);
  await sleep(2500);
  // the flamethrower on the idle dummy
  await arm(page, 18, 162.5, 165.5, 1.1);
  await page.mouse.down();
  await sleep(700);
  await shot(page, `${prefix}flames`);
  await page.mouse.up();
  await page.close();
}

console.log(`launcher screenshots → ${out}`);
await scene('?sandbox', '3d-');
await scene('?sandbox&render=2d', '2d-');
await browser.close();
