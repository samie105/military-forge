/* global process, Buffer */
/**
 * Animation-stream screenshots for PRs (docs/screenshots/animation), headless Chrome with a throwaway profile:
 *   cd apps/web && pnpm exec vite --port 5195 --strictPort        # in another shell
 *   node apps/web/scripts/animation-shots.mjs [--base http://localhost:5195] [--out docs/screenshots/animation] [--set looks]
 * Sets:
 *   looks   the same Rookie in the Locker and in game (close-up camera), and the range with placeholder looks
 *   strips  frame strips from the animation lab (/animlab.html): slow walk, run, brake, reverse, launch, land,
 *           jet, dash (`--only brake,launch` for some of them)
 *   zoom1x  the range at the real 1× gameplay zoom at 1080p (a soldier is ~80 px tall), cropped round the dummies
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5195');
const out = resolve(arg('out', 'docs/screenshots/animation'));
const set = arg('set', 'looks');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'animation-shots-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});

async function page(path, viewport = { width: 1280, height: 720 }) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.error('[page]', e.message));
  await p.setViewport(viewport);
  await p.goto(`${base}/${path}`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
  return p;
}

async function shot(p, name, clip) {
  await p.screenshot({ path: join(out, `${name}.png`), ...(clip ? { clip } : {}) });
  console.log(`  ${name}.png`);
}

/** The game, with the camera pulled in to `width` metres (the zoom table only pulls back) and the panels hidden. */
async function game(width, query = '') {
  const p = await page(query);
  for (let i = 0; i < 120 && !(await p.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
  await p.evaluate((w) => {
    document.getElementById('panel').style.display = 'none';
    document.getElementById('perf3d')?.remove();
    const g = window.__game;
    g.view3d.pinScale(1);
    Object.defineProperty(g.camera, 'viewWidth', { get: () => w, configurable: true });
    window.dispatchEvent(new Event('resize'));
  }, width);
  return p;
}

try {
  if (set === 'looks') {
    const locker = await page('locker.html');
    await locker.waitForSelector('.mm-overlay[hidden]', { timeout: 300_000 });
    await sleep(2500);
    await shot(locker, 'looks-locker', { x: 472, y: 52, width: 808, height: 668 });

    const close = await game(7, '?gfx=high');
    await sleep(3000);
    await shot(close, 'looks-game-closeup');

    // the shooting range: four dummies in PLACEHOLDER looks (default Rookie, dyes by player id)
    const range = await game(17, '?gfx=high');
    await range.evaluate(() => window.__game.mode.me.spawn(161, 0, window.__game.mode.game.tuning));
    await sleep(3500);
    await shot(range, 'looks-range-placeholders');
  }
  if (set === 'strips') {
    const lab = await page('animlab.html', { width: 800, height: 600 });
    for (let i = 0; i < 600 && !(await lab.evaluate(() => window.__lab?.ready)); i++) await sleep(1000);
    const only = arg('only', null)?.split(',');
    for (const name of await lab.evaluate(() => window.__lab.scenarios)) {
      if (only && !only.includes(name)) continue;
      const url = await lab.evaluate((n) => window.__lab.strip(n), name);
      writeFileSync(join(out, `strip-${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
      console.log(`  strip-${name}.png`);
    }
  }
  if (set === 'zoom1x') {
    const p = await page('?gfx=high', { width: 1920, height: 1080 });
    for (let i = 0; i < 600 && !(await p.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
    await p.evaluate(() => {
      document.getElementById('panel').style.display = 'none';
      document.getElementById('perf3d')?.remove();
      window.__game.view3d.pinScale(1);
      window.__game.mode.me.spawn(161, 0, window.__game.mode.game.tuning);
    });
    await sleep(4000);
    // the dummies stand at x 157–168, the local player at 161
    const at = await p.evaluate(() => ({ x: window.__game.camera.toScreenX(162), y: window.__game.camera.toScreenY(1) }));
    await shot(p, 'zoom1x-range', { x: Math.round(at.x - 420), y: Math.round(at.y - 230), width: 840, height: 360 });
  }
} finally {
  await browser.close();
}
