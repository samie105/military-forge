/**
 * Two players through a playtest link, end to end, in two separate headless Chrome instances
 * (separate profiles, like two friends): names → the same room → host settings → ready →
 * countdown → a match (both moving, jetting and firing) → results → Play again → the next
 * countdown. Samples both net graphs during the match and prints their numbers.
 *
 *   pnpm playtest                     # prints https://<words>.trycloudflare.com/r/<CODE>
 *   node apps/web/scripts/playtest-two-players.mjs https://<words>.trycloudflare.com/r/<CODE> [out dir]
 *
 * Works on the production build (no dev hooks): it only clicks, types and holds keys. A home-page
 * URL works too (player A makes the room with Play with friends).
 */
/* global process */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const [link, outArg = 'docs/screenshots/ui-playtest/two-players'] = process.argv.slice(2);
if (!link) {
  console.error('usage: node apps/web/scripts/playtest-two-players.mjs <playtest link> [out dir]');
  process.exit(2);
}
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);
const suffix = () => Math.floor(Math.random() * 900 + 100);

async function player(label) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    userDataDir: mkdtempSync(join(tmpdir(), `two-players-${label}-`)),
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1280, height: 720 },
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { browser, page, label, errors };
}

const byText = (page, tag, text, timeout = 30_000) => page.waitForSelector(`xpath/.//${tag}[contains(normalize-space(.), "${text}")]`, { timeout });
const shot = (p, name) => p.page.screenshot({ path: join(out, `${name}-${p.label}.png`) });

async function enter(p, url, name) {
  // a first load over a tunnel can be slow (the host's upload): be patient
  await p.page.goto(url, { waitUntil: 'load', timeout: 180_000 });
  await p.page.waitForSelector('input[aria-label="Your name"]', { timeout: 180_000 });
  await p.page.type('input[aria-label="Your name"]', name);
  // the live nickname check: Continue turns on once the API says the name is free
  await p.page.waitForSelector('button[type=submit]:not([disabled])', { timeout: 60_000 });
  await p.page.click('button[type=submit]');
}

/** One net-graph reading (the HUD's net plate carries the full graph): "ping 42 ms ±3 · loss 0.4% · 30 snap/s", "↓ 8.1 KB/s · ↑ 4.0 KB/s · …", "buffer … corrections …" */
async function netSample(p) {
  const text = await p.page.$eval('.hud-net[data-detail]', (e) => e.getAttribute('data-detail') ?? '').catch(() => '');
  const num = (re) => Number(re.exec(text)?.[1] ?? NaN);
  return {
    ping: num(/ping (\d+) ms/),
    jitter: num(/±(\d+)/),
    loss: num(/loss ([\d.]+)%/),
    snaps: num(/(\d+) snap\/s/),
    kbIn: num(/↓ ([\d.]+) KB\/s/),
    kbOut: num(/↑ ([\d.]+) KB\/s/),
    corrections: num(/corrections ([\d.]+)\/min/),
    transport: /WebSocket|WebTransport/.exec(text)?.[0] ?? '?',
  };
}

function summary(samples) {
  const pick = (k) => samples.map((s) => s[k]).filter(Number.isFinite).sort((a, b) => a - b);
  const median = (xs) => (xs.length ? xs[Math.floor(xs.length / 2)] : NaN);
  const max = (xs) => (xs.length ? xs[xs.length - 1] : NaN);
  return {
    samples: samples.length,
    pingMedianMs: median(pick('ping')),
    pingMaxMs: max(pick('ping')),
    jitterMedianMs: median(pick('jitter')),
    lossMaxPct: max(pick('loss')),
    snapshotsPerSec: median(pick('snaps')),
    kbInPerSec: median(pick('kbIn')),
    kbOutPerSec: median(pick('kbOut')),
    correctionsPerMinMax: max(pick('corrections')),
    transport: samples.at(-1)?.transport ?? '?',
  };
}

const a = await player('A');
const b = await player('B');
const net = { A: [], B: [] };
try {
  await enter(a, link, `Ade${suffix()}`);
  if (!/\/r\/[A-Z]{6}/.test(link)) await (await byText(a.page, 'button', 'Play with friends')).click();
  const lobby = '[data-screen="lobby"]';
  await a.page.waitForSelector(lobby, { timeout: 60_000 });
  const roomLink = a.page.url();
  log('room', roomLink);
  await enter(b, roomLink, `Kemi${suffix()}`);
  await b.page.waitForSelector(lobby, { timeout: 60_000 });
  await a.page.waitForFunction(() => document.querySelectorAll('.player-list .player-row:not(.player-row--open) .avatar:not(.avatar--bot)').length === 2, { timeout: 30_000 });
  log('both in the lobby');
  // the host's settings: a 1-minute match, first to 5 (the kill limit steps by 5)
  await (await a.page.waitForSelector('xpath/.//*[@aria-labelledby="tl-label"]/button[normalize-space(.)="1"]')).click();
  for (let i = 0; i < 6 && (await a.page.$eval('[data-bind="room.killLimit"]', (e) => e.textContent)) !== '5'; i++) await (await a.page.waitForSelector('button[aria-label="Fewer kills"]')).click();
  await b.page.waitForFunction(() => document.querySelector('[data-bind="room.timeLimit"]')?.textContent === '1 min', { timeout: 15_000 });
  await shot(a, '01-lobby');
  await shot(b, '01-lobby');
  for (const p of [a, b]) await (await p.page.waitForSelector('xpath/.//footer//button[normalize-space(.)="Ready"]')).click();
  await a.page.waitForSelector('[data-screen="countdown"]', { timeout: 30_000 });
  log('countdown');
  await shot(a, '02-countdown');
  await a.page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 30_000 });
  log('match on');
  // the first-run controls card: read, then away
  for (const p of [a, b]) {
    const got = await p.page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
    if (got) await got.click();
  }
  for (const p of [a, b]) await p.page.keyboard.press('KeyN'); // the net graph

  // a minute of play: A heads right, B left, both jetting in bursts and firing toward each other
  const move = async (p, dir, aimX) => {
    await p.page.keyboard.down(dir);
    await p.page.mouse.move(aimX, 380);
  };
  await move(a, 'KeyD', 1100);
  await move(b, 'KeyA', 180);
  let shots = 0;
  const firing = new Map();
  while (!(await a.page.$('[data-screen="results"]'))) {
    const s = Math.floor((Date.now() - t0) / 1000);
    for (const p of [a, b]) {
      if (s % 3 === 0) await p.page.keyboard.down('KeyW');
      else await p.page.keyboard.up('KeyW');
      // puppeteer refuses an up() without a down(): track the button
      const fire = s % 2 === 0;
      if (fire !== (firing.get(p) ?? false)) {
        firing.set(p, fire);
        if (fire) await p.page.mouse.down();
        else await p.page.mouse.up();
      }
    }
    const [sa, sb] = await Promise.all([netSample(a), netSample(b)]);
    net.A.push(sa);
    net.B.push(sb);
    if (shots === 0 && net.A.length > 8) {
      shots++;
      await shot(a, '03-match');
      await shot(b, '03-match');
    }
    await sleep(1000);
    if (Date.now() - t0 > 600_000) throw new Error('no results after 10 minutes');
  }
  for (const p of [a, b]) {
    for (const k of ['KeyA', 'KeyD', 'KeyW']) await p.page.keyboard.up(k);
    if (firing.get(p)) await p.page.mouse.up();
  }
  await b.page.waitForSelector('[data-screen="results"]', { timeout: 30_000 });
  log('results');
  // vote at once (the vote window is short; screenshots of a 3D page are slow in headless Chrome)
  for (const p of [a, b]) await (await byText(p.page, 'button', 'Play again')).click();
  log('both voted');
  await shot(a, '04-results');
  await shot(b, '04-results');
  await a.page.waitForSelector('[data-screen="countdown"], #hud[data-active-state~="match"]', { timeout: 30_000 });
  log('play again: the next match');
  await shot(a, '05-rematch');
  const report = { link: roomLink, A: summary(net.A), B: summary(net.B), errors: { A: a.errors, B: b.errors } };
  writeFileSync(join(out, 'net-graph.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  log('FAILED', e.message);
  await shot(a, '99-fail').catch(() => {});
  await shot(b, '99-fail').catch(() => {});
  process.exitCode = 1;
} finally {
  await a.browser.close();
  await b.browser.close();
}
