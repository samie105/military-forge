/* global process */
/**
 * Online in 3D on v10 (review H1): smoke, an armed mine and pickups seen from player A, with B the
 * thrower. Two browsers against a fresh dev room on the movement test range (seed 1: a mine pair
 * turns up on the tower top ~3 s after boot, a riot shield on the cover, a smoke pair on the top
 * one-way platform ~11 s in). B flies up for the mines and the smokes through the dev room's live
 * tuning (restored before any screenshot), then throws a smoke between them and a mine at A's feet.
 *   PORT=9202 pnpm --filter @military-forge/game-server start            # a fresh dev room
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-online-v10-shots.mjs [--base http://localhost:5192] [--server ws://localhost:9202] [--out docs/screenshots/render3d-b]
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
const server = arg('server', 'ws://localhost:9202');
const out = resolve(arg('out', 'docs/screenshots/render3d-b'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SMOKE = 1;
const MINE = 4;

const browsers = [];
async function connect(name) {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    userDataDir: mkdtempSync(join(tmpdir(), 'render3d-online-v10-')),
    args: ['--enable-gpu', '--ignore-gpu-blocklist'],
    protocolTimeout: 900_000,
  });
  browsers.push(browser);
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.error(`[${name}]`, e.message));
  // no ?render: online opens in 3D by default now
  await page.goto(`${base}/?online&transport=ws&server=${encodeURIComponent(server)}&name=${name}&gfx=medium`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(() => window.__game?.view3d?.ready && window.__game.mode.net?.predictor?.started)) break;
    await sleep(500);
  }
  await page.evaluate(() => {
    document.getElementById('panel').style.display = 'none';
    document.getElementById('perf3d')?.remove();
  });
  return page;
}

const me = (page) =>
  page.evaluate(() => {
    const p = window.__game.mode.net.predictor.player;
    return { x: p.x, y: p.y, vx: p.vx, vy: p.vy, grounded: p.grounded, type: p.grenadeType, counts: [...p.grenadeCounts] };
  });

/** Steers `page`'s player to (x, y): left/right toward x, the jet while below y. */
async function flyTo(page, x, y, until = () => false, ms = 15000) {
  const keys = new Set();
  const hold = async (k, on) => {
    if (on && !keys.has(k)) await page.keyboard.down(k);
    if (!on && keys.has(k)) await page.keyboard.up(k);
    if (on) keys.add(k);
    else keys.delete(k);
  };
  const end = Date.now() + ms;
  for (;;) {
    const p = await me(page);
    if ((await until(p)) || Date.now() > end) break;
    const dx = x - p.x;
    const dy = y - p.y;
    await hold('KeyD', dx > 0.3);
    await hold('KeyA', dx < -0.3);
    await hold('KeyW', dy > 0.2 || (dy > -1 && p.vy < -4));
    if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.4 && Math.abs(p.vx) < 1) break;
    await sleep(30);
  }
  for (const k of [...keys]) await hold(k, false);
}

/** The cursor at world (wx, wy) on `page`'s camera. */
async function cursorAt(page, wx, wy) {
  const at = await page.evaluate(({ wx, wy }) => ({ x: window.__game.camera.toScreenX(wx), y: window.__game.camera.toScreenY(wy) }), { wx, wy });
  await page.mouse.move(at.x, at.y);
}

/** Selects grenade `type` with the cycle key (T), then aims at (wx, wy) holding G and lets go. */
async function throwAt(page, type, wx, wy) {
  for (let i = 0; i < 8 && (await me(page)).type !== type; i++) {
    await page.keyboard.down('KeyT'); // held across a sample (a press shorter than a tick can fall between)
    await sleep(60);
    await page.keyboard.up('KeyT');
    await sleep(200);
  }
  await sleep(200);
  await page.keyboard.down('KeyG');
  for (let i = 0; i < 6; i++) {
    await cursorAt(page, wx, wy); // the camera's look-ahead moves: re-aim a few times
    await sleep(80);
  }
  await page.keyboard.up('KeyG');
  await sleep(700); // past the throw cooldown (0.5 s)
  console.log('  threw', type, '→ belt', (await me(page)).counts.join(','));
}

async function shot(page, name) {
  mkdirSync(out, { recursive: true });
  const file = join(out, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ${file}`);
}

const a = await connect('Alpha');
const b = await connect('Bravo');
console.log('A', await me(a), 'B', await me(b));
const pickups = await a.evaluate(() => window.__game.mode.net.snapshots.at(-1)?.msg.pickups ?? []);
console.log('pickups in view of A:', JSON.stringify(pickups));

const saved = await b.evaluate(() => {
  const m = window.__game.mode;
  const t = m.tuning();
  m.setTuning({ ...t, walkMax: 12, airMaxX: 12, jetAirMaxX: 12, groundAccel: 120, airAccel: 60, fuelBurn: 0 });
  return t;
});
await sleep(300);
// A to the range, left of the cover (over the ledges and the tower; clear of the shield on the cover)
await flyTo(a, 153, 13.5, undefined, 25000);
await flyTo(a, 153, 0, undefined, 8000);
// B: the mines on the tower top (up through the one-way ledge on its right, then over), then the smokes
await flyTo(b, 146, 13.2, undefined, 20000);
await flyTo(b, 143, 12.6, (p) => p.counts[MINE] > 0, 6000);
await flyTo(b, 143, 12, (p) => p.counts[MINE] > 0, 3000);
console.log('B after the tower', await me(b));
await flyTo(b, 127, 8.6, (p) => p.counts[SMOKE] > 0, 15000);
await flyTo(b, 127, 7.5, (p) => p.counts[SMOKE] > 0, 4000);
console.log('B after the platform', await me(b));
// B over the tower and down just past the one-way ledge on its right (144–148 at 12 m)
await flyTo(b, 148.6, 14, undefined, 15000);
await flyTo(b, 148.6, 0, undefined, 8000);
await b.evaluate((t) => window.__game.mode.setTuning(t), saved);
await sleep(1200);
console.log('A', await me(a), 'B', await me(b));

// B throws a smoke over itself by the tower (it hides in it) and a mine on the floor 2.5 m short of A
await throwAt(b, SMOKE, 145, 0.6);
await throwAt(b, MINE, 151, 0);
await sleep(2600); // the mine arms (2 s) and starts flashing red; the smoke spreads
await cursorAt(a, 148, 1.5);
await sleep(400);
await shot(a, 'v10-online-smoke-mine-pickups');
await sleep(700);
await shot(a, 'v10-online-smoke-mine-pickups-2');
await shot(b, 'v10-online-thrower-view');
const stats = await a.evaluate(() => {
  const m = window.__game.mode.net.snapshots.at(-1).msg;
  return { clouds: m.clouds.length, pickups: m.pickups.map((k) => k.def), grenades: m.grenades.map((g) => ({ type: g.type, state: g.state })) };
});
console.log('A sees', JSON.stringify(stats));
for (const browser of browsers) await browser.close();
