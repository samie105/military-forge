/**
 * The mobile audit's fixes walked end to end as a stranger on a phone (docs/design/mobile-audit-2026-10-23.md):
 * a Samsung Galaxy S23 profile (780×360 held sideways and 360×780 upright, DPR 3, the Chrome Android user
 * agent), real touch events (CDP), 4× CPU throttling. Against a running dev server; no API is needed.
 *
 *   node apps/web/scripts/mobile-walk.mjs <dev server> <screenshot dir> [scenario ...]
 *
 * Scenarios (all by default):
 *   no-popups   a new player's first training match: no "How to play", tip card or fire chooser opens
 *               during the countdown or the clock, and none stacks; the controls card waits for Home.
 * Exits 1 on any failed check.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? join(tmpdir(), 'mobile-walk');
const only = process.argv.slice(4);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PROFILES = {
  sideways: { width: 780, height: 360, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true },
  upright: { width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: false },
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: mkdtempSync(join(tmpdir(), 'walk-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });

/** A fresh S23 page (cleared storage), 4× CPU. */
async function phone(profile) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport(PROFILES[profile]);
  await page.emulateCPUThrottling(4);
  page.on('pageerror', (e) => check(`${profile}: no page error`, false, e.message));
  await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  return page;
}

/** Taps (a real touch) the centre of the first visible element matching `sel` whose text includes `text`. */
async function tap(page, sel, text = '') {
  const at = await page.evaluate(
    (s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => (!t || (e.textContent ?? '').toLowerCase().includes(t.toLowerCase())) && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    sel,
    text,
  );
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

/** Title → name → (creator: Skip) → Briefing (veteran) → Home, as a new player. */
async function newPlayerToHome(page, profile) {
  await page.goto(`${base}/?app`, { waitUntil: 'load' });
  await sleep(1500);
  await page.evaluate(() => document.querySelector('.pm-turn__card button')?.click());
  // the title: tap anywhere
  if (await until(page, () => !!document.querySelector('[data-screen="title"]'), 15_000)) {
    await page.touchscreen.tap(PROFILES[profile].width / 2, PROFILES[profile].height / 2);
  }
  await until(page, () => !!document.querySelector('input[aria-label="Your name"], [data-screen="home"], [data-screen="m-home"]'), 90_000);
  if (await page.$('input[aria-label="Your name"]')) {
    await tap(page, 'input[aria-label="Your name"]');
    await page.keyboard.type(`Walk${Math.floor(Math.random() * 900 + 100)}`);
    await page.keyboard.press('Enter');
  }
  if (await until(page, () => !!document.querySelector('[data-screen="creator"] [data-action="skip"]'), 20_000)) {
    await sleep(800);
    await tap(page, '[data-screen="creator"] [data-action="skip"]');
  }
  if (await until(page, () => !!document.querySelector('[data-screen="briefing"]'), 15_000)) {
    await sleep(600);
    await tap(page, '[data-answer="veteran"]');
  }
  return until(page, () => !!document.querySelector('[data-screen="home"], [data-screen="m-home"]'), 20_000);
}

const cardsUp = (page) =>
  page.evaluate(() => {
    const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
    const s = window.__game?.shell?.store?.getState();
    return {
      phase: s?.match?.phase ?? null,
      screen: s?.screen?.name,
      tips: vis(document.querySelector('[data-screen="tips"], [data-screen="m-tips"]')),
      chooser: vis(document.querySelector('.mf-choose')),
    };
  });

// ---- P0-3: no pop-ups during a live match
async function noPopups(profile) {
  const page = await phone(profile);
  const home = await newPlayerToHome(page, profile);
  if (!home) await page.screenshot({ path: join(out, `p0-3-${profile}-stuck.png`) });
  check(`${profile}: a new player reaches Home`, home);
  await page.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
  let worst = null;
  let seenLive = false;
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    const c = await cardsUp(page);
    const live = c.phase === 1 || c.phase === 2;
    seenLive ||= live;
    if (live && (c.tips || c.chooser)) worst ??= c;
    await sleep(250);
  }
  await page.screenshot({ path: join(out, `p0-3-${profile}-in-match.png`) });
  check(`${profile}: the match ran (countdown and clock)`, seenLive);
  check(`${profile}: no card opened while the countdown or the clock ran`, worst === null, JSON.stringify(worst));
  // back to Home: the controls card (queued) may open there, once, alone
  await page.evaluate(() => window.__game.shell.controller.leave());
  await until(page, () => !!document.querySelector('[data-screen="home"], [data-screen="m-home"]'), 15_000);
  await sleep(1500);
  const after = await cardsUp(page);
  await page.screenshot({ path: join(out, `p0-3-${profile}-home-after.png`) });
  check(`${profile}: the queued controls card opens on Home, alone`, after.tips && !after.chooser, JSON.stringify(after));
  await page.close();
}

const SCENARIOS = { 'no-popups': noPopups };
try {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (only.length && !only.includes(name)) continue;
    for (const profile of ['sideways', 'upright']) await run(profile);
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all mobile walk checks passed');
process.exit(failures ? 1 : 0);
