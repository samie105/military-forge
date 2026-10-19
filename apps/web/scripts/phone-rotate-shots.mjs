/**
 * Phones always play in landscape (ui/landscape.ts), checked in headless Chrome as an upright phone
 * (375×812, touch, a coarse pointer) where the landscape lock is refused (as on iPhone Safari): the
 * page turns onto its side. Then the same phone held sideways (812×375), where nothing turns.
 *
 * It checks, and exits 1 on a failure, a page error, a console error or a missing #icon-*:
 *   - the first tap asks for full screen, then for the landscape lock (both refused here);
 *   - the page fills the portrait screen turned, laid out at 812×375 (html.mf-rotated);
 *   - taps land on the buttons they show (name entry, Home, Settings, Training, the pause menu);
 *   - a slider follows a finger along the page's axis (down the glass);
 *   - the dials: a push towards the page's right moves right, towards its top jets, and the aim dial
 *     reads the same way; the move dial floats to a thumb on the page's left half;
 *   - the layout editor: a drag moves a control the page's way, a pinch resizes it;
 *   - held sideways the page is untouched and the dials read as before.
 * Shots (portrait, as the phone shows them, and turned upright next to the 812×375 ones) go to `out`.
 *
 *   cd apps/web && pnpm exec vite --port 5220 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/phone-rotate-shots.mjs http://localhost:5220 docs/screenshots/phone-ui/rotated
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5220').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/phone-ui/rotated');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const problems = [];
const check = (ok, what) => {
  if (ok) console.log(`ok: ${what}`);
  else problems.push(what);
};
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'phone-rotate-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  // no API in this check: its fetches fail by design (the name check, the server ping)
  if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|\/api\//.test(m.text())) {
    problems.push(`console error: ${m.text()}`);
    console.log(`(console error: ${m.text().slice(0, 60)})`);
  }
});
const cdp = await page.createCDPSession();
const phone = async (portrait) => {
  await page.emulate({
    viewport: portrait ? { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false } : { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
    userAgent: UA,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'pointer', value: 'coarse' },
      { name: 'any-pointer', value: 'coarse' },
      { name: 'hover', value: 'none' },
    ],
  });
};
await phone(true);
// iPhone Safari's case: full screen and the lock are refused (and counted, to check they were asked for)
await page.evaluateOnNewDocument(() => {
  window.__asked = [];
  Element.prototype.requestFullscreen = () => {
    window.__asked.push('fullscreen');
    return Promise.reject(new Error('not allowed'));
  };
  if (screen.orientation) screen.orientation.lock = (o) => (window.__asked.push(`lock ${o}`), Promise.reject(new Error('NotSupportedError')));
});

const shot = async (name, settle = 600) => {
  await sleep(settle);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};
/** An element's centre on the screen (where a finger goes). */
const centre = (sel) =>
  page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ id: p.id ?? i, x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1 })) });
const tapAt = async (c, hold = 60) => {
  await touch('touchStart', [c]);
  await sleep(hold);
  await touch('touchEnd', []);
};
/** A tap on what's drawn at `sel`'s centre: it must be that element (hit-testing through the turn). */
const tap = async (sel, what = sel) => {
  const c = await centre(sel);
  const hit = await page.evaluate((x, y, s) => document.elementFromPoint(x, y)?.closest(s) !== null && document.elementFromPoint(x, y)?.closest(s) !== undefined, c.x, c.y, sel);
  check(hit, `a finger on ${what} lands on it`);
  await tapAt(c);
};
/** A page point (the turned page's own coordinates) on the screen. */
const toScreen = (p) => page.evaluate((x, y) => (document.documentElement.classList.contains('mf-rotated') ? { x: innerWidth - y, y: x } : { x, y }), p.x, p.y);
/** A finger dragged by (dx, dy) in the page's axes from a screen point. */
const drag = async (from, dx, dy, steps = 6, id = 7, release = true) => {
  const rotated = await page.evaluate(() => document.documentElement.classList.contains('mf-rotated'));
  const s = rotated ? { x: -dy, y: dx } : { x: dx, y: dy };
  await touch('touchStart', [{ id, ...from }]);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ id, x: from.x + (s.x * i) / steps, y: from.y + (s.y * i) / steps }]);
    await sleep(25);
  }
  if (release) await touch('touchEnd', []);
};
const sticks = () => page.evaluate(() => window.__touch.sticks());
async function iconsResolve(where) {
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('use')]
      .map((u) => u.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('#') && !document.getElementById(h.slice(1)))
      .filter((h, i, a) => a.indexOf(h) === i),
  );
  for (const h of missing) problems.push(`${where}: missing ${h || '(empty href)'}`);
}

/** The dials read the page's way: right is right, the page's top jets (and the aim dial the same). */
async function dials(where) {
  const move = await centre('.mf-ctl-move');
  await drag(move, 60, 0, 6, 11, false);
  let s = await sticks();
  check(s.moveActive && s.move.x > 0.6 && Math.abs(s.move.y) < 0.2, `${where}: the move dial pushed to the page's right reads right (x ${s.move.x.toFixed(2)}, y ${s.move.y.toFixed(2)})`);
  await touch('touchEnd', []);
  await sleep(300);
  await drag(move, 0, -60, 6, 12, false);
  s = await sticks();
  check(s.move.y > 0.6 && Math.abs(s.move.x) < 0.2, `${where}: pushed to the page's top it reads up: jet (x ${s.move.x.toFixed(2)}, y ${s.move.y.toFixed(2)})`);
  await touch('touchEnd', []);
  await sleep(300);
  const aim = await centre('.mf-ctl-aim');
  await drag(aim, -40, -40, 6, 13, false);
  s = await sticks();
  check(s.aimActive && s.aim.x < -0.4 && s.aim.y > 0.4, `${where}: the aim dial pushed up-left reads up-left (x ${s.aim.x.toFixed(2)}, y ${s.aim.y.toFixed(2)})`);
  await touch('touchEnd', []);
  await sleep(300);
  // floating: a thumb on the page's left half, away from the dial, brings the move dial to it
  const at = await toScreen({ x: 300, y: 200 });
  await touch('touchStart', [{ id: 14, ...at }]);
  await sleep(80);
  const dial = await page.$eval('.mf-ctl-move', (el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
  const safe = await page.$eval('.mf-touch-safe', (el) => ({ left: el.offsetLeft, top: el.offsetTop }));
  check(Math.abs(dial.left + safe.left - 300) < 3 && Math.abs(dial.top + safe.top - 200) < 3, `${where}: the move dial comes to a thumb at the page's (300, 200) (it's at ${(dial.left + safe.left).toFixed(0)}, ${(dial.top + safe.top).toFixed(0)})`);
  await touch('touchEnd', []);
  await sleep(500);
}

try {
  await page.goto(`${base}/?app&time=600`, { waitUntil: 'load' });
  await page.evaluate(() => {
    localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ mode: 'on' }));
    localStorage.removeItem('mf.touch.layout.v1');
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('[data-screen="m-name"] input[aria-label="Your name"]', { timeout: 60_000 });
  const turned = await page.evaluate(() => {
    const b = document.body.getBoundingClientRect();
    return { rotated: document.documentElement.classList.contains('mf-rotated'), w: document.body.clientWidth, h: document.body.clientHeight, box: [b.left, b.top, b.width, b.height].map(Math.round) };
  });
  check(turned.rotated && turned.w === 812 && turned.h === 375, `upright: the page lays out at 812×375 (${turned.w}×${turned.h})`);
  check(turned.box.join() === '0,0,375,812', `upright: turned, it fills the 375×812 screen (${turned.box.join(', ')})`);
  await shot('r0-name', 1200);
  await iconsResolve('name');

  // the first tap: full screen, then the lock (both refused: the page stays turned)
  await tap('[data-screen="m-name"] input[aria-label="Your name"]', 'the name field');
  await sleep(300);
  const asked = await page.evaluate(() => window.__asked);
  check(asked.join() === 'fullscreen,lock landscape', `the first tap asks for full screen, then the landscape lock (${asked.join(', ')})`);
  await page.keyboard.type(`Ade${Math.floor(Math.random() * 900 + 100)}`);
  await page.waitForSelector('[data-screen="m-name"]:not([data-active-state="checking"])', { timeout: 10_000 });
  await shot('r0-name-typed', 300);
  for (let i = 0; i < 8 && !(await page.$('[data-screen="m-home"]')); i++) {
    await tap('[data-screen="m-name"] button[type=submit]', 'Continue');
    await sleep(1200);
  }
  await page.waitForSelector('[data-screen="m-home"]', { timeout: 30_000 });
  await shot('r2-home', 1200);
  await iconsResolve('home');

  // Settings: the Touch tab's opacity slider follows a finger along the page (down the glass)
  await tap('.pm-nav__i:last-child', 'Settings');
  await page.waitForSelector('[data-screen="m-settings"]', { timeout: 10_000 });
  await tap('.pm-rail__i:first-child', 'the Touch tab');
  await shot('r7-settings', 800);
  await page.$eval('[aria-label="Touch controls opacity"]', (el) => el.scrollIntoView({ block: 'center' }));
  await sleep(300);
  const slider = await page.$eval('[aria-label="Touch controls opacity"]', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const before = await page.$eval('[aria-label="Touch controls opacity"]', (el) => Number(el.getAttribute('aria-valuenow')));
  await drag(slider, -60, 0, 6, 20);
  await sleep(200);
  const after = await page.$eval('[aria-label="Touch controls opacity"]', (el) => Number(el.getAttribute('aria-valuenow')));
  check(after < before - 10, `the opacity slider follows a finger to the page's left (${before} → ${after})`);
  await page.evaluate(() => window.__touch.setTouchSettings({ opacity: 1 }));
  await tap('[data-screen="m-settings"] .btn--volt', 'Done');
  await page.waitForSelector('[data-screen="m-home"]', { timeout: 10_000 });
  await sleep(500);

  // the Locker (a route): the phone layout, turned
  await tap('.pm-nav__i:nth-child(2)', 'Locker');
  await page.waitForSelector('.mf-route .mm-locker', { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('.mm-overlay')?.hidden !== false, { timeout: 120_000 }).catch(() => {});
  await shot('r6-locker', 2500);
  const areas = await page.$eval('.mf-route .mm-locker', (el) => getComputedStyle(el).gridTemplateAreas);
  check(/"head head" "tabs tabs" "stage panel"/.test(areas), `the Locker takes its phone layout when turned (${areas})`);
  await page.evaluate(() => (location.hash = ''));
  await page.waitForSelector('[data-screen="m-home"]', { timeout: 10_000 });
  await sleep(600);

  // training: the HUD and the dials, turned
  const training = await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Training")]');
  await tapAt(await training.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }));
  await page.waitForFunction(() => window.__game?.mode?.update && document.querySelector('.mf-touch:not([hidden])'), { timeout: 60_000 });
  const tips = await page.waitForSelector('[data-screen="m-tips"]', { timeout: 10_000 }).catch(() => null);
  if (tips) {
    await shot('r8-tips', 1200);
    await tap('.pm-tips .btn--volt', 'Got it');
  }
  await sleep(6000); // past the countdown
  await shot('r1-hud', 300);
  await iconsResolve('hud');
  await dials('upright');

  // the layout editor: a drag moves the reload button the page's way; a pinch grows the melee button
  await page.evaluate(() => window.__touch.openTouchEditor());
  await sleep(600);
  await shot('r1-editor', 300);
  const place = (sel) => page.$eval(sel, (el) => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
  const r0 = await place('.mf-ctl-reload');
  await drag(await centre('.mf-ctl-reload'), -60, 30, 8, 21);
  await sleep(300);
  const r1 = await place('.mf-ctl-reload');
  check(r1.left - r0.left < -40 && r1.top - r0.top > 15, `the editor: dragged 60 left and 30 down the page, reload moved (${(r1.left - r0.left).toFixed(0)}, ${(r1.top - r0.top).toFixed(0)})`);
  await page.evaluate(() => window.__touch.resetTouchLayout());
  await sleep(300);
  const size = () => page.$eval('.mf-ctl-melee', (el) => el.offsetWidth);
  const s0 = await size();
  const m = await centre('.mf-ctl-melee');
  const far = await page.evaluate(() => document.documentElement.classList.contains('mf-rotated'));
  const second = far ? { x: m.x + 30, y: m.y - 70 } : { x: m.x - 70, y: m.y - 30 };
  await touch('touchStart', [{ id: 30, ...m }]);
  await touch('touchStart', [{ id: 30, ...m }, { id: 31, ...second }]);
  for (let i = 1; i <= 5; i++) {
    const spread = far ? { x: second.x + 8 * i, y: second.y - 18 * i } : { x: second.x - 18 * i, y: second.y - 8 * i };
    await touch('touchMove', [{ id: 30, ...m }, { id: 31, ...spread }]);
    await sleep(30);
  }
  await shot('r1-editor-pinch', 200);
  await touch('touchEnd', []);
  const s1 = await size();
  check(s1 > s0 * 1.3, `the editor: a pinch grows the melee button (${s0} → ${s1} px)`);
  await page.evaluate(() => window.__touch.resetTouchLayout());
  await page.$eval('[data-ed="done"]', (b) => b.click());
  await sleep(500);

  // the pause menu over the turned game, and at 150 % text
  await tapAt(await centre('.mf-touch .mf-ctl-pause'));
  await page.waitForSelector('[data-screen="m-pause"]', { timeout: 10_000 });
  await shot('r4-pause', 800);
  await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1.5'));
  await shot('r4-pause-text150', 800);
  const off = await page.$$eval('.pm-pause .btn', (bs) => bs.filter((b) => b.offsetParent && (b.getBoundingClientRect().bottom > innerHeight + 0.5 || b.getBoundingClientRect().right > innerWidth + 0.5)).length);
  check(off === 0, `the pause menu's buttons stay on the screen at 150 % (${off} off)`);
  await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
  await tap('.pm-pause .btn--paper', 'Resume');
  await sleep(800);

  // held sideways: nothing turns, the same checks
  await phone(false);
  await sleep(1200);
  const flat = await page.evaluate(() => ({ rotated: document.documentElement.classList.contains('mf-rotated'), w: document.body.clientWidth, h: document.body.clientHeight, t: getComputedStyle(document.body).transform }));
  check(!flat.rotated && flat.w === 812 && flat.h === 375 && flat.t === 'none', `sideways: the page isn't turned (${flat.w}×${flat.h}, ${flat.t})`);
  await shot('l1-hud', 600);
  await dials('sideways');
  // and back upright mid-match
  await phone(true);
  await sleep(1200);
  check(await page.evaluate(() => document.documentElement.classList.contains('mf-rotated')), 'upright again mid-match: the page turns again');
  await dials('upright again');
  await shot('r1-hud-again', 300);
} finally {
  await browser.close();
}
for (const p of problems) console.error(`FAIL: ${p}`);
if (problems.length) process.exit(1);
