/* global process */
/**
 * Thumbs put down on the results take their sticks when the next match starts (the owner, 27 Oct 2026:
 * "fix the lobby one too"). Between rounds the results, then the lobby, cover the game: a thumb landing
 * on them was the screen's, not the controls', and stayed nobody's after the next GO until it was lifted.
 *
 * A phone-sized headless Chrome (812×375, touch, real CDP touches) hosts a one-minute round with bots on
 * Classic, fixed sticks. Each time a round ends, by turns: the left thumb lands where the move dial sits
 * and the right on the aim side of the results, then the rematch vote (a click); or nobody votes, and
 * the thumbs land on the lobby, then the host's Start (a click). Both hold through the countdown. After
 * GO the left pushes up: it must be the move stick and jetting (Jet in every sampled Input, the fuel
 * burning), the right the aim stick.
 *
 * First, in the lobby: a finger drag scrolls the match rules (the owner, 27 Oct: "you can't scroll
 * down… for every other section too": the controls took every drag on a screen over the game).
 *
 * Needs the dev page (its debug hooks) on a local room, as respawn-fly-check.mjs:
 *   pnpm playtest --local --no-build --port 5395
 *   cd apps/web && DEV_API=http://127.0.0.1:<ws-1> DEV_GAME_SERVER=http://127.0.0.1:<ws> DEV_PROXY_ORIGIN=http://127.0.0.1:5395 pnpm exec vite --port 5232 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/rematch-fly-check.mjs http://127.0.0.1:5232 <ROOM> [rounds]
 *
 * Exits 1 if a check fails.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5232').replace(/\/$/, '');
const room = process.argv[3];
const rounds = Number(process.argv[4] ?? 2);
if (!room) {
  console.error('usage: rematch-fly-check.mjs <dev page> <room code> [rounds]');
  process.exit(2);
}
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const VIEW = { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true };
const JET = 1 << 2;
const Phase = { Waiting: 0, Countdown: 1, InProgress: 2, Ending: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const SETTINGS = { mode: 'auto', fire: 'auto', fireChosen: true, preset: 'classic', stickJet: true, tapFire: false, precisionRelease: true, assist: 'standard', handed: 'right', sticks: 'fixed', vibrate: true, swipeDash: true, keepAim: true, opacity: 0.5, autoFade: true, gestures: true, haptics: true, lookAhead: true, pinchZoom: true, shake: 1, view: 0.8, viewAuto: true, leftFire: false, rev: 5 };

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'rematch-fly-check-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });
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
  const phase = () => page.evaluate(() => window.__game?.mode?.matchState?.phase);

  // into the room's lobby: a picked name
  await page.goto(`${base}/r/${room}?render=2d`, { waitUntil: 'load' });
  for (let i = 0; i < 120 && !(await page.$('.pm-rules')); i++) {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const input = document.querySelector('input[type=text], input:not([type])');
      if (input && !input.value) btns.find((b) => /pick one for me/i.test(b.textContent))?.click();
      btns.find((b) => /join room/i.test(b.textContent) && !b.disabled)?.click();
    });
    await sleep(1000);
  }
  // the match rules scroll under a finger
  await sleep(1000);
  await page.evaluate(() => document.querySelector('.pm-rules')?.click());
  await page.waitForSelector('.pm-sheet:not(.is-leaving)', { timeout: 5000 });
  await sleep(400);
  const sheet = await page.$eval('.pm-sheet', (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.7), room: el.scrollHeight - el.clientHeight };
  });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sheet.x, y: sheet.y, id: 1 }] });
  for (let i = 1; i <= 12; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sheet.x, y: sheet.y - i * 10, id: 1 }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
  const scrolled = await page.$eval('.pm-sheet', (el) => el.scrollTop);
  check('a finger drag scrolls the lobby\'s match rules', sheet.room <= 0 || scrolled > 40, `scrollTop ${scrolled} of ${sheet.room}`);
  await page.evaluate(() => document.querySelector('.pm-scrim')?.click());
  await sleep(400);

  // a one-minute round (the host's setting), then Start until the match runs
  for (let i = 0; i < 90 && !(await page.evaluate(() => window.__game?.mode?.matchState?.phase === 2 && !!window.__game.mode.net?.predictor?.player)); i++) {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button')];
      const input = document.querySelector('input[type=text], input:not([type])');
      if (input && !input.value) btns.find((b) => /pick one for me/i.test(b.textContent))?.click();
      if (window.__game?.mode?.matchState?.phase === 0 && !window.__oneMinute && window.__game.mode.setMatchSettings) {
        window.__game.mode.setMatchSettings({ timeLimit: 60 });
        window.__oneMinute = true;
        return;
      }
      // Start first: the death cam's hidden Join next round sits before it on the page
      const start = btns.find((b) => /^\s*start\s*$/i.test(b.textContent) && !b.disabled);
      (start ?? btns.find((b) => /join room|join next round/i.test(b.textContent) && !b.disabled))?.click();
    });
    await sleep(1000);
  }
  const running = (await phase()) === Phase.InProgress;
  if (!running) await page.screenshot({ path: join(tmpdir(), 'rematch-fly-check.png') }).catch(() => {});
  check('the match runs', running, running ? '' : `screenshot: ${join(tmpdir(), 'rematch-fly-check.png')}`);
  if (!running) throw new Error('never got into a match');
  const dial = await page.$eval('.mf-ctl-move .dial__base', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
  });
  const aimAt = { x: VIEW.width - dial.x, y: dial.y };
  const pts = (left, right) => [
    { x: Math.round(left.x), y: Math.round(left.y), id: 1, radiusX: 8, radiusY: 8, force: 1 },
    ...(right ? [{ x: Math.round(right.x), y: Math.round(right.y), id: 2, radiusX: 8, radiusY: 8, force: 1 }] : []),
  ];
  const vote = () => page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^\s*vote\s*$/i.test(b.textContent) && !b.disabled)?.click());

  for (let k = 0; k < rounds; k++) {
    try {
      await page.waitForFunction(() => window.__game.mode.matchState?.phase === 3, { timeout: 120_000, polling: 100 });
    } catch {
      check(`round ${k + 1}: the round ends within 2 minutes`, false);
      break;
    }
    await sleep(1500);
    const onResults = k % 2 === 0;
    // the lobby: the results run out unvoted (the host's room goes back to it)
    if (!onResults) await page.waitForFunction(() => window.__game.mode.matchState?.phase === 0 && document.querySelector('.pm-rules'), { timeout: 60_000, polling: 100 });
    // both thumbs land on the screen (where the sticks sit in play) and rest there, a little restless
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(dial) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(dial, aimAt) });
    const under = await page.evaluate((x, y) => {
      const el = document.elementFromPoint(x, y);
      return el ? `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}` : 'nothing';
    }, Math.round(dial.x), Math.round(dial.y));
    if (onResults) await vote();
    else await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => /^\s*start\s*$/i.test(b.textContent) && !b.disabled)?.click());
    let jiggle = 0;
    while ((await phase()) !== Phase.InProgress) {
      jiggle = 1 - jiggle;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts({ x: dial.x + jiggle, y: dial.y }, { x: aimAt.x - jiggle, y: aimAt.y }) });
      await sleep(250);
    }
    await page.evaluate(() => {
      const s = window.__game.mode.sampler;
      if (!s.__wrapped) {
        const orig = s.sample.bind(s);
        s.sample = (...a) => {
          const out = orig(...a);
          window.__samples.push(out.buttons);
          return out;
        };
        s.__wrapped = true;
      }
      window.__samples = [];
    });
    // GO: the left thumb pushes up to the dial's rim
    for (let i = 1; i <= 6; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts({ x: dial.x, y: dial.y - (i * dial.r) / 6 }, aimAt) });
      await sleep(16);
    }
    const f0 = await page.evaluate(() => window.__game.mode.net.predictor.player.fuel);
    await page.evaluate(() => (window.__samples = []));
    await sleep(500);
    const f1 = await page.evaluate(() => window.__game.mode.net.predictor.player.fuel);
    const jets = await page.evaluate((JET) => ({ jet: window.__samples.filter((b) => b & JET).length, of: window.__samples.length }), JET);
    const live = await page.evaluate(() => window.__touch.sticks());
    const when = onResults ? 'the results' : 'the lobby';
    check(`round ${k + 1} (${when}, on ${under}): the left thumb held from ${when} is the move stick and flies`, live.moveActive && jets.jet === jets.of && jets.of > 0 && f1 < f0, `move ${live.moveActive}, Jet in ${jets.jet}/${jets.of} samples, fuel ${f0.toFixed(0)} → ${f1.toFixed(0)}`);
    check(`round ${k + 1}: the right thumb held from ${when} is the aim stick`, live.aimActive);
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
