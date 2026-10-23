import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
// the brand lives in one place (packages/shared/src/brand.ts): pages get it at build time
import { GAME_NAME } from '../../packages/shared/src/brand';
// the crawl and install files: /manifest.webmanifest, /robots.txt, /sitemap.xml (docs/seo.md)
import { seo } from './seo';
// the installable app's service worker, /sw.js (src/pwa registers it)
import { pwa } from './pwa';

/**
 * The app reaches the API at /api and rooms at /ws/<code> on its own origin (the playtest proxy,
 * scripts/playtest, does the same in production). In dev, Vite forwards them:
 * DEV_API (default http://localhost:8787) and DEV_GAME_SERVER (default http://localhost:9001).
 */
const api = process.env.DEV_API ?? 'http://localhost:8787';
const gameServer = process.env.DEV_GAME_SERVER ?? 'http://localhost:9001';
// the admin page's API: a game server run with ADMIN_TOKEN and ADMIN_PORT (default 9002 here)
const adminApi = process.env.DEV_ADMIN ?? 'http://localhost:9002';
const proxy: Record<string, ProxyOptions> = {
  '/api': { target: api, rewrite: (path) => path.replace(/^\/api/, '') },
  '/ws': { target: gameServer, ws: true },
  '/admin/api': { target: adminApi },
};

/**
 * `%GAME_NAME%` in the HTML pages (title, link previews) → the game's name. `%ORIGIN%` (link
 * previews need absolute image URLs) is the site's public address: the playtest proxy fills it in
 * per request, so the build keeps it; in dev the URLs stay relative.
 */
const brand: Plugin = {
  name: 'brand',
  transformIndexHtml: (html, ctx) => {
    const named = html.replaceAll('%GAME_NAME%', GAME_NAME);
    return ctx.server ? named.replaceAll('%ORIGIN%', '') : named;
  },
};

/**
 * `virtual:title-info` (the title screen, shell/screens/Title.tsx): this build's id (git's short hash,
 * 'dev' without git) and the key art the Forge has dropped in public/art/key-art/
 * (key-art-desktop.*, key-art-phone.*, optional *-fg.* parallax layers): known at build time, so the
 * page never probes for files that aren't there. New art needs a dev-server restart or a build.
 */
const TITLE_INFO = 'virtual:title-info';
const titleInfo: Plugin = {
  name: 'title-info',
  resolveId: (id) => (id === TITLE_INFO ? `\0${TITLE_INFO}` : null),
  load(id) {
    if (id !== `\0${TITLE_INFO}`) return null;
    let build = 'dev';
    try {
      build = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || 'dev';
    } catch {
      /* no git: a build from an export */
    }
    const dir = fileURLToPath(new URL('./public/art/key-art/', import.meta.url));
    const files = existsSync(dir) ? readdirSync(dir) : [];
    // every format a picture comes in, best first (AVIF, then WebP as the fallback: art/key-art/README.md)
    const all = (stem: string, exts: readonly string[]) => exts.map((ext) => `${stem}.${ext}`).filter((f) => files.includes(f));
    const IMG = ['avif', 'webp', 'jpg', 'jpeg', 'png'];
    const art = {
      desktop: all('key-art-desktop', IMG),
      phone: all('key-art-phone', IMG),
      desktopFg: all('key-art-desktop-fg', IMG),
      phoneFg: all('key-art-phone-fg', IMG),
      desktopLoop: all('key-art-desktop-loop', ['webm', 'mp4']),
    };
    return `export const buildId = ${JSON.stringify(build)};\nexport const keyArt = ${JSON.stringify(art)};\n`;
  },
};

export default defineConfig({
  plugins: [brand, titleInfo, seo(GAME_NAME), pwa()],
  server: { port: 5173, proxy },
  preview: { proxy },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Pages: the game (index.html), the Locker (locker.html, also a route inside the game), the Armory (armory.html)
    // the owner's admin page (admin.html: /admin on pnpm playtest) and the net trial's ping probe
    // (probe.html: /probe on the trial boxes, docs/net-trial.md), the controller check (gamepad.html: every axis and button, live)
    // and the sound board (sounds.html: every sound with a play button, docs/audio.md).
    rolldownOptions: { input: { main: 'index.html', locker: 'locker.html', armory: 'armory.html', admin: 'admin.html', probe: 'probe.html', gamepad: 'gamepad.html', sounds: 'sounds.html' } },
  },
});
