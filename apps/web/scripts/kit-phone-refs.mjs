/**
 * Renders the design kit's phone screens (docs/design/military-forge-ui-v2.html: m-hud and its states,
 * m-home, m-lobby, m-pause, m-results, m-locker) at 812×375, plain and at 150 % text, as WebP
 * references in docs/design/v2-shots/phone/. (The kit's own m*.jpg captures show the name-entry
 * screen instead of the phone frames.) Needs python3 with Pillow for the WebP.
 *
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/kit-phone-refs.mjs
 */
/* global process */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const kit = fileURLToPath(new URL('../../../docs/design/military-forge-ui-v2.html', import.meta.url));
const out = fileURLToPath(new URL('../../../docs/design/v2-shots/phone/', import.meta.url));
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const tmp = mkdtempSync(join(tmpdir(), 'kit-phone-'));
mkdirSync(out, { recursive: true });
const shots = [
  ['m-hud', 'idle'],
  ['m-hud', 'grenade-aim'],
  ['m-hud', 'near-crate'],
  ['m-hud', 'swap'],
  ['m-hud', 'low-hp'],
  ['m-home', ''],
  ['m-lobby', ''],
  ['m-pause', 'host'],
  ['m-pause', 'guest'],
  ['m-results', ''],
  ['m-locker', ''],
];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: join(tmp, 'profile') });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 812, height: 375, deviceScaleFactor: 2 });
  for (const [id, state] of shots) {
    for (const q of ['shot', 'shot&text']) {
      await page.goto(`file://${kit}?${q}#${id}${state ? `/${state}` : ''}`);
      await page.reload();
      await new Promise((r) => setTimeout(r, 400));
      const name = `${id}${state ? `-${state}` : ''}${q.includes('text') ? '-text150' : ''}`;
      const png = join(tmp, `${name}.png`);
      await (await page.$(`.dev-frame[data-for="${id}"]`)).screenshot({ path: png });
      execFileSync('python3', ['-I', '-c', 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], "WEBP", quality=82, method=6)', png, join(out, `${name}.webp`)]);
      console.log(`${name}.webp`);
    }
  }
} finally {
  await browser.close();
}
