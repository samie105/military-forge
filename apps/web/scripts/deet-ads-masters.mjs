/* global process */
/**
 * DEET's billboard masters (art/ads/deet/*.png), drawn from the brand itself: the DEET. mark
 * (art/ads/deet/brand/deet-mark.svg, the site's own file), Bricolage Grotesque bold set tight for the
 * headlines, and the palette from the brand book: ink #0B0B0E, bone #F3F1EA, ash #8D8C93. The rainbow
 * ramp lives only in the mark's dot (the brand's rule: never a background, never type), which also
 * keeps the boards clear of the game's signal hues (house-ads.py checks the shipped pixels).
 *
 *   node apps/web/scripts/deet-ads-masters.mjs [--out art/ads/deet] [--only <master prefix>]
 *
 * Sizes are docs/14 §3.1's upload masters: Screens 2048 × 1536, Hoardings 2304 × 384. Text stays in
 * the central 90% × 85% (§3.2's safe area) and every line's cap height is ≥ 7% of the creative's
 * height. No URL, QR code or call to action on the art (docs/14 §1.3 rule 8, §3.2); the destination
 * travels with tap-to-save. A Motion creative (docs/14 §3.3) is one master per keyframe: the
 * headline, then its answer, the mark fixed in place. Then grade and encode them:
 *
 *   python3 -I apps/web/scripts/house-ads.py street_market --sponsored-only apps/web/public/assets/ads
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const ROOT = resolve(new URL('../../../', import.meta.url).pathname);
const ART = join(ROOT, 'art/ads/deet');
const out = resolve(arg('out', ART));
const only = arg('only', '');

const INK = '#0b0b0e';
const BONE = '#f3f1ea';
const ASH = '#8d8c93';
/** colourways: background, headline ("lit"), the answer line ("muted"), the mark's letters */
// flat colour only: a gradient bands in the ETC1S layers
const WAYS = {
  ink: { bg: INK, lit: BONE, muted: ASH, mark: BONE },
  ash: { bg: ASH, lit: INK, muted: '#26262c', mark: INK },
};

/**
 * The copy (art/ads/deet/README.md has every option and why these won). `lines`: the headline and
 * its answer. A still shows both; a Motion creative shows one per keyframe. `\n` sets a line break.
 */
const MASTERS = [
  // Screens, Motion: the headline, then its answer
  { name: 'm0_deet_three', fmt: '4:3', way: 'ink', motion: true, lines: ['The brand,\nthe app,\nthe AI.', 'One studio\nmakes all three.'] },
  { name: 'm1_deet_worlds', fmt: '4:3', way: 'ink', motion: true, lines: ['We build\nworlds too.', 'You’re\nstanding in one.'] },
  { name: 'm2_deet_clickable', fmt: '4:3', way: 'ink', motion: true, lines: ['Clickable\nby Friday.', 'Not a deck.\nNot a document.'] },
  { name: 'm3_deet_alma', fmt: '4:3', way: 'ink', motion: true, lines: ['Every project\nstarts with Alma.', 'Our AI listens.\nOur team builds.'] },
  { name: 'm4_deet_sharper', fmt: '4:3', way: 'ink', motion: true, lines: ['Shipped Friday.\nSharper by Monday.', 'We stay on\nafter launch.'] },
  // Screens, stills: headline and answer together
  { name: 's0_deet_taste', fmt: '4:3', way: 'ink', lines: ['AI with taste.', 'A design studio\nthat builds AI.'] },
  { name: 's1_deet_grind', fmt: '4:3', way: 'ink', lines: ['Let agents\ndo the grind.', 'AI that handles\nthe busywork.'] },
  { name: 's2_deet_rush', fmt: '4:3', way: 'ink', lines: ['Built for\nthe rush.', 'Quick on any phone,\nany network.'] },
  // the ash colourway
  { name: 's3_deet_taste_ash', fmt: '4:3', way: 'ash', lines: ['AI with taste.', 'A design studio\nthat builds AI.'] },
  { name: 's4_deet_worlds_ash', fmt: '4:3', way: 'ash', lines: ['We build\nworlds too.', 'You’re standing in one.'] },
  { name: 's5_deet_clickable_ash', fmt: '4:3', way: 'ash', lines: ['Clickable\nby Friday.', 'Not a deck.\nNot a document.'] },
  { name: 's6_deet_grind_ash', fmt: '4:3', way: 'ash', lines: ['Let agents\ndo the grind.', 'AI that handles\nthe busywork.'] },
  // Hoardings
  { name: 'h0_deet_worlds', fmt: '6:1', way: 'ink', motion: true, lines: ['We build worlds too.', 'You’re standing in one.'] },
  { name: 'h1_deet_taste', fmt: '6:1', way: 'ink', lines: ['AI with taste.', 'A design studio that builds AI.'] },
  { name: 'h2_deet_clickable', fmt: '6:1', way: 'ink', motion: true, lines: ['Clickable by Friday.', 'Not a deck. Not a document.'] },
  { name: 'h3_deet_grind', fmt: '6:1', way: 'ink', lines: ['Let agents do the grind.', 'AI that handles the busywork.'] },
];

const SIZE = { '4:3': [2048, 1536], '6:1': [2304, 384] };
const fontUrl = pathToFileURL(join(ART, 'brand/fonts/BricolageGrotesque-latin.woff2')).href;
const markSvg = readFileSync(join(ART, 'brand/deet-mark.svg'), 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const html = (s) => esc(s).replace(/\n/g, '<br>');

/** One keyframe's page. `lit` and `muted` are the lines shown (either may be absent). */
function page({ fmt, way }, lit, muted) {
  const [w, h] = SIZE[fmt];
  const c = WAYS[way];
  const mark = markSvg.replace(/fill="#f3f1ea"/g, `fill="${c.mark}"`);
  const screen = fmt === '4:3';
  // Screens: mark top left, the words bottom left. Hoardings: mark left, the words right.
  const pad = screen ? [176, 168] : [150, 52];
  const markH = screen ? 150 : 132;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: Bricolage; src: url(${fontUrl}) format('woff2'); font-weight: 200 800; }
html, body { margin: 0; width: ${w}px; height: ${h}px; overflow: hidden; }
body { background: ${c.bg}; font-family: Bricolage; font-weight: 700; -webkit-font-smoothing: antialiased; }
.frame { position: absolute; inset: ${pad[1]}px ${pad[0]}px; display: flex; ${screen ? 'flex-direction: column; justify-content: space-between;' : 'flex-direction: row; align-items: center; justify-content: space-between;'} }
.mark svg { display: block; height: ${markH}px; width: auto; }
.words { width: max-content; ${screen ? '' : 'text-align: right;'} }
.lit, .muted { letter-spacing: -0.045em; line-height: 0.96; white-space: nowrap; }
.lit { color: ${c.lit}; }
.muted { color: ${c.muted}; margin-top: 0.22em; }
</style></head><body><div class="frame">
<div class="mark">${mark}</div>
<div class="words">${lit ? `<div class="lit">${html(lit)}</div>` : ''}${muted ? `<div class="muted">${html(muted)}</div>` : ''}</div>
</div></body></html>`;
}

/**
 * Sets the type as large as the space allows, up to `max`: the words must fit beside (Hoardings) or
 * under (Screens) the mark with a clear gap. Returns the sizes and the measured cap heights.
 */
function fit({ screen, max, ratio, minMuted, gap }) {
  const frame = document.querySelector('.frame');
  const mark = document.querySelector('.mark');
  const words = document.querySelector('.words');
  const lit = document.querySelector('.lit');
  const muted = document.querySelector('.muted');
  const fw = frame.clientWidth;
  const fh = frame.clientHeight;
  let size = max;
  const set = (s) => {
    if (lit) lit.style.fontSize = `${s}px`;
    if (muted) muted.style.fontSize = `${lit ? Math.max(Math.round(s * ratio), minMuted) : s}px`;
  };
  for (; size > 20; size -= 2) {
    set(size);
    const wr = words.getBoundingClientRect();
    const mr = mark.getBoundingClientRect();
    const ok = screen ? wr.width <= fw && wr.height <= fh - mr.height - gap : wr.width <= fw - mr.width - gap && wr.height <= fh;
    if (ok) break;
  }
  // cap height of the smallest line, measured from the font (capHeight of an 'H')
  const probe = document.createElement('canvas').getContext('2d');
  const cap = (el) => {
    if (!el) return Infinity;
    const px = parseFloat(el.style.fontSize);
    probe.font = `700 ${px}px Bricolage`;
    const m = probe.measureText('H');
    return m.actualBoundingBoxAscent;
  };
  return { size, cap: Math.min(cap(lit), cap(muted)), loaded: document.fonts.check('700 100px Bricolage') };
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'deet-ads-masters-')),
  args: ['--allow-file-access-from-files', '--font-render-hinting=none'],
});
const tmp = mkdtempSync(join(tmpdir(), 'deet-ads-pages-'));
let failed = false;
try {
  mkdirSync(out, { recursive: true });
  const pg = await browser.newPage();
  for (const m of MASTERS.filter((x) => !only || x.name.startsWith(only))) {
    const [w, h] = SIZE[m.fmt];
    await pg.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
    const keys = m.motion ? [[m.lines[0], null], [m.lines[1], null]] : [[m.lines[0], m.lines[1]]];
    for (const [i, [lit, muted]] of keys.entries()) {
      const file = join(tmp, `${m.name}-${i}.html`);
      writeFileSync(file, page(m, lit, muted));
      await pg.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 30_000 });
      await pg.evaluate(() => document.fonts.ready);
      const screen = m.fmt === '4:3';
      // Screens: the headline up to 290 px, the answer 0.62 of it but never under 7% cap height
      // (Bricolage's cap is 0.66 em: 166 px on a Screen); a Hoarding's lines up to 136 px
      const r = await pg.evaluate(fit, { screen, max: screen ? 290 : 136, ratio: screen ? 0.62 : 0.72, minMuted: screen ? 166 : 44, gap: screen ? 110 : 140 });
      if (!r.loaded) throw new Error(`${m.name}: Bricolage didn't load`);
      const minCap = 0.07 * h;
      if (r.cap < minCap) {
        console.error(`${m.name} k${i}: cap height ${r.cap.toFixed(0)} px < 7% (${minCap.toFixed(0)} px)`);
        failed = true;
      }
      const name = m.motion ? `${m.name}_k${i}.png` : `${m.name}.png`;
      await pg.screenshot({ path: join(out, name), clip: { x: 0, y: 0, width: w, height: h } });
      console.log(`${name}: ${w}x${h}, type ${r.size} px, smallest cap ${r.cap.toFixed(0)} px`);
    }
  }
} finally {
  await browser.close();
  rmSync(tmp, { recursive: true, force: true });
}
if (failed) process.exit(1);
