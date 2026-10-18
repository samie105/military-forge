/**
 * Headless-Chrome screenshots of grenade variety for PRs (throwaway profile, never the user's).
 *   cd apps/web && pnpm exec vite --port 5194 --strictPort      (dev server: the __game hook is dev-only)
 *   node apps/web/scripts/grenade-screenshots.mjs [http://localhost:5194] [out dir] [shot …]
 * Local sandbox with a full grenade belt (?grenades): the player is put on the range's cover
 * through the dev hook, cycles with T and throws with G at the dummies, in 3D and in the 2D view.
 * The bursts seen from afar (flash-pop, emp-ring) are dropped in through the dev hook with a short
 * fuse; the pairs are the range's grenade spawner.
 */
/* global process */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://localhost:5194';
const out = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '../../../docs/screenshots/arsenal-b');
const only = new Set(process.argv.slice(4));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits `seconds` of sim time (a loaded machine runs the sim slower than the wall clock). */
async function simWait(page, seconds) {
  const start = await page.evaluate(() => window.__game.mode.game.tick);
  await page.waitForFunction((t) => window.__game.mode.game.tick >= t, { timeout: 120_000, polling: 50 }, start + Math.round(seconds * 60));
}

mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'mf-grenades-'));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: profile,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720 },
});

/** Waits for the flashbang to blind us, then until its fade is ~65% white. */
async function midFade(page) {
  await page.waitForFunction(() => window.__game.mode.me.blindTicks > 0, { timeout: 60_000, polling: 20 });
  await page.waitForFunction(() => window.__game.mode.me.blindTicks <= 0.65 * window.__game.mode.me.blindFade, { timeout: 60_000, polling: 20 });
}

/** Opens the sandbox and stands on the cover; `reduceFlashes` sets the accessibility option first. */
async function open(page, query, reduceFlashes = false) {
  await page.goto(`${base}/?sandbox&grenades&name=Ade${query}`, { waitUntil: 'load' });
  const stored = await page.evaluate(() => localStorage.getItem('mf.reduceFlashes'));
  if (stored !== (reduceFlashes ? '1' : '0')) {
    await page.evaluate((on) => localStorage.setItem('mf.reduceFlashes', on ? '1' : '0'), reduceFlashes);
    await page.reload({ waitUntil: 'load' });
  }
  await page.waitForFunction(() => window.__game?.mode?.me && (!window.__game.view3d || window.__game.view3d.ready), { timeout: 60_000, polling: 100 });
  // the tuning panel would swallow the mouse over the range: hide it
  await page.evaluate(() => (document.getElementById('panel').style.display = 'none'));
  await page.evaluate(() => Object.assign(window.__game.mode.me, { x: 154.5, y: 1.25, vx: 0, vy: 0 }));
  await page.mouse.move(900, 300);
  await delay(1500); // the camera settles
}

/** Aims at world (x, y), cycles to grenade type `type` and throws it. */
async function throwAt(page, type, x, y) {
  for (let i = 0; i < 8; i++) {
    const sel = await page.evaluate(() => window.__game.mode.me.grenadeType);
    if (sel === type) break;
    // held across a sim tick or two: the input is sampled once per tick (60 Hz)
    await page.keyboard.down('KeyT');
    await delay(60);
    await page.keyboard.up('KeyT');
    await delay(60);
  }
  const at = await page.evaluate((wx, wy) => ({ x: window.__game.camera.toScreenX(wx), y: window.__game.camera.toScreenY(wy) }), x, y);
  await page.mouse.move(at.x, at.y);
  await delay(100);
  await page.keyboard.down('KeyG');
  await delay(60);
  await page.keyboard.up('KeyG');
}

/** Points the mouse at world (x, y) and lets the camera's look-ahead settle there. */
async function lookAt(page, x, y) {
  for (let i = 0; i < 3; i++) {
    const at = await page.evaluate((wx, wy) => ({ x: window.__game.camera.toScreenX(wx), y: window.__game.camera.toScreenY(wy) }), x, y);
    await page.mouse.move(Math.max(40, Math.min(1240, at.x)), Math.max(40, Math.min(680, at.y)));
    await simWait(page, 0.4);
  }
}

/** Drops a grenade of `type` at (x, y) through the dev hook, nobody's, about to go off. */
async function popAt(page, type, x, y) {
  await page.evaluate(
    (t, gx, gy) => {
      const g = window.__game.mode.game.allocGrenade();
      Object.assign(g, { alive: true, owner: -1, x: gx, y: gy, vx: 0, vy: 0, fuse: 2, type: t, state: 0 });
    },
    type,
    x,
    y,
  );
}

const shots = {
  /** smoke against the thin wall (3D): the Strafer pacing there vanishes in it */
  async 'smoke-3d'(page) {
    await open(page, '');
    await throwAt(page, 1, 162, 6);
    await simWait(page, 3);
  },
  /** gas on the dummies from beside the thin wall (3D): a sickly green-yellow haze, not cover */
  async 'gas-3d'(page) {
    await open(page, '');
    await page.evaluate(() => Object.assign(window.__game.mode.me, { x: 161.2, y: 0, vx: 0, vy: 0 }));
    await simWait(page, 0.5);
    await throwAt(page, 2, 167, 4);
    await simWait(page, 3);
  },
  /** a flashbang we look at, partway into its fade (after up to 2.5 s of full white) */
  async 'flash-3d'(page) {
    await open(page, '');
    await throwAt(page, 3, 158.5, 3);
    await midFade(page);
  },
  /** the same with "Reduce flashes": a dark grey vignette and a blur instead of white */
  async 'flash-reduced-3d'(page) {
    await open(page, '', true);
    await throwAt(page, 3, 158.5, 3);
    await midFade(page);
  },
  /** "Reduce flashes" during the full white-out phase: what the white is replaced with, at full strength */
  async 'flash-reduced-full-3d'(page) {
    await open(page, '', true);
    await throwAt(page, 3, 158.5, 3);
    await page.waitForFunction(() => window.__game.mode.me.blindTicks > window.__game.mode.me.blindFade + 20, { timeout: 60_000, polling: 20 });
    await delay(150);
  },
  /** a mine thrown back at the tower sticks to its face and arms: a flashing red light (3D) */
  async 'mine-3d'(page) {
    await open(page, '');
    await throwAt(page, 4, 140, 2.6);
    await page.waitForFunction(() => window.__game.mode.game.grenades.some((g) => g.alive && g.type === 4 && g.state === 2), { timeout: 60_000, polling: 20 });
    await simWait(page, 0.1);
  },
  /** the same in the 2D view: the armed mine's trigger radius */
  async 'mine-2d'(page) {
    await open(page, '&render=2d');
    await throwAt(page, 4, 140, 2.6);
    await page.waitForFunction(() => window.__game.mode.game.grenades.some((g) => g.alive && g.type === 4 && g.state === 2), { timeout: 60_000, polling: 20 });
    await simWait(page, 0.1);
  },
  /** an EMP at our feet: holding jet does nothing (2D view: the blue burst, the HUD and the status tag) */
  async 'emp-2d'(page) {
    await open(page, '&render=2d');
    await throwAt(page, 5, 155.5, -5);
    await page.waitForFunction(() => window.__game.mode.me.jetDisabledTicks > 0, { timeout: 60_000, polling: 20 });
    await page.keyboard.down('KeyW');
    await simWait(page, 0.3);
  },
  /** smoke popped right against the thin wall: it stops at the wall, as the sim bounds it (review) */
  async 'smoke-wall-3d'(page) {
    await open(page, '');
    await popAt(page, 1, 159.3, 0.15);
    await simWait(page, 2.5);
  },
  async 'smoke-wall-2d'(page) {
    await open(page, '&render=2d');
    await popAt(page, 1, 159.3, 0.15);
    await simWait(page, 2.5);
  },
  /** a flashbang going off 18 m away (too far to blind us): the 3D pop and its ring (review M7) */
  async 'flash-pop-3d'(page) {
    await open(page, '');
    await page.evaluate(() => Object.assign(window.__game.mode.me, { x: 130, y: 0, vx: 0, vy: 0 }));
    await lookAt(page, 148, 2.5);
    await popAt(page, 3, 148, 2.5);
    await page.waitForFunction(() => !window.__game.mode.game.grenades.some((g) => g.alive && g.type === 3), { timeout: 60_000, polling: 10 });
    await simWait(page, 0.03);
  },
  /** an EMP going off: the blue ring out to its 4 m (review M7) */
  async 'emp-ring-3d'(page) {
    await open(page, '');
    await page.evaluate(() => Object.assign(window.__game.mode.me, { x: 130, y: 0, vx: 0, vy: 0 }));
    await lookAt(page, 140, 2.5);
    await popAt(page, 5, 140, 2.5);
    await page.waitForFunction(() => !window.__game.mode.game.grenades.some((g) => g.alive && g.type === 5), { timeout: 60_000, polling: 10 });
    await simWait(page, 0.12);
  },
  /** grenade pairs turning up on the range's platforms (map pickups, owner's decision) */
  async 'pairs-3d'(page) {
    await open(page, '');
    await page.evaluate(() => Object.assign(window.__game.mode.me, { x: 131, y: 0, vx: 0, vy: 0 }));
    await page.waitForFunction(() => window.__game.mode.game.pickups.filter((k) => k.alive && k.def > 0).length >= 2, { timeout: 120_000, polling: 50 });
    await simWait(page, 0.3);
  },
  async 'pairs-2d'(page) {
    await open(page, '&render=2d');
    await page.evaluate(() => Object.assign(window.__game.mode.me, { x: 131, y: 0, vx: 0, vy: 0 }));
    await page.waitForFunction(() => window.__game.mode.game.pickups.filter((k) => k.alive && k.def > 0).length >= 2, { timeout: 120_000, polling: 50 });
    await simWait(page, 0.3);
  },
  /** both in the 2D view: the HUD shows the belt and "GAS: get out!" once we walk into it */
  async 'clouds-2d'(page) {
    await open(page, '&render=2d');
    await throwAt(page, 1, 162, 6);
    await simWait(page, 0.6);
    await page.evaluate(() => Object.assign(window.__game.mode.me, { x: 161.2, y: 0, vx: 0, vy: 0 }));
    await simWait(page, 0.5);
    await throwAt(page, 2, 167, 4);
    await simWait(page, 2.5);
    await page.evaluate(() => Object.assign(window.__game.mode.me, { x: 164.4, y: 0 }));
    await simWait(page, 0.6);
  },
};

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  for (const [name, run] of Object.entries(shots)) {
    if (only.size && !only.has(name)) continue;
    await run(page);
    if (process.env.DEBUG) console.log(name, await page.evaluate(() => ({ tick: window.__game.mode.game.tick, blind: window.__game.mode.me.blindTicks, fx: [...(document.getElementById('fx')?.children ?? [])].map((c) => c.style.opacity).join('/') })));
    await page.screenshot({ path: join(out, `${name}.png`) });
    await page.keyboard.up('KeyW'); // whatever a shot held
    console.log(`wrote ${name}.png`);
  }
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
