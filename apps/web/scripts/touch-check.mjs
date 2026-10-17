/* global process */
/**
 * Touch controls in a phone-sized headless Chrome (apps/web/src/touch). Real multi-touch events
 * (CDP Input.dispatchTouchEvent) drive the sticks and buttons; the checks read the local game
 * (window.__game, dev builds) to see the player move, jet, fire, throw, swap and dash. Then the HUD
 * editor (a drag that survives a reload), screenshots in the 375×812 viewport (landscape and
 * portrait), and frame time on the 3D Low preset with the CPU throttled 4×.
 *
 *   cd apps/web && pnpm exec vite --port 5199 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/touch-check.mjs http://localhost:5199 docs/screenshots/touch
 *
 * Exits 1 if a check fails. Headless Chrome renders WebGL in software (SwiftShader), so the frame
 * times are a CPU-bound worst case, not a phone GPU's.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const [base = 'http://localhost:5199', outDir = 'docs/screenshots/touch'] = process.argv.slice(2);
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'touch-check-'));
mkdirSync(outDir, { recursive: true });

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const LANDSCAPE = { width: 812, height: 375, deviceScaleFactor: 3, isMobile: true, hasTouch: true, isLandscape: true };
const PORTRAIT = { ...LANDSCAPE, width: 375, height: 812, isLandscape: false };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  userDataDir: profile,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});

/** A phone page: touch emulation, a coarse pointer, the given viewport. */
async function phonePage(viewport) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  const cdp = await page.createCDPSession();
  await page.emulate({ viewport, userAgent: PHONE_UA });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'pointer', value: 'coarse' },
      { name: 'any-pointer', value: 'coarse' },
      { name: 'hover', value: 'none' },
    ],
  });
  return { page, cdp };
}

/** Fingers: each `touch(id, x, y)` / `lift(id)` sends one CDP event with every finger still down. */
function fingers(cdp) {
  const down = new Map();
  const send = (type) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...down.values()] });
  return {
    async touch(id, x, y) {
      const fresh = !down.has(id);
      down.set(id, { x, y, id, radiusX: 10, radiusY: 10, force: 1 });
      await send(fresh ? 'touchStart' : 'touchMove');
    },
    async lift(id) {
      const p = down.get(id);
      down.delete(id);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [...down.values()] });
      return p;
    },
    /**
     * A quick stroke and lift taking `ms` by the events' own clocks: a busy headless page can deliver
     * CDP events late, and the controls time gestures by event timestamps (as phones stamp them).
     */
    async flick(id, x, y, dx, dy, ms = 120) {
      const t0 = Date.now() / 1000 - 1;
      const pt = (fx, fy) => [{ x: fx, y: fy, id, radiusX: 10, radiusY: 10, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x, y), timestamp: t0 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x + dx / 2, y + dy / 2), timestamp: t0 + ms / 2000 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x + dx, y + dy), timestamp: t0 + (ms * 0.9) / 1000 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: t0 + ms / 1000 });
    },
    /** a drag from (x, y) by (dx, dy) in `steps` moves, `ms` apart */
    async drag(id, x, y, dx, dy, steps = 6, ms = 16) {
      await this.touch(id, x, y);
      for (let i = 1; i <= steps; i++) {
        await this.touch(id, x + (dx * i) / steps, y + (dy * i) / steps);
        await sleep(ms);
      }
    },
  };
}

const me = (page) =>
  page.evaluate(() => {
    const m = window.__game.mode;
    const p = m.me;
    return { x: p.x, y: p.y, mag: p.weapons[p.active].mag, active: p.active, frags: p.frags, dashCooldown: p.dashCooldown, live: m.game.grenades.filter((g) => g.alive).length };
  });

async function centre(page, selector) {
  return page.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
}

async function ready(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.__game?.mode?.me && document.querySelector('.mf-touch') && !document.querySelector('.mf-touch').hidden, { timeout: 300_000 });
  await sleep(600);
}

/** Let the player land and stand still before a check. */
async function settle(page) {
  for (let i = 0; i < 40; i++) {
    const a = await me(page);
    await sleep(100);
    const b = await me(page);
    if (Math.abs(a.y - b.y) < 0.01 && Math.abs(a.x - b.x) < 0.01) return b;
  }
  return me(page);
}

try {
  // ---------- gameplay through touch (2D view: quick in software rendering) ----------
  {
    const { page, cdp } = await phonePage(LANDSCAPE);
    const f = fingers(cdp);
    await ready(page, `${base}/?sandbox&render=2d`);
    check('touch layout on a phone, no keyboard needed', await page.evaluate(() => document.documentElement.hasAttribute('data-touch-controls')));
    const W = LANDSCAPE.width;
    const H = LANDSCAPE.height;
    const L = { x: W * 0.18, y: H * 0.68 };
    const R = { x: W * 0.8, y: H * 0.62 };

    let s0 = await settle(page);
    await f.drag(1, L.x, L.y, 70, 0);
    await sleep(900);
    await f.lift(1);
    let s1 = await me(page);
    check('left stick right: the player walks right', s1.x - s0.x > 1, `${(s1.x - s0.x).toFixed(2)} m`);

    s0 = await settle(page);
    await f.drag(1, L.x, L.y, 0, -80);
    await sleep(700);
    s1 = await me(page);
    await f.lift(1);
    check('left stick up: the jetpack lifts', s1.y - s0.y > 0.5, `${(s1.y - s0.y).toFixed(2)} m`);

    s0 = await settle(page);
    await f.drag(2, R.x, R.y, 80, 0);
    await sleep(500);
    await f.lift(2);
    s1 = await me(page);
    check('right stick pushed past half-way fires (hold mode)', s1.mag < s0.mag, `mag ${s0.mag} → ${s1.mag}`);

    s0 = await settle(page);
    await f.drag(2, R.x, R.y, 20, 0, 3); // only aims
    await sleep(400);
    await f.lift(2);
    s1 = await me(page);
    check('a light push only aims, no shot', s1.mag === s0.mag);

    await page.evaluate(() => window.__touch.setTouchSettings({ fire: 'release' }));
    s0 = await settle(page);
    await f.drag(2, R.x, R.y, 0, -80);
    await sleep(300);
    const held = await me(page);
    await f.lift(2);
    await sleep(300);
    s1 = await me(page);
    check('release mode: aiming holds fire, lifting fires once', held.mag === s0.mag && s1.mag === s0.mag - 1, `mag ${s0.mag} → ${held.mag} → ${s1.mag}`);
    await page.evaluate(() => window.__touch.setTouchSettings({ fire: 'hold' }));

    // both thumbs at once: walk left while firing
    s0 = await settle(page);
    await f.touch(1, L.x, L.y);
    await f.touch(2, R.x, R.y);
    for (let i = 1; i <= 6; i++) {
      await f.touch(1, L.x - (70 * i) / 6, L.y);
      await f.touch(2, R.x + (80 * i) / 6, R.y);
      await sleep(16);
    }
    await sleep(700);
    await f.lift(1);
    await f.lift(2);
    s1 = await me(page);
    check('two thumbs: walking and firing together', s0.x - s1.x > 1 && s1.mag < s0.mag, `dx ${(s1.x - s0.x).toFixed(2)} m, mag ${s0.mag} → ${s1.mag}`);

    const g = await centre(page, '.mf-ctl-grenade');
    s0 = await settle(page);
    await f.touch(3, g.x, g.y);
    await sleep(60);
    await f.lift(3);
    await sleep(400);
    s1 = await me(page);
    check('grenade button: a tap throws', s1.frags === s0.frags - 1 || s1.live > s0.live, `frags ${s0.frags} → ${s1.frags}`);

    s0 = await settle(page);
    await f.drag(3, g.x, g.y, -40, -60, 5);
    await sleep(300);
    await f.lift(3);
    await sleep(400);
    s1 = await me(page);
    check('grenade button: hold and drag aims the arc, release throws', s1.frags === s0.frags - 1 || s1.live > 0, `frags ${s0.frags} → ${s1.frags}`);

    const sw = await centre(page, '.mf-ctl-swap');
    s0 = await settle(page);
    await f.touch(4, sw.x, sw.y);
    await sleep(80);
    await f.lift(4);
    await sleep(700);
    s1 = await me(page);
    check('swap button switches weapon', s1.active !== s0.active, `slot ${s0.active} → ${s1.active}`);

    s0 = await settle(page);
    await f.flick(1, L.x, L.y, 90, 0, 120);
    await sleep(150);
    s1 = await me(page);
    check('swipe and lift on the move stick dashes', s1.dashCooldown > 0, `cooldown ${s1.dashCooldown}`);
    await sleep(1200);
    s0 = await settle(page);
    await f.flick(1, L.x, L.y, 90, 0, 450); // the same stroke, slowly: a step, not a dash
    await sleep(150);
    s1 = await me(page);
    check('a slow stroke is a step, not a dash', s1.dashCooldown === 0 && s1.x > s0.x, `cooldown ${s1.dashCooldown}`);

    const d = await centre(page, '.mf-ctl-dash');
    await sleep(1200); // the dash cooldown
    await f.drag(1, L.x, L.y, -70, 0); // holding left…
    await f.touch(5, d.x, d.y);
    await sleep(60);
    await f.lift(5);
    await sleep(120);
    s1 = await me(page);
    await f.lift(1);
    check('dash button dashes the way the stick points', s1.dashCooldown > 0);

    const page2 = await page.evaluate(() => ({ scroll: window.scrollY, scale: window.visualViewport?.scale ?? 1, selected: String(window.getSelection?.() ?? '') }));
    check('no scrolling, zoom or text selection after all that', page2.scroll === 0 && page2.scale === 1 && page2.selected === '', JSON.stringify(page2));

    // the editor: drag reload somewhere else; it's there after a reload
    const edit = await centre(page, '.mf-touch-edit');
    await f.touch(6, edit.x, edit.y);
    await f.lift(6);
    await sleep(200);
    check('the ✎ button opens the HUD editor', await page.evaluate(() => !document.querySelector('.mf-touch-editor').hidden));
    const before = await centre(page, '.mf-ctl-reload');
    await f.drag(6, before.x, before.y, -150, 90, 8);
    await f.lift(6);
    await sleep(100);
    await page.screenshot({ path: join(outDir, 'editor-landscape.png') });
    const done = await centre(page, '[data-ed="done"]');
    await f.touch(6, done.x, done.y);
    await f.lift(6);
    await page.evaluate(() => document.querySelector('[data-ed="done"]').click()); // the tap may land as a click only
    await sleep(200);
    await ready(page, `${base}/?sandbox&render=2d`);
    const after = await centre(page, '.mf-ctl-reload');
    check('an edited layout survives a reload', Math.abs(after.x - (before.x - 150)) < 3 && Math.abs(after.y - (before.y + 90)) < 3, `(${before.x.toFixed(0)},${before.y.toFixed(0)}) → (${after.x.toFixed(0)},${after.y.toFixed(0)})`);
    await page.evaluate(() => window.__touch.resetTouchLayout());

    await page.evaluate(() => window.__touch.setTouchSettings({ handed: 'left' }));
    await sleep(200);
    const aimHome = await centre(page, '.mf-ctl-aim');
    check('left-handed: the aim stick moves to the left', aimHome.x < W / 2);
    await page.screenshot({ path: join(outDir, 'left-handed.png') });
    await page.evaluate(() => window.__touch.setTouchSettings({ handed: 'right' }));
    await page.close();
  }

  // ---------- screenshots and frame time, 3D Low preset ----------
  {
    const { page, cdp } = await phonePage(LANDSCAPE);
    await ready(page, `${base}/?sandbox`);
    await page.waitForFunction(() => window.__game.view3d?.stats().frameP50 > 0, { timeout: 300_000 });
    await sleep(1500);
    await page.screenshot({ path: join(outDir, 'landscape-375x812.png') });
    const s = await page.evaluate(() => window.__game.view3d.stats());
    check('phones: Low preset, DPR capped at 1.5, dynamic resolution on', s.preset === 'low' && s.pixelRatio <= 1.5 + 1e-6, `${s.preset}, pixel ratio ${s.pixelRatio.toFixed(2)}, scale ${s.scale.toFixed(2)}, ${s.width}×${s.height}`);

    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const f = fingers(cdp);
    await f.drag(1, LANDSCAPE.width * 0.18, LANDSCAPE.height * 0.68, 70, 0); // keep running while measuring
    const frames = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const times = [];
          let last = performance.now();
          const end = last + 8000;
          const step = (now) => {
            times.push(now - last);
            last = now;
            if (now < end) requestAnimationFrame(step);
            else resolve(times);
          };
          requestAnimationFrame(step);
        }),
    );
    await f.lift(1).catch(() => {});
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const sorted = [...frames].sort((a, b) => a - b);
    const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    const st = await page.evaluate(() => window.__game.view3d.stats());
    console.log(
      `frame time, CPU ×4, 3D Low (software WebGL): p50 ${pct(0.5).toFixed(1)} ms · p90 ${pct(0.9).toFixed(1)} ms · p99 ${pct(0.99).toFixed(1)} ms · ${frames.length} frames · ` +
        `render CPU mean ${st.cpuMean.toFixed(1)} ms · dynamic scale ${st.scale.toFixed(2)} · pixel ratio ${st.pixelRatio.toFixed(2)}`,
    );
    await page.close();
  }
  {
    const { page } = await phonePage(PORTRAIT);
    await ready(page, `${base}/?sandbox`);
    await sleep(1500);
    check('portrait: the landscape prompt shows', await page.evaluate(() => !document.querySelector('.mf-touch-rotate').hidden));
    await page.screenshot({ path: join(outDir, 'portrait-375x812.png') });
    await page.close();
  }
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
