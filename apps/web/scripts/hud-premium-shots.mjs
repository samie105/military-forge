/**
 * The premium in-match moments (owner, 23 Oct 2026; the Pen board "IN-MATCH · premium HUD"), shot in
 * headless Chrome for the PR: the weapon swap (mid-draw, landing), guns and items on the ground (the
 * world tags, the compare card, the item card), the map event's sequence (warning, impact, active,
 * all-clear) with each kind's screen treatment, the kill confirm and the respawn card; on the desktop
 * (1920×1080, plus 1280×720) and as a landscape phone (812×375, touch, coarse pointer).
 *
 * It plays training (?bots=0: the range dummies, nobody shoots) and overrides the frame's values
 * through the dev hooks (window.__game, as hud-v2.mjs does). A moment in motion is shot frozen: the
 * HUD's updates are held and every running animation is paused at a set time (Web Animations), so
 * each shot is exactly that instant however slow the machine. Needs the dev server:
 *
 *   cd apps/web && pnpm exec vite --port 8231 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/hud-premium-shots.mjs http://127.0.0.1:8231 docs/screenshots/hud-premium [desktop|phone|all]
 *
 * Exits 1 on a page error, a console error or a missing #icon-* reference.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8231').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/hud-premium');
const what = process.argv[4] ?? 'all';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONTENT = fileURLToPath(new URL('../../../packages/content/src/index.ts', import.meta.url));
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'hud-premium-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});

/** The kinds and their content words (packages/content/src/maps/mechanics.ts EVENT_KINDS). */
const KINDS = {
  gravitySurge: ['GRAVITY SURGE', 'Everything is heavier: jets climb slowly'],
  lowGravity: ['LOW GRAVITY', 'Everything floats: long jumps, slow falls'],
  emp: ['EMP STORM', 'Jetpacks offline'],
  fog: ['FOG BANK', 'Bullets fall short'],
  gust: ['WIND GUSTS', 'Gusts throw fliers and grenades sideways'],
  flip: ['GRAVITY POCKET', 'Gravity flips inside the marked zone'],
};
const EVENT = (kind, phase, secondsLeft, progress, occurrence = 1) => {
  const [name, description] = KINDS[kind];
  return `(f) => ({ mapEvent: { id: 'ev-${kind}', kind: '${kind}', name: '${name}', description: '${description}', phase: '${phase}', secondsLeft: ${secondsLeft}, progress: ${progress}, color: 0, zones: [], occurrence: ${occurrence}, bulletRangeMul: 1 } })`;
};

async function open(page, phone) {
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|\/api\/|WebSocket/.test(m.text())) problems.push(`console error: ${m.text()}`);
  });
  const cdp = await page.createCDPSession();
  if (phone) {
    await page.emulate({ viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: PHONE_UA });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  } else await page.setViewport({ width: 1920, height: 1080 });
  await page.goto(`${base}/?app&time=600&bots=0`, { waitUntil: 'load' });
  if (phone) {
    await page.evaluate(() => {
      localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ mode: 'on' }));
      localStorage.setItem('mf.touch.drill.v1', 'done');
      // every first-time hint seen (touch/teach.ts), so none covers the HUD
      localStorage.setItem('mf.touch.hints.v1', JSON.stringify(['dash-swipe', 'grenade-types', 'swap-radial', 'take', 'shield-hold']));
      localStorage.removeItem('mf.touch.layout.v1');
    });
    await page.reload({ waitUntil: 'load' });
  }
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await sleep(1500);
  await page.click('button[type=submit]');
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Training")]', { timeout: 30_000 })).click();
  await page.waitForFunction(() => window.__game?.mode?.update, { timeout: 60_000 });
  await sleep(1500);
  await page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 60_000 });
  // the controls card (first training): close it however late it shows
  for (let i = 0; i < 12; i++) {
    const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
    if (got) {
      await got.click();
      break;
    }
    await sleep(500);
  }
  await sleep(600);
  await page.evaluate(async (content) => {
    window.__content = await import(/* @vite-ignore */ `/@fs${content}`);
    const c = window.__content;
    const mode = window.__game.mode;
    const update = mode.update.bind(mode);
    const t = c.createTuning();
    const gun = (id, extra = {}) => {
      const w = c.weapons.find((x) => x.id === id);
      return { def: w.index, mag: w.mag, reserve: w.reserve, reloadTicks: 0, ...extra };
    };
    window.__gun = gun;
    window.__crate = (id) => c.weaponPickup(c.weapons.find((x) => x.id === id).index).index;
    window.__pair = (gid) => c.pickups.find((p) => p.kind === 'grenades' && c.grenades[p.grenade]?.id === gid).index;
    window.__shieldItem = () => c.pickups.find((p) => p.kind === 'shield').index;
    window.__hudPatch = { me: {}, frame: null, hold: false, last: null };
    window.__hudBase = () => ({ alive: true, respawnTicks: 0, hp: 82, fuel: t.fuelMax * 0.7, fuelRegenDelay: 0, grenadeCounts: [3, 1, 1, 1, 0, 1], grenadeType: 0, dual: false, swapTicks: 0 });
    mode.update = (dt) => {
      if (window.__hudPatch.hold && window.__hudPatch.last) return window.__hudPatch.last;
      const f = update(dt);
      const me = f.players.find((p) => p.id === f.localId);
      if (me) Object.assign(me, window.__hudBase(me), typeof window.__hudPatch.me === 'function' ? window.__hudPatch.me(me) : window.__hudPatch.me);
      if (window.__hudPatch.frame) Object.assign(f, window.__hudPatch.frame(f, me));
      window.__hudPatch.last = f;
      return f;
    };
    const hud = window.__game.hud;
    hud.__live = hud.update.bind(hud);
  }, CONTENT);
  return cdp;
}

/** Values for the local player (an object, or the source of a function of it) and the frame (source of (f, me) => values). */
const patch = (page, me, frame = 'null') => page.evaluate(`window.__hudPatch.me = ${typeof me === 'string' ? me : JSON.stringify(me)}; window.__hudPatch.frame = ${frame};`);
/** sim events into the HUD, `me` and the dummies' ids filled in */
const events = (page, fn) =>
  page.evaluate(`(() => {
    const g = window.__game;
    const me = g.mode.localId;
    const others = g.mode.game.players.filter((p) => p && p.id !== me).map((p) => p.id);
    while (others.length < 3) others.push(others[0] ?? me);
    g.hud.onEvents((${fn})(me, others), me);
  })()`);
/** the guns in hand: Hammer .44 in slot 0, K-47 in slot 1 */
const LOADOUT = `(me) => ({ active: 0, weapons: [window.__gun('hammer44', { mag: 5, reserve: 28 }), window.__gun('k47', { mag: 30, reserve: 90 })] })`;

/**
 * The HUD now, frozen: its updates held, the world still, and (when `at` is given) every running
 * animation paused `at` ms in, so a moment in motion is shot at that instant.
 */
async function shot(page, dir, name, { settle = 700, at = null, clip } = {}) {
  await sleep(settle);
  await page.evaluate((at) => {
    window.__hudPatch.hold = true;
    window.__game.hud.update = () => {};
    if (at !== null) for (const a of document.getAnimations()) {
      a.pause();
      a.currentTime = at;
    }
  }, at);
  await sleep(250);
  await page.screenshot({ path: join(dir, `${name}.png`), ...(clip ? { clip } : {}) });
  await iconsResolve(page, name);
  await page.evaluate(() => {
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
    window.__game.hud.update = window.__game.hud.__live;
    window.__hudPatch.hold = false;
  });
  console.log(`wrote ${name}.png`);
}

/**
 * A frame strip of a moment (docs/design/ui-motion-spec.md §5): `start()` triggers it, then the HUD is
 * held and every animation paused and stepped 16 ms at a time; frames/<name>-NN.png, stitched into
 * strip-<name>.webp by phone-strips.py.
 */
async function strip(page, dir, name, start, { count = 24, clip } = {}) {
  mkdirSync(join(dir, 'frames'), { recursive: true });
  await start();
  await page.evaluate(() => {
    window.__hudPatch.hold = true;
    window.__game.hud.update = () => {};
    for (const a of document.getAnimations()) a.pause();
  });
  for (let i = 0; i < count; i++) {
    await page.evaluate((t) => {
      for (const a of document.getAnimations()) a.currentTime = t;
    }, i * 16);
    await page.screenshot({ path: join(dir, 'frames', `${name}-${String(i).padStart(2, '0')}.png`), ...(clip ? { clip } : {}) });
  }
  await page.evaluate(() => {
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
    window.__game.hud.update = window.__game.hud.__live;
    window.__hudPatch.hold = false;
  });
  console.log(`strip ${name}: ${count} frames`);
}

/** Every <use href="#icon-…"> on the page points at a symbol that exists. */
async function iconsResolve(page, where) {
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('#hud use, .mf-touch use')]
      .map((u) => u.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('#') && !document.getElementById(h.slice(1)))
      .filter((h, i, a) => a.indexOf(h) === i),
  );
  for (const h of missing) problems.push(`${where}: missing ${h}`);
}

/** Runs the moments on one page (desktop or phone). */
async function moments(page, dir, phone) {
  mkdirSync(dir, { recursive: true });
  const p = phone ? 'm-' : '';
  const loadout = LOADOUT;
  // the swap, mid-draw: slot 1 (the K-47) comes out over its equip time; frozen 45 % in
  await patch(page, loadout);
  await sleep(600);
  await patch(page, `(me) => Object.assign((${loadout})(me), { active: 1, swapTicks: 21 })`);
  await sleep(50);
  // the equip clock half run (the sim counts swapTicks down; the bar and ring fill from it)
  await patch(page, `(me) => Object.assign((${loadout})(me), { active: 1, swapTicks: 11 })`);
  await sleep(150);
  await shot(page, dir, `${p}01-swap-mid-draw`, { settle: 0, at: 170 });
  // the landing: the draw just ended (the name and class stamp, the edge flashes), the cue names the swap-back key
  await sleep(800); // the cards' trade has finished
  await patch(page, `(me) => Object.assign((${loadout})(me), { active: 1, swapTicks: 0 })`);
  await sleep(60);
  await shot(page, dir, `${p}02-swap-landed`, { settle: 0, at: 90 });
  await sleep(1500);

  // guns and items on the ground: tags near and far, a power weapon, a grenade pair, the shield
  const ground = `(f, me) => ({ pickups: [
    { id: 901, def: window.__crate('widow'), x: me.x + 5, y: me.y },
    { id: 902, def: window.__crate('breacher'), x: me.x - 11, y: me.y },
    { id: 903, def: window.__pair('frag'), x: me.x + 12, y: me.y },
    { id: 904, def: window.__crate('hawk50'), x: me.x - 24, y: me.y },
    { id: 905, def: window.__shieldItem(), x: me.x + 20, y: me.y },
  ] })`;
  await patch(page, loadout, ground);
  await shot(page, dir, `${p}03-ground-tags`, { settle: 900 });
  // standing on a crate: the compare card (desktop), the compare chip over Take (phone)
  const onCrate = `(f, me) => ({ pickups: [{ id: 910, def: window.__crate('k47'), x: me.x, y: me.y }, { id: 911, def: window.__crate('widow'), x: me.x + 7, y: me.y }, { id: 912, def: window.__pair('smoke'), x: me.x - 9, y: me.y }] })`;
  await patch(page, `(me) => ({ active: 0, weapons: [window.__gun('hammer44', { mag: 5, reserve: 28 }), window.__gun('buzz')] })`, onCrate);
  await shot(page, dir, `${p}04-compare-card`, { settle: 900 });
  const onPower = `(f, me) => ({ pickups: [{ id: 913, def: window.__crate('thumper'), x: me.x, y: me.y }] })`;
  await patch(page, loadout, onPower);
  await shot(page, dir, `${p}05-compare-card-power`, { settle: 900 });
  // a grenade pair a step away: the item card
  const nearPair = `(f, me) => ({ pickups: [{ id: 914, def: window.__pair('frag'), x: me.x + 1.4, y: me.y }] })`;
  await patch(page, loadout, nearPair);
  await shot(page, dir, `${p}06-item-card-grenades`, { settle: 900 });
  await patch(page, loadout);
  await sleep(500);

  // the map event: warning (3 s to go), impact, active, all-clear
  await patch(page, loadout, EVENT('gravitySurge', 'warning', 2.6, 0.35));
  await shot(page, dir, `${p}07-event-warning`, { settle: 900 });
  await patch(page, loadout, EVENT('gravitySurge', 'active', 14.9, 0.005));
  await sleep(40);
  await shot(page, dir, `${p}08-event-impact`, { settle: 0, at: 220 });
  await sleep(1200);
  await patch(page, loadout, EVENT('gravitySurge', 'active', 9.4, 0.38));
  await shot(page, dir, `${p}09-event-active-surge`, { settle: 900, at: 350 });
  await patch(page, loadout);
  await sleep(40);
  await shot(page, dir, `${p}10-event-end`, { settle: 0, at: 300 });
  await sleep(2200);
  // each kind's treatment, running
  let n = 2;
  for (const kind of ['lowGravity', 'emp', 'fog', 'gust', 'flip']) {
    await patch(page, loadout, EVENT(kind, 'warning', 1.2, 0.8, n));
    await sleep(500);
    await patch(page, loadout, EVENT(kind, 'active', 8.6, 0.42, n));
    await shot(page, dir, `${p}11-treatment-${kind}`, { settle: 1300, at: 300 });
    await patch(page, loadout);
    await sleep(2300);
    n += 1;
  }

  // a kill confirmed, with a headshot and a streak
  await patch(page, loadout);
  await events(page, `(me, [a, b]) => [{ type: 'death', victim: b, killer: me, source: 0 }, { type: 'hit', attacker: me, target: a, damage: 90, zone: 1, source: 0 }, { type: 'death', victim: a, killer: me, source: 0 }]`);
  await shot(page, dir, `${p}12-kill-confirm-streak`, { settle: 120, at: 300 });
  await sleep(1800);
  // dead: the respawn card
  await patch(page, `(me) => Object.assign((${loadout})(me), { alive: false, respawnTicks: 130, hp: 0 })`);
  await events(page, `(me, [a]) => [{ type: 'death', victim: me, killer: a, source: 2 }]`);
  await shot(page, dir, `${p}13-respawn`, { settle: 700 });
  await patch(page, loadout);
  await sleep(600);

  // Reduce motion + Reduce flashes: the same moments, still
  await page.evaluate(() => document.documentElement.classList.add('reduce-motion', 'reduce-flashes'));
  await patch(page, loadout, EVENT('emp', 'active', 6.2, 0.3, 20));
  await shot(page, dir, `${p}14-reduced-emp-active`, { settle: 900 });
  await patch(page, loadout);
  await page.evaluate(() => document.documentElement.classList.remove('reduce-motion', 'reduce-flashes'));
  await sleep(2200);
  // text at 150 %
  await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1.5'));
  await patch(page, `(me) => ({ active: 0, weapons: [window.__gun('hammer44', { mag: 5, reserve: 28 }), window.__gun('buzz')] })`, onCrate);
  await shot(page, dir, `${p}15-text150-compare`, { settle: 900 });
  await patch(page, loadout, EVENT('gravitySurge', 'warning', 2.6, 0.35, 30));
  await shot(page, dir, `${p}16-text150-warning`, { settle: 900 });
  await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
  await patch(page, loadout);
  await sleep(2200);

  // the spectator bar's visuals (spectating comes with netcode: nothing shows it yet), forced on for the shot
  if (!phone) {
    await page.evaluate(() => {
      const bar = document.querySelector('#hud .mf-spec');
      bar.removeAttribute('hidden');
      bar.querySelector('.display').textContent = 'Kemi';
    });
    await shot(page, dir, '19-spectator-bar-visuals', { settle: 400 });
    await page.evaluate(() => document.querySelector('#hud .mf-spec').setAttribute('hidden', ''));
  }

  // frame strips: the swap (the cards trade, the ghosts stream), the impact
  const swapClip = phone ? undefined : { x: 1100, y: 620, width: 820, height: 460 };
  await patch(page, loadout);
  await sleep(700);
  await strip(page, dir, `${p}swap`, async () => {
    await patch(page, `(me) => Object.assign((${loadout})(me), { active: 1, swapTicks: 21 })`);
    await sleep(60);
  }, { count: 24, clip: swapClip });
  await patch(page, loadout);
  await sleep(1200);
  await patch(page, loadout, EVENT('gravitySurge', 'warning', 1.2, 0.8, 50));
  await sleep(700);
  await strip(page, dir, `${p}event-impact`, async () => {
    await patch(page, loadout, EVENT('gravitySurge', 'active', 14.9, 0.005, 50));
    await sleep(40);
  }, { count: 30, clip: phone ? undefined : { x: 360, y: 100, width: 1200, height: 520 } });
  await patch(page, loadout);
}

try {
  if (what === 'all' || what === 'desktop') {
    const page = await browser.newPage();
    await open(page, false);
    await moments(page, join(out, 'desktop'), false);
    // the laptop box: 1280×720
    await page.setViewport({ width: 1280, height: 720 });
    await sleep(800);
    await patch(page, `(me) => ({ active: 0, weapons: [window.__gun('hammer44', { mag: 5, reserve: 28 }), window.__gun('buzz')] })`, `(f, me) => ({ pickups: [{ id: 910, def: window.__crate('k47'), x: me.x, y: me.y }, { id: 911, def: window.__crate('widow'), x: me.x + 7, y: me.y }] })`);
    await shot(page, join(out, 'desktop'), '17-1280x720-compare', { settle: 900 });
    await patch(page, LOADOUT, EVENT('fog', 'active', 12, 0.3, 40));
    await shot(page, join(out, 'desktop'), '18-1280x720-fog-active', { settle: 1300, at: 300 });
    await page.close();
  }
  if (what === 'all' || what === 'phone') {
    const page = await browser.newPage();
    await open(page, true);
    await page.waitForSelector('.mf-touch:not([hidden])', { timeout: 30_000 });
    await moments(page, join(out, 'phone'), true);
    await page.close();
  }
} finally {
  await browser.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
