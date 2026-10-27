/* global process */
/**
 * Thumbs put down on the death cam take their sticks at the respawn (the owner, 27 Oct 2026, an Android
 * phone: "I can't still hold the joystick up to fly"). The death cam hides the touch controls; a thumb
 * landing then was read against the hidden layout (no size: every touch fell on the aim side), so the
 * left thumb became the aim stick and stayed it after the respawn until it was lifted.
 *
 * A phone-sized headless Chrome (812×375, touch, real CDP touches) plays a room with bots on Classic,
 * fixed sticks. Each time a bot gets it: the left thumb lands on the move dial and pushes up, the right
 * thumb lands on the aim side, both hold through the respawn. Within 0.5 s of it the left must be the
 * move stick and jetting (Jet in every sampled Input, the fuel burning), the right the aim stick.
 *
 * Needs the dev page (its debug hooks) on a local room: a playtest for the API and the game server, and
 * vite proxied to them (the playtest prints the game server's ws port; the API's is one below it):
 *   pnpm playtest --local --no-build --port 5395
 *   cd apps/web && DEV_API=http://127.0.0.1:<ws-1> DEV_GAME_SERVER=http://127.0.0.1:<ws> DEV_PROXY_ORIGIN=http://127.0.0.1:5395 pnpm exec vite --port 5232 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/respawn-fly-check.mjs http://127.0.0.1:5232 <ROOM> [deaths]
 *
 * Exits 1 if a check fails.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5232').replace(/\/$/, '');
const room = process.argv[3];
const deaths = Number(process.argv[4] ?? 2);
if (!room) {
  console.error('usage: respawn-fly-check.mjs <dev page> <room code> [deaths]');
  process.exit(2);
}
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
const SETTINGS = { mode: 'auto', fire: 'auto', fireChosen: true, preset: 'classic', stickJet: true, tapFire: false, precisionRelease: true, assist: 'standard', handed: 'right', sticks: 'fixed', vibrate: true, swipeDash: true, keepAim: true, opacity: 0.5, autoFade: true, gestures: true, haptics: true, lookAhead: true, pinchZoom: true, shake: 1, view: 0.8, viewAuto: true, leftFire: false, rev: 5 };

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'respawn-fly-check-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.evaluateOnNewDocument((settings) => {
    if (location.protocol === 'about:') return;
    const now = Date.now();
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.setItem('mf.install.v1', JSON.stringify({ sessions: 1, dismissedAt: 1, matchesAtDismiss: 0, accepted: false }));
    localStorage.setItem('mf.facts.v1', JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }));
    localStorage.setItem('mf.touch.settings.v1', JSON.stringify(settings));
  }, SETTINGS);
  const cdp = await page.createCDPSession();
  await page.emulate({ viewport: VIEW, userAgent: UA });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });

  // into the room: a picked name, then Start (the host) until the match runs
  await page.goto(`${base}/r/${room}?render=2d`, { waitUntil: 'load' });
  for (let i = 0; i < 90 && !(await page.evaluate(() => window.__game?.mode?.matchState?.phase === 2 && !!window.__game.mode.net?.predictor?.player)); i++) {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const input = document.querySelector('input[type=text], input:not([type])');
      if (input && !input.value) btns.find((b) => /pick one for me/i.test(b.textContent))?.click();
      // Start first: the death cam's hidden Join next round sits before it on the page
      const start = btns.find((b) => /^\s*start\s*$/i.test(b.textContent) && !b.disabled);
      (start ?? btns.find((b) => /join room|join next round/i.test(b.textContent) && !b.disabled))?.click();
    });
    await sleep(1000);
  }
  const running = await page.evaluate(() => window.__game?.mode?.matchState?.phase === 2);
  if (!running) await page.screenshot({ path: join(tmpdir(), 'respawn-fly-check.png') }).catch(() => {});
  check('the match runs', running, running ? '' : `screenshot: ${join(tmpdir(), 'respawn-fly-check.png')}; buttons: ${await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter(Boolean).slice(0, 10).join(' | '))}`);
  if (!running) throw new Error('never got into a match');
  await page.evaluate(() => {
    const s = window.__game.mode.sampler;
    window.__samples = [];
    const orig = s.sample.bind(s);
    s.sample = (...a) => {
      const out = orig(...a);
      window.__samples.push(out.buttons);
      if (window.__samples.length > 4000) window.__samples.splice(0, 2000);
      return out;
    };
  });
  const dial = await page.$eval('.mf-ctl-move .dial__base', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
  });
  const aimAt = { x: VIEW.width - dial.x, y: dial.y };
  const me = () => page.evaluate(() => {
    const p = window.__game.mode.net.predictor.player;
    return { alive: p.alive, fuel: p.fuel };
  });
  const pts = (left, right) => [
    { x: Math.round(left.x), y: Math.round(left.y), id: 1, radiusX: 8, radiusY: 8, force: 1 },
    ...(right ? [{ x: Math.round(right.x), y: Math.round(right.y), id: 2, radiusX: 8, radiusY: 8, force: 1 }] : []),
  ];

  for (let k = 0; k < deaths; k++) {
    // wait for a bot to get us (the death cam), in this match
    try {
      await page.waitForFunction(() => window.__game.mode.matchState?.phase === 2 && !window.__game.mode.net.predictor.player.alive, { timeout: 240_000, polling: 50 });
    } catch {
      check(`death ${k + 1}: a bot got the player within 4 minutes`, false);
      break;
    }
    await sleep(k % 2 ? 1200 : 200);
    // the left thumb lands on the move dial and pushes up to its rim, the right lands on the aim side; both hold
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(dial) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(dial, aimAt) });
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts({ x: dial.x, y: dial.y - (i * dial.r) / 6 }, aimAt) });
      await sleep(16);
    }
    const dead = await page.evaluate(() => window.__touch.sticks());
    check(`death ${k + 1}: on the death cam the thumbs take no stick yet`, !dead.moveActive && !dead.aimActive, `move ${dead.moveActive}, aim ${dead.aimActive}`);
    await page.waitForFunction(() => window.__game.mode.net.predictor.player.alive, { timeout: 60_000, polling: 16 });
    const f0 = (await me()).fuel;
    await page.evaluate(() => (window.__samples = []));
    await sleep(500);
    const f1 = (await me()).fuel;
    const jets = await page.evaluate((JET) => {
      const s = window.__samples.slice(6); // the first ticks of the respawn: the controls come back on the next frame
      return { jet: s.filter((b) => b & JET).length, of: s.length };
    }, JET);
    const live = await page.evaluate(() => window.__touch.sticks());
    check(`death ${k + 1}: the left thumb held through the respawn is the move stick and flies`, live.moveActive && jets.jet === jets.of && jets.of > 0 && f1 < f0, `move ${live.moveActive}, Jet in ${jets.jet}/${jets.of} samples, fuel ${f0.toFixed(0)} → ${f1.toFixed(0)}`);
    check(`death ${k + 1}: the right thumb held through the respawn is the aim stick`, live.aimActive);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
} catch (e) {
  check('run', false, e.message);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
