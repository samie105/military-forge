/**
 * Jet on the first frame of a match (the owner, 24 Oct: "sometimes someone can't fly as the game
 * starts, and sometimes the flying feature just doesn't work until someone pauses and unpauses"):
 * make a room, Start, and the moment the countdown ends (GO) hold jet: the move stick pushed up on a
 * touch phone (780×360, touch, 4× CPU), Space on a keyboard. Jetting burns fuel, so the HUD's fuel
 * must drop within a second and a half. Needs the dev server against a playtest stack:
 *
 *   node apps/web/scripts/jet-at-go.mjs http://localhost:5226 [rounds]
 *
 * Exits 1 when a round can't jet.
 */
/* global process */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5226').replace(/\/$/, '');
const rounds = Number(process.argv[3] ?? 2);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const problems = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'jet-at-go-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });

async function open(touch) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.evaluateOnNewDocument(() => {
    if (location.protocol === 'about:') return;
    const now = Date.now();
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.setItem('mf.install.v1', JSON.stringify({ sessions: 1, dismissedAt: 1, matchesAtDismiss: 0, accepted: false }));
    localStorage.setItem('mf.facts.v1', JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }));
  });
  const cdp = await page.createCDPSession();
  if (touch) {
    await page.emulate({ viewport: { width: 780, height: 360, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: UA });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  } else await page.setViewport({ width: 1440, height: 900 });
  return { page, cdp };
}

const home = touch => (touch ? '[data-screen="m-home"]' : '[data-screen="home"]');
async function toHome(page, touch) {
  await page.goto(`${base}/?app`, { waitUntil: 'load' });
  const name = touch ? '[data-screen="m-name"] input' : '[data-screen="name-entry"] input';
  await page.waitForSelector(`${name}, ${home(touch)}`, { timeout: 90_000 });
  if (!(await page.$(home(touch)))) {
    await page.type(name, `J${Math.floor(Math.random() * 90000 + 10000)}`);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 15 && !(await page.$(home(touch))); i++) {
      await sleep(800);
      await page.$eval('button[type=submit]', (b) => b.click()).catch(() => {});
    }
  }
  await page.waitForSelector(home(touch), { timeout: 30_000 });
}
const fuel = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-bind="player.fuel"]');
  const n = Number(el?.textContent?.trim());
  return Number.isFinite(n) ? n : null;
});

async function round(touch, n, through) {
  const { page, cdp } = await open(touch);
  await toHome(page, touch);
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Create room")]')).click();
  await page.waitForSelector(touch ? '[data-screen="m-lobby"]' : '[data-screen="lobby"]', { timeout: 60_000 });
  await sleep(1500);
  await (await page.waitForSelector(`xpath/.//button[normalize-space(.)="Start" or contains(normalize-space(.), "Start now") or contains(normalize-space(.), "Start the")]`, { timeout: 15_000 })).click();
  // the countdown's last second (past the VS poster and the map's intro)
  await page.waitForSelector('[data-screen="countdown"][data-active-state~="1"]', { timeout: 40_000 });
  const press = async () => {
    if (touch) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 150, y: 260, id: 1, radiusX: 8, radiusY: 8, force: 1 }] });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 150, y: 260 - i * 14, id: 1, radiusX: 8, radiusY: 8, force: 1 }] });
      await sleep(16);
    }
    } else await page.keyboard.down('Space');
  };
  // `through`: held from the countdown's 1 through GO (a player ready to go); else pressed at GO
  if (through) await press();
  await page.waitForFunction(() => !document.querySelector('[data-screen="countdown"]') || /\bgo\b/i.test(document.querySelector('[data-screen="countdown"]')?.getAttribute('data-active-state') ?? ''), { timeout: 30_000, polling: 16 });
  const before = await fuel(page);
  if (!through) await press();
  let after = before;
  for (let i = 0; i < 15 && after !== null && before !== null && after >= before; i++) {
    await sleep(100);
    after = await fuel(page);
  }
  if (touch) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.keyboard.up('Space');
  const ok = before !== null && after !== null && after < before;
  console.log(`${touch ? 'touch' : 'keyboard'} round ${n} (${through ? 'held through GO' : 'pressed at GO'}): fuel ${before} → ${after} ${ok ? 'ok: jetting from GO' : 'NO JET'}`);
  // the device's event log (diag/): what the input looked like at the countdown and at GO (dev builds)
  const log = await page.evaluate(async () => (await import('/src/diag/log.ts')).diagEvents().filter((e) => e.k === 'input').map((e) => e.m)).catch(() => []);
  for (const line of log) console.log(`    log: ${line}`);
  if (!ok) {
    problems.push(`${touch ? 'touch' : 'keyboard'} round ${n} (${through ? 'held through GO' : 'pressed at GO'}): no jet at GO (fuel ${before} → ${after})`);
    await page.screenshot({ path: `/tmp/jet-at-go-${touch ? 'touch' : 'kb'}-${n}.png` }).catch(() => {});
  }
  await page.close();
}

/**
 * The owner's way in: Warm up (the lobby folds, play starts), a thumb on the move stick, Ready with
 * another finger: the countdown (and the VS poster) start under the held thumb; at GO that thumb
 * pushes up, and then a fresh one does.
 */
async function warmRound(n) {
  const { page, cdp } = await open(true);
  await toHome(page, true);
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Create room")]')).click();
  await page.waitForSelector('[data-screen="m-lobby"]', { timeout: 60_000 });
  await sleep(1500);
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Warm up")]', { timeout: 15_000 })).click();
  await page.waitForSelector('[data-screen="m-lobby"][data-active-state~="folded"]', { timeout: 15_000 });
  await sleep(1500);
  const thumb = (type, y, more = []) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [{ x: 150, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }, ...more] });
  await thumb('touchStart', 260);
  await thumb('touchMove', 250);
  // the host starts while the thumb stays down (the lobby's Start, through the dev build's mode handle)
  await page.evaluate(() => (window.__mfMode?.())?.startMatch?.());
  await page.waitForSelector('[data-screen="countdown"][data-active-state~="1"]', { timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('[data-screen="countdown"]') || /\bgo\b/i.test(document.querySelector('[data-screen="countdown"]')?.getAttribute('data-active-state') ?? ''), { timeout: 30_000, polling: 16 });
  // the held thumb pushes up at GO
  let before = await fuel(page);
  for (let i = 1; i <= 6; i++) {
    await thumb('touchMove', 250 - i * 14);
    await sleep(16);
  }
  let after = before;
  for (let i = 0; i < 15 && after !== null && before !== null && after >= before; i++) {
    await sleep(100);
    after = await fuel(page);
  }
  const held = before !== null && after !== null && after < before;
  console.log(`touch warm-up round ${n}, the thumb held from warm-up: fuel ${before} → ${after} ${held ? 'ok' : 'NO JET'}`);
  if (!held) problems.push(`touch warm-up round ${n}: the held thumb can't jet at GO (fuel ${before} → ${after})`);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(1500);
  // a fresh thumb
  before = await fuel(page);
  await thumb('touchStart', 260);
  for (let i = 1; i <= 6; i++) {
    await thumb('touchMove', 260 - i * 14);
    await sleep(16);
  }
  after = before;
  for (let i = 0; i < 15 && after !== null && before !== null && after >= before; i++) {
    await sleep(100);
    after = await fuel(page);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  const fresh = before !== null && after !== null && after < before;
  console.log(`touch warm-up round ${n}, a fresh thumb after: fuel ${before} → ${after} ${fresh ? 'ok' : 'NO JET'}`);
  if (!fresh) {
    problems.push(`touch warm-up round ${n}: a fresh thumb can't jet after GO (fuel ${before} → ${after})`);
    await page.screenshot({ path: `/tmp/jet-at-go-warm-${n}.png` }).catch(() => {});
  }
  await page.close();
}

try {
  for (let i = 1; i <= rounds; i++) await warmRound(i);
  for (let i = 1; i <= rounds; i++) for (const through of [false, true]) await round(true, i, through);
  for (let i = 1; i <= rounds; i++) for (const through of [false, true]) await round(false, i, through);
} catch (e) {
  problems.push(`run: ${e.message}`);
} finally {
  await browser.close();
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\njet at GO: passed');
