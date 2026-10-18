import { defineConfig, type Plugin, type ProxyOptions } from 'vite';
// the brand lives in one place (packages/shared/src/brand.ts): pages get it at build time
import { GAME_NAME } from '../../packages/shared/src/brand';

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

export default defineConfig({
  plugins: [brand],
  server: { port: 5173, proxy },
  preview: { proxy },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Pages: the game (index.html), the Locker (locker.html, also a route inside the game), the Armory (armory.html)
    // and the owner's admin page (admin.html: /admin on pnpm playtest).
    rolldownOptions: { input: { main: 'index.html', locker: 'locker.html', armory: 'armory.html', admin: 'admin.html' } },
  },
});
