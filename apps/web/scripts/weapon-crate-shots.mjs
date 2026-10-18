/* global process */
/**
 * Weapon crate and test armory screenshots in headless Chrome (throwaway profile), local sandbox.
 *   pnpm --filter @military-forge/web exec vite --port 5197 --strictPort        # in another shell
 *   node apps/web/scripts/weapon-crate-shots.mjs [--base http://localhost:5197] [--out docs/screenshots/more-guns] [--gpu]
 * Shots, in 3D and 2D: the movement-test range's armory rack (one of every gun); standing on a
 * gun with the `[E] take` prompt; after `E`, the new gun in hand; a map crate from the range's
 * weapons spawner.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5197');
const out = resolve(arg('out', 'docs/screenshots/more-guns'));
const gpu = process.argv.includes('--gpu');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'crate-shots-')),
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

/** Puts the local player at (x, y) and waits for it to settle. */
async function place(page, x, y = 0.01) {
  await page.evaluate(
    ([x, y]) => {
      const me = window.__game.mode.me;
      Object.assign(me, { x, y, vx: 0, vy: 0 });
    },
    [x, y],
  );
  await sleep(600);
}

/** Mouse at world (x, y) through the 2D camera, re-aimed until the camera settles. */
async function aimAt(page, x, y) {
  for (let i = 0; i < 4; i++) {
    const at = await page.evaluate(([x, y]) => ({ x: window.__game.camera.toScreenX(x), y: window.__game.camera.toScreenY(y) }), [x, y]);
    await page.mouse.move(at.x, at.y);
    await sleep(gpu ? 150 : 500);
  }
}

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

/** The live items: [{ x, y, def, rack }] (rack: from the test armory). */
const items = (page) =>
  page.evaluate(() => {
    const g = window.__game.mode.game;
    return g.pickups.filter((k) => k.alive).map((k) => ({ x: k.x, y: k.y, def: k.def, rack: k.spawner >= 0 && g.spawners[k.spawner].def.id.startsWith('armory-') }));
  });

async function scene(query, prefix) {
  const page = await open(query);
  // the rack: one of every gun, near the spawns
  let rack = [];
  for (let i = 0; i < 60 && rack.length === 0; i++, await sleep(500)) rack = (await items(page)).filter((k) => k.rack);
  const mid = rack.reduce((s, k) => s + k.x, 0) / rack.length;
  await place(page, rack[0].x - 2, rack[0].y + 0.01);
  await aimAt(page, mid + 4, rack[0].y + 1.5);
  await shot(page, `${prefix}armory-rack`);
  // standing on the Widow (the 5th gun): the prompt, then E
  const widow = rack[4];
  await place(page, widow.x, widow.y + 0.01);
  await aimAt(page, widow.x + 6, widow.y + 1.5);
  await shot(page, `${prefix}take-prompt`);
  await tap(page, 'KeyE');
  await shot(page, `${prefix}taken`, 1200);
  // a crate from the range's weapons spawner (not the rack)
  let crate = null;
  for (let i = 0; i < 60 && !crate; i++, await sleep(500)) crate = (await items(page)).find((k) => !k.rack && k.def >= 7) ?? null;
  if (crate) {
    await place(page, crate.x - 2.5, crate.y + 0.01);
    await aimAt(page, crate.x + 3, crate.y + 1.2);
    await shot(page, `${prefix}map-crate`);
  } else console.log('  (no map crate came out)');
  await page.close();
}

console.log(`weapon crate screenshots → ${out}`);
await scene('?sandbox', '3d-');
await scene('?sandbox&render=2d', '2d-');
await browser.close();
