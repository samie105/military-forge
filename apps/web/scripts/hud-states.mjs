/**
 * Headless-Chrome screenshots of the HUD in the states the UI brief lists (throwaway profile): normal,
 * low health with the shield up, a reload and the dash recharging, an EMP with the map event, an event
 * warning with a pickup close by, and the grenade belt with blindness and gas (the arsenal-b fields,
 * shown ahead of their merge). It plays training in the app and overrides the frame's values through
 * the dev hook, so it needs the dev server:
 *
 *   cd apps/web && pnpm exec vite --port 5191 --strictPort       (with the API on DEV_API for the name)
 *   node apps/web/scripts/hud-states.mjs [http://127.0.0.1:5191] [out dir]
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:5191';
const out = resolve(process.argv[3] ?? 'docs/screenshots/ui-playtest/hud-states');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'hud-states-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
const shot = async (name) => {
  await sleep(400);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};

try {
  await page.goto(`${base}/?app`, { waitUntil: 'load' });
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await sleep(700);
  await page.click('button[type=submit]');
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Training")]', { timeout: 30_000 })).click();
  await page.waitForFunction(() => window.__game?.mode?.update, { timeout: 30_000 });
  await page.evaluate(() => {
    // the frame's values for each state, applied after every update
    const mode = window.__game.mode;
    const update = mode.update.bind(mode);
    window.__hudPatch = { me: {}, frame: null };
    mode.update = (dt) => {
      const f = update(dt);
      const me = f.players.find((p) => p.id === f.localId);
      if (me) Object.assign(me, typeof window.__hudPatch.me === 'function' ? window.__hudPatch.me(me) : window.__hudPatch.me);
      if (window.__hudPatch.frame) Object.assign(f, window.__hudPatch.frame(f, me));
      return f;
    };
  });
  await page.mouse.move(900, 380);
  await shot('30-normal');

  await page.evaluate(() => {
    window.__hudPatch.me = (me) => ({
      hp: 24,
      shield: 'front',
      shieldHp: 220,
      dashCooldown: 36,
      weapons: me.weapons.map((w, i) => (i === me.active ? { ...w, mag: 0, reloadTicks: 45 } : w)),
    });
  });
  await shot('31-low-hp-shield-up-reloading-dash-recharging');

  const emp = (phase, secondsLeft) => ({
    id: 'solar-flare',
    kind: 'emp',
    name: 'SOLAR FLARE',
    description: 'Jetpacks offline: the low gravity is all you have',
    phase,
    secondsLeft,
    progress: 0.4,
    color: 0xb48cff,
    zones: [],
    occurrence: phase === 'warning' ? 1 : 2,
    bulletRangeMul: 1,
  });
  await page.evaluate((event) => {
    window.__hudPatch.me = { jetDisabled: true, fuel: 62 };
    window.__hudPatch.frame = () => ({ mapEvent: event });
  }, emp('active', 5.2));
  await shot('32-emp-map-event');

  await page.evaluate((event) => {
    window.__hudPatch.me = { shield: 'back', shieldHp: 300 };
    window.__hudPatch.frame = (f, me) => ({ mapEvent: event, pickups: [{ id: 9, def: 0, x: me.x + 1.6, y: me.y }] });
  }, emp('warning', 3));
  await shot('33-event-warning-pickup-shield-slung');

  await page.evaluate(() => {
    window.__hudPatch.me = { grenadeCounts: [3, 2, 0, 1, 2, 1], grenadeType: 3, blind: 0.7, gasTicks: 40 };
    window.__hudPatch.frame = null;
  });
  await shot('34-grenade-belt-blind-gas');
} finally {
  await browser.close();
}
