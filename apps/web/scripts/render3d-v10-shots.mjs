/* global process */
/**
 * render3d-b (v10) screenshots on the stepped clock:
 *   ricochet    a Hammer shot off a dummy's riot shield (3D): the cold tracer on, metal sparks
 *   arc-3d      hold G: the throw arc in 3D (the default since 18 Oct: tap = quick throw)
 *   arc-2d      the same in the 2D view (?render=2d)
 *   phone-*     a phone (844×390 @3x, touch): hold the grenade button, aim with the right stick,
 *               lift to throw
 *   cd apps/web && pnpm exec vite --port 5192 --strictPort
 *   node apps/web/scripts/render3d-v10-shots.mjs [--base http://localhost:5192] [--out docs/screenshots/render3d-b] [--hw] [--only ricochet,arc-3d,arc-2d,phone]
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
const hw = process.argv.includes('--hw');
const only = arg('only', 'ricochet,arc-3d,arc-2d,phone').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'render3d-v10-')),
  args: hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 900_000,
});

/** A page on the stepped clock (window.__clock), ready to play. */
async function open(query, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.evaluateOnNewDocument(() => {
    const realNow = performance.now.bind(performance);
    const realRaf = window.requestAnimationFrame.bind(window);
    let virtual = false;
    let now = 0;
    const queue = [];
    performance.now = () => (virtual ? now : realNow());
    window.requestAnimationFrame = (cb) => (virtual ? (queue.push(cb), queue.length) : realRaf(cb));
    window.__clock = {
      stop() {
        now = realNow();
        virtual = true;
        return new Promise((resolve) => realRaf(() => resolve()));
      },
      flush: () => new Promise((resolve) => realRaf(() => resolve())),
      step(frames = 1) {
        for (let i = 0; i < frames; i++) {
          now += 1000 / 60;
          for (const cb of queue.splice(0)) cb(now);
        }
      },
    };
  });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`${base}/?${query}`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120 && !(await page.evaluate(() => !!window.__game?.mode && (!window.__game.view3d || window.__game.view3d.ready))); i++) await sleep(1000);
  await page.evaluate(() => {
    document.getElementById('panel').style.display = 'none';
    document.getElementById('perf3d')?.remove();
    window.__game.view3d?.pinScale(1);
  });
  await page.evaluate(() => window.__clock.stop());
  const step = (n) => page.evaluate((k) => window.__clock.step(k), n);
  const flush = () => page.evaluate(() => window.__clock.flush());
  /** the cursor at (dx, dy) m from the player's feet; the camera's look-ahead moves the world, so a few passes */
  const cursorAt = async (dx, dy) => {
    for (let i = 0; i < 4; i++) {
      const at = await page.evaluate(
        ({ dx, dy }) => {
          const g = window.__game;
          const me = g.mode.me;
          return { x: g.camera.toScreenX(me.x + dx), y: g.camera.toScreenY(me.y + dy) };
        },
        { dx, dy },
      );
      await page.mouse.move(at.x, at.y);
      await flush();
      await step(20);
    }
  };
  const shot = async (name) => {
    mkdirSync(out, { recursive: true });
    const file = join(out, `${name}.png`);
    await page.screenshot({ path: file, captureBeyondViewport: false });
    console.log(`  ${file}`);
  };
  return { page, step, flush, cursorAt, shot };
}

if (only.includes('ricochet')) {
  const { page, step, cursorAt, shot } = await open('sandbox&gfx=medium', { width: 1280, height: 720 });
  // the Idle dummy on open floor with its riot shield up: it faces the nearest player, so the shield faces us
  await page.evaluate(() => {
    const m = window.__game.mode;
    const idle = m.game.players.find((p) => p?.name === 'Idle');
    idle.x = idle.homeX = 121;
    idle.y = idle.homeY = 0;
    idle.vx = idle.vy = 0;
    idle.shieldHp = 300;
    idle.shieldStowed = false;
    m.setLoadout([0, 1]);
    m.me.spawn(115.5, 0, m.game.tuning);
  });
  await step(90);
  await cursorAt(5.5, 1.15);
  const mag = () => page.evaluate(() => window.__game.mode.me.weapons[window.__game.mode.me.active].mag);
  const before = await mag();
  await page.mouse.down();
  for (let i = 0; i < 10 && (await mag()) === before; i++) await step(1);
  await page.mouse.up();
  await step(1);
  await shot('v10-ricochet');
  await step(2);
  await shot('v10-ricochet-2');
  await page.close();
}

for (const view of ['3d', '2d']) {
  if (!only.includes(`arc-${view}`)) continue;
  const { page, step, cursorAt, shot } = await open(`sandbox&gfx=medium&render=${view}`, { width: 1280, height: 720 });
  await page.evaluate(() => {
    const m = window.__game.mode;
    m.me.spawn(117, 0, m.game.tuning);
  });
  await step(60);
  await cursorAt(8, 4.5);
  await page.keyboard.down('KeyG'); // held past a tap: the arc
  await step(20);
  await shot(`v10-arc-${view}`);
  await page.keyboard.up('KeyG');
  await step(30);
  await shot(`v10-arc-${view}-thrown`);
  await page.close();
}

if (only.includes('phone')) {
  const { page, step, flush, shot } = await open('sandbox&gfx=low', { width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  for (let i = 0; i < 40 && !(await page.evaluate(() => document.documentElement.hasAttribute('data-touch-controls'))); i++) {
    await page.evaluate(() => window.__clock.flush());
    await step(5);
    await sleep(100);
  }
  await page.evaluate(() => {
    const m = window.__game.mode;
    m.me.spawn(117, 0, m.game.tuning);
  });
  await step(60);
  const rect = (sel) =>
    page.evaluate((s) => {
      const r = document.querySelector(s)?.getBoundingClientRect();
      return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 } : null;
    }, sel);
  const grenade = await rect('[data-mf-control="grenade"]');
  const stick = await rect('[data-mf-stick="aim"]');
  if (!grenade || !stick) throw new Error(`touch controls not found: ${JSON.stringify({ grenade, stick })}`);
  const cdp = await page.createCDPSession();
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
  const g = { x: grenade.x, y: grenade.y, id: 1 };
  // hold the grenade button with one thumb…
  await touch('touchStart', [g]);
  await flush();
  await step(12);
  // …and push the right stick up-right with the other: it aims the throw and its push is the strength
  await touch('touchStart', [g, { x: stick.x, y: stick.y, id: 2 }]);
  await flush();
  for (let k = 1; k <= 4; k++) {
    await touch('touchMove', [g, { x: stick.x + 14 * k, y: stick.y - 12 * k, id: 2 }]);
    await flush();
    await step(3);
  }
  await step(10);
  await shot('v10-phone-arc');
  // lift the grenade thumb: it throws
  await touch('touchMove', [{ x: stick.x + 56, y: stick.y - 48, id: 2 }]);
  await flush();
  await touch('touchEnd', []);
  await flush();
  await step(24);
  await shot('v10-phone-thrown');
  await page.close();
}

await browser.close();
