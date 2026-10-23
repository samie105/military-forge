/**
 * The spotlight's acceptance checks (docs/design/onboarding-research.md §7, phase 2) in headless
 * Chrome, on the real app (its fit, zoom and the turned phone page), against a running dev server:
 *
 *   node apps/web/scripts/spotlight-check.mjs http://127.0.0.1:5191 [screenshot dir]
 *
 * At 1280×720, 2560×1440, a phone held sideways (812×375) and an upright phone (the page turns):
 * - the hole and the ring line up with the target within 1 px;
 * - blocking: a click outside the hole reaches nothing, inside it reaches the target (elementFromPoint and a
 *   real mouse click); not blocking: everything is reachable;
 * - no animation frame is asked for while the spotlight stands still;
 * - focus goes to the target, Tab cycles it and the callout, Escape skips the pass; the live region speaks;
 * - Reduce motion: no pulse or travel; text at 150 %: the callout stays clear of the hole and on screen.
 * Exits 1 on any failure. It needs the dev server (it imports /src/ui/spotlight.ts) but no API: the name
 * screen is its stage.
 */
/* global process */
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? null;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (out) mkdirSync(out, { recursive: true });

const SIZES = [
  ['laptop', { width: 1280, height: 720 }],
  ['desktop-2k', { width: 2560, height: 1440 }],
  ['phone', { width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: true }],
  ['phone-upright', { width: 375, height: 812, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: false }],
];

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: mkdtempSync(join(tmpdir(), 'spot-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  for (const [label, viewport] of SIZES) {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    page.on('pageerror', (e) => check(`${label}: no page error`, false, e.message));
    await page.goto(`${base}/?app`, { waitUntil: 'load' });
    await page.waitForSelector('input[aria-label="Your name"]', { timeout: 90_000 });
    await sleep(800);
    // an upright phone first shows "turn it sideways" over the form: put it away
    await page.evaluate(() => document.querySelector('.pm-turn__card button')?.click());
    await sleep(300);
    // count the animation frames the spotlight asks for (other code on the page has its own)
    await page.evaluate(() => {
      const raf = window.requestAnimationFrame.bind(window);
      window.__spotFrames = 0;
      window.requestAnimationFrame = (cb) => {
        // the spotlight module's own frames (this script's evaluate frames carry its file name too)
        if (/\/ui\/spotlight\.ts/.test(new Error().stack ?? '')) window.__spotFrames++;
        return raf(cb);
      };
    });
    const setup = await page.evaluate(async () => {
      const { Spotlight } = await import('/src/ui/spotlight.ts');
      const target = document.querySelector('input[aria-label="Your name"]').closest('.input');
      const outside = document.querySelector('.idcard, .pm-ne__card');
      window.__clicks = 0;
      document.addEventListener('click', (e) => { if (e.target instanceof Node && outside.contains(e.target)) window.__clicks++; }, true);
      const spot = new Spotlight({ phone: () => document.documentElement.classList.contains('mf-phone') });
      window.__spot = spot;
      window.__skips = [];
      spot.onSkip = (id, all) => window.__skips.push([id, all]);
      spot.show({ id: 'name', target: { kind: 'element', el: target }, block: 'outside', title: 'Your name.', body: 'Friends see it in the room.', eyebrow: 'ORDERS · 1/3', announce: 'Step 1 of 3. Your name.' });
      return { rotated: document.documentElement.classList.contains('mf-rotated') };
    });
    await sleep(900);
    const geo = await page.evaluate(() => {
      // the pulse scales the ring for 4 s; measure it at rest
      document.querySelector('.mf-spot__ring').getAnimations().forEach((a) => a.finish());
      const t = document.querySelector('input[aria-label="Your name"]').closest('.input').getBoundingClientRect();
      const r = document.querySelector('.mf-spot__ring').getBoundingClientRect();
      const outside = document.querySelector('.idcard, .pm-ne__card').getBoundingClientRect();
      const c = document.querySelector('.mf-spot__callout').getBoundingClientRect();
      return { t: [t.left, t.top, t.right, t.bottom], r: [r.left, r.top, r.right, r.bottom], o: [outside.left + outside.width / 2, outside.top + outside.height / 2], c: [c.left, c.top, c.right, c.bottom], vw: innerWidth, vh: innerHeight };
    });
    // the hole is the target inflated by the padding: 6 px on every side (the turned page keeps it 6)
    const off = Math.max(...[0, 1, 2, 3].map((i) => Math.abs(geo.r[i] - (geo.t[i] + (i < 2 ? -6 : 6)))));
    check(`${label}: the ring lines up with its target within 1 px${setup.rotated ? ' (turned page)' : ''}`, off <= 1, `off by ${off.toFixed(2)} px`);
    const centre = [(geo.t[0] + geo.t[2]) / 2, (geo.t[1] + geo.t[3]) / 2];
    const hit = await page.evaluate(([x, y], [ox, oy]) => {
      const inside = document.elementFromPoint(x, y);
      const outside = document.elementFromPoint(ox, oy);
      return { inside: inside?.closest('.input') ? 'target' : inside?.className, outside: outside?.className };
    }, centre, geo.o);
    check(`${label}: blocking, the hole passes to the target`, hit.inside === 'target', String(hit.inside));
    check(`${label}: blocking, outside the hole only the dim is hit`, hit.outside === 'mf-spot__dim', String(hit.outside));
    await page.mouse.click(geo.o[0], geo.o[1]);
    await page.mouse.click(centre[0], centre[1]);
    const after = await page.evaluate(() => ({ clicks: window.__clicks, focus: document.activeElement?.getAttribute('aria-label') }));
    check(`${label}: a real click outside reaches nothing`, after.clicks === 0, `${after.clicks} clicks`);
    check(`${label}: a real click in the hole reaches the target`, after.focus === 'Your name', String(after.focus));
    // standing still: no animation frames
    await sleep(400);
    await page.evaluate(() => (window.__spotFrames = 0));
    await sleep(1000);
    const frames = await page.evaluate(() => window.__spotFrames);
    check(`${label}: no animation frames while it stands still`, frames === 0, `${frames} frames`);
    // focus order, the live region, Escape
    const keys = await page.evaluate(() => {
      window.__spot.show({ ...window.__spot.current, id: 'name-2' });
      const first = document.activeElement?.closest('.input') ? 'target' : document.activeElement?.className;
      return { first, live: document.querySelector('.mf-spot__live').textContent, role: document.querySelector('.mf-spot__callout').getAttribute('role') };
    });
    await sleep(100);
    await page.keyboard.press('Tab');
    const second = await page.evaluate(() => document.activeElement?.className);
    await page.keyboard.press('Tab');
    const third = await page.evaluate(() => (document.activeElement?.closest('.input') ? 'target' : document.activeElement?.className));
    await page.keyboard.press('Escape');
    const skips = await page.evaluate(() => window.__skips);
    check(`${label}: focus starts on the target, Tab cycles the callout and back`, keys.first === 'target' && second === 'mf-spot__skip' && third === 'target', `${keys.first} → ${second} → ${third}`);
    check(`${label}: the live region speaks the step; the callout is a dialog when it blocks`, keys.live === 'Step 1 of 3. Your name.' && keys.role === 'dialog', `${keys.live} · ${keys.role}`);
    check(`${label}: Escape skips the pass`, JSON.stringify(skips) === JSON.stringify([['name-2', true]]), JSON.stringify(skips));
    if (out) await page.screenshot({ path: join(out, `${label}-blocking.png`) });
    // not blocking (in play): everything reachable
    const free = await page.evaluate(([ox, oy]) => {
      window.__spot.show({ ...window.__spot.current, id: 'play', block: 'none' });
      return document.elementFromPoint(ox, oy)?.className;
    }, geo.o);
    check(`${label}: not blocking, outside the hole is reachable`, !String(free).includes('mf-spot'), String(free));
    // Reduce motion: no pulse, no travel
    const motion = await page.evaluate(() => {
      document.documentElement.classList.add('reduce-motion');
      const r = getComputedStyle(document.querySelector('.mf-spot__ring'));
      return { anim: r.animationName, transition: r.transitionProperty };
    });
    check(`${label}: Reduce motion stops the pulse and the travel`, motion.anim === 'none' && !motion.transition.includes('transform'), `${motion.anim} · ${motion.transition}`);
    // text at 150 %: the callout stays clear of the hole and on screen
    await page.evaluate(() => {
      document.documentElement.classList.remove('reduce-motion');
      document.documentElement.style.setProperty('--text-scale', '1.5');
      window.__spot.show({ ...window.__spot.current, id: 'big', block: 'outside' });
    });
    await sleep(900);
    const big = await page.evaluate(() => {
      document.querySelector('.mf-spot__ring').getAnimations().forEach((a) => a.finish());
      const c = document.querySelector('.mf-spot__callout').getBoundingClientRect();
      const r = document.querySelector('.mf-spot__ring').getBoundingClientRect();
      const overlap = !(c.right <= r.left || c.left >= r.right || c.bottom <= r.top || c.top >= r.bottom);
      const r4 = (b) => [b.left, b.top, b.right, b.bottom].map((v) => Math.round(v));
      return { overlap, inside: c.left >= -1 && c.top >= -1 && c.right <= innerWidth + 1 && c.bottom <= innerHeight + 1, ...(overlap ? { callout: r4(c), ring: r4(r) } : {}) };
    });
    check(`${label}: at 150 % text the callout is on screen and clear of the hole`, !big.overlap && big.inside, JSON.stringify(big));
    if (out) await page.screenshot({ path: join(out, `${label}-big-text.png`) });
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all spotlight checks passed');
process.exit(failures ? 1 : 0);
