/* global process */
/**
 * A network stall in a real browser: an online player (WebSocket) goes offline for 15 s through
 * Chrome's network emulation, then comes back. It must still be playing afterwards, not kicked
 * with 4004 RATE_LIMITED for the INPUTs it queued while it was stalled.
 *   PORT=9213 pnpm --filter @military-forge/game-server start           # a dev room
 *   cd apps/web && pnpm exec vite --port 5213 --strictPort
 *   node apps/web/scripts/stall-check.mjs [--base http://localhost:5213] [--server ws://localhost:9213] [--seconds 15]
 * Exits 1 when the player was kicked or never came back.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5213');
const server = arg('server', 'ws://localhost:9213');
const seconds = Number(arg('seconds', '15'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'stall-check-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1280, height: 720 },
  protocolTimeout: 120_000,
});
let ok;
try {
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`${base}/?online&transport=ws&server=${encodeURIComponent(server)}&name=Staller`, { waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 120; i++) {
    if (await page.evaluate(() => !!window.__game?.mode.net?.predictor?.started)) break;
    await sleep(500);
  }
  const state = () =>
    page.evaluate(() => {
      const m = window.__game.mode;
      const n = m.net;
      return { status: m.status, conn: m.conn?.state, code: m.conn?.code ?? null, connected: n.isConnected, reconnects: n.reconnects, heldBack: n.inputsHeldBack, transport: m.transport?.kind ?? null };
    });
  await page.keyboard.down('KeyD'); // walking: an INPUT every tick, as in play
  await sleep(2000);
  const before = await state();
  log('playing:', JSON.stringify(before));
  if (!before.connected) throw new Error('never connected');

  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const conditions = (offline) => cdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await conditions(true);
  log(`offline for ${seconds} s`);
  await sleep(seconds * 1000);
  log('stalled:', JSON.stringify(await state()));
  await conditions(false);
  log('back online');
  await sleep(8000);
  const after = await state();
  log('after:', JSON.stringify(after));
  await page.keyboard.up('KeyD');

  const kicked = after.code === 4004 || after.conn === 'failed';
  const sameSocket = after.reconnects === before.reconnects;
  log(kicked ? 'FAIL: kicked' : after.connected ? `OK: still playing${sameSocket ? ' on the same WebSocket' : ' (after a resume)'}` : 'FAIL: not connected');
  ok = !kicked && after.connected;
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
