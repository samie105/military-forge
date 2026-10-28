/**
 * No blank screens on a phone (the owner, 26 Oct: "tapping on any other link shows a blank page"): headless
 * Chrome as a landscape phone (812×375, touch, a coarse pointer) taps every way out of phone Home and
 * checks what the player sees after each tap:
 *
 *   - something shows at once: the next screen's frame (its title, Back, a loading line) within 300 ms
 *     of the tap, read frame by frame in the page;
 *   - never a blank screen: every frame the page paints from the tap until the screen is ready (Chrome's
 *     screencast) has something on it; a near-uniform frame (under 1% of its pixels off its median
 *     shade) is blank. The landing page (index.html) showing through the app counts as a failure too;
 *   - fully loaded within a sane time (READY_MS, 25 s by default: software WebGL is slow);
 *   - Back (the Android back gesture: history.back) from a full-screen page lands on Home at once.
 *
 * Then the ways a load can go wrong: a cold load straight onto #/locker and #/armory; a screen whose
 * code can't be fetched (a deploy replaced it under an open page: 404) shows a way to try again, not
 * nothing; the game's own code failing to load on the landing says so and offers a reload.
 *
 *   pnpm --filter @military-forge/web build
 *   pnpm playtest --local --no-build --port 5391          (in another terminal)
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/no-blank-check.mjs http://127.0.0.1:5391 /tmp/no-blank
 *
 * --offline blocks /api and /ws (the app runs on its own, nothing is written to the server: for a live
 * site, read only) and skips the targets that need them. --only=Locker,Armory runs some targets.
 * NET=slow throttles the network (1.6 Mbit/s, 150 ms); CPU=4 slows the CPU 4×.
 * HOME_WAIT (ms, default 3000): how long Home settles before a tap. DEBUG=1 prints the timeline, DUMP=1 the frames.
 * Writes a screenshot per step and report.json to the out folder. Exits 1 when a check fails.
 */
/* global process, Buffer */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const plain = args.filter((a) => !a.startsWith('--'));
const base = (plain[0] ?? 'http://127.0.0.1:5391').replace(/\/$/, '');
const out = resolve(plain[1] ?? join(tmpdir(), 'no-blank'));
const offline = flags.has('--offline');
const only = [...flags].find((f) => f.startsWith('--only='))?.slice(7).split(',') ?? null;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FRAME_MS = 300;
const READY_MS = Number(process.env.READY_MS ?? 25_000);
const BLANK_INK = 0.01;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

// the whole run has a hard limit (the shared lock must never be held by a hung browser)
const killer = setTimeout(() => {
  console.error('no-blank-check: out of time (15 min)');
  process.exit(2);
}, 900_000);

const failures = [];
const report = [];
const fail = (what) => {
  failures.push(what);
  console.log(`  FAIL ${what}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'no-blank-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 120_000,
});

// a page of its own reads the sampled frames (JPEG → pixels), off the page being checked
let lab = await browser.newPage();
async function inkOf(jpegB64) {
  // a crashed lab page is replaced (software GL runs Chrome hard)
  if (lab.isClosed() || lab.mainFrame().detached) lab = await browser.newPage();
  return lab.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    // the viewport is the capture's top-left 812:375 (headless pads the capture below it)
    const w = 203, h = 94;
    const srcH = Math.min(bmp.height, Math.round((bmp.width * 375) / 812));
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, bmp.width, srcH, 0, 0, w, h);
    const { data } = g.getImageData(0, 0, w, h);
    const lum = new Uint8Array(data.length / 4);
    const hist = new Uint32Array(256);
    for (let i = 0; i < lum.length; i++) {
      const l = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
      lum[i] = l;
      hist[l]++;
    }
    let median = 0;
    for (let n = 0, half = lum.length / 2; median < 256; median++) if ((n += hist[median]) >= half) break;
    let ink = 0;
    for (let i = 0; i < lum.length; i++) if (Math.abs(lum[i] - median) > 18) ink++;
    return ink / lum.length;
  }, jpegB64);
}

/** What's on screen, recorded in the page at every animation frame it changes (wall-clock ms). */
const RECORDER = () => {
  const vis = (el) => !!el && el.getClientRects().length > 0 && (typeof el.checkVisibility !== 'function' || el.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
  const snap = () => {
    const route = document.querySelector('.mf-route');
    const wait = route?.querySelector('.mf-route__wait');
    const play = document.getElementById('land-play');
    let landing = false;
    if (document.documentElement.classList.contains('mf-app') && play && vis(play)) {
      const r = play.getBoundingClientRect();
      landing = !!document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('#landing');
    }
    const line = document.getElementById('land-line');
    return {
      screens: [...document.querySelectorAll('#shell [data-screen], .mf-route [data-screen]')].filter(vis).map((e) => e.getAttribute('data-screen')),
      route: route ? (wait && vis(wait) ? (wait.querySelector('.mf-route__fail') ? 'failed' : 'waiting') : `body ${route.querySelector('.mf-route__body')?.childElementCount ?? 0}`) : null,
      busy: [...document.querySelectorAll('.mf-route .mm-overlay, .mf-route .mf-overlay, .mf-route .mf-cr__overlay')].some((e) => !e.hidden && vis(e)),
      list: !!document.querySelector('.mf-route .mf-list [data-weapon]'),
      hud: vis(document.getElementById('hud')),
      landing,
      bootFailed: !!document.querySelector('.mf-land__retry') && vis(document.querySelector('.mf-land__retry')),
      landLine: line && vis(line) ? line.textContent : null,
    };
  };
  const nb = (window.__nb = { log: [], last: '', long: [], input: [] });
  const at = () => performance.timeOrigin + performance.now();
  for (const type of ['pointerdown', 'pointerup', 'click', 'fullscreenchange', 'resize', 'hashchange'])
    addEventListener(type, () => nb.input.push([type, Math.round(at())]), { capture: true, passive: true });
  document.addEventListener('fullscreenchange', () => nb.input.push(['fs', Math.round(at())]), { capture: true });
  // the main thread's long tasks (nothing paints during one)
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) nb.long.push([performance.timeOrigin + e.startTime, e.duration]);
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    /* no long-task timing here */
  }
  const loop = () => {
    try {
      const s = snap();
      const key = JSON.stringify(s);
      if (key !== nb.last) {
        nb.last = key;
        nb.log.push({ t: at(), s });
      }
    } catch {
      /* the page is between documents */
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
};

/** A fresh page as a landscape phone, with a returning player's memory (no first-run tours). */
async function phonePage({ block = null, bypassWorker = false } = {}) {
  // a browser profile of its own each time: no service worker or cache carried from another check
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  if (bypassWorker) await page.setBypassServiceWorker(true);
  page.setDefaultTimeout(30_000);
  page.on('pageerror', (e) => console.log(`    page error: ${e.message.slice(0, 160)}`));
  await page.emulate({
    viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'pointer', value: 'coarse' },
      { name: 'any-pointer', value: 'coarse' },
      { name: 'hover', value: 'none' },
      { name: 'orientation', value: 'landscape' },
    ],
  });
  if (process.env.NET === 'slow') await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
  if (process.env.CPU) await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CPU) });
  const blocks = { patterns: block ? [block] : [] };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname;
    if (offline && /^\/(api|ws)(\/|$)/.test(path)) return void req.abort('internetdisconnected');
    if (blocks.patterns.some((p) => p.test(path))) return void req.respond({ status: 404, contentType: 'text/plain', body: 'Not found' });
    void req.continue();
  });
  await page.evaluateOnNewDocument(() => {
    try {
      const now = Date.now();
      localStorage.setItem('mf-creator-seen', '1');
      localStorage.setItem('mf.age.v1', JSON.stringify({ adult: true, birthYear: 1990, at: now })); // the 18+ step, answered
      localStorage.setItem(
        'mf.facts.v1',
        JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }),
      );
    } catch {
      /* no storage */
    }
  });
  await page.evaluateOnNewDocument(RECORDER);
  // what's on screen, sampled back to back while a check watches (each a small JPEG with the time it was
  // taken: the middle of the capture); Chrome's screencast skipped frames and lagged in headless runs
  const frames = [];
  let sampling = false;
  const sampler = {
    start() {
      if (sampling) return;
      sampling = true;
      void (async () => {
        while (sampling) {
          const t0 = Date.now();
          try {
            const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 30, optimizeForSpeed: true });
            frames.push({ t: (t0 + Date.now()) / 2, data });
          } catch {
            /* between documents */
          }
          // a breath between captures: back to back, they starve the page (and its input) in software GL
          await sleep(80);
        }
      })();
    },
    stop() {
      sampling = false;
    },
  };
  return { page, cdp, frames, sampler, blocks, context };
}

const name = () => `Nb${Math.random().toString(36).slice(2, 8)}`;

/** Home, from a cold load: the name screen first when this browser has no name yet. */
async function toHome(page) {
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  const first = await page.waitForFunction(() => document.querySelector('[data-screen="m-home"], [data-screen="m-name"] input'), { timeout: 60_000 });
  if (await first.evaluate((e) => e.tagName === 'INPUT')) {
    await (await page.$('[data-screen="m-name"] input')).tap();
    await page.keyboard.type(name());
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-screen="m-home"]', { timeout: 60_000 });
  }
  // Home's own entrance settles first
  // (HOME_WAIT=1200 taps while Home's warm-up still runs: the 3D view and the soldier's portrait, long
  // tasks of 200-400 ms in software GL that no frame can cut into; 26 Oct they made 300-390 ms first frames)
  await sleep(Number(process.env.HOME_WAIT ?? 3000));
}

/** Taps `target` ({ sel, text }) like a finger; returns when the page saw the tap land (its click, wall ms). */
async function tapOn(page, target) {
  const until = Date.now() + 15_000;
  let box = null;
  while (!box) {
    box = await page.evaluate(
      (sel, text) => {
        const el = [...document.querySelectorAll(sel)].find((e) => (!text || e.textContent.includes(text)) && e.getBoundingClientRect().width > 0);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      },
      target.sel,
      target.text ?? '',
    );
    if (!box && Date.now() > until) throw new Error(`nothing to tap: ${target.sel} ${target.text ?? ''}`);
    if (!box) await sleep(150);
  }
  const sent = Date.now();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  // timed from the tap's click in the page: headless Chrome can take a second to deliver a touch (on a
  // phone the finger is there at once; the page's own work delaying it shows in the long tasks)
  for (let i = 0; i < 50; i++) {
    const input = await page.evaluate(() => window.__nb.input).catch(() => null);
    if (!input) return sent; // the tap started a new page (Try again)
    const click = input.find(([k, t]) => k === 'click' && t >= sent - 50);
    if (click) return click[1];
    await sleep(100);
  }
  return sent;
}

const log = (page) => page.evaluate(() => window.__nb?.log ?? []).catch(() => []);
/** The longest main-thread task overlapping [from, to], in ms. */
const longest = async (page, from, to) => Math.round(Math.max(0, ...(await page.evaluate(() => window.__nb.long)).filter(([t, d]) => t < to && t + d > from).map(([, d]) => d)));

/** The first recorded moment at or after `from` when `pred` holds, or null. */
function firstWhen(entries, from, pred) {
  let last = null;
  for (const e of entries) {
    if (e.t <= from) last = e;
    else {
      if (last && pred(last.s)) return from;
      last = null;
      if (pred(e.s)) return e.t;
    }
  }
  return last && pred(last.s) ? from : null;
}

async function waitFor(page, from, pred, ms) {
  const end = Date.now() + ms;
  for (;;) {
    const t = firstWhen(await log(page), from, pred);
    if (t !== null || Date.now() > end) return t;
    await sleep(150);
  }
}

/** Blank frames on screen between `from` and `to` (wall ms): each as [ms after `from`, ink]. */
async function blankFrames(frames, from, to, { before = 150 } = {}) {
  const bad = [];
  // the frame on screen at `from` counts too, when it was taken just before (not a stale one)
  const inWindow = frames.filter((f, i) => (f.t >= from && f.t <= to) || (f.t < from && f.t >= from - before && (frames[i + 1]?.t ?? Infinity) >= from));
  for (const f of inWindow) {
    const ink = await inkOf(f.data);
    // DUMP=1: every frame checked, as a JPEG named by its time after `from` and its ink
    if (process.env.DUMP) writeFileSync(join(out, `frame-${step}-${Math.round(f.t - from)}ms-${(ink * 100).toFixed(1)}.jpg`), Buffer.from(f.data, 'base64'));
    if (ink < BLANK_INK) bad.push([Math.round(f.t - from), +ink.toFixed(4)]);
  }
  return { bad, count: inWindow.length };
}

const landingShows = (entries, from, to) => entries.some((e) => e.t >= from && e.t <= to && e.s.landing);

const homeOnly = (s) => s.screens.length > 0 && s.screens.every((x) => x === 'm-home');

/** The targets on phone Home: what to tap, what shows first, what "loaded" means, how to leave. */
const TARGETS = [
  { name: 'Locker', tap: { sel: '.pm-nav__i', text: 'Locker' }, frame: (s) => s.route !== null, ready: (s) => s.screens.includes('locker') && !s.busy, back: true },
  { name: 'Armory', tap: { sel: '.pm-nav__i', text: 'Armory' }, frame: (s) => s.route !== null, ready: (s) => s.screens.includes('armory') && s.list && !s.busy, back: true },
  { name: 'Settings', tap: { sel: '.pm-nav__i', text: 'Settings' }, frame: (s) => s.screens.includes('m-settings'), ready: (s) => s.screens.includes('m-settings') },
  { name: 'Your name', tap: { sel: '.pm-av' }, frame: (s) => s.screens.includes('m-name'), ready: (s) => s.screens.includes('m-name'), online: true },
  { name: 'Friends', tap: { sel: '.sx-fbtn' }, frame: (s) => s.screens.includes('friends'), ready: (s) => s.screens.includes('friends'), online: true },
  { name: 'Join', tap: { sel: '[data-tour="join"]' }, frame: (s) => s.screens.includes('m-join'), ready: (s) => s.screens.includes('m-join') },
  { name: 'Training', tap: { sel: '.pm-tk', text: 'Training' }, frame: (s) => !homeOnly(s), ready: (s) => s.hud },
  { name: 'Play now', tap: { sel: '.pm-play' }, frame: (s) => !homeOnly(s), ready: (s) => s.hud || s.screens.includes('m-lobby'), online: true },
  { name: 'Create room', tap: { sel: '.pm-create-room' }, frame: (s) => !homeOnly(s), ready: (s) => s.screens.includes('m-lobby'), online: true },
  { name: 'Local room', tap: { sel: '.pm-tk--local' }, frame: (s) => !homeOnly(s), ready: (s) => !homeOnly(s) && s.screens.length > 0 },
];

let step = 0;
async function shot(page, label) {
  const file = join(out, `${String(step++).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  return file;
}

const blankText = (bad) => bad.map(([t, ink]) => `${t} ms (${(ink * 100).toFixed(2)}%)`).join(', ');

async function checkTarget(target) {
  console.log(`\n${target.name}`);
  const { page, frames, sampler, context } = await phonePage();
  const row = { target: target.name };
  try {
    await toHome(page);
    sampler.start();
    await sleep(200);
    const at = await tapOn(page, target.tap);
    const frameAt = await waitFor(page, at, target.frame, READY_MS);
    const readyAt = await waitFor(page, at, target.ready, READY_MS);
    await sleep(300);
    row.frameMs = frameAt === null ? null : Math.round(frameAt - at);
    row.readyMs = readyAt === null ? null : Math.round(readyAt - at);
    const end = readyAt ?? at + READY_MS;
    const blanks = await blankFrames(frames, at + FRAME_MS, end + 300);
    row.frames = blanks.count;
    row.blankFrames = blanks.bad;
    row.landing = landingShows(await log(page), at, end);
    row.longestTaskMs = await longest(page, at, at + (row.frameMs ?? FRAME_MS));
    if (process.env.DEBUG) {
      console.log('  input', JSON.stringify((await page.evaluate(() => window.__nb.input)).filter(([, t]) => t >= at - 2000).map(([k, t]) => [k, t - at])));
      console.log('  long tasks', JSON.stringify((await page.evaluate(() => window.__nb.long)).filter(([t, d]) => t + d >= at - 3000 && t <= end).map(([t, d]) => [Math.round(t - at), Math.round(d)])));
      for (const e of (await log(page)).filter((x) => x.t >= at - 500 && x.t <= end)) console.log(`   ${Math.round(e.t - at)} ${JSON.stringify(e.s)}`);
    }
    row.shot = await shot(page, target.name);
    console.log(`  first frame ${row.frameMs ?? '-'} ms (longest task ${row.longestTaskMs} ms) · ready ${row.readyMs ?? '-'} ms · ${blanks.count} frames, ${blanks.bad.length} blank${row.landing ? ' · the landing showed' : ''}`);
    if (row.frameMs === null || row.frameMs > FRAME_MS) fail(`${target.name}: nothing new on screen within ${FRAME_MS} ms (${row.frameMs ?? 'never'})`);
    if (row.readyMs === null) fail(`${target.name}: not loaded within ${READY_MS} ms`);
    if (blanks.bad.length) fail(`${target.name}: blank frames at ${blankText(blanks.bad)}`);
    if (row.landing) fail(`${target.name}: the landing page showed through the app`);
    if (target.back && readyAt !== null) {
      // the Android back gesture
      const sent = Date.now();
      await page.evaluate(() => history.back());
      // from the page's hashchange (the gesture landing), as a tap is timed from its click
      let backAt = sent;
      for (let i = 0; i < 30; i++) {
        const change = (await page.evaluate(() => window.__nb.input)).find(([k, t]) => k === 'hashchange' && t >= sent - 50);
        if (change) {
          backAt = change[1];
          break;
        }
        await sleep(100);
      }
      const homeAt = await waitFor(page, backAt, (s) => s.screens.includes('m-home') && s.route === null, 10_000);
      await sleep(300);
      // Home rises back in (its stagger, P3, ends by ~400 ms): judged from 300 ms on, by frames taken then
      const back = await blankFrames(frames, backAt + FRAME_MS, (homeAt ?? backAt + 10_000) + 500, { before: 0 });
      row.backMs = homeAt === null ? null : Math.round(homeAt - backAt);
      row.backBlankFrames = back.bad;
      console.log(`  back → Home ${row.backMs ?? '-'} ms · ${back.count} frames, ${back.bad.length} blank`);
      if (row.backMs === null || row.backMs > FRAME_MS) fail(`${target.name}: Back didn't show Home within ${FRAME_MS} ms (${row.backMs ?? 'never'})`);
      if (back.bad.length) fail(`${target.name}: blank frames after Back at ${blankText(back.bad)}`);
    }
  } catch (e) {
    fail(`${target.name}: ${e.message.split('\n')[0]}`);
    if (process.env.DEBUG) console.log(e.stack);
    row.error = e.message.split('\n')[0];
    row.shot = await shot(page, `${target.name}-error`);
  }
  sampler.stop();
  report.push(row);
  await context.close();
}

/** A cold load straight onto a full-screen page (a shared or restored #/locker link). */
async function checkDeep(hash, ready) {
  console.log(`\ncold load ${hash}`);
  const { page, frames, sampler, context } = await phonePage();
  const row = { target: `cold ${hash}` };
  try {
    // a name first, so the deep link isn't the name screen
    await toHome(page);
    // away first: the same page with a new #hash would only change the hash, not load anew
    await page.goto('about:blank');
    sampler.start();
    const at = Date.now();
    await page.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' });
    const readyAt = await waitFor(page, at, ready, READY_MS + 30_000);
    await sleep(300);
    row.readyMs = readyAt === null ? null : Math.round(readyAt - at);
    const entries = await log(page);
    // from the app's first screen on (before it, the landing is the page's own first picture)
    const appAt = entries.find((e) => e.s.screens.length > 0 || e.s.route !== null)?.t ?? at;
    row.appMs = Math.round(appAt - at);
    const blanks = await blankFrames(frames, appAt, (readyAt ?? appAt + READY_MS) + 300);
    row.blankFrames = blanks.bad;
    row.shot = await shot(page, `cold-${hash}`);
    console.log(`  the app's first screen ${row.appMs} ms, ready ${row.readyMs ?? '-'} ms after the load began · ${blanks.count} frames, ${blanks.bad.length} blank`);
    if (row.readyMs === null) fail(`cold ${hash}: not loaded`);
    if (blanks.bad.length) fail(`cold ${hash}: blank frames at ${blankText(blanks.bad)}`);
  } catch (e) {
    fail(`cold ${hash}: ${e.message.split('\n')[0]}`);
  }
  sampler.stop();
  report.push(row);
  await context.close();
}

/** A screen's code that can't be fetched (a deploy took it away under an open page): a way out, not nothing. */
async function checkBrokenRoute(target, pattern) {
  console.log(`\n${target.name} with its code missing (404)`);
  // past the service worker too: its cache would hold the code from an earlier visit
  const { page, frames, sampler, blocks, context } = await phonePage({ bypassWorker: true });
  const row = { target: `${target.name}, code missing` };
  try {
    await toHome(page);
    blocks.patterns.push(pattern);
    sampler.start();
    await sleep(200);
    const at = await tapOn(page, target.tap);
    const failedAt = await waitFor(page, at, (s) => s.route === 'failed', 15_000);
    await sleep(300);
    row.failedMs = failedAt === null ? null : Math.round(failedAt - at);
    const blanks = await blankFrames(frames, at + FRAME_MS, (failedAt ?? at + 15_000) + 1000);
    row.blankFrames = blanks.bad;
    row.shot = await shot(page, `${target.name}-missing`);
    console.log(`  Try again offered after ${row.failedMs ?? '-'} ms · ${blanks.count} frames, ${blanks.bad.length} blank`);
    if (row.failedMs === null) fail(`${target.name} (code missing): no way to try again`);
    if (blanks.bad.length) fail(`${target.name} (code missing): blank frames at ${blankText(blanks.bad)}`);
    if (failedAt !== null) {
      // the code is back (the new deploy's files): Try again gets there
      blocks.patterns.length = 0;
      const again = Date.now();
      await tapOn(page, { sel: '.mf-route__fail button', text: 'Try again' });
      const readyAt = await waitFor(page, again, target.ready, READY_MS + 30_000);
      row.retryMs = readyAt === null ? null : Math.round(readyAt - again);
      row.retryShot = await shot(page, `${target.name}-missing-try-again`);
      console.log(`  Try again → loaded after ${row.retryMs ?? '-'} ms`);
      if (readyAt === null) fail(`${target.name} (code missing): Try again didn't load it`);
    }
  } catch (e) {
    fail(`${target.name} (code missing): ${e.message.split('\n')[0]}`);
  }
  sampler.stop();
  report.push(row);
  await context.close();
}

/** The game's own code can't be fetched: the landing says so and offers Try again. */
async function checkBrokenBoot() {
  console.log("\nthe game's code missing on a cold load (404)");
  // the page's entry (boot.ts) loads; the game's chunk it imports doesn't
  const page0 = await fetch(`${base}/`).then((r) => r.text(), () => "");
  const entry = /<script type="module"[^>]*src="(\/assets\/[^"]+\.js)"/.exec(page0)?.[1] ?? '';
  const block = { test: (path) => /^\/assets\/main-[^/]+\.js$/.test(path) && path !== entry };
  const { page, sampler, context } = await phonePage({ block, bypassWorker: true });
  const row = { target: "game's code missing" };
  try {
    sampler.start();
    const at = Date.now();
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    const failedAt = await waitFor(page, at, (s) => s.bootFailed, 30_000);
    row.failedMs = failedAt === null ? null : Math.round(failedAt - at);
    row.shot = await shot(page, 'game-code-missing');
    console.log(`  Try again offered after ${row.failedMs ?? '-'} ms (after one quiet reload)`);
    if (failedAt === null) fail("game's code missing: the landing never offered Try again");
  } catch (e) {
    fail(`game's code missing: ${e.message.split('\n')[0]}`);
  }
  sampler.stop();
  report.push(row);
  await context.close();
}

const want = (n) => !only || only.includes(n);
for (const t of TARGETS) if (want(t.name) && !(offline && t.online)) await checkTarget(t);
if (want('cold')) {
  await checkDeep('#/locker', (s) => s.screens.includes('locker') && !s.busy);
  await checkDeep('#/armory', (s) => s.screens.includes('armory') && s.list && !s.busy);
}
const CODE = /^\/assets\/(route|locker|armory|creator|briefingRoute|turntable|tiles)-[^/]+\.js$/;
if (want('missing')) {
  await checkBrokenRoute(TARGETS[0], CODE);
  await checkBrokenRoute(TARGETS[1], CODE);
}
if (want('boot')) await checkBrokenBoot();

writeFileSync(join(out, 'report.json'), JSON.stringify({ base, offline, failures, report }, null, 2));
await browser.close();
clearTimeout(killer);
console.log(`\n${failures.length ? `${failures.length} failed` : 'all passed'} · ${join(out, 'report.json')}`);
process.exit(failures.length ? 1 : 0);
