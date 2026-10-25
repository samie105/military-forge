/**
 * The phone HUD (thumb dials) in headless Chrome as a landscape phone (812×375, touch, a coarse
 * pointer): the round-two kit's states (idle, grenade-aim, near-crate, swap, low-hp), the layout
 * editor, 150 % text, Reduce motion and Reduce flashes, and frame strips of its transitions (the
 * animations slowed 10× through CDP, a shot every 160 ms = one every 16 ms of animation time),
 * stitched into WebP strips by phone-strips.py. It plays training and overrides the frame's values
 * through the same dev hook as hud-states.mjs, so it needs the dev server:
 *
 *   cd apps/web && pnpm exec vite --port 5220 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/phone-hud-shots.mjs http://127.0.0.1:5220 docs/screenshots/phone-ui
 *
 * Exits 1 on a page error, a console error or a missing #icon-* reference.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5220').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/phone-ui');
const only = process.argv[4] ?? '';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONTENT = fileURLToPath(new URL('../../../packages/content/src/index.ts', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(join(out, 'frames'), { recursive: true });

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const problems = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'phone-hud-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  // the API isn't running in this check: its fetches fail by design (the name check, the server ping)
  if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|\/api\//.test(m.text())) problems.push(`console error: ${m.text()}`);
});
const cdp = await page.createCDPSession();
await page.emulate({ viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: PHONE_UA });
await cdp.send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'pointer', value: 'coarse' },
    { name: 'any-pointer', value: 'coarse' },
    { name: 'hover', value: 'none' },
  ],
});
await cdp.send('Animation.enable');

const shot = async (name, settle = 500) => {
  await sleep(settle);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};
/**
 * Values for the local player (an object, or the source of a function of it) and for the frame, applied
 * after every update, over the kit's sample (alive, HP 82, fuel 64 %: its m-hud values) so shots compare.
 */
const patch = (me, frame = 'null') => page.evaluate(`window.__hudPatch.me = ${typeof me === 'function' ? me.toString() : JSON.stringify(me)}; window.__hudPatch.frame = ${frame};`);
const centre = (sel) =>
  page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ id: p.id ?? i, x: p.x, y: p.y, radiusX: 10, radiusY: 10, force: 1 })) });
const tap = async (sel, hold = 60) => {
  const c = await centre(sel);
  await touch('touchStart', [c]);
  await sleep(hold);
  await touch('touchEnd', []);
};

/**
 * A frame strip of a transition: animations slowed 10×, `start()` kicks it off, then `count` shots
 * 160 ms apart (16 ms of animation time each), cropped to `clip` (CSS px), into frames/<name>-NN.png.
 */
async function strip(name, start, clip, count = 22) {
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
  await start();
  for (let i = 0; i < count; i++) {
    const t = Date.now();
    await page.screenshot({ path: join(out, 'frames', `${name}-${String(i).padStart(2, '0')}.png`), clip });
    await sleep(Math.max(0, 160 - (Date.now() - t)));
  }
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  console.log(`strip ${name}: ${count} frames`);
}

/** Every <use href="#icon-…"> on the page points at a symbol that exists. */
async function iconsResolve(where) {
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('use')]
      .map((u) => u.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('#') && !document.getElementById(h.slice(1)))
      .filter((h, i, a) => a.indexOf(h) === i),
  );
  for (const h of missing) problems.push(`${where}: missing ${h || '(empty href)'}`);
}

try {
  await page.goto(`${base}/?app&time=600`, { waitUntil: 'load' });
  await page.evaluate(() => {
    localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ mode: 'on' }));
    // the drill (Learn the controls) has its own check: phone-gestures-shots.mjs
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.removeItem('mf.touch.layout.v1');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await sleep(1500);
  await page.click('button[type=submit]');
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Training")]', { timeout: 30_000 })).click();
  await page.waitForFunction(() => window.__game?.mode?.update && document.querySelector('.mf-touch:not([hidden])'), { timeout: 60_000 });
  await sleep(1500);
  const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
  if (got) await got.click();
  await sleep(7000); // past the countdown
  await page.evaluate(async (content) => {
    window.__content = await import(/* @vite-ignore */ `/@fs${content}`);
    const mode = window.__game.mode;
    const update = mode.update.bind(mode);
    window.__hudPatch = { me: {}, frame: null };
    const t = window.__content.createTuning();
    window.__hudBase = () => ({ alive: true, respawnTicks: 0, hp: 82, fuel: t.fuelMax * 0.64, fuelRegenDelay: 0 });
    mode.update = (dt) => {
      const f = update(dt);
      const me = f.players.find((p) => p.id === f.localId);
      if (me) Object.assign(me, window.__hudBase(me), typeof window.__hudPatch.me === 'function' ? window.__hudPatch.me(me) : window.__hudPatch.me);
      if (window.__hudPatch.frame) Object.assign(f, window.__hudPatch.frame(f, me));
      return f;
    };
  }, CONTENT);
  const crate = `(f, me) => { const c = window.__content; const w = c.weapons.find((x) => x.id === 'dragon'); return { pickups: [...(f.pickups ?? []), { id: 900, def: c.weaponPickup(w.index).index, x: me.x, y: me.y }] }; }`;
  const swapTo = `(me) => { const c = window.__content; const d = c.weapons.find((x) => x.id === 'dragon'); return { active: 1, dual: false, weapons: [me.weapons[0], { def: d.index, mag: d.mag, reserve: d.reserve, reloadTicks: 0 }] }; }`;
  const aim = await centre('.mf-ctl-aim');
  const move = await centre('.mf-ctl-move');
  const run = (name) => !only || only.split(',').includes(name);

  if (run('states')) {
    // the kit's states: idle, low-hp, grenade-aim, near-crate, swap
    await touch('touchStart', [{ x: aim.x + 40, y: aim.y - 26 }]); // aim up-right a little: the reticle shows
    await sleep(120);
    await touch('touchEnd', []);
    await shot('m1-idle', 900);
    await iconsResolve('idle');

    await patch({ hp: 22 });
    await shot('m1e-low-hp', 1200);
    await patch({});

    const g = await centre('.mf-ctl-grenade');
    await touch('touchStart', [{ id: 1, x: g.x, y: g.y }]);
    await sleep(400);
    await touch('touchMove', [{ id: 1, x: g.x, y: g.y }, { id: 2, x: aim.x + 30, y: aim.y - 30 }]);
    await sleep(80);
    await touch('touchMove', [{ id: 1, x: g.x, y: g.y }, { id: 2, x: aim.x + 52, y: aim.y - 40 }]);
    await shot('m1b-grenade-aim', 500);
    await touch('touchCancel', []); // no throw
    await sleep(300);

    await patch({}, crate);
    await shot('m1c-near-crate', 900);
    await iconsResolve('near-crate');
    await patch({});
    await sleep(600);

    // a swap to the Dragon (0.5 s to equip): the pill's border, the equip ring, the guns crossing
    await patch({ active: 0 });
    await sleep(400);
    await page.evaluate(`window.__hudPatch.me = ${swapTo}`);
    await shot('m1d-swap', 150);
    await patch({});
    await sleep(1200);

    // the menu, text at 150 %, Reduce motion + Reduce flashes
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1.5'));
    await patch({ hp: 22 });
    await shot('m1-text150-low-hp', 900);
    // the owner's admin page tag (shown by the HUD's admin token on a tuned server): under the ping
    await page.evaluate(() => document.querySelector('#hud .phud-admin')?.removeAttribute('hidden'));
    await patch({});
    await shot('m1-text150-admin', 900);
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
    await shot('m1-admin', 500);
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1.5'));
    await patch({}, crate);
    await shot('m1-text150-near-crate', 900);
    await patch({});
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
    await page.evaluate(() => document.documentElement.classList.add('reduce-motion', 'reduce-flashes'));
    await patch({ hp: 22 }, crate);
    await shot('m1-reduced-low-hp-crate', 900);
    await patch({});
    await page.evaluate(() => document.documentElement.classList.remove('reduce-motion', 'reduce-flashes'));
    await sleep(600);
  }

  if (run('strips')) {
    // the take button grows in at its place near a crate, and shrinks away out of reach
    const takeClip = { x: 250, y: 280, width: 312, height: 90 };
    await strip('take-in', () => patch({}, crate), takeClip, 18);
    await sleep(800);
    await strip('take-out', () => patch({}), takeClip, 12);
    await sleep(600);

    // the move dial comes to the thumb, then springs and glides home on the settle
    const dialClip = { x: 30, y: 60, width: 340, height: 315 };
    await touch('touchStart', [{ id: 3, x: move.x + 70, y: move.y - 60 }]);
    await touch('touchMove', [{ id: 3, x: move.x + 120, y: move.y - 90 }]);
    await sleep(300);
    await strip('stick-home', () => touch('touchEnd', []), dialClip, 22);
    await sleep(600);

    // the swap pill: the two guns cross over the Dragon's 0.5 s equip
    const pillClip = await page.$eval('.mf-ctl-swap', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - 20, y: Math.max(0, r.top - 14), width: r.width + 40, height: r.height + 28 };
    });
    await patch({ active: 0 });
    await sleep(500);
    await strip('swap-cross', () => page.evaluate(`window.__hudPatch.me = ${swapTo}`), pillClip, 34);
    await patch({});
    await sleep(800);

    // the dash ring refills with the fuel and ticks when a dash is affordable again (v14: no cooldown)
    const dashClip = await page.$eval('.mf-ctl-dash', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - 20, y: r.top - 20, width: r.width + 40, height: r.height + 40 };
    });
    await patch(() => ({ fuel: Math.min(20, (window.__dashFuel = (window.__dashFuel ?? 4) + 2)) }));
    await strip('dash-ready', async () => {}, dashClip, 22);
    await patch({});
    await sleep(500);

    // a tap on the grenade: the quick stamp
    const gClip = await page.$eval('.mf-ctl-grenade', (el) => {
      const r = el.getBoundingClientRect();
      return { x: r.left - 40, y: r.top - 50, width: r.width + 80, height: r.height + 70 };
    });
    await strip('grenade-quick', () => tap('.mf-ctl-grenade', 40), gClip, 18);
    await sleep(800);

    // the dials draw in at the start of a match (the controls coming up mid-match does the same)
    await page.evaluate(() => document.querySelector('.mf-touch')?.animate([{ '--dial-in': '0' }, { '--dial-in': '1' }], { duration: 360, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }));
    await strip('dials-in', async () => {}, dialClip, 26);
    await sleep(500);

    // the editor: a control lifts under the finger, snaps to a guide, settles on drop
    await page.evaluate(() => window.__touch.openTouchEditor());
    await sleep(600);
    await shot('m1-editor', 300);
    const r = await centre('.mf-ctl-dash');
    await touch('touchStart', [{ id: 4, x: r.x, y: r.y }]);
    for (let i = 1; i <= 6; i++) {
      await touch('touchMove', [{ id: 4, x: r.x - 10 * i, y: r.y + 4 * i }]);
      await sleep(30);
    }
    await shot('m1-editor-drag', 300);
    await strip('editor-drop', () => touch('touchEnd', []), { x: r.x - 120, y: r.y - 60, width: 180, height: 150 }, 18);
    // pinch: a second finger on the screen while one holds a control resizes it
    await page.evaluate(() => window.__touch.resetTouchLayout());
    await sleep(300);
    const sizeOf = () => page.$eval('.mf-ctl-grenade', (el) => el.getBoundingClientRect().width);
    const before = await sizeOf();
    const d = await centre('.mf-ctl-grenade');
    await touch('touchStart', [{ id: 5, x: d.x, y: d.y }]);
    await touch('touchStart', [{ id: 5, x: d.x, y: d.y }, { id: 6, x: d.x - 70, y: d.y - 30 }]);
    for (let i = 1; i <= 5; i++) {
      await touch('touchMove', [{ id: 5, x: d.x, y: d.y }, { id: 6, x: d.x - 70 - 18 * i, y: d.y - 30 - 8 * i }]);
      await sleep(30);
    }
    await shot('m1-editor-pinch', 200);
    await touch('touchEnd', []);
    const after = await sizeOf();
    if (!(after > before * 1.3)) problems.push(`pinch didn't resize the melee button (${before.toFixed(0)} → ${after.toFixed(0)} px)`);
    else console.log(`pinch: melee ${before.toFixed(0)} → ${after.toFixed(0)} px`);
    await page.evaluate(() => window.__touch.resetTouchLayout());
    await page.$eval('[data-bay="save"]', (b) => b.click());
    await sleep(400);
  }
  await iconsResolve('end');
} finally {
  await browser.close();
}
for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
