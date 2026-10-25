/**
 * The HUD editor (the layout bay, touch/editor/) walked as a stranger on a landscape phone (the owner, 24
 * Oct: "to set the HUD is confusing, and we keep forgetting it's a mobile device and on landscape").
 * Against a production build behind `pnpm playtest --local --no-build --port <n>`: no dev hooks, every
 * step by touch.
 *
 *   node apps/web/scripts/hud-bay-walk.mjs http://127.0.0.1:<port> <out dir> [profile ...]
 *
 * Profiles (all by default): s23 780×360 (Android Chrome), iphone 844×390 (Safari, bars hidden),
 * iphone-bars 844×300 (Safari with its address and tab bars). For each:
 *   home      Home › Settings › Touch › Edit: the bay is on top (it used to open under Home), the base
 *             cards, a base swap and Undo, a drag that snaps, the control's card beside it (never over
 *             it), size and fade, an extra from the tray, Cancel (nothing kept), Save (kept).
 *   training  the same from a training match's pause menu: the game dims under the bay.
 * Every step checks that nothing leaves the screen and that the bay's buttons are 44 px or more.
 * Exits 1 on a page error or a failed check.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8097').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'hud-bay-walk');
const only = process.argv.slice(4);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PROFILES = {
  s23: { ua: ANDROID, view: { width: 780, height: 360, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true } },
  iphone: { ua: IPHONE, view: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true } },
  'iphone-bars': { ua: IPHONE, view: { width: 844, height: 300, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true } },
};

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'bay-walk-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });
const FACTS = JSON.stringify({ v: 1, firstSeen: Date.now(), lastSession: Date.now(), sessions: 3, devices: ['touch'], lastDevice: 'touch', experience: 'veteran', promoted: false, invited: false, tours: { 'first-flight': { status: 'done' }, home: { status: 'done' } }, matches: { local: 2, online: 1, finished: 2, wonInARow: 0 }, kills: 3, deaths: {}, moves: {}, screens: [], rooms: { created: 0, joined: 1, local: 0 }, soldierSaved: true, touch: { missedTaps: 0, hops: 0 }, cards: {} });

async function phone(profile) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => check(`${profile}: no page error`, false, e.message));
  const p = PROFILES[profile];
  await page.setUserAgent(p.ua);
  await page.setViewport(p.view);
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'orientation', value: 'landscape' }] });
  await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.evaluate((facts) => {
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('mf.facts.v1', facts);
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.setItem('mf.install.v1', JSON.stringify({ dismissedAt: Date.now(), stats: {} }));
    localStorage.setItem('profile.name.v1', 'Ade');
  }, FACTS);
  await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  return page;
}

async function centre(page, sel, text = '') {
  return page.evaluate(
    (s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => (!t || (e.textContent ?? '').toLowerCase().includes(t.toLowerCase())) && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    },
    sel,
    text,
  );
}
async function tap(page, sel, text = '') {
  const at = await centre(page, sel, text);
  if (!at) return false;
  await page.touchscreen.tap(at.x, at.y);
  return true;
}
const until = async (page, fn, ms = 30_000, arg) => {
  try {
    await page.waitForFunction(fn, { timeout: ms, polling: 200 }, arg);
    return true;
  } catch {
    return false;
  }
};
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) });

/** The bay's own buttons: on screen, 44 px or more, and what's on top at their centre is them. */
async function bayFits(page, label) {
  const r = await page.evaluate(() => {
    const W = innerWidth;
    const H = innerHeight;
    const bad = [];
    for (const el of document.querySelectorAll('.mf-bay button, .mf-bay input')) {
      if (!el.getClientRects().length || el.closest('[hidden]')) continue;
      const b = el.getBoundingClientRect();
      const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30);
      if (b.left < -1 || b.top < -1 || b.right > W + 1 || b.bottom > H + 1) bad.push(`${name}: off screen`);
      if (Math.min(b.width, b.height) < 43.5) bad.push(`${name}: ${Math.round(b.width)}×${Math.round(b.height)}`);
      if (getComputedStyle(el).visibility === 'hidden') continue;
      const top = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (top && !el.contains(top) && !top.contains(el)) bad.push(`${name}: covered by ${top.className || top.tagName}`);
    }
    return { bad, scroll: document.documentElement.scrollWidth > W + 1 };
  });
  check(`${label}: the bay's buttons fit, 44 px, uncovered`, r.bad.length === 0 && !r.scroll, r.bad.join(' | '));
}

const grenade = (page) => centre(page, '[data-mf-control="grenade"]');

async function inBay(page, profile, tag) {
  check(`${profile} ${tag}: the bay opens on top`, await until(page, () => !!document.querySelector('.mf-bay:not([hidden])'), 15_000));
  await sleep(900);
  // on top of every screen: what's under a control's centre is the control
  const g = await grenade(page);
  const onTop = g && (await page.evaluate((p) => !!document.elementFromPoint(p.x, p.y)?.closest('[data-mf-control="grenade"]'), g));
  check(`${profile} ${tag}: the controls are on top (not under a menu)`, !!onTop);
  await shot(page, `${profile}-${tag}-1-bay`);
  await bayFits(page, `${profile} ${tag} bay`);
  const before = g;

  // the base: three cards; Claw moves the controls; Undo brings Classic back
  await tap(page, '[data-bay="base"]');
  await sleep(500);
  await shot(page, `${profile}-${tag}-2-bases`);
  await bayFits(page, `${profile} ${tag} bases`);
  await tap(page, '[data-preset="claw"]');
  await sleep(600);
  const claw = await page.evaluate(() => document.querySelector('[data-bay="base-name"]')?.textContent);
  check(`${profile} ${tag}: a base card swaps the base`, claw === 'Claw', claw);
  await shot(page, `${profile}-${tag}-3-claw`);
  await bayFits(page, `${profile} ${tag} claw`);
  await tap(page, '[data-bay="undo"]');
  await sleep(500);
  const back = await page.evaluate(() => document.querySelector('[data-bay="base-name"]')?.textContent);
  check(`${profile} ${tag}: Undo brings the base back`, back === 'Classic', back);

  // drag the grenade up and left: it moves; the card opens beside it, never over it
  const g0 = await grenade(page);
  await page.touchscreen.touchStart(g0.x, g0.y);
  for (let i = 1; i <= 10; i++) {
    await page.touchscreen.touchMove(g0.x - i * 9, g0.y - i * 5);
    await sleep(30);
  }
  await shot(page, `${profile}-${tag}-4-drag`);
  await page.touchscreen.touchEnd();
  await sleep(500);
  const g1 = await grenade(page);
  check(`${profile} ${tag}: a drag moves the control`, Math.hypot(g1.x - g0.x, g1.y - g0.y) > 40, `${Math.round(g0.x)},${Math.round(g0.y)} → ${Math.round(g1.x)},${Math.round(g1.y)}`);
  const card = await centre(page, '.mf-bay__card');
  check(`${profile} ${tag}: the control's card opens`, !!card);
  if (card) {
    const overlap = !(card.right <= g1.left || card.left >= g1.right || card.bottom <= g1.top || card.top >= g1.bottom);
    check(`${profile} ${tag}: the card sits beside the control, not over it`, !overlap);
  }
  await shot(page, `${profile}-${tag}-5-card`);
  await bayFits(page, `${profile} ${tag} card`);
  // size: slide right; the control grows
  const slider = await centre(page, '[data-bay="size"]');
  if (slider) {
    await page.touchscreen.touchStart(slider.x, slider.y);
    await page.touchscreen.touchMove(slider.x + slider.w * 0.35, slider.y);
    await page.touchscreen.touchEnd();
    await sleep(400);
    const g2 = await grenade(page);
    check(`${profile} ${tag}: the size slider grows the control`, g2.w > g1.w + 4, `${Math.round(g1.w)} → ${Math.round(g2.w)}`);
  }
  // an extra from the tray (tap empty space first: the card closes, the tray shows)
  await page.touchscreen.tap(Math.round(PROFILES[profile].view.width * 0.42), Math.round(PROFILES[profile].view.height * 0.3));
  await sleep(400);
  // a folded tray (no room between the controls) opens from its + first
  if (!(await centre(page, '[data-pin="dash"]'))) await tap(page, '[data-bay="tray-open"]');
  await sleep(300);
  const trayed = await tap(page, '[data-pin="dash"]');
  await sleep(500);
  check(`${profile} ${tag}: an extra goes on the HUD from the tray`, trayed && !!(await centre(page, '[data-mf-control="dash"]:not(.mf-off)')));
  await shot(page, `${profile}-${tag}-6-tray`);
  await bayFits(page, `${profile} ${tag} tray`);

  // Cancel: nothing kept
  await tap(page, '[data-bay="cancel"]');
  check(`${profile} ${tag}: Cancel closes the bay`, await until(page, () => !!document.querySelector('.mf-bay[hidden]'), 5000));
  return before;
}

async function reopenFromSettings(page) {
  await tap(page, '.pm-nav__i', 'Settings');
  await until(page, () => !!document.querySelector('[data-screen="m-settings"]'), 15_000);
  await tap(page, '[role="tab"]', 'Touch');
  await sleep(500);
  await tap(page, 'button', 'Edit');
}

async function home(profile) {
  const page = await phone(profile);
  await until(page, () => !!document.querySelector('[data-screen="title"], [data-screen="m-home"], input[aria-label="Your name"]'), 90_000);
  if (await page.$('[data-screen="title"]')) await page.touchscreen.tap(PROFILES[profile].view.width / 2, PROFILES[profile].view.height / 2);
  if (await until(page, () => !!document.querySelector('input[aria-label="Your name"]'), 4000)) {
    await tap(page, 'input[aria-label="Your name"]');
    await page.keyboard.type(`Ade${Math.floor(Math.random() * 9000 + 1000)}`);
    await page.keyboard.press('Enter');
  }
  check(`${profile}: Home`, await until(page, () => !!document.querySelector('[data-screen="m-home"]'), 60_000));
  await sleep(1200);
  await reopenFromSettings(page);
  const g0 = await inBay(page, profile, 'home');
  // reopened after Cancel: the grenade is where it was, the dash gone
  await reopenFromSettings(page);
  await until(page, () => !!document.querySelector('.mf-bay:not([hidden])'), 15_000);
  await sleep(700);
  const g = await grenade(page);
  check(`${profile}: after Cancel, nothing was kept`, g && Math.hypot(g.x - g0.x, g.y - g0.y) < 3 && !(await centre(page, '[data-mf-control="dash"]:not(.mf-off)')));
  // drag and Save: kept
  await page.touchscreen.touchStart(g.x, g.y);
  for (let i = 1; i <= 8; i++) {
    await page.touchscreen.touchMove(g.x - i * 10, g.y - i * 4);
    await sleep(30);
  }
  await page.touchscreen.touchEnd();
  await sleep(400);
  const moved = await grenade(page);
  await tap(page, '[data-bay="save"]');
  await sleep(500);
  await reopenFromSettings(page);
  await until(page, () => !!document.querySelector('.mf-bay:not([hidden])'), 15_000);
  await sleep(700);
  const kept = await grenade(page);
  check(`${profile}: Save keeps the move`, kept && Math.hypot(kept.x - moved.x, kept.y - moved.y) < 3);
  await tap(page, '[data-bay="reset"]');
  await sleep(300);
  await tap(page, '[data-bay="save"]');
  await page.browserContext().close();
}

async function training(profile) {
  const page = await phone(profile);
  await until(page, () => !!document.querySelector('[data-screen="title"], [data-screen="m-home"], input[aria-label="Your name"]'), 90_000);
  if (await page.$('[data-screen="title"]')) await page.touchscreen.tap(PROFILES[profile].view.width / 2, PROFILES[profile].view.height / 2);
  if (await until(page, () => !!document.querySelector('input[aria-label="Your name"]'), 4000)) {
    await tap(page, 'input[aria-label="Your name"]');
    await page.keyboard.type(`Ade${Math.floor(Math.random() * 9000 + 1000)}`);
    await page.keyboard.press('Enter');
  }
  await until(page, () => !!document.querySelector('[data-screen="m-home"]'), 60_000);
  await sleep(1000);
  await tap(page, 'button, a, [role="button"]', 'Training');
  check(`${profile}: training starts`, await until(page, () => !!document.querySelector('.mf-touch:not([hidden]) [data-mf-control="pause"]'), 60_000));
  await sleep(6000);
  await tap(page, '[data-mf-control="pause"]');
  await until(page, () => !!document.querySelector('[data-screen="m-pause"]'), 15_000);
  await sleep(600);
  await tap(page, 'button', 'Settings');
  await until(page, () => !!document.querySelector('[data-screen="m-settings"]'), 15_000);
  await tap(page, '[role="tab"]', 'Touch');
  await sleep(500);
  await tap(page, 'button', 'Edit');
  await inBay(page, profile, 'match');
  await page.browserContext().close();
}

const scenarios = (process.env.WALK ?? 'home,training').split(',');
for (const p of only.length ? only : Object.keys(PROFILES)) {
  for (const [name, fn] of [
    ['home', home],
    ['training', training],
  ]) {
    if (!scenarios.includes(name)) continue;
    try {
      await fn(p);
    } catch (e) {
      check(`${p} ${name}: walk ran`, false, e.message);
    }
  }
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
