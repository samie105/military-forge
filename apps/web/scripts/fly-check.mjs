/* global process */
/**
 * Fly at GO, in every touch layout and stick mode (the owner, 26 Oct 2026, an Android phone: "I can't
 * fly", "I'm only flying if I press JET"). A phone-sized headless Chrome (812×375, touch, real CDP
 * touches) starts Training from Home for each layout (Classic, Claw, One-thumb assist; Fire button mode
 * on Classic) with Fixed and Follow thumb sticks, and from the countdown through GO:
 * - a thumb landed low on the move dial during the countdown (over the VS poster) pushes up 36 px at GO;
 * - a fresh thumb landing low and left of the centre, then one on the centre, push up 36 px;
 * - the JET button, where it's shown, is held;
 * then a reload mid-match and a new Training, and the keyboard (Space, ↑) on a desktop page.
 * Every sim tick's sampled Input is read through a wrapper on the mode's sampler (the Jet bit), and the
 * player's fuel must drop (the sim flew). Claw's stick doesn't jet (its JET button does).
 *
 *   cd apps/web && pnpm exec vite --port 5231 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/fly-check.mjs http://127.0.0.1:5231
 *
 * Exits 1 if a check fails.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5231').replace(/\/$/, '');
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const VIEW = { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true };
const JET = 1 << 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

/** the layouts: a preset and what picking it sets (touch/settings.ts PRESET_SETTINGS), plus Fire button mode on Classic */
const LAYOUTS = [
  { name: 'Classic', s: { preset: 'classic', fire: 'auto', stickJet: true, tapFire: false }, stickJets: true },
  { name: 'Classic, Fire button', s: { preset: 'classic', fire: 'button', stickJet: true, tapFire: false, leftFire: true }, stickJets: true },
  { name: 'Claw', s: { preset: 'claw', fire: 'button', stickJet: false, tapFire: true, leftFire: false }, stickJets: false },
  { name: 'One-thumb assist', s: { preset: 'oneThumb', fire: 'auto', stickJet: true, tapFire: false }, stickJets: true },
];

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'fly-check-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });

async function open(touch, settings) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.evaluateOnNewDocument((settings) => {
    if (location.protocol === 'about:') return;
    const now = Date.now();
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.setItem('mf.install.v1', JSON.stringify({ sessions: 1, dismissedAt: 1, matchesAtDismiss: 0, accepted: false }));
    localStorage.setItem('mf.facts.v1', JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }));
    localStorage.setItem('mf.age.v1', JSON.stringify({ adult: true, birthYear: 1990, at: Date.now() })); // the 18+ step, answered
    if (settings && !sessionStorage.getItem('fly-check-set')) {
      sessionStorage.setItem('fly-check-set', '1');
      localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ ...settings, fireChosen: true, rev: 5 }));
    }
  }, settings);
  const cdp = await page.createCDPSession();
  if (touch) {
    await page.emulate({ viewport: VIEW, userAgent: UA });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  } else await page.setViewport({ width: 1440, height: 900 });
  return { ctx, page, cdp };
}

async function toTraining(page, touch) {
  if (!page.url().includes('?app')) await page.goto(`${base}/?app&render=2d`, { waitUntil: 'load' });
  const home = touch ? '[data-screen="m-home"]' : '[data-screen="home"]';
  const name = touch ? '[data-screen="m-name"] input' : '[data-screen="name-entry"] input';
  await page.waitForSelector(`${name}, ${home}`, { timeout: 120_000 });
  if (!(await page.$(home))) {
    await page.type(name, `F${Math.floor(Math.random() * 90000 + 10000)}`);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 15 && !(await page.$(home)); i++) {
      await sleep(800);
      await page.$eval('button[type=submit]', (b) => b.click()).catch(() => {});
    }
  }
  await page.waitForSelector(home, { timeout: 60_000 });
  await page.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
  await page.waitForFunction(() => window.__game?.mode?.match && window.__game.mode.me, { timeout: 120_000 });
  // every tick's sampled buttons
  await page.evaluate(() => {
    const s = window.__game.mode.sampler;
    if (s.__wrapped) return;
    s.__wrapped = true;
    const orig = s.sample.bind(s);
    window.__samples = [];
    s.sample = (...a) => {
      const out = orig(...a);
      window.__samples.push(out.buttons);
      if (window.__samples.length > 4000) window.__samples.splice(0, 2000);
      return out;
    };
  });
}

const phase = (page) => page.evaluate(() => window.__game.mode.match?.phase ?? -1);
const fuel = (page) => page.evaluate(() => window.__game.mode.me.fuel);
const dial = (page) =>
  page.$eval('.mf-ctl-move .dial__base', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
  });
const pt = (x, y) => ({ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 8, radiusY: 8, force: 1 });

/** Push a thumb (already down at `from` when `held`) up 36 px over ~100 ms, hold 600 ms: did it jet (Input) and fly (fuel)? */
async function pushUp(page, cdp, from, held) {
  await page.evaluate(() => (window.__samples = []));
  const f0 = await fuel(page);
  if (!held) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(from.x, from.y)] });
  for (let i = 1; i <= 6; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt(from.x, from.y - i * 6)] });
    await sleep(16);
  }
  await sleep(600);
  const f1 = await fuel(page);
  const jet = await page.evaluate((JET) => window.__samples.some((b) => b & JET), JET);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(700); // land and refuel a little
  return { jet, flew: f1 < f0, detail: `fuel ${f0.toFixed(0)} → ${f1.toFixed(0)}` };
}

async function holdJetButton(page, cdp) {
  const r = await page.$eval('.mf-ctl-jet', (el) => ({ off: el.classList.contains('mf-off') || getComputedStyle(el).display === 'none', ...(() => { const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })() }));
  if (r.off) return null;
  await page.evaluate(() => (window.__samples = []));
  const f0 = await fuel(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...pt(r.x, r.y), id: 2 }] });
  await sleep(600);
  const f1 = await fuel(page);
  const jet = await page.evaluate((JET) => window.__samples.some((b) => b & JET), JET);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(700);
  return { jet, flew: f1 < f0, detail: `fuel ${f0.toFixed(0)} → ${f1.toFixed(0)}` };
}

/** One Training run from the countdown through GO; `reload`: reload mid-match and fly in a new one */
async function run(layout, sticks, reload = false) {
  const label = `${layout.name}, ${sticks === 'fixed' ? 'Fixed' : 'Follow thumb'}`;
  const settings = { mode: 'auto', precisionRelease: true, assist: 'standard', handed: 'right', sticks, vibrate: true, swipeDash: true, keepAim: true, opacity: 0.5, autoFade: true, gestures: true, haptics: true, lookAhead: true, pinchZoom: true, shake: 1, view: 0.8, viewAuto: true, leftFire: false, ...layout.s };
  const { ctx, page, cdp } = await open(true, settings);
  try {
    await toTraining(page, true);
    const got = await page.evaluate(() => window.__touch.getTouchSettings());
    check(`${label}: the settings load (preset ${got.preset}, sticks ${got.sticks}, fire ${got.fire}, push up to fly ${got.stickJet})`, got.preset === layout.s.preset && got.sticks === sticks && got.fire === layout.s.fire && got.stickJet === layout.s.stickJet);
    await page.waitForFunction(() => window.__game.mode.match?.phase === 1, { timeout: 60_000, polling: 16 }).catch(() => {});
    const wasCountdown = (await phase(page)) === 1;
    const D = await dial(page);
    // a thumb resting low on the dial through the countdown, put down while the VS poster is up (the
    // owner, 27 Oct: the poster took the touch, and the thumb never became the stick)
    if (wasCountdown) await page.waitForSelector('.vs:not(.is-held):not(.is-leaving)', { timeout: 4000 }).catch(() => {});
    const low = { x: D.x, y: D.y + 0.6 * D.r };
    if (wasCountdown) await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(low.x, low.y)] });
    await page.waitForFunction(() => window.__game.mode.match?.phase === 2, { timeout: 60_000, polling: 16 });
    await sleep(100);
    const expect = layout.stickJets;
    const say = (r) => `${r.jet ? 'Jet' : 'no Jet'} in the input, ${r.detail}`;
    let r = await pushUp(page, cdp, low, wasCountdown);
    check(`${label}: a thumb ${wasCountdown ? 'held low on the dial through the countdown' : 'low on the dial'} pushes up 36 px at GO: ${expect ? 'flies' : 'no jet (JET is a button)'}`, r.jet === expect && r.flew === expect, say(r));
    r = await pushUp(page, cdp, { x: D.x - 0.3 * D.r, y: D.y + 0.8 * D.r }, false);
    check(`${label}: a fresh thumb landing low-left on the dial pushes up 36 px: ${expect ? 'flies' : 'no jet'}`, r.jet === expect && r.flew === expect, say(r));
    r = await pushUp(page, cdp, { x: D.x, y: D.y }, false);
    check(`${label}: a thumb on the dial's centre pushes up 36 px: ${expect ? 'flies' : 'no jet'}`, r.jet === expect && r.flew === expect, say(r));
    const b = await holdJetButton(page, cdp);
    if (b) check(`${label}: holding JET flies`, b.jet && b.flew, say(b));
    else check(`${label}: JET is hidden only in One-thumb with push up to fly`, layout.s.preset === 'oneThumb' && layout.s.stickJet);
    if (reload) {
      await page.reload({ waitUntil: 'load' });
      await toTraining(page, true);
      await page.waitForFunction(() => window.__game.mode.match?.phase === 2, { timeout: 60_000, polling: 16 });
      await sleep(100);
      const D2 = await dial(page);
      r = await pushUp(page, cdp, { x: D2.x, y: D2.y + 0.6 * D2.r }, false);
      check(`${label}: reloaded mid-match, a new Training: a thumb low on the dial pushes up at GO and flies`, r.jet && r.flew, say(r));
    }
  } catch (e) {
    check(`${label}: run`, false, e.message);
    await page.screenshot({ path: join(tmpdir(), `fly-check-${layout.s.preset}-${sticks}.png`) }).catch(() => {});
  } finally {
    await ctx.close();
  }
}

try {
  for (const layout of LAYOUTS) for (const sticks of ['fixed', 'follow']) await run(layout, sticks, layout === LAYOUTS[0]);
  // the keyboard (Space and ↑) at GO, on a desktop page
  const { ctx, page } = await open(false, null);
  try {
    await toTraining(page, false);
    await page.waitForFunction(() => window.__game.mode.match?.phase === 2, { timeout: 60_000, polling: 16 });
    for (const key of ['Space', 'ArrowUp']) {
      await page.evaluate(() => (window.__samples = []));
      const f0 = await fuel(page);
      await page.keyboard.down(key);
      await sleep(600);
      const f1 = await fuel(page);
      await page.keyboard.up(key);
      const jet = await page.evaluate((JET) => window.__samples.some((b) => b & JET), JET);
      check(`keyboard: ${key} at GO flies`, jet && f1 < f0, `fuel ${f0.toFixed(0)} → ${f1.toFixed(0)}`);
      await sleep(900);
    }
  } finally {
    await ctx.close();
  }
} catch (e) {
  check('run', false, e.message);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
