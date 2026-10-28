/**
 * Problem reports, end to end (the owner, 24 Oct: "check the logs if you're logging anything"): a
 * local room's guest loses the room (the host's phone goes), the automatic report goes and its alert
 * says so; the guest sends one from Settings too; the owner reads both on the admin page's Reports.
 * Needs a playtest stack (its API keeps the reports) and its admin token:
 *
 *   ADMIN_TOKEN=<the token in the admin link> node apps/web/scripts/report-check.mjs http://localhost:5225 docs/screenshots/reports
 *
 * Exits 1 when a step fails.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5225').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/reports');
const token = process.env.ADMIN_TOKEN ?? '';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const problems = [];
const check = (ok, what) => (ok ? console.log(`ok: ${what}`) : problems.push(what));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'report-check-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });

async function phone() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
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
const click = async (page, xpath) => (await page.waitForSelector(`xpath/${xpath}`, { timeout: 20_000 })).click();

try {
  const host = await phone();
  await host.goto(`${base}/?app`, { waitUntil: 'load' });
  await named(host, '[data-screen="m-home"]');
  await click(host, './/button[contains(normalize-space(.), "Local room")]');
  await host.waitForSelector('[data-screen="m-lobby"]', { timeout: 30_000 });
  const code = await host.waitForFunction(() => document.querySelector('.pm-lan__how-code')?.textContent?.trim() || null, { timeout: 15_000 }).then((h) => h.jsonValue());
  console.log(`host: room ${code}`);
  const guest = await phone();
  // the guest's phone camera opens the room's QR: its link
  await guest.goto(`${base}/r/${code}`, { waitUntil: 'load' });
  await named(guest, '[data-screen="m-lobby"]');
  check(true, 'the guest is in the local room');
  // the host's phone goes: the guest's room is gone, a report goes by itself
  await host.close();
  const alert = await guest.waitForSelector('[data-screen="connection"] [role=alertdialog]', { timeout: 40_000 }).then(() => true, () => false);
  check(alert, "the guest's alert when the host's phone goes");
  const note = await guest.waitForSelector('.mf-report__auto', { timeout: 15_000 }).then(() => true, () => false);
  check(note, 'the alert says a report went by itself');
  await shot(guest, '1-guest-room-gone-report-sent');
  // the guest sends one from Settings (Network)
  await click(guest, './/button[contains(normalize-space(.), "Home")]');
  await guest.waitForSelector('[data-screen="m-home"]', { timeout: 20_000 });
  await click(guest, './/nav//button[contains(normalize-space(.), "Settings")]');
  await guest.waitForSelector('[data-screen="m-settings"]', { timeout: 10_000 });
  await click(guest, './/button[@role="tab"][contains(normalize-space(.), "Network")]');
  await click(guest, './/button[contains(normalize-space(.), "Send a report")]');
  await guest.waitForSelector('.mf-report__what', { timeout: 5000 });
  await shot(guest, '2-settings-what-is-sent');
  await click(guest, './/div[contains(@class,"mf-report")]//button[normalize-space(.)="Send"]');
  const sent = await guest.waitForSelector('.mf-report__done', { timeout: 15_000 }).then(() => true, () => false);
  check(sent, 'Send a report: sent, with its id');
  await shot(guest, '3-settings-sent');
  // the owner reads them
  const admin = await (await browser.createBrowserContext()).newPage();
  await admin.setViewport({ width: 1280, height: 900 });
  await admin.goto(`${base}/admin.html#t=${token}`, { waitUntil: 'load' });
  await click(admin, './/details[contains(@class,"admin__group--reports")]/summary');
  await admin.waitForSelector('.admin__report', { timeout: 20_000 });
  const rows = await admin.$$eval('.admin__report', (r) => r.length);
  check(rows >= 2, `the admin page lists the reports (${rows})`);
  // the guest's report sent by itself (the host's own room closing sends none)
  const reasons = await admin.$$eval('.admin__report summary', (ss) => ss.map((s) => s.textContent ?? ''));
  const mine = (r) => /auto/.test(r) && r.includes(code);
  check(reasons.filter(mine).length === 1, `one automatic report for room ${code}: the guest's (${reasons.length} in all)`);
  const auto = await admin.$$('.admin__report');
  const autoAt = reasons.findIndex(mine);
  await auto[autoAt].$eval('summary', (s) => s.click());
  await admin.waitForFunction((i) => /Events \(/.test(document.querySelectorAll('.admin__report-text')[i]?.textContent ?? ''), { timeout: 15_000 }, autoAt);
  const text = await admin.$$eval('.admin__report-text', (ps, i) => ps[i].textContent, autoAt);
  check(/guest: joining .* through the relay/.test(text) && /peer \d+: /.test(text), 'the auto report holds the local room steps and the WebRTC states');
  await auto[autoAt].evaluate((d) => d.scrollIntoView());
  await shot(admin, '4-admin-reports', 300);
  console.log(text.split('\n').slice(0, 30).join('\n'));
} catch (e) {
  problems.push(`run: ${e.message}`);
} finally {
  await browser.close();
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nreport check passed');
