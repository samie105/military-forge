/**
 * The Locker (the app's route) and the Armory (its own page, as Home's Armory opens it) on a phone, held sideways (812×375) and upright (375×812: the page
 * turned, ui/landscape.ts), with touch and a coarse pointer, in headless Chrome. For each it checks:
 *   - nothing interactive sits off the screen, and every target is at least 48 px;
 *   - the Locker's "Fits the body" stamp stays on the stage, clear of the item panel, on every tab;
 *   - the Armory takes its phone layout (the list as a row, the gun's table and its card side by side),
 *     and Equip as gun 1 / gun 2 are reachable.
 * Shots go to `out`; exits 1 on a failed check, a page error or a missing #icon-*.
 *
 *   cd apps/web && pnpm exec vite --port 5221 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/phone-gear-shots.mjs http://localhost:5221 docs/screenshots/phone-ui/gear
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5221').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/phone-ui/gear');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const problems = [];
const check = (ok, what) => {
  if (ok) console.log(`ok: ${what}`);
  else problems.push(what);
};
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'phone-gear-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|\/api\//.test(m.text())) problems.push(`console error: ${m.text()}`);
});
const cdp = await page.createCDPSession();
const phone = async (portrait) => {
  await page.emulate({
    viewport: portrait ? { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false } : { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
    userAgent: UA,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'pointer', value: 'coarse' },
      { name: 'any-pointer', value: 'coarse' },
      { name: 'hover', value: 'none' },
    ],
  });
};
const shot = async (name, settle = 600) => {
  await sleep(settle);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};
async function iconsResolve(where) {
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('use')]
      .map((u) => u.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('#') && !document.getElementById(h.slice(1)))
      .filter((h, i, a) => a.indexOf(h) === i),
  );
  for (const h of missing) problems.push(`${where}: missing ${h || '(empty href)'}`);
}

/**
 * Visible buttons: none off the screen (in a scroller, the scroller's box counts: it can be scrolled
 * to), none under 48 px. Rects are the screen's: on a turned page a box's width and height swap, so
 * the smaller side is what's checked.
 */
async function targets(where, sel = 'button, [role="tab"], .seg__opt') {
  const bad = await page.evaluate((s) => {
    const out = [];
    const sw = innerWidth;
    const sh = innerHeight;
    for (const b of document.querySelectorAll(s)) {
      if (!b.offsetParent || b.closest('[hidden], details:not([open]) > :not(summary)')) continue;
      const r = b.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const name = (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 24);
      // inside scrollers: on screen once scrolled to (the outermost scroller's own box must be on screen)
      let box = r;
      for (let p = b.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (/(auto|scroll)/.test(cs.overflowX + cs.overflowY) && p.scrollHeight + p.scrollWidth > p.clientHeight + p.clientWidth + 2) box = p.getBoundingClientRect();
      }
      if (box.right > sw + 1 || box.bottom > sh + 1 || box.left < -1 || box.top < -1) out.push(`"${name}" off screen`);
      if (Math.min(r.width, r.height) < 47.5) out.push(`"${name}" is ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return [...new Set(out)];
  }, sel);
  for (const b of bad) problems.push(`${where}: ${b}`);
}

const overlap = (sa, sb) =>
  page.evaluate(
    (a, b) => {
      const ea = document.querySelector(a);
      const eb = document.querySelector(b);
      if (!ea || !eb) return null;
      const r = ea.getBoundingClientRect();
      const q = eb.getBoundingClientRect();
      return r.left < q.right - 1 && r.right > q.left + 1 && r.top < q.bottom - 1 && r.bottom > q.top + 1;
    },
    sa,
    sb,
  );

try {
  for (const [where, portrait] of [
    ['l', false],
    ['r', true],
  ]) {
    await phone(portrait);

    // ---- the Locker (the app's route, as Home's Locker opens it): every tab; the stamp stays on the stage ----
    await page.goto(`${base}/?app`, { waitUntil: 'load' });
    await page.waitForSelector('input[aria-label="Your name"], [data-screen="m-home"]', { timeout: 60_000 });
    if (!(await page.$('[data-screen="m-home"]'))) {
      // an upright phone's one-time turn tip, if this build has it
      await page.$eval('.pm-turn .btn', (b) => b.click()).catch(() => {});
      await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
      for (let i = 0; i < 10 && !(await page.$('[data-screen="m-home"]')); i++) {
        await sleep(1200);
        await page.$eval('button[type=submit]', (b) => b.click()).catch(() => {});
      }
      await page.waitForSelector('[data-screen="m-home"]', { timeout: 30_000 });
    }
    await page.evaluate(() => (location.hash = '#/locker'));
    await page.waitForSelector('.mf-route .mm-locker', { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('.mm-overlay')?.hidden !== false, { timeout: 120_000 }).catch(() => {});
    if (portrait) check(await page.evaluate(() => document.documentElement.classList.contains('mf-rotated')), 'upright: the Locker turns onto its side');
    const tabs = await page.$$eval('.mm-tabs [data-tab]', (b) => b.length);
    for (let i = 0; i < tabs; i++) {
      await page.$$eval('.mm-tabs [data-tab]', (b, n) => b[n].click(), i);
      await sleep(500);
      const name = await page.$$eval('.mm-tabs [data-tab]', (b, n) => b[n].textContent.trim(), i);
      const hit = await overlap('.lk__fits', '.lk__panel');
      check(hit === false, `${where}: Locker · ${name}: the "Fits the body" stamp is clear of the item panel`);
      if (i === 0) {
        await shot(`${where}-locker`, 1500);
        await iconsResolve(`${where} locker`);
      }
    }
    await targets(`${where} locker`, '.mm-locker button');
    await page.evaluate(() => (location.hash = ''));
    await sleep(500);

    // ---- the Armory: its phone layout; Equip reachable ----
    await page.goto(`${base}/armory.html`, { waitUntil: 'load' });
    await page.waitForSelector('[data-screen="armory"] .ar__item', { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelector('.mf-overlay')?.hidden !== false, { timeout: 120_000 }).catch(() => {});
    await shot(`${where}-armory`, 2000);
    await iconsResolve(`${where} armory`);
    const layout = await page.evaluate(() => {
      const ar = document.querySelector('.menu-body.ar');
      const fit = document.querySelector('.mf-gear-fit > .screen');
      return { areas: ar ? getComputedStyle(ar).gridTemplateAreas : '', zoom: fit ? getComputedStyle(fit).zoom : '' };
    });
    check(/"list list"/.test(layout.areas) && /"stage side"/.test(layout.areas), `${where}: the Armory takes its phone layout (${layout.areas})`);
    check(layout.zoom === '1', `${where}: the Armory lays out at the phone's own size, not the desktop's scaled down (zoom ${layout.zoom})`);
    await targets(`${where} armory`, '.mf-armory button, .mf-armory .seg__opt');
    // Equip: scroll the side panel to it and press gun 2
    await page.$eval('.mf-equip', (el) => el.scrollIntoView({ block: 'center' }));
    await sleep(300);
    const equip = await page.$eval('.mf-equip [data-slot="1"]', (b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight + 1 && r.left >= 0 && r.right <= innerWidth + 1;
    });
    check(equip, `${where}: Equip as gun 2 is on screen once the card is scrolled to`);
    await shot(`${where}-armory-equip`, 400);
    // large text
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1.5'));
    await shot(`${where}-armory-text150`, 600);
    await targets(`${where} armory 150%`, '.mf-armory button, .mf-armory .seg__opt');
    await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
  }
} finally {
  await browser.close();
}
for (const p of problems) console.error(`FAIL: ${p}`);
if (problems.length) process.exit(1);
