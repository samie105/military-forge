/**
 * Can a phone player see their soldier? (the owner, 24 Oct: "someone said on mobile they can't see the
 * 3D character properly"). Training on each map at phone sizes and graphics presets: the soldier's
 * height on screen (px), and its contrast against the map around it (the luminance of the soldier's
 * pixels against a ring of map pixels around it, WCAG-style ratio). Screenshots for the eye.
 *
 *   node apps/web/scripts/soldier-visibility.mjs http://localhost:5228 <out-dir>
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5228').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/soldier-visibility');
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAPS = (process.env.MAPS ?? 'street-market,fog-stair,movement-test').split(',');
const SIZES = (process.env.SIZES ?? '780x360,844x300').split(',').map((s) => s.split('x').map(Number));
const GFX = (process.env.GFX ?? 'low,medium').split(',');
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'soldier-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });
const rows = [];

for (const map of MAPS)
  for (const [w, h] of SIZES)
    for (const gfx of GFX) {
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.evaluateOnNewDocument(() => {
        if (location.protocol === 'about:') return;
        const now = Date.now();
        localStorage.setItem('mf-creator-seen', '1');
        localStorage.setItem('mf.touch.drill.v1', 'done');
        localStorage.setItem('tips.seen.v1', '1');
        localStorage.setItem('mf.install.v1', JSON.stringify({ sessions: 1, dismissedAt: 1, matchesAtDismiss: 0, accepted: false }));
        localStorage.setItem('mf.facts.v1', JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }));
        localStorage.setItem('mf.age.v1', JSON.stringify({ adult: true, birthYear: 1990, at: Date.now() })); // the 18+ step, answered
      });
      await page.emulate({ viewport: { width: w, height: h, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' });
      await page.goto(`${base}/?app&map=${map}&gfx=${gfx}`, { waitUntil: 'load' });
      await page.waitForSelector('[data-screen="m-name"] input, [data-screen="m-home"]', { timeout: 90_000 });
      if (!(await page.$('[data-screen="m-home"]'))) {
        await page.type('[data-screen="m-name"] input', `S${Math.floor(Math.random() * 9999)}`);
        await page.keyboard.press('Enter');
        for (let i = 0; i < 15 && !(await page.$('[data-screen="m-home"]')); i++) {
          await sleep(800);
          await page.$eval('button[type=submit]', (b) => b.click()).catch(() => {});
        }
      }
      await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Training")]')).click();
      await sleep(Number(process.env.WAIT ?? 16_000));
      // the soldier's box on screen: its feet and its head (1.5 m standing) through the game's camera
      const box = await page.evaluate(() => {
        const m = window.__mfMode?.();
        const me = m?.me;
        const cam = m?.camera;
        if (!me || !cam) return null;
        const x = cam.toScreenX(me.x);
        const feet = cam.toScreenY(me.y);
        const head = cam.toScreenY(me.y + 1.5);
        const top = Math.min(feet, head);
        const bottom = Math.max(feet, head);
        const half = Math.abs(cam.toScreenX(me.x + 0.35) - x);
        // how much of the soldier the touch controls cover (their drawn circles)
        let covered = 0;
        const N = 12;
        const under = new Set();
        for (let i = 0; i < N; i++)
          for (let j = 0; j < N; j++) {
            const px = x - half + ((i + 0.5) / N) * 2 * half;
            const py = top + ((j + 0.5) / N) * (bottom - top);
            for (const el of document.querySelectorAll('.mf-ctl:not(.mf-off)')) {
              const r = el.getBoundingClientRect();
              const cx = r.left + r.width / 2;
              const cy = r.top + r.height / 2;
              if (Math.hypot(px - cx, py - cy) < Math.min(r.width, r.height) / 2 && Number(getComputedStyle(el).opacity) > 0.05) {
                covered++;
                under.add(el.dataset.mfControl || el.dataset.mfStick);
                break;
              }
            }
          }
        return { x, top, bottom, h: Math.abs(feet - head), view: cam.viewScale, covered: covered / (N * N), under: [...under].join(' '), xFrac: x / innerWidth, yFrac: (top + bottom) / 2 / innerHeight };
      });
      const file = join(out, `${map}-${w}x${h}-${gfx}.png`);
      await page.screenshot({ path: file });
      rows.push({ map, size: `${w}x${h}`, gfx, ...(box ?? {}), file });
      console.log(`${map} ${w}x${h} ${gfx}: soldier ${box ? `${box.h.toFixed(0)} px tall at ${(box.xFrac * 100).toFixed(0)}%,${(box.yFrac * 100).toFixed(0)}% of the screen, ${(box.covered * 100).toFixed(0)}% under controls${box.under ? ` (${box.under})` : ''} (view ${box.view})` : '?'}`);
      await ctx.close();
    }
await browser.close();
console.log(JSON.stringify(rows));
