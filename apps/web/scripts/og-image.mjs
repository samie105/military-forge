/**
 * The link-preview image (public/og-image.jpg, 1200×630) and the poster set (public/art/posters/, art/posters/
 * README.md): the key art v3 (art/key-art/) in one frame system. Every frame has the lockup
 * (public/art/brand/forged-force-lockup.svg), the hook "Fly. Dash. Fight." in the kit's stencil, a volt corner
 * tab ("Free in your browser"), the emblem bottom right and the address bottom left. Colours are the kit's tokens
 * (src/ui/kit.css, linked); the type is the kit's two families, from the @fontsource files.
 *
 *   node apps/web/scripts/og-image.mjs            # headless Chrome; nothing to serve: the pages are local files
 *
 * The 9:16 keeps its top 250 px and bottom 340 px free of words (a story's own buttons sit there).
 */
/* global process */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const repo = join(web, '../..');
const require = createRequire(join(web, 'package.json'));
const puppeteer = require('puppeteer-core');
const url = (p) => pathToFileURL(p).href;

const pnpm = join(repo, 'node_modules/.pnpm');
const pkgDir = (prefix, sub) => join(pnpm, readdirSync(pnpm).find((d) => d.startsWith(prefix)), 'node_modules', sub);
const stencil = join(pkgDir('@fontsource+big-shoulders-stencil-display@', '@fontsource/big-shoulders-stencil-display'), 'files/big-shoulders-stencil-display-latin-900-normal.woff2');
const archivo = join(pkgDir('@fontsource-variable+archivo@', '@fontsource-variable/archivo'), 'files/archivo-latin-wdth-normal.woff2');

const ADDRESS = 'forgedforce.deet.studio';
const art = {
  wide: join(repo, 'art/key-art/v3-desktop.jpg'),
  tall: join(repo, 'art/key-art/v3-tall-9x16.jpg'),
  portrait: join(repo, 'art/key-art/v3-tall-4x5.jpg'),
};
const lockup = join(web, 'public/art/brand/forged-force-lockup.svg');
const emblem = join(web, 'public/favicon.svg');

/**
 * The frames. `pos`: the art's object-position (keeps the hero in); `lock`: the lockup's width; `safe`: the
 * insets nothing written may cross (top, right, bottom, left); `scrim`: where the ink gradient comes from.
 */
const FRAMES = [
  { file: 'og-image.jpg', out: join(web, 'public'), w: 1200, h: 630, art: art.wide, pos: '70% 50%', lock: 470, hook: 64, safe: [48, 48, 44, 56], scrim: 'left' },
  { file: 'forged-force-1600x900.jpg', w: 1600, h: 900, art: art.wide, pos: '60% 50%', lock: 640, hook: 86, safe: [64, 64, 60, 76], scrim: 'left' },
  { file: 'forged-force-1080x1350.jpg', w: 1080, h: 1350, art: art.portrait, pos: '50% 50%', lock: 560, hook: 84, safe: [72, 60, 64, 64], scrim: 'top' },
  { file: 'forged-force-1080x1080.jpg', w: 1080, h: 1080, art: art.portrait, pos: '50% 62%', lock: 500, hook: 74, safe: [60, 56, 56, 60], scrim: 'top' },
  { file: 'forged-force-1080x1920.jpg', w: 1080, h: 1920, art: art.tall, pos: '50% 50%', lock: 640, hook: 92, safe: [250, 64, 340, 64], scrim: 'top' },
];

function page(f) {
  const [t, r, b, l] = f.safe;
  const scrim =
    f.scrim === 'left'
      ? 'linear-gradient(90deg, color-mix(in srgb, var(--c-ink-950) 82%, transparent) 0%, color-mix(in srgb, var(--c-ink-950) 50%, transparent) 34%, transparent 58%)'
      : 'linear-gradient(180deg, color-mix(in srgb, var(--c-ink-950) 72%, transparent) 0%, color-mix(in srgb, var(--c-ink-950) 30%, transparent) 30%, transparent 46%)';
  const tall = f.h > f.w;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${url(join(web, 'src/ui/kit.css'))}">
<style>
@font-face { font-family: 'Big Shoulders Stencil Display'; font-weight: 900; src: url('${url(stencil)}') format('woff2'); }
@font-face { font-family: 'Archivo'; font-weight: 100 900; font-stretch: 62% 125%; src: url('${url(archivo)}') format('woff2-variations'); }
html, body { margin: 0; width: ${f.w}px; height: ${f.h}px; overflow: hidden; background: var(--c-ink-900); }
.art { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; object-position: ${f.pos}; }
.scrim { position: absolute; inset: 0; background: ${scrim}; }
.foot { position: absolute; left: 0; right: 0; bottom: 0; height: ${b + 120}px; background: linear-gradient(0deg, color-mix(in srgb, var(--c-ink-950) 70%, transparent), transparent); }
.copy { position: absolute; left: ${l}px; top: ${t + (tall ? 0 : 40)}px; display: flex; flex-direction: column; align-items: flex-start; gap: ${Math.round(f.hook * 0.32)}px; }
.lock { width: ${f.lock}px; display: block; filter: drop-shadow(0 6px 18px color-mix(in srgb, var(--c-ink-950) 55%, transparent)); }
.hook { margin: 0; font: 900 ${f.hook}px/.92 var(--f-display); letter-spacing: .04em; text-transform: uppercase; color: var(--c-text); filter: drop-shadow(0 3px 10px color-mix(in srgb, var(--c-ink-950) 70%, transparent)); }
.hook b { color: var(--c-volt); font-weight: 900; }
.tab { ${tall ? 'position: relative; margin-bottom: 8px; padding-right: 22px; border-radius: var(--r-xs);' : 'position: absolute; top: 0; right: 0; padding-right: 30px; clip-path: polygon(22px 0, 100% 0, 100% 100%, 0 100%);'} display: inline-flex; align-items: center; gap: 12px; padding-left: ${tall ? 22 : 44}px; height: ${Math.round(f.hook * 0.78)}px; background: var(--c-volt); color: var(--c-volt-ink); font: 800 ${Math.round(f.hook * 0.34)}px/1 var(--f-ui); letter-spacing: .14em; text-transform: uppercase; }
.tab i { width: ${Math.round(f.hook * 0.2)}px; height: ${Math.round(f.hook * 0.2)}px; background: var(--c-volt-ink); clip-path: polygon(0 0, 100% 50%, 0 100%); }
.url { position: absolute; left: ${l}px; bottom: ${b}px; font: 700 ${Math.round(f.hook * 0.34)}px/1 var(--f-ui); letter-spacing: .06em; color: var(--c-text); text-shadow: var(--ts-hud); }
.url::before { content: ''; display: inline-block; width: ${Math.round(f.hook * 0.5)}px; height: 6px; margin: 0 14px 0 0; vertical-align: middle; background: var(--c-volt); }
.emb { position: absolute; right: ${r}px; bottom: ${b - 10}px; width: ${Math.round(f.hook * 1.05)}px; height: ${Math.round(f.hook * 1.05)}px; border-radius: 14%; box-shadow: var(--sh-card-sm); }
</style></head><body>
<img class="art" src="${url(f.art)}">
<div class="scrim"></div><div class="foot"></div>
${tall ? '' : '<div class="tab"><i></i>Free in your browser</div>'}
<div class="copy">
  ${tall ? '<div class="tab"><i></i>Free in your browser</div>' : ''}
  <img class="lock" src="${url(lockup)}" alt="Forged Force">
  <p class="hook">Fly. Dash.<br><b>Fight.</b></p>
</div>
<div class="url">${ADDRESS}</div>
<img class="emb" src="${url(emblem)}" alt="">
</body></html>`;
}

const scratch = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'ff-posters-'));
const posters = join(web, 'public/art/posters');
mkdirSync(posters, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: join(scratch, 'chrome'),
  args: ['--allow-file-access-from-files'],
});
try {
  await (await browser.target().createCDPSession()).send('Browser.setDownloadBehavior', { behavior: 'deny' });
  const tab = await browser.newPage();
  tab.setDefaultTimeout(60_000);
  for (const f of FRAMES) {
    // each frame a folder's index.html, so a file URL never offers a download
    const dir = join(scratch, f.file.replace(/\W/g, '-'));
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.html'), page(f));
    await tab.setViewport({ width: f.w, height: f.h, deviceScaleFactor: 1 });
    await tab.goto(url(join(dir, 'index.html')), { waitUntil: 'load', timeout: 60_000 });
    await tab.evaluate(() => document.fonts.ready);
    const path = join(f.out ?? posters, f.file);
    await tab.screenshot({ path, type: 'jpeg', quality: f.out ? 86 : 90 });
    console.log(`wrote ${path}`);
  }
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
