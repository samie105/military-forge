/**
 * Headless-Chrome screenshots of the HUD in the states the UI brief and the design kit list
 * (throwaway profile, 1920×1080): normal, low health, reloading with the dash recharging, the shield
 * up, an EMP grenade with a map event, an event warning with a pickup and the shield slung, gas,
 * Reduce flashes, the grenade belt with low ammo, dead (the respawn card), and the hit and kill
 * markers with the kill feed. It plays training in the app and overrides the frame's values through
 * the dev hook, so it needs the dev server:
 *
 *   cd apps/web && DEV_API=http://127.0.0.1:8791 pnpm exec vite --port 5191 --strictPort   (the API for the name)
 *   node apps/web/scripts/hud-states.mjs [http://127.0.0.1:5191] [out dir]
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5191').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/ui-design/after/hud-states');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'hud-states-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1920, height: 1080 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
const shot = async (name) => {
  await sleep(700);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};
/**
 * Values for the local player (an object, or a function of the player) and for the frame (the source
 * of a function (frame, me) => values, or 'null'), applied after every update.
 */
const patch = (me, frame = 'null') => page.evaluate(`window.__hudPatch.me = ${typeof me === 'function' ? me.toString() : JSON.stringify(me)}; window.__hudPatch.frame = ${frame};`);

try {
  await page.goto(`${base}/?app&time=600`, { waitUntil: 'load' });
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await sleep(1200);
  await page.click('button[type=submit]');
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Training")]', { timeout: 30_000 })).click();
  await page.waitForFunction(() => window.__game?.mode?.update, { timeout: 30_000 });
  await sleep(1500);
  const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
  if (got) await got.click();
  await sleep(5000); // past the countdown
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
  await page.mouse.move(1300, 420);
  await shot('40-normal');

  await patch({ hp: 24 });
  await shot('41-low-hp');

  await patch((me) => ({ dashCooldown: 30, weapons: me.weapons.map((w, i) => (i === me.active ? { ...w, mag: 0, reloadTicks: 45 } : w)) }));
  await shot('42-reloading-dash-cooldown');

  await patch({ shield: 'front', shieldHp: 212 });
  await shot('43-shield-up');

  const flare = (phase, secondsLeft) =>
    `{ id: 'solar-flare', kind: 'emp', name: 'SOLAR FLARE', description: 'Jetpacks offline: the low gravity is all you have', phase: '${phase}', secondsLeft: ${secondsLeft}, progress: 0.45, color: 0xf4d84a, zones: [], occurrence: ${phase === 'warning' ? 1 : 2}, bulletRangeMul: 1 }`;
  await patch({ jetDisabledTicks: 150, fuel: 58 }, `() => ({ mapEvent: ${flare('active', 5.2)} })`);
  await shot('44-emp-grenade-map-event');

  await patch({ shield: 'back', shieldHp: 300 }, `(f, me) => ({ mapEvent: ${flare('warning', 3)}, pickups: [{ id: 9, def: 0, x: me.x + 1.6, y: me.y }] })`);
  await shot('45-event-warning-pickup-shield-slung');

  await patch({ gasTicks: 40, hp: 57 });
  await shot('46-gas');

  await page.evaluate(() => window.__game.shell.controller.updateSettings({ reduceFlashes: true }));
  await patch({ blind: 0.95 });
  await shot('47-flashbang-reduce-flashes');
  await page.evaluate(() => window.__game.shell.controller.updateSettings({ reduceFlashes: false }));

  await patch((me) => ({ grenadeCounts: [3, 2, 0, 1, 2, 1], grenadeType: 3, weapons: me.weapons.map((w, i) => (i === me.active ? { ...w, mag: 1 } : w)) }));
  await shot('48-grenade-belt-low-ammo');

  // the kill feed, the hit and kill markers: events as the sim reports them
  await patch({});
  await page.evaluate(() => {
    const g = window.__game;
    const me = g.mode.localId;
    const bots = g.mode.game.players.filter((p) => p && p.id !== me).map((p) => p.id);
    const [x, y = x, z = y] = bots;
    g.hud.onEvents(
      [
        { type: 'hit', attacker: x, target: y, damage: 30, zone: 0, source: 1 },
        { type: 'death', victim: y, killer: x, source: 1 },
        { type: 'death', victim: z, killer: z, source: 62 },
        { type: 'hit', attacker: me, target: x, damage: 90, zone: 0, source: 0 },
        { type: 'death', victim: x, killer: me, source: 0 },
      ],
      me,
    );
  });
  await sleep(150);
  await page.screenshot({ path: join(out, '49-kill-feed-markers.png') });
  console.log('wrote 49-kill-feed-markers.png');

  await page.evaluate(() => {
    const g = window.__game;
    const me = g.mode.localId;
    const killer = g.mode.game.players.find((p) => p && p.id !== me)?.id ?? -1;
    g.hud.onEvents([{ type: 'death', victim: me, killer, source: 4 }], me);
  });
  await patch({ alive: false, respawnTicks: 120 });
  await shot('50-dead-respawn');
} finally {
  await browser.close();
}
