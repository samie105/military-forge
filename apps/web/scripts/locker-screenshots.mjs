/* global process */
/**
 * Locker screenshots for PRs (docs/screenshots/locker). Drives headless Chrome with a throwaway
 * profile against a running dev server:
 *   cd apps/web && pnpm exec vite --port 5182 --strictPort
 *   node apps/web/scripts/locker-screenshots.mjs http://localhost:5182 docs/screenshots/locker
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const [base = 'http://localhost:5182', outDir = 'docs/screenshots/locker'] = process.argv.slice(2);
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'locker-shots-'));
mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  userDataDir: profile,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.setViewport({ width: 1280, height: 720 });
  await page.goto(`${base}/locker.html`);
  await page.waitForSelector('.mm-overlay[hidden]', { timeout: 300_000 });

  const tab = (label) => page.$$eval('[data-tab]', (tabs, l) => tabs.find((t) => t.textContent === l).click(), label);
  const click = (selector) => page.click(selector);
  const shot = async (name) => {
    await new Promise((r) => setTimeout(r, 2000)); // let focus/zoom easing settle
    await page.screenshot({ path: join(outDir, `${name}.png`) });
    console.log('saved', name);
  };

  await shot('01-default-rookie');

  await tab('Dyes');
  await click('[data-channel="primary"][data-id="dye_red"]');
  await click('[data-channel="secondary"][data-id="dye_navy"]');
  await click('[data-channel="accent"][data-id="dye_yellow"]');
  await click('[data-id="dye_gold"][data-channel="accent"]'); // locked: shows how to get it
  await shot('02-dyes');

  await tab('Headgear');
  await click('[data-id="headgear_field_cap"]');
  await tab('Eyewear');
  await click('[data-id="eyewear_aviators"]');
  await tab('Gloves');
  await click('[data-id="gloves_tactical"]');
  await tab('Boots');
  await click('[data-id="boots_jungle"]');
  await tab('Body');
  await click('[data-id="body_stocky"]');
  await shot('03-parts');

  await tab('Skin');
  await click('[data-id="skin_10"]');
  await tab('Headgear');
  await click('[data-id="headgear_bandana"]');
  await click('[data-focus="face"]');
  await click('[data-light="night"]');
  await shot('04-face-night');

  await tab('Jetpack');
  await click('[data-id="jetpack_drum"]');
  await tab('Exhaust');
  await click('[data-id="exhaust_plasma"]');
  await click('[data-focus="jetpack"]');
  await click('[data-light="desert"]');
  await shot('05-jetpack-desert');

  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await click('[data-focus="full"]');
  await click('[data-light="lobby"]');
  await shot('06-phone');
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
