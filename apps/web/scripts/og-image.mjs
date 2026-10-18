/**
 * The link-preview image (public/og-image.jpg, 1200×630): the game's own map behind the name.
 * Re-run it after a rebrand: the name comes from packages/shared/src/brand.ts.
 *
 *   node apps/web/scripts/og-image.mjs http://127.0.0.1:<playtest port>/   # a running production build
 */
/* global process */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const name = /GAME_NAME = '([^']+)'/.exec(readFileSync(join(here, '../../../packages/shared/src/brand.ts'), 'utf8'))?.[1] ?? 'Game';
const [base = 'http://127.0.0.1:5173/?app', out = join(here, '../public/og-image.jpg')] = process.argv.slice(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'og-image-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1200, height: 630 },
});
const page = await browser.newPage();
await page.goto(base, { waitUntil: 'load', timeout: 120_000 });
await sleep(9000); // the 3D map warms up behind the menus
await page.evaluate((title) => {
  document.getElementById('shell')?.style.setProperty('display', 'none');
  document.getElementById('boot-splash')?.remove();
  const card = document.createElement('div');
  card.innerHTML = `
    <div style="position:fixed;inset:0;background:linear-gradient(90deg,rgba(10,14,20,.94) 0%,rgba(10,14,20,.78) 46%,rgba(10,14,20,.1) 100%)"></div>
    <div style="position:fixed;left:72px;top:150px;color:#e8edf3;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif">
      <div style="display:flex;align-items:center;gap:22px;font:800 64px/1 system-ui,sans-serif;letter-spacing:.05em;text-transform:uppercase">
        <span style="width:46px;height:46px;border-radius:7px;background:linear-gradient(135deg,#3fb6a8,#2a7f75);transform:rotate(45deg);box-shadow:0 0 40px rgba(63,182,168,.6);display:inline-block"></span>
        <span id="og-title"></span>
      </div>
      <div style="margin-top:26px;font:600 30px/1.3 system-ui,sans-serif;color:#cfd8e3">A 2.5D jetpack shooter in your browser</div>
      <div style="margin-top:34px;display:inline-flex;align-items:center;gap:12px;padding:16px 26px;border-radius:14px;background:#3fb6a8;color:#062521;font:800 26px/1 system-ui,sans-serif">▶ Open the link · pick a name · play</div>
    </div>`;
  document.body.appendChild(card);
  document.getElementById('og-title').textContent = title;
}, name);
await sleep(400);
await page.screenshot({ path: out, type: 'jpeg', quality: 86 });
await browser.close();
console.log(`wrote ${out}`);
