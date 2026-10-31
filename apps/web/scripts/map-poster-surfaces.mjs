/* global process */
/**
 * Every place a map poster shows (Home's Quick match, the desktop lobby's map cards, the phone lobby and
 * its match-rules sheet, the map loading screen, the countdown's map intro and the VS poster), on a desktop, a tablet
 * both ways and a phone both ways, from the shell's store with a sample room (no server needed).
 *   cd apps/web && pnpm exec vite --port 5451 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/map-poster-surfaces.mjs [--base http://127.0.0.1:5451] [--out <dir>] [--prefix after-]
 * Exits 1 on a page error, a console error or a poster image that failed to load.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://127.0.0.1:5451').replace(/\/$/, '');
const out = resolve(arg('out', 'docs/screenshots/map-posters'));
const prefix = arg('prefix', '');
const only = arg('only', '').split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, deviceScaleFactor: 1 },
  { name: 'tablet-land', width: 1024, height: 768, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'tablet-port', width: 768, height: 1024, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  { name: 'phone-land', width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  { name: 'phone-port', width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
].filter((v) => only.length === 0 || only.includes(v.name));

const PLAYERS = [
  { id: 0, name: 'Ade', isBot: false, ready: false, host: true, you: true, pingMs: 38 },
  { id: 1, name: 'Kemi', isBot: false, ready: true, host: false, you: false, pingMs: 52 },
  { id: 2, name: '[BOT] Kestrel', isBot: true, ready: false, host: false, you: false, pingMs: -1 },
];
const LOBBY = { code: 'KMTXRA', isHost: true, ready: false, minPlayers: 2, timeLimit: 300, killLimit: 20, bots: 4, botLevel: 'normal', mapId: 'storm-front', mapName: 'Storm Front', players: PLAYERS };
const MATCH = { phase: 0, number: 1, secondsLeft: 0, untimed: false, secondsElapsed: 0, killLimit: 20, timeLimit: 300, countdownTotal: 3, mapName: 'Storm Front', localId: 0, myScore: 0, leaderScore: 0, leaderName: '', ready: false, votes: 0, humans: 2, voted: false, results: null };
const CONNECTED = { state: 'connected', detail: '', code: 0, since: 0, until: 0, attempt: 0, lastPingMs: 38, lossPct: 0 };

const problems = [];
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'poster-surfaces-')),
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  protocolTimeout: 300_000,
});
try {
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    if (vp.isMobile) await page.setUserAgent(PHONE_UA);
    await page.setViewport(vp);
    if (vp.hasTouch) {
      const cdp = await page.createCDPSession();
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
    }
    // a returning player: the soldier made, the 18+ step answered, the tours done (their screens have their own checks)
    await page.evaluateOnNewDocument(() => {
      try {
        const now = Date.now();
        localStorage.setItem('mf-creator-seen', '1');
        localStorage.setItem('mf.age.v1', JSON.stringify({ adult: true, birthYear: 1990, at: now }));
        localStorage.setItem('mf.touch.drill.v1', 'done');
        localStorage.setItem('mf.facts.v1', JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }));
      } catch {
        /* no storage */
      }
    });
    page.on('pageerror', (e) => problems.push(`${vp.name}: page error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|\/api\/|WebSocket|net::/.test(m.text())) problems.push(`${vp.name}: console error: ${m.text()}`);
    });
    page.on('requestfailed', (r) => {
      if (r.url().includes('/posters/')) problems.push(`${vp.name}: ${r.url()} failed`);
    });
    page.on('response', (r) => {
      if (r.url().includes('/posters/') && r.status() >= 400) problems.push(`${vp.name}: ${r.url()} ${r.status()}`);
    });
    await page.goto(`${base}/?app&notitle`, { waitUntil: 'load', timeout: 120_000 });
    await page.waitForFunction(() => window.__game?.shell?.store, { timeout: 120_000 });
    await page.evaluate(() => {
      window.__game.shell.update = () => {};
    });
    const set = (state) => page.evaluate((s) => window.__game.shell.store.setState(s), state);
    const settle = async (ms = 1400) => {
      await sleep(ms);
      // every poster image on the page has loaded (or there are none)
      await page
        .waitForFunction(() => [...document.querySelectorAll('img')].filter((i) => i.src.includes('/posters/') && i.getBoundingClientRect().top < innerHeight).every((i) => i.complete), { timeout: 20_000 })
        .catch(() => problems.push(`${vp.name}: posters still loading`));
      const broken = await page.$$eval('img', (is) => is.filter((i) => i.complete && i.naturalWidth === 0 && i.src.includes('/posters/')).map((i) => i.src));
      for (const b of broken) problems.push(`${vp.name}: broken poster ${b}`);
    };
    const shot = async (name) => {
      await page.screenshot({ path: join(out, `${prefix}${name}-${vp.name}.png`) });
      console.log(`  ${prefix}${name}-${vp.name}.png`);
    };

    // Home: the Quick match poster
    await set({ profile: { nickname: 'Ade', changeableAt: null, offline: false }, screen: { name: 'home' }, overlay: null, lobby: null, match: null, connection: null });
    await settle(2200);
    await shot('home');

    // the map loading screen: connected, no match yet
    await set({ screen: { name: 'home' } });
    await sleep(100);
    await set({ screen: { name: 'room', code: 'KMTXRA' }, connection: CONNECTED, lobby: LOBBY, match: null });
    await settle();
    await shot('loading');

    // the lobby (desktop's map cards; the phone's room)
    await set({ match: MATCH });
    await settle(1800);
    await shot('lobby');
    const cards = await page.$('.lobby__set .maps');
    if (cards) {
      await page.$eval('.lobby__set .maps', (el) => el.scrollIntoView({ block: 'start' }));
      await sleep(400);
      await cards.screenshot({ path: join(out, `${prefix}lobby-cards-${vp.name}.png`) }).catch(() => {});
      // the end of the list (the lazy posters load as it scrolls)
      await page.$eval('.lobby__set .maps', (el) => el.scrollTo({ top: el.scrollHeight }));
      await settle(900);
      await cards.screenshot({ path: join(out, `${prefix}lobby-cards-end-${vp.name}.png`) }).catch(() => {});
    }
    // the phone's match rules sheet (the map choice)
    const rules = await page.$('.pm-rules');
    if (rules) {
      // a DOM click: a turned (upright) phone's rotated page puts pointer clicks elsewhere
      await rules.evaluate((b) => b.click());
      await settle(900);
      await shot('lobby-rules');
      await page.$eval('.pm-sheet [aria-label="Close"]', (b) => b.click()).catch(() => {});
    }

    // the countdown's map intro (no fighters known: the intro, not the VS poster)
    await set({ match: { ...MATCH, phase: 1, secondsLeft: 5 } });
    await settle(500);
    await shot('countdown');

    // the VS poster (the room's fighters known): the map's poster behind them
    await set({ match: MATCH });
    await page.evaluate((players) => window.__mfPortraits?.lookBook.setRoster(0, players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot }))), PLAYERS);
    await sleep(300);
    await set({ match: { ...MATCH, phase: 1, secondsLeft: 5 } });
    await settle(700);
    await shot('vs');
    await page.close();
  }
} finally {
  await browser.close();
}
for (const p of problems) console.error(`PROBLEM ${p}`);
process.exit(problems.length ? 1 : 0);
