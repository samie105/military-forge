/* global process */
/**
 * Riot shield screenshots in headless Chrome (throwaway profile), local sandbox mode.
 *   pnpm --filter @military-forge/web exec vite --port 5193 --strictPort        # in another shell
 *   node apps/web/scripts/shield-shots.mjs [--base http://localhost:5193] [--out docs/screenshots/shield] [--gpu]
 * Shots: a shield standing at its spawner spot; one raised (3D, and with the H overlay showing the
 * sim's blocking segment); one slung on the back; ricochets off a dummy's shield (3D and 2D).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5193');
const out = resolve(arg('out', 'docs/screenshots/shield'));
const gpu = process.argv.includes('--gpu');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'shield-shots-')),
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

/** Puts the local player at x (on the floor) and waits for it to settle. */
async function place(page, x) {
  await page.evaluate((x) => {
    const me = window.__game.mode.me;
    me.x = x;
    me.y = 0.01;
    me.vx = me.vy = 0;
  }, x);
  await sleep(400);
}

/** Mouse at world (x, y) through the 2D camera. The camera eases toward the player and leans toward the cursor, so re-aim until it settles. */
async function aimAt(page, x, y) {
  for (let i = 0; i < 4; i++) {
    const at = await page.evaluate(([x, y]) => ({ x: window.__game.camera.toScreenX(x), y: window.__game.camera.toScreenY(y) }), [x, y]);
    await page.mouse.move(at.x, at.y);
    await sleep(gpu ? 150 : 500);
  }
}

/** A gameplay key held long enough for the 60 Hz input sampler to see it. */
async function tap(page, code) {
  await page.keyboard.down(code);
  await sleep(120);
  await page.keyboard.up(code);
}

async function shot(page, name, settle = gpu ? 200 : 1500) {
  await sleep(settle);
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  ${name}.png`);
}

/** Waits for the first shield to appear at one of its spots; returns it. */
async function firstItem(page) {
  for (let i = 0; i < 60; i++) {
    const k = await page.evaluate(() => {
      const k = window.__game.mode.game.pickups.find((x) => x.alive);
      return k ? { x: k.x, y: k.y } : null;
    });
    if (k) return k;
    await sleep(250);
  }
  throw new Error('no shield spawned');
}

/**
 * The Strafer dummy stands still at x with a shield (it raises it: Hammer in hand, facing the
 * nearest human).
 */
async function arm(page, x) {
  await page.evaluate((x) => {
    const d = window.__game.mode.game.players.find((p) => p?.name === 'Strafer');
    d.script = { kind: 'idle' };
    d.x = x;
    d.y = 0.01;
    d.vx = 0;
    d.shieldHp = 300;
    d.shieldStowed = false;
  }, x);
}

async function scene(query, prefix) {
  const page = await open(query);
  const is3d = await page.evaluate(() => !!window.__game.view3d);
  await place(page, 147.5);
  const item = await firstItem(page);
  await aimAt(page, item.x, item.y + 0.8);
  if (is3d) await shot(page, `${prefix}pickup`);

  // walk onto it: it comes up with the Hammer in hand. Open ground, the dummy 3.5 m away
  await place(page, item.x);
  await place(page, 147.5);
  await arm(page, 151);
  await aimAt(page, 151, 0.9);
  await sleep(800);
  await shot(page, `${prefix}raised`);
  if (is3d) {
    await page.keyboard.press('KeyH');
    await shot(page, `${prefix}raised-overlay`);
    await page.keyboard.press('KeyH');
  }

  // the Buzz into the dummy's shield: ricochets fly back past us, into the tower
  await tap(page, 'KeyQ');
  await sleep(600);
  await aimAt(page, 150.58, 0.75);
  await page.mouse.down();
  await sleep(gpu ? 250 : 500);
  // effects last ~0.12–0.16 s: a short burst, keep whichever frame shows them best
  for (let i = 1; i <= 3; i++) await shot(page, `${prefix}ricochet-${i}`, 70);
  await page.mouse.up();

  // slung on the back
  await tap(page, 'KeyX');
  await aimAt(page, 154, 2);
  await shot(page, `${prefix}slung`);
  await page.close();
}

console.log(`shield screenshots → ${out}`);
await scene('?sandbox', '3d-');
await scene('?sandbox&render=2d', '2d-');
await browser.close();
