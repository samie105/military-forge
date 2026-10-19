/**
 * Round two's desktop menus, frame strips of their moves (docs/design/ui-motion-spec.md §4.1), for
 * the phase 4 PR: one PNG per 16 ms of animation time, in headless Chrome (throwaway profile,
 * 1920×1080). As in hud-v2.mjs, every animation the trigger starts is paused and stepped 16 ms at a
 * time (Web Animations currentTime), with the animation clock slowed while the trigger lands and the
 * page's timeouts parked (and let go afterwards), so each frame is where the move is at that time,
 * however slow the machine.
 *
 * One player plays it through: name, Home, Join, Settings, a room with the bots (lobby, countdown,
 * pause, a dropped link, results), then training for the countdown's numbers and GO. A variant
 * runs the same with Reduce motion or Reduce flashes on (the names get the suffix).
 *
 *   cd apps/web && DEV_API=http://127.0.0.1:8791 pnpm exec vite --port 5191 --strictPort
 *   node apps/web/scripts/menus-v2.mjs [http://127.0.0.1:5191] [out dir] [''|reduce-motion|reduce-flashes] [strip,names]
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5191').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'menus-v2-shots');
const variant = process.argv[4] ?? '';
/** only these strips (comma-separated names, without the variant's suffix), when given */
const only = process.argv[5] ? new Set(process.argv[5].split(',')) : null;
const suffix = variant ? `-${variant}` : '';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FRAME_MS = 16;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'menus-v2-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1920, height: 1080 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
const cdp = await page.createCDPSession();
await cdp.send('Animation.enable');

const button = (text, timeout = 30_000) => page.waitForSelector(`xpath/.//button[contains(normalize-space(.), "${text}")]`, { timeout });
const click = async (text) => (await button(text)).click();
const wait = (selector, timeout = 30_000) => page.waitForSelector(selector, { timeout });
const ctl = (fn, ...args) => page.evaluate(`window.__game.shell.controller.${fn}(${args.map((a) => JSON.stringify(a)).join(', ')})`);

/**
 * The page's timeouts of 100 ms or more wait while a strip is shot (an intro's exit, "Copied" going
 * back, the Back chip), then run their full delay once it is: release() lets the parked ones with at most `upTo` ms
 * go now (the rest stay parked), unpark() lets them all go and stops parking.
 */
const park = () =>
  page.evaluate(() => {
    if (window.__parked) return;
    const real = { set: window.setTimeout.bind(window), clear: window.clearTimeout.bind(window), was: { set: window.setTimeout, clear: window.clearTimeout } };
    const parked = new Map();
    let next = 1e9;
    window.__parked = { real, parked };
    window.setTimeout = (fn, ms = 0, ...rest) => {
      // the next turn's work (a scheduler, a microtask's cousin) runs as usual
      if (ms < 100) return real.set(fn, ms, ...rest);
      const id = next++;
      parked.set(id, { fn, ms, rest });
      return id;
    };
    window.clearTimeout = (id) => (parked.has(id) ? parked.delete(id) : real.clear(id));
  });
const release = (upTo) =>
  page.evaluate((upTo) => {
    const p = window.__parked;
    if (!p) return;
    for (const [id, t] of p.parked) {
      if (t.ms > upTo) continue;
      p.parked.delete(id);
      p.real.set(() => (typeof t.fn === 'function' ? t.fn(...t.rest) : undefined), t.ms);
    }
  }, upTo);
const unpark = async () => {
  await release(Infinity);
  await page.evaluate(() => {
    const p = window.__parked;
    if (!p) return;
    window.setTimeout = p.real.was.set;
    window.clearTimeout = p.real.was.clear;
    window.__parked = null;
  });
};

/**
 * One move: `trigger` starts it (and waits until its element is there) with the animation clock 20×
 * slower and the timeouts parked; then every animation that started since is paused and stepped
 * FRAME_MS at a time from its start; what was already running goes on from where it was. `prep`
 * runs first, at full speed (waiting for a match to nearly end, say).
 */
async function strip(name, { ms, trigger, clip: around = null, prep = async () => {}, keepParked = false, slow = true }) {
  await prep();
  if (only && !only.has(name)) {
    await trigger();
    if (!keepParked) await unpark();
    return;
  }
  const dir = join(out, 'strips', `${name}${suffix}`);
  mkdirSync(dir, { recursive: true });
  // (training's countdown runs on the animation clock's time: there the trigger lands at full speed)
  if (slow) await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
  await page.evaluate(() => (window.__trigAt = document.timeline.currentTime));
  await park();
  await trigger();
  const count = await page.evaluate(() => {
    // the shell's state holds still while the strip is shot (a room's updates keep coming); they land after
    const store = window.__game.shell.store;
    const held = [];
    window.__held = { store, set: store.setState, held };
    store.setState = (...args) => void held.push(args);
    const anims = document.getAnimations().filter((a) => a.playState !== 'finished' || (a.startTime ?? 0) >= window.__trigAt - 1);
    // a CSS animation its screen holds (.mf-held: paused until a flood has covered it) waits, and is
    // stepped from the frame where the hold lets it go
    const heldByCss = (a) => a instanceof CSSAnimation && a.effect?.target && getComputedStyle(a.effect.target).animationPlayState.includes('paused');
    window.__heldByCss = heldByCss;
    window.__strip = anims.map((a) => {
      if (heldByCss(a)) return { a, held: true, t0: 0 };
      const fresh = a.startTime === null || a.startTime >= window.__trigAt - 1;
      const t0 = fresh ? 0 : Number(a.currentTime) || 0;
      a.pause();
      return { a, t0 };
    });
    return anims.length;
  });
  // a small move is shot around its element (padded); a screen's arrival whole
  const clip = around
    ? await page.$eval(around, (el) => {
        const r = el.getBoundingClientRect();
        const pad = 40;
        const x = Math.max(0, Math.floor(r.left - pad));
        const y = Math.max(0, Math.floor(r.top - pad));
        return { x, y, width: Math.min(innerWidth - x, Math.ceil(r.width + pad * 2)), height: Math.min(innerHeight - y, Math.ceil(r.height + pad * 2)) };
      })
    : undefined;
  const n = Math.floor(ms / FRAME_MS) + 1;
  for (let k = 0; k < n; k++) {
    await page.evaluate(async (t) => {
      // an animation that reaches its end finishes, so what chains on it starts (the flood's clearing);
      // what starts then is paused too and stepped from this frame
      const known = new Set(window.__strip.map((s) => s.a));
      for (const st of window.__strip) {
        if (st.done) continue;
        if (st.held) {
          if (window.__heldByCss(st.a)) continue;
          st.held = false;
          st.a.pause();
          st.t0 = -t;
        }
        const end = st.a.effect?.getComputedTiming().endTime ?? Infinity;
        if (Number.isFinite(end) && st.t0 + t >= end) {
          st.a.finish();
          st.done = true;
        } else st.a.currentTime = st.t0 + t;
      }
      for (let i = 0; i < 4; i++) await Promise.resolve();
      for (const a of document.getAnimations()) {
        if (known.has(a) || a.playState === 'finished') continue;
        if (window.__heldByCss(a)) {
          window.__strip.push({ a, held: true, t0: 0 });
          continue;
        }
        a.pause();
        a.currentTime = 0;
        window.__strip.push({ a, t0: -t });
      }
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }, k * FRAME_MS);
    await page.screenshot({ path: join(dir, `${String(k * FRAME_MS).padStart(4, '0')}ms.png`), clip });
  }
  await page.evaluate(() => {
    for (const { a, done, held } of window.__strip) {
      if (done || held) continue;
      try {
        a.finish();
      } catch {
        a.play();
      }
    }
    window.__strip = [];
    const h = window.__held;
    h.store.setState = h.set;
    for (const args of h.held) h.set(...args);
  });
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  if (!keepParked) await unpark();
  console.log(`strip ${name}${suffix}: ${n} frames, ${count} animations`);
}

try {
  // ---- name entry and Home
  await page.goto(`${base}/?app`, { waitUntil: 'load' });
  await wait('input[aria-label="Your name"]', 60_000);
  if (variant === 'reduce-motion') await ctl('updateSettings', { reduceMotion: true });
  if (variant === 'reduce-flashes') await ctl('updateSettings', { reduceFlashes: true });
  await sleep(1500);
  const name = `Ade${Math.floor(Math.random() * 900 + 100)}`;
  await strip('name-cleared', {
    ms: 208,
    clip: '.idcard',
    trigger: async () => {
      await page.type('input[aria-label="Your name"]', name);
      await release(2000); // the name check's pause after typing
      await wait('.idcard__stamp');
    },
  });
  await strip('home-arrive', {
    ms: 704,
    trigger: async () => {
      await page.click('button[type=submit]');
      await wait('[data-screen="home"]');
    },
  });
  await sleep(1500);

  // ---- Join with code
  await strip('join-open', { ms: 320, trigger: async () => (await ctl('openOverlay', 'join'), await wait('[data-screen="join"]')) });
  await sleep(800);
  await strip('join-letter', { ms: 176, clip: '.codebox', trigger: async () => (await page.keyboard.type('K'), await wait('.codebox__cell.mf-filled')) });
  await page.keyboard.type('MTXRZ');
  await sleep(800); // the letters' own stamps are done before the wrong code lands
  await strip('join-wrong-code', { ms: 272, clip: '.codebox', trigger: async () => (await page.keyboard.press('Enter'), await wait('[data-screen="join"][data-active-state~="error"]')) });
  await ctl('closeOverlay');
  await sleep(800);

  // ---- Settings: the vertical tabs
  await ctl('openSettings', 'graphics');
  await sleep(1500);
  await strip('settings-tab', { ms: 288, trigger: async () => (await page.click('[role="tab"][data-tab="audio"]'), await wait('[role="tab"][data-tab="audio"][aria-selected="true"]')) });
  await ctl('closeOverlay');
  await sleep(800);

  // ---- a room with the bots
  await strip('lobby-arrive', { ms: 640, trigger: async () => (await ctl('go', { to: 'create' }), await wait('[data-screen="lobby"] .prows')) });
  await sleep(1500);
  await strip('copy-link', { ms: 192, clip: '.mf-linkt__acts', trigger: async () => (await click('Copy link'), await button('Copied')) });
  await sleep(2000);
  // the first-run controls card, folded so it doesn't cover the countdown
  await click('Warm up');
  await click('Got it');
  await click('Lobby');
  await (await page.waitForSelector('xpath/.//*[@aria-labelledby="tl-label"]/button[normalize-space(.)="1"]')).click();
  await sleep(1200);
  await strip('countdown-start', {
    ms: 672,
    trigger: async () => {
      await click('Start now');
      await wait('[data-screen="countdown"][data-active-state~="intro"]');
    },
  });
  await wait('#hud[data-active-state~="match"]', 60_000);
  await sleep(1500);

  // ---- the pause menu
  await strip('pause-open', { ms: 480, trigger: async () => (await page.keyboard.press('Escape'), await wait('[data-screen="pause"]')) });
  await strip('pause-leave-confirm', { ms: 224, clip: '.pause__confirm', trigger: async () => (await click('Leave match'), await wait('.pause__confirm')) });
  await click('Stay');
  await page.keyboard.press('Escape');
  await sleep(1200);

  // ---- a dropped link: the banner comes in, then leaves when it's back and the chip stamps
  await strip('reconnect-in', {
    ms: 304,
    clip: '.reconnect',
    trigger: async () => {
      await page.evaluate(() => {
        const mode = window.__game.mode;
        window.__open = mode.open;
        mode.open = () => {};
        mode.transport?.close?.(3000, 'strip');
      });
      await wait('.reconnect');
    },
  });
  await sleep(2500);
  await strip('reconnect-back', {
    ms: 400,
    keepParked: true,
    trigger: async () => {
      await page.evaluate(() => {
        const mode = window.__game.mode;
        mode.open = window.__open;
        mode.open();
      });
      await wait('.reconnect.is-leaving', 15_000);
      await release(200); // the banner's exit is done: the chip
      await wait('.mf-back-chip');
    },
  });
  await unpark();

  // ---- results: the minute runs out
  const secondsLeft = (n) => page.waitForFunction((n) => (window.__game.shell.store.getState().match?.secondsLeft ?? 99) <= n, { timeout: 120_000, polling: 250 }, n);
  await strip('results-arrive', { ms: 800, prep: () => secondsLeft(2), trigger: () => wait('[data-screen="results"]', 30_000) });
  await sleep(1500);
  // (a vote's pip stamping needs a second player: alone with the bots, the rematch starts at once)

  // ---- the countdown's numbers and GO, in training (the room's countdown is over while its start is shot)
  await ctl('leave');
  await wait('[data-screen="home"]');
  await sleep(1000);
  await ctl('go', { to: 'training' });
  await strip('countdown-number', { ms: 288, clip: '.cd__num', prep: () => wait('[data-screen="countdown"][data-active-state~="3"]', 60_000), trigger: () => wait('[data-screen="countdown"][data-active-state~="2"]', 5_000), slow: false });
  await strip('countdown-go', { ms: 320, trigger: () => wait('[data-screen="countdown"][data-active-state~="go"]', 60_000), slow: false });
  console.log('done');
} catch (e) {
  console.error('FAILED', e.message);
  await page.screenshot({ path: join(out, `fail${suffix}.png`) });
  process.exitCode = 1;
} finally {
  await browser.close();
}
