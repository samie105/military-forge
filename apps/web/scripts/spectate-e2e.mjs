/**
 * Spectating end to end (v20) in headless Chrome: A makes a room and plays a match with bots; B
 * types the code on Join with code and presses Watch. B must be a spectator (no player, nothing
 * predicted), follow A from the picker, fly the free camera, and take a slot with "Jump in now".
 * A phone (812×375) watches too. Screenshots of each, and of A's death cam when a bot gets A.
 *
 * Works on the production build (no dev hooks: it reads the HUD's state tokens and text), e.g. a
 * local playtest's:
 *   pnpm playtest --local --no-build --port 8573 --bots 4 --map street-market
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/spectate-e2e.mjs http://127.0.0.1:8573 docs/screenshots/spectate
 * Exits 1 on a failed check, a page error or a console error.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8573').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'spectate-e2e-shots');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);
mkdirSync(out, { recursive: true });

const problems = [];
const check = (ok, what) => {
  if (!ok) problems.push(what);
  log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'spectate-e2e-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  protocolTimeout: 600_000,
  defaultViewport: { width: 1920, height: 1080 },
});

let ip = 60;
async function guest(name) {
  const res = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.19.1.${ip++}` }, body: JSON.stringify({ nickname: name }) });
  if (!res.ok) throw new Error(`guest ${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function person(name, phone = false) {
  const g = await guest(name);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name} page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebTransport|ERR_CONNECTION_REFUSED|health|net::/.test(m.text())) problems.push(`${name} console error: ${m.text()}`);
  });
  if (phone) {
    await page.emulate({
      viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    });
  }
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.evaluate((t) => {
    localStorage.setItem('session.refreshToken.v1', t);
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('mf.touch.drill.v1', 'done');
  }, g.refreshToken);
  return { page, name };
}

const stamp = Date.now().toString(36).slice(-4);
const a = await person(`Ade_${stamp}`);
const b = await person(`Kemi_${stamp}`);
/** the HUD's state tokens on this page (#hud data-active-state) */
const tokens = (p) => p.evaluate(() => (document.querySelector('#hud')?.getAttribute('data-active-state') ?? '').split(/\s+/));
const waitToken = (p, t, timeout = 60_000) => p.waitForFunction((tok) => (document.querySelector('#hud')?.getAttribute('data-active-state') ?? '').split(/\s+/).includes(tok), { timeout }, t);
const text = (p, sel) => p.evaluate((q) => document.querySelector(q)?.textContent?.trim() ?? null, sel);

// A makes a room and starts the match (the playtest's bots fill it)
await a.page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await (await a.page.waitForSelector('.home__create', { timeout: 60_000 })).click();
await a.page.waitForFunction(() => /^\/r\/[A-Z]{6}$/.test(location.pathname), { timeout: 60_000 });
const code = await a.page.evaluate(() => location.pathname.slice(3));
log(`room ${code}`);
await (await a.page.waitForSelector('xpath/.//button[@title="Start the countdown now"][not(@disabled)]', { visible: true, timeout: 60_000 })).click();
await a.page.waitForFunction(() => !document.querySelector('[data-screen="lobby"]'), { timeout: 60_000 });
await sleep(6000);

// B: Join with code → the code → Watch
await b.page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await (await b.page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Join with code")]', { visible: true, timeout: 60_000 })).click();
await b.page.waitForSelector('[data-screen="join"] input', { visible: true, timeout: 30_000 });
await b.page.click('[data-screen="join"] input');
await b.page.keyboard.type(code, { delay: 40 });
await (await b.page.waitForSelector('xpath/.//*[@data-screen="join"]//button[normalize-space(.)="Watch"][not(@disabled)]', { visible: true, timeout: 30_000 })).click();
const joinedAt = Date.now();
await waitToken(b.page, 'spec-watch');
check(true, `B watches (the spectator bar is up ${((Date.now() - joinedAt) / 1000).toFixed(1)} s after Watch)`);
check(!(await tokens(b.page)).includes('alive'), 'B has no soldier of its own');
const delay = await text(b.page, '.mf-hud-desktop .mf-spec-tag--delay');
check(/3 s delay/i.test(delay ?? ''), `B's feed runs 3 s behind ("${delay}")`);
await waitToken(b.page, 'spec-target', 30_000);
check(true, 'B follows a soldier once the feed starts');

// B follows A from the picker (a click on A's row)
const aRow = await b.page.waitForSelector(`xpath/.//button[@data-spec-follow][contains(., "${a.name}")]`, { timeout: 30_000 });
await aRow.click();
await sleep(1500);
const watched = await text(b.page, '.mf-hud-desktop .mf-spec__who .display');
check(watched === a.name, `B watches A after a click on A's row ("${watched}")`);
await b.page.screenshot({ path: join(out, 'desktop-following.png') });

// the free camera: F, then pan with the keys
await b.page.keyboard.press('KeyF');
await waitToken(b.page, 'spec-free', 5000);
await b.page.keyboard.down('KeyD');
await sleep(900);
await b.page.keyboard.up('KeyD');
await sleep(900);
check(true, 'F frees the camera');
await b.page.screenshot({ path: join(out, 'desktop-free-camera.png') });
await b.page.keyboard.press('KeyF');

// a phone watches too: Join → the code → Watch
const c = await person(`Seun_${stamp}`, true);
await c.page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await (await c.page.waitForSelector('xpath/.//button[contains(@class, "pm-tk")][contains(., "Join")]', { visible: true, timeout: 60_000 })).tap();
await c.page.waitForSelector('[data-screen="m-join"] input, .pm-join input', { visible: true, timeout: 30_000 });
await c.page.tap('[data-screen="m-join"] input, .pm-join input');
await c.page.keyboard.type(code, { delay: 40 });
await (await c.page.waitForSelector('.pm-join__watch:not([disabled])', { visible: true, timeout: 30_000 })).tap();
await waitToken(c.page, 'spec-target');
await sleep(1500);
await c.page.screenshot({ path: join(out, 'phone-spectator.png') });
const watching = await text(b.page, '.mf-hud-desktop .mf-spec-tag--eyes');
check(/2 watching/.test(watching ?? ''), `two spectators in the room ("${watching}")`);
await c.page.tap('.mf-spec-pill--free');
await waitToken(c.page, 'spec-free', 5000);
await sleep(800);
await c.page.screenshot({ path: join(out, 'phone-free-camera.png') });

// A's death cam: wait (up to 60 s) for a bot to get A
let died = false;
for (let t = 0; t < 120 && !died; t++) {
  const tk = await tokens(a.page);
  died = tk.includes('spec-death') && tk.includes('spec-target');
  if (!died) await sleep(500);
}
if (died) {
  const who = await text(a.page, '.mf-hud-desktop .mf-spec__who .display');
  await a.page.screenshot({ path: join(out, 'desktop-death-cam.png') });
  check(!!who && who !== a.name, `A died and watches its killer on the death cam ("${who}")`);
} else log('A never died in 60 s: no death cam shot this run');

// B takes a free slot: Jump in now
const label = await text(b.page, '.mf-hud-desktop [data-spec="join"]');
check(/Jump in now/.test(label ?? ''), `a free slot reads Jump in now ("${label}")`);
await b.page.click('.mf-hud-desktop [data-spec="join"]');
await waitToken(b.page, 'alive', 30_000);
await sleep(2500);
const after = await tokens(b.page);
check(!after.includes('spectate-bar'), 'B plays now: the spectator bar is gone and its soldier is alive');
await b.page.screenshot({ path: join(out, 'desktop-joined.png') });

await browser.close();
for (const p of problems) console.error(`problem: ${p}`);
console.log(problems.length ? `${problems.length} problem(s)` : 'spectating e2e: all good');
process.exit(problems.length ? 1 : 0);
