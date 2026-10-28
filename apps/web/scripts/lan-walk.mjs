/**
 * A local room, as two strangers on one Wi-Fi: a host (Android Chrome) makes the room from Home, a
 * guest (another phone) scans its QR, i.e. opens its room link, and lands in the lobby. Times "Local
 * room" tapped → both in the lobby with each other, then the host starts the match, both play, the
 * guest leaves and comes back. Needs the dev server against a playtest stack (or a playtest build):
 *
 *   node apps/web/scripts/lan-walk.mjs http://localhost:5224 docs/screenshots/local-room
 *
 * Exits 1 when a step fails, or on a page error.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5224').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/local-room');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

const problems = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'lan-walk-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });

async function phone(who) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${who}: page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) console.log(`  [${who} console] ${m.text().slice(0, 200)}`);
  });
  await page.evaluateOnNewDocument(() => {
    if (location.protocol === 'about:') return;
    const now = Date.now();
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.setItem('mf.install.v1', JSON.stringify({ sessions: 1, dismissedAt: 1, matchesAtDismiss: 0, accepted: false }));
    localStorage.setItem('mf.facts.v1', JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }));
    localStorage.setItem('mf.age.v1', JSON.stringify({ adult: true, birthYear: 1990, at: Date.now() })); // the 18+ step, answered
  });
  await page.emulate({ viewport: { width: 780, height: 360, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: UA });
  return page;
}
const shot = async (page, name, settle = 500) => {
  await sleep(settle);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`  wrote ${name}.png`);
};
/** Through the name screen if it shows (a first visit), with a made-up name. */
async function named(page, then) {
  await page.waitForSelector(`[data-screen="m-name"] input, ${then}`, { timeout: 90_000 });
  if (await page.$(then)) return;
  await page.type('[data-screen="m-name"] input', `P${Math.floor(Math.random() * 9000 + 1000)}`);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 15 && !(await page.$(then)); i++) {
    await sleep(800);
    await page.$eval('button[type=submit]', (b) => b.click()).catch(() => {});
  }
  await page.waitForSelector(then, { timeout: 30_000 });
}
const humans = (page) => page.$$eval('[data-screen="m-lobby"] .pm-roster li', (ls) => ls.filter((l) => !l.querySelector('.tag--bot')).length).catch(() => 0);
const t = () => performance.now();

let guestPage = null;
try {
  const host = await phone('host');
  await host.goto(`${base}/?app`, { waitUntil: 'load' });
  await named(host, '[data-screen="m-home"]');
  await shot(host, '1-host-home');
  const t0 = t();
  await (await host.waitForSelector('xpath/.//button[contains(normalize-space(.), "Local room")]')).click();
  await host.waitForSelector('[data-screen="m-lobby"]', { timeout: 30_000 });
  const code = await host.waitForFunction(() => document.querySelector('.pm-lan__how-code, .pm-lan__code')?.textContent?.trim() || null, { timeout: 15_000 }).then((h) => h.jsonValue());
  console.log(`host: lobby with code ${code} in ${((t() - t0) / 1000).toFixed(1)} s`);
  await shot(host, '2-host-lobby');
  await host.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1.5'));
  await shot(host, '2-host-lobby-text150');
  await host.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
  // the guest: the phone's camera opens the QR's link (the room link)
  const guest = await phone('guest');
  const tg = t();
  await guest.goto(`${base}/r/${code}`, { waitUntil: 'load' });
  guestPage = guest;
  // what the guest sees, as it changes (where the seconds go)
  let last = '';
  const watch = setInterval(async () => {
    const now = await guest.$$eval('[data-screen]', (els) => els.filter((e) => e.getClientRects().length).map((e) => `${e.getAttribute('data-screen')}:${e.getAttribute('data-active-state') ?? ''}`).join(' ')).catch(() => '');
    if (now && now !== last) console.log(`  guest +${((t() - tg) / 1000).toFixed(1)} s: ${now}`);
    last = now || last;
  }, 250);
  await named(guest, '[data-screen="m-lobby"], [data-screen="m-error"], [role=alert]');
  await shot(guest, '3-guest-after-link', 1500);
  for (let i = 0; i < 40 && ((await humans(host)) < 2 || (await humans(guest)) < 2); i++) await sleep(500);
  clearInterval(watch);
  const both = (await humans(host)) >= 2 && (await humans(guest)) >= 2;
  console.log(`guest: ${both ? 'in' : 'NOT in'} the lobby ${((t() - tg) / 1000).toFixed(1)} s after the link; ${((t() - t0) / 1000).toFixed(1)} s from "Local room" (the guest's taps not counted)`);
  if (!both) problems.push('the guest did not reach the lobby with the host');
  await shot(guest, '4-guest-lobby');
  await shot(host, '5-host-lobby-with-guest');
  // the host starts; both play
  const click = async (page, xpath) => (await page.waitForSelector(`xpath/${xpath}`, { timeout: 15_000 })).click();
  await click(host, './/button[normalize-space(.)="Start"]');
  const playing = (page) => page.waitForFunction(() => !document.querySelector('[data-screen="m-lobby"]') && !!document.querySelector('[data-screen="m-hud"]'), { timeout: 40_000 }).then(() => true, () => false);
  const [hp, gp] = await Promise.all([playing(host), playing(guest)]);
  if (!hp || !gp) problems.push(`the match didn't start for ${!hp ? 'the host' : ''} ${!gp ? 'the guest' : ''}`);
  else console.log('ok: the match runs for both');
  await sleep(4000);
  await shot(guest, '6-guest-in-match', 0);
  // the guest leaves (the menu, Leave, Leave match) and comes back by the same link
  await guest.keyboard.press('Escape');
  await guest.waitForSelector('[data-screen="m-pause"]', { timeout: 10_000 });
  await click(guest, './/nav[contains(@class,"pm-pause")]//button[contains(normalize-space(.), "Leave")]');
  await click(guest, './/button[contains(normalize-space(.), "Leave match") or contains(normalize-space(.), "Leave room")]');
  await guest.waitForSelector('[data-screen="m-home"]', { timeout: 20_000 });
  console.log('ok: the guest left to Home');
  const tb = t();
  await guest.goto(`${base}/r/${code}`, { waitUntil: 'load' });
  const back = await guest.waitForSelector('[data-screen="m-hud"]', { timeout: 60_000 }).then(() => true, () => false);
  console.log(back ? `ok: back in the room ${((t() - tb) / 1000).toFixed(1)} s after the link` : 'the guest did not get back in');
  if (!back) problems.push('rejoin by the link failed');
  await sleep(3000);
  await shot(guest, '7-guest-back', 0);
} catch (e) {
  problems.push(`run: ${e.message}`);
  if (guestPage) await guestPage.screenshot({ path: join(out, 'x-guest-stuck.png') }).catch(() => {});
  if (guestPage) console.log('guest screens:', await guestPage.$$eval('[data-screen]', (s) => s.map((e) => e.getAttribute('data-screen') + ':' + (e.getAttribute('data-active-state') ?? ''))).catch(() => '?'));
} finally {
  await browser.close();
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nlocal room walk passed');
