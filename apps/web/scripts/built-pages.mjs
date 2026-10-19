/**
 * Smoke test of the production build's pages of their own (locker.html, armory.html, admin.html,
 * probe.html): each one loads in headless Chrome from the built files, draws its root and throws no
 * page error. The dev server can't catch a page whose chunk imports the game's entry chunk (which
 * then boots the game with no canvas: #132 review H1); this can.
 *
 *   pnpm --filter @military-forge/web build && pnpm --filter @military-forge/web check:pages
 *   node apps/web/scripts/built-pages.mjs [dist dir]      (a build elsewhere: vite build --outDir <dir>)
 *
 * Exits 1 when a page throws or doesn't draw. It serves the files itself (a throwaway port).
 */
/* global process */
import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const dist = resolve(process.argv[2] ?? 'apps/web/dist');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ktx2': 'image/ktx2', '.wasm': 'application/wasm' };

/** [page, a selector its root draws] */
const PAGES = [
  ['locker.html', '.mm-locker'],
  ['armory.html', '.mf-armory'],
  ['admin.html', 'body *'],
  ['probe.html', 'body *'],
];

if (!existsSync(join(dist, 'locker.html'))) {
  console.error(`no build at ${dist}: run vite build first`);
  process.exit(1);
}

const server = createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join(dist, path || 'index.html');
  if (!file.startsWith(dist) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'built-pages-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 720 },
});
let failed = 0;
try {
  for (const [page, root] of PAGES) {
    const tab = await browser.newPage();
    const errors = [];
    tab.on('pageerror', (e) => errors.push(e.message));
    await tab.goto(`${base}/${page}`, { waitUntil: 'load' });
    const drawn = await tab.waitForSelector(root, { timeout: 15_000 }).then(
      () => true,
      () => false,
    );
    await new Promise((r) => setTimeout(r, 1500));
    const ok = drawn && errors.length === 0;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${page}${drawn ? '' : ` (no ${root})`}${errors.length ? `: ${errors.join(' | ')}` : ''}`);
    await tab.close();
  }
} finally {
  await browser.close();
  server.close();
}
process.exit(failed ? 1 : 0);
