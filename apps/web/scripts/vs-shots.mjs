/**
 * The VS poster, its strip and the lobby's avatars, shot in headless Chrome from the dev-only preview
 * (vsposter.html: real portraits rendered by the portrait renderer) on the desktop (1920×1080, 1280×720)
 * and as a landscape phone (812×375, touch). Each shot waits for every portrait to land, then finishes
 * the entrance animations, so it shows the settled poster.
 *
 *   cd apps/web && pnpm exec vite --port 8234 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/vs-shots.mjs http://127.0.0.1:8234 docs/screenshots/match-presentation
 *
 * Exits 1 on a page error or a console error.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8234').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/match-presentation');
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const problems = [];

const SHOTS = [
  ['desktop-01-poster-all-vs-all-8', 'desktop', 'n=8'],
  ['desktop-02-poster-1v1', 'desktop', 'n=2'],
  ['desktop-03-poster-all-vs-all-16', 'desktop', 'n=16'],
  ['desktop-04-strip-at-3', 'desktop', 'n=8&state=strip'],
  ['desktop-05-lobby-avatars', 'desktop', 'n=8&state=lobby'],
  ['desktop-06-teams-4v4v4-later', 'desktop', 'n=12&teams=4v4v4'],
  ['laptop-1280-poster-all-vs-all-8', 'laptop', 'n=8'],
  ['phone-01-poster-all-vs-all-8', 'phone', 'n=8&phone'],
  ['phone-02-poster-1v1', 'phone', 'n=2&phone'],
  ['phone-03-poster-all-vs-all-16', 'phone', 'n=16&phone'],
  ['phone-04-strip-at-3', 'phone', 'n=8&state=strip&phone'],
  ['phone-05-teams-4v4-later', 'phone', 'n=8&teams=4v4&phone'],
];

const VIEWPORTS = {
  desktop: { width: 1920, height: 1080 },
  laptop: { width: 1280, height: 720 },
  phone: { width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: true },
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'vs-shots-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});
try {
  for (const [name, kind, query] of SHOTS) {
    const page = await browser.newPage();
    page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
    // the female soldier's rig 404s until her art lands (the assembler draws her on the male rig: #175)
    page.on('console', (m) => m.type() === 'error' && !/404/.test(m.text()) && problems.push(`${name}: ${m.text()}`));
    page.on('response', (r) => r.status() === 404 && !/rookie_female|favicon/.test(r.url()) && problems.push(`${name}: 404 ${r.url()}`));
    if (kind === 'phone') await page.setUserAgent(PHONE_UA);
    await page.setViewport(VIEWPORTS[kind]);
    await page.goto(`${base}/vsposter.html?${query}`, { waitUntil: 'load', timeout: 180_000 });
    // every portrait on show has landed (the silhouettes are underneath until then)
    await page.waitForFunction(() => document.querySelectorAll('.pt').length > 0 && document.querySelectorAll('.pt').length === document.querySelectorAll('.pt__img').length, { timeout: 240_000, polling: 250 });
    await page.evaluate(async () => {
      await Promise.all([...document.querySelectorAll('img')].map((i) => (i.complete ? null : new Promise((r) => (i.onload = i.onerror = r)))));
      for (const a of document.getAnimations()) a.finish();
    });
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log('shot', name);
    await page.close();
  }
} finally {
  await browser.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
