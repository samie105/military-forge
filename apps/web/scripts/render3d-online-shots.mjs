/* global process */
/**
 * Online in 3D, two players: screenshots from player A's view of player B, who is drawn at
 * net.remotePose. B's shots and frag come in through snapshots, and the effects play on the remote
 * timeline.
 *   PORT=9202 pnpm --filter @military-forge/game-server start           # a dev room (live tuning on)
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-online-shots.mjs [--base http://localhost:5192] [--server ws://localhost:9202] [--out docs/screenshots/render3d-b]
 * The room spawns players far apart, so B gets a fast run and endless jet fuel through the dev
 * room's live tuning to fly over to A. The tuning is restored before any screenshot.
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
const prefix = arg('prefix', 'online-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One browser per player: a background tab is document.hidden, and the 3D view pauses there. */
const browsers = [];
async function connect(name) {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: 'new',
    userDataDir: mkdtempSync(join(tmpdir(), 'render3d-online-')),
    args: ['--enable-gpu', '--ignore-gpu-blocklist'],
    protocolTimeout: 900_000,
  });
  browsers.push(browser);
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.error(`[${name}]`, e.message));
  await page.goto(`${base}/?online&render=3d&transport=ws&server=${encodeURIComponent(server)}&name=${name}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    const ok = await page.evaluate(() => window.__game?.view3d?.ready && window.__game.mode.net?.predictor?.started);
    if (ok) break;
    await sleep(500);
  }
  await page.evaluate(() => {
    document.getElementById('panel').style.display = 'none';
    document.getElementById('perf3d')?.remove();
  });
  return page;
}

const me = (page) => page.evaluate(() => {
  const p = window.__game.mode.net.predictor.player;
  return { x: p.x, y: p.y, alive: p.alive };
});

async function shot(page, name) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, `${prefix}${name}.png`) });
  console.log(`  ${prefix}${name}.png`);
}

/** Mouse at an offset (m) from the page's own player, through its camera. */
async function aim(page, dx, dy) {
  const at = await page.evaluate(
    ({ dx, dy }) => {
      const g = window.__game;
      const p = g.mode.net.predictor.player;
      return { x: g.camera.toScreenX(p.x + dx), y: g.camera.toScreenY(p.y + 1.1 + dy) };
    },
    { dx, dy },
  );
  await page.mouse.move(at.x, at.y);
}

const a = await connect('Alpha');
const b = await connect('Bravo');
console.log('A at', await me(a), '· B at', await me(b));

// B flies over to A: fast, endless fuel; the jet pulses to clear the ledges (≤ 4 m)
const saved = await b.evaluate(() => {
  const m = window.__game.mode;
  const t = m.tuning();
  m.setTuning({ ...t, walkMax: 16, airMaxX: 16, jetAirMaxX: 16, groundAccel: 160, airAccel: 80, fuelBurn: 0 });
  return t;
});
await sleep(300);
await b.keyboard.down('KeyA');
for (let i = 0; i < 200; i++) {
  const p = await me(b);
  if (p.x < 10) break;
  if (p.y < 4.6) await b.keyboard.down('KeyW');
  else await b.keyboard.up('KeyW');
  await sleep(60);
}
await b.keyboard.up('KeyA');
await b.keyboard.up('KeyW');
await b.evaluate((t) => window.__game.mode.setTuning(t), saved);
await sleep(1500);
// the flight ends against the left wall: B walks back right a few metres, so A sees it apart
await b.keyboard.down('KeyD');
for (let i = 0; i < 100 && (await me(b)).x < 6.5; i++) await sleep(40);
await b.keyboard.up('KeyD');
await sleep(800);
console.log('A at', await me(a), '· B at', await me(b));

// A looks right at B; B shoots over A's head into the wall behind it (A must stay alive for the shots)
await aim(a, 9, 0.5);
await aim(b, -8, 2.2);
await sleep(600);
await shot(a, 'remote-player');
// the Buzz (slot 2, automatic): a stream of shots, so a frame catches a tracer in flight
await b.keyboard.down('Digit2');
await sleep(150);
await b.keyboard.up('Digit2');
await sleep(500);
await b.mouse.down();
await sleep(300);
for (let i = 1; i <= 3; i++) {
  await shot(a, `remote-tracers-${i}`);
  await sleep(90);
}
await b.mouse.up();
await sleep(800);

// B lobs a frag toward the wall past A: A sees it fly (a snapshot grenade on the remote timeline), then the blast
await aim(b, -3, 4.5);
await sleep(300);
await b.keyboard.down('KeyG');
await sleep(80);
await b.keyboard.up('KeyG');
await sleep(420);
await shot(a, 'remote-frag');
const blastAt = Date.now();
for (let i = 0; i < 60; i++) {
  const n = await a.evaluate(() => window.__game.view3d.vfx.decals.count);
  if (n > 0) break;
  await sleep(50);
}
await sleep(120);
await shot(a, 'remote-blast');
console.log(`blast drawn ${Date.now() - blastAt} ms after the frag shot`);
console.log('A stats', JSON.stringify(await a.evaluate(() => {
  const s = window.__game.view3d.stats();
  const n = window.__game.mode.net;
  return { avatars: s.avatars, particles: s.particles, calls: s.calls, renderTick: n.viewTick, interpDelay: n.interpDelay };
})));
for (const browser of browsers) await browser.close();
