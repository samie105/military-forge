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
const proxy: Record<string, ProxyOptions> = {
  '/api': { target: api, rewrite: (path) => path.replace(/^\/api/, '') },
  '/ws': { target: gameServer, ws: true },
};

/** `%GAME_NAME%` in the HTML pages (title, link previews) → the game's name. */
const brand: Plugin = {
  name: 'brand',
  transformIndexHtml: (html) => html.replaceAll('%GAME_NAME%', GAME_NAME),
};

export default defineConfig({
  plugins: [brand],
  server: { port: 5173, proxy },
  preview: { proxy },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Pages: the game (index.html), the Locker (locker.html, also a route inside the game) and the Armory (armory.html).
    rolldownOptions: { input: { main: 'index.html', locker: 'locker.html', armory: 'armory.html' } },
  },
});
