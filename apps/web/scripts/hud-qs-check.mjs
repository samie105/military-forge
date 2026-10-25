/**
 * The weapon selectors, walked for real (owner, 25 Oct: "the selecting of gun UI isn't mapped
 * properly"): on desktop (1280×720, 1920×1080, and 1920×1080 at 2× pixels) hold Q, move the mouse
 * onto each drawn item of the quick-select and check that item lights up, with the wheel opened in
 * the middle, near a corner (it's pulled on screen) and after a resize; let go on one and check the
 * sim took it. On phones (780×360, 844×300) hold the gun pill, slide the finger onto each drawn
 * choice of its radial and check it's the one picked, then take the other gun. And the crate card:
 * the swap only, its stats on the Stats key (desktop) or button (phone). Screenshots of each.
 *
 *   node apps/web/scripts/hud-qs-check.mjs <url> <out dir>
 *
 * Exits 1 when a check fails or the page errs. Every step has its own time limit.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8235').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/hud-premium/selectors');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONTENT = fileURLToPath(new URL('../../../packages/content/src/index.ts', import.meta.url));
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const limit = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`timed out: ${what}`)), ms))]);
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'hud-qs-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 120_000 });

async function open({ w, h, dpr = 1, phone = false }) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  const cdp = await page.createCDPSession();
  if (phone) {
    await page.emulate({ viewport: { width: w, height: h, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: PHONE_UA });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  } else await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  await page.evaluateOnNewDocument((phone) => {
    try {
      localStorage.setItem('mf-creator-seen', '1');
      if (phone) {
        localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ mode: 'on' }));
        localStorage.setItem('mf.touch.drill.v1', 'done');
        localStorage.setItem('mf.touch.hints.v1', JSON.stringify(['dash-swipe', 'grenade-types', 'swap-radial', 'take', 'shield-hold']));
      }
    } catch {
      /* fine */
    }
  }, phone);
  await page.goto(`${base}/?app&time=600&bots=0`, { waitUntil: 'load', timeout: 60_000 });
  // the title screen: any key, click or tap, until the name screen shows
  for (let i = 0; i < 30 && !(await page.$('input[aria-label="Your name"]')); i++) {
    await sleep(800);
    await page.keyboard.press('Enter').catch(() => {});
    if (phone) await page.touchscreen.tap(w / 2, h * 0.6).catch(() => {});
    else await page.mouse.click(w / 2, h * 0.6).catch(() => {});
  }
  await page.evaluate(() => localStorage.setItem('mf.phone.turnTip.v1', 'seen'));
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await sleep(1500);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__game?.mode?.update)); i++) {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      const skip = buttons.find((b) => /^(skip|skip all|not now|later|i'?ve played|veteran|continue)/i.test((b.textContent ?? '').trim()));
      const training = buttons.find((b) => /training/i.test(b.textContent ?? ''));
      (skip ?? training)?.click();
    });
    await sleep(800);
  }
  await page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 90_000 });
  for (let i = 0; i < 16; i++) {
    const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
    if (got) {
      await got.click().catch(() => {});
      break;
    }
    await sleep(500);
  }
  await sleep(800);
  await page.evaluate(async (content) => {
    try {
      window.__content = await import(/* @vite-ignore */ `/@fs${content}`);
    } catch {
      window.__content = null; // another checkout's server: the crate step is skipped there
    }
    const mode = window.__game.mode;
    const p = mode.game.players.find((x) => x && x.id === mode.localId);
    if (p) p.grenadeCounts = [3, 2, 1, 1, 0, 1];
    const update = mode.update.bind(mode);
    window.__extra = null;
    mode.update = (dt) => {
      const f = update(dt);
      const me = f.players.find((x) => x.id === f.localId);
      if (me) Object.assign(me, { hp: 100, alive: true, respawnTicks: 0 });
      if (window.__extra) Object.assign(f, window.__extra(f, me));
      return f;
    };
  }, CONTENT);
  return { page, cdp };
}

const sim = (page) =>
  page.evaluate(() => {
    const m = window.__game.mode;
    const p = m.game.players.find((x) => x && x.id === m.localId);
    return { active: p.active, grenadeType: p.grenadeType, def: p.weapons[p.active]?.def };
  });
const has = (page, token) => page.evaluate((t) => (document.querySelector('#hud')?.dataset.activeState ?? '').split(' ').includes(t), token);
const until = async (page, token, ms = 3000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await has(page, token)) return true;
    await sleep(20);
  }
  return false;
};
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) }).then(() => console.log(`wrote ${name}.png`));

/** Desktop: open the wheel with the mouse at (mx, my), visit each drawn item, check the lit one. */
async function wheel(page, tag, mx, my, shoot) {
  await page.mouse.move(mx, my);
  await sleep(200);
  await page.keyboard.down('KeyQ');
  if (!(await until(page, 'quick-open', 2500))) {
    problems.push(`${tag}: the quick-select didn't open`);
    await page.keyboard.up('KeyQ');
    return;
  }
  await sleep(250);
  const n = await page.evaluate(() => document.querySelectorAll('#hud .mf-hud-desktop .mf-qs__item').length);
  for (let i = 0; i < n; i++) {
    const c = await page.evaluate((i) => {
      const r = document.querySelectorAll('#hud .mf-hud-desktop .mf-qs__item')[i].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, i);
    await page.mouse.move(c.x, c.y, { steps: 4 });
    await sleep(120);
    const lit = await page.evaluate(() => [...document.querySelectorAll('#hud .mf-hud-desktop .mf-qs__item')].findIndex((e) => e.classList.contains('is-hi')));
    if (lit !== i) problems.push(`${tag}: the mouse on item ${i} lit item ${lit}`);
    if (shoot && i === 4) await shot(page, `${tag}-wheel-on-item-4`);
  }
  // let go on the slung gun (item 1): the sim takes it
  const before = await sim(page);
  const c1 = await page.evaluate(() => {
    const r = document.querySelectorAll('#hud .mf-hud-desktop .mf-qs__item')[1].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(c1.x, c1.y, { steps: 4 });
  await sleep(120);
  await page.keyboard.up('KeyQ');
  await sleep(900);
  if ((await sim(page)).active === before.active) problems.push(`${tag}: letting go on the slung gun didn't take it`);
  await sleep(900);
}

/** The crate card: compact, then its stats on the key (desktop) or the button (phone). */
async function crate(page, tag, phone, cdp) {
  if (!(await page.evaluate(() => !!window.__content))) return;
  await page.evaluate(() => {
    const c = window.__content;
    const crate = (id) => c.weaponPickup(c.weapons.find((x) => x.id === id).index).index;
    window.__extra = (f, me) => ({ pickups: [{ id: 901, def: crate('k47'), x: me.x, y: me.y }] });
  });
  if (!(await until(page, 'pickup-crate', 3000))) problems.push(`${tag}: no crate card`);
  await sleep(500);
  if (await has(page, 'stats-open')) problems.push(`${tag}: the stats were open before asked for`);
  await shot(page, `${tag}-crate-swap-only`);
  if (phone) {
    const b = await page.evaluate(() => {
      const el = document.querySelector('#hud .mf-hud-phone .pt-cmp__stats');
      const r = el.getBoundingClientRect();
      // its hit area: the button, or the larger ::after round it (drawn small, 44 px to the finger), on the glass
      const zoom = r.height / (parseFloat(getComputedStyle(el).height) || r.height);
      const hit = Math.max(r.height, (parseFloat(getComputedStyle(el, '::after').height) || 0) * zoom);
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, h: hit, w: r.width };
    });
    if (b.h < 44) problems.push(`${tag}: the Stats button's hit area is ${b.h.toFixed(0)} px tall (44 at least)`);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b.x, y: b.y, radiusX: 8, radiusY: 8, force: 1, id: 7 }] });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } else await page.keyboard.press('KeyI');
  if (!(await until(page, 'stats-open', 1500))) problems.push(`${tag}: the Stats ${phone ? 'button' : 'key'} didn't open the stats`);
  await sleep(400);
  await shot(page, `${tag}-crate-stats-open`);
  await page.evaluate(() => (window.__extra = null));
  await sleep(800);
  if (await has(page, 'stats-open')) problems.push(`${tag}: the stats stayed open after leaving the crate`);
}

/** Phone: hold the gun pill, slide onto each drawn radial choice, check it's the one picked; take the other gun. */
async function radial(page, cdp, tag) {
  const pill = await page.evaluate(() => {
    const r = document.querySelector('.mf-ctl-swap').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const touch = (type, p) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [{ x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1, id: 3 }] : [] });
  await touch('touchStart', pill);
  await sleep(700);
  const n = await page.evaluate(() => document.querySelectorAll('.mf-radial__it').length);
  if (n < 2) problems.push(`${tag}: the radial didn't open (${n} choices)`);
  const before = await sim(page);
  for (let i = 0; i < n; i++) {
    const c = await page.evaluate((i) => {
      const r = document.querySelectorAll('.mf-radial__it')[i].getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, i);
    await touch('touchMove', c);
    await sleep(120);
    const picked = await page.evaluate(() => [...document.querySelectorAll('.mf-radial__it')].findIndex((e) => e.classList.contains('is-picked')));
    if (picked !== i) problems.push(`${tag}: the finger on choice ${i} picked ${picked}`);
    if (i === 0) await shot(page, `${tag}-radial-on-other-gun`);
  }
  // back onto the other gun (choice 0) and let go
  const c0 = await page.evaluate(() => {
    const r = document.querySelectorAll('.mf-radial__it')[0].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await touch('touchMove', c0);
  await sleep(120);
  await touch('touchEnd', null);
  await sleep(900);
  if ((await sim(page)).active === before.active) problems.push(`${tag}: letting go on the other gun didn't swap`);
}

try {
  for (const v of [
    { w: 1280, h: 720 },
    { w: 1920, h: 1080 },
    { w: 1920, h: 1080, dpr: 2 },
  ]) {
    const tag = `desktop-${v.w}x${v.h}${v.dpr ? `@${v.dpr}x` : ''}`;
    const { page, cdp } = await limit(open(v), 180_000, `${tag} open`);
    await limit(wheel(page, `${tag}-middle`, v.w * 0.55, v.h * 0.45, true), 60_000, `${tag} wheel`);
    await limit(wheel(page, `${tag}-corner`, 30, 24, false), 60_000, `${tag} wheel corner`);
    if (!v.dpr) {
      // a resize, then the wheel again
      await page.setViewport({ width: Math.round(v.w * 0.8), height: Math.round(v.h * 0.8) });
      await sleep(800);
      await limit(wheel(page, `${tag}-resized`, v.w * 0.6, v.h * 0.4, false), 60_000, `${tag} wheel resized`);
      await page.setViewport({ width: v.w, height: v.h });
      await sleep(800);
      await limit(crate(page, tag, false, cdp), 30_000, `${tag} crate`);
    }
    await page.close();
  }
  for (const v of [
    { w: 780, h: 360, dpr: 3 },
    { w: 844, h: 300, dpr: 3 },
  ]) {
    const tag = `phone-${v.w}x${v.h}`;
    const { page, cdp } = await limit(open({ ...v, phone: true }), 180_000, `${tag} open`);
    await page.waitForSelector('.mf-ctl-swap', { timeout: 30_000 });
    await limit(radial(page, cdp, tag), 60_000, `${tag} radial`);
    await limit(crate(page, tag, true, cdp), 30_000, `${tag} crate`);
    await page.close();
  }
} catch (e) {
  problems.push(String(e?.message ?? e));
} finally {
  await browser.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('all checks passed');
