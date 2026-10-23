/**
 * Real portraits of our soldiers, rendered by the game's own portrait renderer (portrait/, research §7) in
 * headless Chrome and saved as files: the head-and-shoulders avatar and the VS poster's full-body renders
 * for a lineup of looks (the female soldier included: she draws on the male rig until her art lands).
 * For the Pen board and the PR's screenshots. Needs the dev server (its window.__mfPortraits hook):
 *
 *   cd apps/web && pnpm exec vite --port 8234 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/portrait-renders.mjs http://127.0.0.1:8234 <out dir>
 */
/* global process, Buffer */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8234').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/match-presentation/renders');
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const D = {
  bodyType: 'body_standard', skinTone: 'skin_04', headgear: 'headgear_brim_helmet', eyewear: 'eyewear_none', top: 'top_fatigues', gloves: 'gloves_none',
  legs: 'legs_fatigues', boots: 'boots_combat', jetpack: 'jetpack_twin_tank', exhaust: 'exhaust_flame', trail: 'trail_ribbon', hair: 'hair_body',
};
const look = (items, primary, secondary, accent) => ({ items: { ...D, ...items }, dyes: { primary, secondary, accent } });
/** a lineup: every item a starter or level item, field and street colourways */
export const LINEUP = [
  ['ade', look({ bodyType: 'body_female', skinTone: 'skin_10', headgear: 'headgear_bandana', eyewear: 'eyewear_aviators', gloves: 'gloves_tactical', boots: 'boots_jungle', hair: 'hair_braids' }, 'dye_red', 'dye_white', 'dye_yellow')],
  ['kemi', look({ skinTone: 'skin_08' }, 'dye_sand', 'dye_olive', 'dye_teal')],
  ['tunde', look({ bodyType: 'body_stocky', skinTone: 'skin_11', headgear: 'headgear_field_cap', gloves: 'gloves_tactical' }, 'dye_olive', 'dye_sand', 'dye_charcoal')],
  ['zara', look({ bodyType: 'body_female', skinTone: 'skin_06', headgear: 'headgear_brim_helmet', hair: 'hair_bun', boots: 'boots_jungle' }, 'dye_khaki', 'dye_gunmetal', 'dye_mustard')],
  ['obi', look({ skinTone: 'skin_12', headgear: 'headgear_bandana', eyewear: 'eyewear_aviators', jetpack: 'jetpack_drum' }, 'dye_charcoal', 'dye_olive', 'dye_red')],
  ['lena', look({ bodyType: 'body_female', skinTone: 'skin_02', headgear: 'headgear_field_cap', hair: 'hair_bun' }, 'dye_forest', 'dye_brown', 'dye_yellow')],
  ['kolo', look({ bodyType: 'body_stocky', skinTone: 'skin_05', boots: 'boots_jungle', gloves: 'gloves_tactical' }, 'dye_stone', 'dye_charcoal', 'dye_terracotta')],
  ['ifeoma', look({ bodyType: 'body_female', skinTone: 'skin_09', headgear: 'headgear_bandana', hair: 'hair_braids' }, 'dye_white', 'dye_charcoal', 'dye_red')],
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'portraits-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 720 },
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
try {
  await page.goto(`${base}/?app`, { waitUntil: 'load', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__mfPortraits?.portraits?.installed, { timeout: 120_000 });
  const jobs = [];
  LINEUP.forEach(([name, l], i) => {
    jobs.push([`${name}-portrait-256`, { look: l, size: 256, pose: 'portrait' }]);
    jobs.push([`${name}-poster-512`, { look: l, size: 512, pose: `poster-${(i % 6) + 1}` }]);
  });
  jobs.push(['ade-portrait-win-256', { look: LINEUP[0][1], size: 256, pose: 'portrait-win' }]);
  jobs.push(['ade-portrait-down-256', { look: LINEUP[0][1], size: 256, pose: 'portrait-down' }]);
  for (const [name, req] of jobs) {
    const t0 = Date.now();
    const data = await page.evaluate(async (req) => {
      const img = await window.__mfPortraits.getPortrait(req, 'now');
      if (img.fallback) return null;
      const blob = await (await fetch(img.url)).blob();
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (const b of buf) s += String.fromCharCode(b);
      return { type: blob.type, b64: btoa(s) };
    }, req);
    if (!data) throw new Error(`${name}: the renderer fell back`);
    const ext = data.type === 'image/webp' ? 'webp' : 'png';
    writeFileSync(join(out, `${name}.${ext}`), Buffer.from(data.b64, 'base64'));
    console.log(name, ext, `${Date.now() - t0} ms`);
  }
  console.log(JSON.stringify({ renders: await page.evaluate(() => window.__mfPortraits.portraits.renders), errors }, null, 2));
} finally {
  await browser.close();
}
