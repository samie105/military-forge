/**
 * Voice chat end to end (v18), in headless Chrome with its fake microphone (a beeping tone): two
 * players in one room, one holds V, the other must hear them: frames through the game server's
 * relay, decoded (Opus through WebCodecs where Chrome has it), and played. Then a match with bots,
 * the same again mid-match, with screenshots of both screens (the push-to-talk plate, who's
 * talking, the speaking tag) and of the comms card in the pause menu.
 *
 * Needs the dev API (8895), a v18 game server and the dev web server pointed at both:
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/voice-e2e.mjs http://127.0.0.1:5196 [out dir]
 * With ADMIN_URL and ADMIN_TOKEN (that game server's admin API) the match runs with voices carrying
 * VOICE_RADIUS metres (default 80), so the two soldiers hear each other wherever they spawn.
 * Exits 1 when the listener hears nothing (in the lobby, or mid-match within the radius), on a page
 * error, or a console error.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5196').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'voice-e2e-shots');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const problems = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'voice-e2e-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  protocolTimeout: 600_000,
  defaultViewport: { width: 1920, height: 1080 },
});

let ip = 40;
async function guest(name) {
  const res = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.19.0.${ip++}` }, body: JSON.stringify({ nickname: name }) });
  if (!res.ok) throw new Error(`guest ${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function player(name) {
  const g = await guest(name);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${name} page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|WebTransport|ERR_CONNECTION_REFUSED|health/.test(m.text())) problems.push(`${name} console error: ${m.text()}`);
  });
  await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded' });
  await page.evaluate((t) => {
    localStorage.setItem('session.refreshToken.v1', t);
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf-creator-seen', '1');
  }, g.refreshToken);
  return { page, name };
}

const stamp = Date.now().toString(36).slice(-4);
const a = await player(`Ade_${stamp}`);
const b = await player(`Kemi_${stamp}`);

// A makes a room, B joins it by its link
await a.page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await (await a.page.waitForSelector('.home__create', { timeout: 60_000 })).click();
await a.page.waitForFunction(() => /^\/r\/[A-Z]{6}$/.test(location.pathname), { timeout: 60_000 });
const code = await a.page.evaluate(() => location.pathname.slice(3));
await b.page.goto(`${base}/r/${code}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
for (const p of [a, b]) await p.page.waitForFunction(() => window.__voice?.state.active, { timeout: 60_000 });
console.log(`room ${code}: both in, voice on`);

// a tap on each page: browsers start sound (and the mic) only after one
for (const p of [a, b]) await p.page.mouse.click(960, 1050);
await sleep(1500);

/** A holds V for `ms`; returns what B heard. */
async function talk(ms) {
  const before = await b.page.evaluate(() => ({ ...window.__voice.counters }));
  await a.page.keyboard.down('KeyV');
  await sleep(ms);
  const mid = { a: await a.page.evaluate(() => ({ talking: window.__voice.state.talking, mic: window.__voice.state.mic, tier: window.__voice.state.tier, sent: window.__voice.counters.sent })), b: await b.page.evaluate(() => ({ speaking: Object.keys(window.__voice.state.speaking), stats: window.__voice.playoutStats() })) };
  await a.page.keyboard.up('KeyV');
  await sleep(500);
  const after = await b.page.evaluate(() => ({ ...window.__voice.counters }));
  return { mid, heard: after.heard - before.heard, opus: after.opusFrames - before.opusFrames, fallback: after.fallbackFrames - before.fallbackFrames };
}

const lobby = await talk(2500);
console.log('lobby:', JSON.stringify(lobby));
if (lobby.heard < 10) problems.push(`in the lobby B heard ${lobby.heard} frames from A (want ≥ 10)`);
if (lobby.mid.a.mic !== 'live') problems.push(`A's mic is ${lobby.mid.a.mic}, not live`);

// a match with bots: both mid-match. Voices carry farther (the admin page's "Voices carry"), if we may.
let radius = 24;
if (process.env.ADMIN_URL && process.env.ADMIN_TOKEN) {
  radius = Number(process.env.VOICE_RADIUS ?? 80);
  const res = await fetch(`${process.env.ADMIN_URL.replace(/\/$/, '')}/admin/api/values`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ 'voice.radius': radius }),
  });
  if (!res.ok) throw new Error(`admin: ${res.status} ${await res.text()}`);
  console.log(`admin: voices carry ${radius} m`);
}
/** Where a player's own soldier is (its predicted position). */
const where = (p) => p.page.evaluate(() => {
  const pl = window.__game?.mode?.net?.predictor?.player;
  return pl ? { x: pl.x, y: pl.y, alive: pl.alive } : null;
});
// the smallest map (Flux Lab, ~114 m across), so they're often within earshot
await a.page.evaluate(() => document.querySelector('[data-screen="lobby"] .mapcard[data-map="flux-lab"]')?.click());
await sleep(500);
await a.page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Fill to 4');
  btn?.click();
});
await (await a.page.waitForSelector('xpath/.//button[@title="Start the countdown now"][not(@disabled)]', { visible: true, timeout: 30_000 })).click();
await a.page.waitForFunction(() => !document.querySelector('[data-screen="lobby"]'), { timeout: 60_000 });
await sleep(6000);
// wait (up to 40 s: the bots kill them, they respawn elsewhere) until both are alive and within earshot
let pa = null;
let pb = null;
const apartNow = async () => {
  [pa, pb] = [await where(a), await where(b)];
  return pa && pb && pa.alive && pb.alive ? Math.hypot(pa.x - pb.x, pa.y - pb.y) : Infinity;
};
for (let t = 0; t < 80 && (await apartNow()) > radius - 6; t++) await sleep(500);
// hold for the screenshots: the plate (A), the strip and the tag (B)
await b.page.evaluate(() => (window.__voice.speakingHoldMs = 4000));
const heardBefore = await b.page.evaluate(() => window.__voice.counters.heard);
await a.page.keyboard.down('KeyV');
await sleep(1200);
await a.page.screenshot({ path: join(out, 'd12-voice-talking.png') });
await b.page.screenshot({ path: join(out, 'd13-voice-hearing.png') });
const apart = await apartNow();
const match = { heard: (await b.page.evaluate(() => window.__voice.counters.heard)) - heardBefore, speaking: await b.page.evaluate(() => window.__voice.state.speaking), apart: Number.isFinite(apart) ? Math.round(apart * 10) / 10 : null, radius };
await a.page.keyboard.up('KeyV');
console.log('match:', JSON.stringify(match));
if (apart < radius - 2 && match.heard < 5) problems.push(`mid-match B heard ${match.heard} frames from A ${match.apart} m away (voices carry ${radius} m)`);

// the comms card in the pause menu (B mutes A from it)
await b.page.keyboard.press('Escape');
await b.page.waitForSelector('.vc-pause', { timeout: 15_000 });
await sleep(600);
await b.page.screenshot({ path: join(out, 'd14-pause-comms.png') });
await b.page.click('.vc-pause__row .btn--ghost');
await sleep(300);
const muted = await b.page.evaluate(() => window.__voice.state.mutes.length);
if (muted !== 1) problems.push(`muting from the pause menu left ${muted} mutes`);
await b.page.keyboard.press('Escape');

// Settings › Audio › Voice chat
await a.page.keyboard.press('Escape');
await a.page.waitForSelector('.pause');
await (await a.page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Settings")]', { visible: true })).click();
await (await a.page.waitForSelector('xpath/.//button[@role="tab"][contains(normalize-space(.), "Audio")]', { visible: true })).click();
await a.page.waitForSelector('.vc-settings');
await a.page.evaluate(() => document.querySelector('.vc-settings__h')?.scrollIntoView({ block: 'start' }));
await sleep(600);
await a.page.screenshot({ path: join(out, 'd15-settings-voice.png') });
await a.page.keyboard.press('Escape');
await a.page.keyboard.press('Escape');

// ---- a phone in the same match: who's talking, the mic button, holding it, its settings ----
const c = await player(`Seun_${stamp}`);
await c.page.emulate({
  viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
});
const cdp = await c.page.createCDPSession();
await cdp.send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'pointer', value: 'coarse' },
    { name: 'any-pointer', value: 'coarse' },
    { name: 'hover', value: 'none' },
    { name: 'orientation', value: 'landscape' },
  ],
});
await c.page.evaluate(() => {
  // the touch hints, seen (they'd cover the shots)
  const hints = ['dash-swipe', 'grenade-types', 'swap-radial', 'take', 'shield-hold', 'move', 'jet', 'fire', 'dash', 'chain', 'cycle', 'throw', 'swap', 'radial', 'reload', 'melee', 'shield', 'zoom', 'scores', 'camera'];
  localStorage.setItem('mf.touch.hints.v1', JSON.stringify(hints));
  localStorage.setItem('mf.touch.drill.v1', 'done');
});
await c.page.goto(`${base}/r/${code}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
await c.page.waitForFunction(() => window.__voice?.state.active, { timeout: 60_000 });
await c.page.touchscreen.tap(400, 30);
await sleep(4000);
// within earshot of A (up to 40 s), then A talks
const cApart = async () => {
  const [x, y] = [await where(a), await where(c)];
  return x && y && x.alive && y.alive ? Math.hypot(x.x - y.x, x.y - y.y) : Infinity;
};
// (a bot may kill one of them mid-sentence: then wait and try again, a few times)
// a headless page under load gets its frames in bursts: keep the strip up between them for the shot
await c.page.evaluate(() => (window.__voice.speakingHoldMs = 4000));
for (let attempt = 0; attempt < 4; attempt++) {
  for (let t = 0; t < 80 && (await cApart()) > radius - 6; t++) await sleep(500);
  const sentBefore = await a.page.evaluate(() => window.__voice.counters.sent);
  await a.page.keyboard.down('KeyV');
  await sleep(1200);
  const hearing = await c.page.evaluate(() => Object.keys(window.__voice.state.speaking).length > 0);
  const why = {
    a: await a.page.evaluate((n) => ({ talking: window.__voice.state.talking, sent: window.__voice.counters.sent - n, overlay: window.__game?.shell?.store.getState().overlay ?? null }), sentBefore),
    c: await c.page.evaluate(() => ({ heard: window.__voice.counters.heard, overlay: window.__game?.shell?.store.getState().overlay ?? null, phase: window.__game?.shell?.store.getState().match?.phase ?? null })),
  };
  if (hearing || attempt === 3) await c.page.screenshot({ path: join(out, 'p7-voice-hearing.png') });
  await a.page.keyboard.up('KeyV');
  console.log(`phone: ${hearing ? 'hears A' : 'nothing yet'} (${Math.round(await cApart())} m) ${JSON.stringify(why)}`);
  if (hearing) break;
  await sleep(1000);
}
// hold the mic button (a touch held down)
const mic = await c.page.waitForSelector('.vc-mic__btn', { visible: true, timeout: 15_000 });
const box = await mic.boundingBox();
await c.page.touchscreen.touchStart(box.x + box.width / 2, box.y + box.height / 2);
await sleep(1200);
await c.page.screenshot({ path: join(out, 'p8-voice-talking.png') });
const cTalking = await c.page.evaluate(() => window.__voice.state.talking);
await c.page.touchscreen.touchEnd();
if (!cTalking) problems.push('holding the phone mic button did not talk');
// the phone's pause menu: the comms card
await c.page.evaluate(() => window.__game?.shell?.controller?.openOverlay('menu'));
await c.page.waitForSelector('.vc-pause', { timeout: 15_000 });
await sleep(600);
await c.page.screenshot({ path: join(out, 'p9-pause-comms.png') });

await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('voice e2e: ok');
