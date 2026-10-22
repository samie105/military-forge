/* global process */
/**
 * The studio's (Deet Studios) billboards in the Street Market, at normal play distance (1×), on a
 * laptop (1280 × 720) and a phone in landscape (812 × 375), on a stepped clock.
 *   cd apps/web && pnpm exec vite --port 5287 --strictPort        # in another shell
 *   node apps/web/scripts/ads-deet-shots.mjs [--base http://localhost:5287] [--out docs/screenshots/ads-deet]
 *
 * The house rotation shows two studio Screens per match; to see every creative in a few shots the
 * boards are given a manifest (AdBoards.setManifest, the paid flow's entry point) that puts one
 * studio creative on each surface, unpaid, so the boards look exactly as they do in the rotation.
 * The Motion creatives are shot on both keyframes (1 s and 2.4 s into a beat).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5287');
const out = resolve(arg('out', 'docs/screenshots/ads-deet'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'ads-deet-shots-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
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
    stop() {
      now = realNow();
      virtual = true;
      return new Promise((resolve) => realRaf(() => resolve()));
    },
    flush() {
      return new Promise((resolve) => realRaf(() => resolve()));
    },
    step(frames = 1, ms = 1000 / 60) {
      for (let i = 0; i < frames; i++) {
        now += ms;
        for (const cb of queue.splice(0)) cb(now);
      }
    },
  };
}

async function open(viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(installClock);
  page.on('pageerror', (e) => console.error('[page]', e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && console.error(`[console.${m.type()}]`, m.text()));
  await page.goto(`${base}/?map=street-market&sandbox&gfx=low`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 180 && !(await page.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
  await page.evaluate(() => {
    document.getElementById('panel').style.display = 'none';
    document.getElementById('bar').style.display = 'none';
    document.getElementById('perf3d')?.remove();
    window.__game.view3d.pinScale(1);
  });
  await page.evaluate(() => window.__clock.stop());
  return page;
}

const step = (page, frames) => page.evaluate((n) => window.__clock.step(n), frames);

/** One studio creative per surface (S1–S4, H1, H2), unpaid; waits for the layers to upload. */
async function showStudio(page, screens, hoardings) {
  const kinds = await page.evaluate(
    ({ screens, hoardings }) => {
      const b = window.__game.view3d.env.boards;
      const pool = [...b.pool.studio.screens, ...b.pool.studio.hoardings];
      const frame = (id) => {
        const e = pool.find((x) => x.id === id);
        return e.keys?.length ? { c: id, k: e.keys.length + 1, paid: false } : { c: id, paid: false };
      };
      let s = 0;
      let h = 0;
      b.setManifest({
        id: 'street-market-deet-shots',
        map: 'street-market',
        geo: 'XX',
        slots: b.slots.map((slot) => {
          const id = slot.format === '4:3' ? screens[s++] : hoardings[h++];
          return { slot: slot.slotId, frames: Array.from({ length: slot.frames }, () => frame(id)) };
        }),
      });
      return b.meshes.map((m) => m.name);
    },
    { screens, hoardings },
  );
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    await step(page, 1);
  }
  return kinds;
}

/** The local player at (x, y), every other player removed, the camera settled. */
async function place(page, x, y) {
  await page.evaluate(
    ({ x, y }) => {
      const m = window.__game.mode;
      for (const p of m.game.players) if (p && p !== m.me) m.game.removePlayer(p.id);
      m.setLoadout([1, 0]);
      m.me.spawn(x, y, m.game.tuning);
    },
    { x, y },
  );
  await step(page, 90);
}

/** Mouse at an offset from the local player's shoulder, in metres (the camera leans toward it). */
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

/** Steps the clock to `ms` into the shared 10 s beat (600 ticks). */
async function toBeat(page, ms) {
  const tick = await page.evaluate(() => window.__game.mode.game.tick);
  const want = Math.round(ms / (1000 / 60));
  await step(page, (((want - (tick % 600)) % 600) + 600) % 600 || 600);
}

async function shot(page, name) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  ${name}.png`);
}

// S1 west junction, S2 central tower, S3 above the danfo park, S4 east gantry; H1 flyover, H2 east roof
const VIEWS = [
  { name: 'west', at: [-50, 8.05], aim: [-4, 5] },
  { name: 'flyover', at: [-57, 12.05], aim: [6, 10] },
  { name: 'centre', at: [-12, 0.05], aim: [2, 5], keys: true },
  { name: 'tower', at: [20, 12.05], aim: [-4, 4] },
  { name: 'east', at: [50, 8.05], aim: [3, 5] },
  { name: 'gantry', at: [56, 12.05], aim: [2, 10], keys: true },
];

for (const [label, viewport] of [
  ['laptop', { width: 1280, height: 720 }],
  ['phone', { width: 812, height: 375 }],
]) {
  const page = await open(viewport);
  console.log(label);
  // pass 1: the wordmark, One studio, the We build Motion piece, the Products Motion piece; both Hoardings
  await showStudio(page, ['house:deet-wordmark', 'house:deet-one-studio', 'house:deet-we-build-motion', 'house:deet-products-motion'], ['house:deet-wordmark-wide', 'house:deet-one-studio-wide']);
  for (const v of VIEWS) {
    await place(page, ...v.at);
    await aimAt(page, ...v.aim);
    await toBeat(page, 1000);
    await shot(page, `${label}-${v.name}`);
    if (v.keys) {
      await toBeat(page, 2400);
      await shot(page, `${label}-${v.name}-k1`);
    }
  }
  // pass 2: We build (still) on the danfo-park Screen
  await showStudio(page, ['house:deet-wordmark', 'house:deet-one-studio', 'house:deet-we-build', 'house:deet-products-motion'], ['house:deet-wordmark-wide', 'house:deet-one-studio-wide']);
  const v = VIEWS[2];
  await place(page, ...v.at);
  await aimAt(page, ...v.aim);
  await toBeat(page, 1000);
  await shot(page, `${label}-centre-still`);
  await page.close();
}
await browser.close();
