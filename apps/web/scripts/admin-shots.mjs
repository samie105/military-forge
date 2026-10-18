/* global process */
/**
 * Screenshots of the owner's admin page in headless Chrome (throwaway profile), on a laptop and a phone.
 *   a game server with ADMIN_TOKEN=<token> ADMIN_PORT=9102, and Vite with DEV_ADMIN=http://localhost:9102
 *   node apps/web/scripts/admin-shots.mjs <base, e.g. http://localhost:5199> <token> [out dir]
 * (pnpm playtest serves the same page at /admin.)
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const [base = 'http://localhost:5199', token = '', outArg] = process.argv.slice(2);
const out = resolve(outArg ?? 'docs/screenshots/admin');
mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'admin-shots-')),
});
for (const [name, viewport] of [
  ['laptop', { width: 1280, height: 860, deviceScaleFactor: 1 }],
  ['phone', { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }],
]) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(`${base}/admin.html#t=${token}`, { waitUntil: 'networkidle0' });
  await page.waitForSelector('.admin__group');
  await page.screenshot({ path: join(out, `admin-${name}.png`) });
  console.log(`  admin-${name}.png`);
  if (name === 'laptop') {
    await page.type('.admin__search', 'k-47');
    await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: join(out, 'admin-search.png') });
    console.log('  admin-search.png');
  }
  await page.close();
}
await browser.close();
