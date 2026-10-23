/* global process */
/**
 * The character creator's dressing check (owner, 23 Oct: "when selecting the clothes it wasn't updating the
 * characters at all"). Drives headless Chrome through #/creator on both bodies, at phone size (812×375, touch) and
 * desktop size, and in every look tab picks items and checks that the 3D soldier on the stage really changes:
 * a colour-histogram diff of the stage canvas.
 *
 * The stage runs under Reduce motion, so it stops drawing ~3 s after the last input and the picture holds still.
 * SLOW=1 throttles the phone's network so parts arrive after that (a stage that forgets to draw them fails); it
 * takes far longer, so it is off by default.
 *
 * Hard limits, so it never holds the shared heavy lock for long: TIMEOUT_S overall (default 300 s) and 20 s for any
 * one step; past either it kills its Chrome and exits 2. ONLY=phone or ONLY=desktop runs one size, BODIES=female one body.
 * Each pick goes B → A → B: the change counts when B→A differs far more than B→B (the idle's own drift).
 *
 *   cd apps/web && pnpm exec vite build && pnpm exec vite preview --port 5291 --strictPort
 *   node apps/web/scripts/creator-slots-check.mjs http://localhost:5291 [docs/screenshots/creator-fix/after]
 *
 * Exits 1 when any pick leaves the soldier unchanged (or the page throws, or an asset 404s).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const [base = 'http://localhost:5291', outDir = ''] = process.argv.slice(2);
const only = (process.env.ONLY ?? '').split(',').filter(Boolean); // e.g. ONLY=phone or ONLY=desktop
const slow = process.env.SLOW === '1';
const bodies = (process.env.BODIES ?? 'male,female').split(',').filter(Boolean); // e.g. BODIES=female
const STEP_MS = 20_000;
const TIMEOUT_MS = Number(process.env.TIMEOUT_S ?? 300) * 1000;
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'creator-slots-'));
if (outDir) mkdirSync(outDir, { recursive: true });

/** what each tab picks: [slot list label, item ids to try (the first that's offered)] */
const PICKS = {
  hair: [['hair_bun', 'hair_braids', 'hair_crop']],
  head: [['headgear_none', 'headgear_beanie', 'headgear_patrol_cap'], ['eyewear_shades', 'eyewear_goggles', 'eyewear_aviators']],
  outfit: [['top_bomber', 'top_hoodie_street', 'top_plate_carrier'], ['legs_joggers', 'legs_cargo_long'], ['gloves_tactical'], ['boots_desert', 'boots_high_tops']],
  gear: [['jetpack_drum', 'jetpack_rocket']],
  colours: [['dye_red', 'dye_navy']],
};

const VIEWS = [
  { name: 'desktop', viewport: { width: 1280, height: 720, deviceScaleFactor: 1 } },
  { name: 'phone', viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, slow },
].filter((v) => !only.length || only.includes(v.name));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  userDataDir: profile,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  protocolTimeout: STEP_MS,
});
/** past the overall limit: kill Chrome (ours) and stop */
const deadline = setTimeout(() => {
  console.error(`timed out after ${TIMEOUT_MS / 1000} s`);
  browser.process()?.kill('SIGKILL');
  rmSync(profile, { recursive: true, force: true });
  process.exit(2);
}, TIMEOUT_MS);
const failures = [];
const errors = [];
try {
  for (const view of VIEWS) {
    for (const body of bodies) {
      const page = await browser.newPage();
      page.setDefaultTimeout(STEP_MS);
      page.setDefaultNavigationTimeout(STEP_MS);
      const tag = `${view.name}/${body}`;
      page.on('pageerror', (e) => errors.push(`${tag} page error: ${e.message}`));
      page.on('console', (m) => m.type() === 'error' && errors.push(`${tag} console: ${m.text()}`));
      page.on('response', (r) => r.status() >= 400 && errors.push(`${tag} HTTP ${r.status()} ${r.url()}`));
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.setViewport(view.viewport);
      if (view.slow) {
        // a phone on a so-so connection: parts land well after the stage has gone to rest
        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 400_000, uploadThroughput: 200_000 });
      }
      await page.goto(`${base}/#/creator`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.mf-cr__overlay[hidden]', { timeout: slow ? 60_000 : STEP_MS });

      const canvasClip = async () => {
        const r = await page.$eval('.mf-cr__stage canvas', (c) => {
          const b = c.getBoundingClientRect();
          return { x: b.left, y: b.top, width: b.width, height: b.height };
        });
        return r;
      };
      /** a still picture of the stage: screenshots 500 ms apart until two match (the stage has come to rest) */
      const still = async () => {
        const clip = await canvasClip();
        let last = await page.screenshot({ clip, encoding: 'base64' });
        for (let i = 0; i < (slow ? 30 : 16); i++) {
          await new Promise((r) => setTimeout(r, 500));
          const now = await page.screenshot({ clip, encoding: 'base64' });
          if (now === last) return now;
          last = now;
        }
        return last;
      };
      /**
       * How far two PNGs differ, decoded in the page: `hist`, the share of pixels (%) whose colour moved to another bin
       * of a 512-bin histogram (a different garment changes the colours on show; the idle settling in another pose
       * mostly moves the same colours about), and `px`, the mean absolute difference per channel (0…255; a part of
       * much the same colours, like another jetpack, changes the shape).
       */
      const diff = (a, b) =>
        page.evaluate(async (a, b) => {
          const hist = async (s) => {
            const img = new Image();
            img.src = `data:image/png;base64,${s}`;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = img.width;
            c.height = img.height;
            const g = c.getContext('2d');
            g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, c.width, c.height).data;
            const h = new Float64Array(512);
            for (let i = 0; i < d.length; i += 4) h[((d[i] >> 5) << 6) | ((d[i + 1] >> 5) << 3) | (d[i + 2] >> 5)]++;
            return { h, d, n: d.length / 4 };
          };
          const [x, y] = await Promise.all([hist(a), hist(b)]);
          let moved = 0;
          for (let i = 0; i < 512; i++) moved += Math.abs(x.h[i] - y.h[i]);
          let sum = 0;
          for (let i = 0; i < x.d.length; i++) if (i % 4 !== 3) sum += Math.abs(x.d[i] - y.d[i]);
          return { hist: (50 * moved) / x.n, px: sum / (x.n * 3) };
        }, a, b);
      const click = async (selector) => {
        await page.$eval(selector, (el) => el.click());
      };
      const selectedId = (slotIds) =>
        page.evaluate((ids) => ids.map((id) => document.querySelector(`.mf-cr__list [data-id="${id}"]`)).find(Boolean)?.closest('.items')?.querySelector('.is-on')?.getAttribute('data-id') ?? null, slotIds);

      await click(`[data-body="${body}"]`);
      await click('[data-action="next"]');
      const tabs = await page.$$eval('.mf-cr__tabs [data-tab]', (ts) => ts.map((t) => ({ i: t.dataset.tab, label: t.textContent.trim() })));
      for (const t of tabs) {
        await click(`.mf-cr__tabs [data-tab="${t.i}"]`);
        const id = { Hair: 'hair', Headwear: 'head', Outfit: 'outfit', Gear: 'gear', Colourways: 'colours' }[t.label];
        for (const candidates of PICKS[id] ?? []) {
          const offered = await page.$$eval('.mf-cr__list [data-id]', (els) => els.map((e) => e.dataset.id));
          const pick = candidates.find((c) => offered.includes(c));
          if (!pick) continue;
          const before = (await selectedId([pick])) ?? null;
          // what it wore (or a second item when nothing was marked)
          const back = before && before !== pick ? before : candidates.find((c) => c !== pick && offered.includes(c));
          if (!back) continue;
          const channel = id === 'colours' ? '[data-channel="primary"]' : '';
          const wear = async (item) => {
            await click(`.mf-cr__list [data-id="${item}"]${channel}`);
            return still();
          };
          // B, back to A, B again: each change of the slot frames the same shot, so B→A is the look and B→B the
          // idle's own drift (the pose it came to rest in)
          const b = await wear(pick);
          if (outDir) await page.screenshot({ path: join(outDir, `${view.name}-${body}-${id}-${pick}.png`) });
          const a = await wear(back);
          const b2 = await wear(pick);
          const change = await diff(b, a);
          const drift = await diff(b, b2);
          // either measure standing well clear of the idle's drift
          const ok = (change.hist > 0.3 && change.hist > drift.hist * 2) || (change.px > 0.5 && change.px > drift.px * 2.5);
          const f = (m) => `${m.hist.toFixed(2)}%/${m.px.toFixed(2)}`;
          console.log(`${ok ? 'ok  ' : 'FAIL'} ${tag} ${t.label}: ${back} <-> ${pick}  change ${f(change)}  drift ${f(drift)} (histogram %/pixel)`);
          await click(`.mf-cr__list [data-id="${back}"]${channel}`); // as it was (the next pick's still waits)
          if (!ok) failures.push(`${tag} ${t.label} ${pick}`);
        }
      }
      await page.close();
    }
  }
} finally {
  clearTimeout(deadline);
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
for (const e of errors) console.error(e);
if (failures.length || errors.some((e) => /page error|HTTP 404/.test(e))) {
  console.error(`\n${failures.length} pick(s) left the soldier unchanged:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log('\nevery pick changed the soldier');
