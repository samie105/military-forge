// Phone network glitches, end to end (owner, 23 Oct 2026: "keeps returning and returning").
// Headless Chrome as a phone (touch, 812×375 landscape) joins a fresh room by code on a server, and
// goes through what phones do: a background freeze, a network drop, a rotation, another tab in
// front, 4G latency. It logs every WebSocket / WebTransport the page opens and closes (with codes)
// and when the reconnect banner shows.
//   node apps/web/scripts/mobile-net.mjs <https://host> <out.json> [ws|auto]
import { mkdtempSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const [base, out, transport = 'auto'] = process.argv.slice(2);
const api = async (path, body, token) => {
  const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
};
const guest = await api('/auth/guest', {});
const room = await api('/rooms', {}, guest.accessToken);
console.log('room', room.code);

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'mobnet-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36');
const landscape = { width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: true };
await page.setViewport(landscape);
const cdp = await page.createCDPSession();
await page.evaluateOnNewDocument((noWt) => {
  const log = (window.__netlog = []);
  const t = () => Math.round(performance.now());
  try {
    localStorage.setItem('profile.offlineName.v1', 'Phone');
  } catch {
    /* private mode */
  }
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(url, p) {
      super(url, p);
      const u = String(url).replace(/^wss?:\/\/[^/]+/, '');
      log.push({ t: t(), e: 'ws-new', u });
      this.addEventListener('open', () => log.push({ t: t(), e: 'ws-open', u }));
      this.addEventListener('close', (ev) => log.push({ t: t(), e: 'ws-close', u, code: ev.code, reason: ev.reason }));
    }
  };
  if (noWt) delete window.WebTransport;
  else if (window.WebTransport) {
    const WT = window.WebTransport;
    window.WebTransport = class extends WT {
      constructor(url, o) {
        super(url, o);
        log.push({ t: t(), e: 'wt-new' });
        this.ready.then(() => log.push({ t: t(), e: 'wt-ready' }), (err) => log.push({ t: t(), e: 'wt-fail', reason: String(err) }));
        this.closed.then((i) => log.push({ t: t(), e: 'wt-closed', code: i.closeCode, reason: i.reason }), (err) => log.push({ t: t(), e: 'wt-lost', reason: String(err) }));
      }
    };
  }
  let shown = false;
  new MutationObserver(() => {
    const el = document.querySelector('.reconnect, [data-screen="connection"]');
    const now = !!el && /Reconnecting|Connection dropped/i.test(el.textContent || '');
    if (now !== shown) log.push({ t: t(), e: now ? 'banner-on' : 'banner-off', text: now ? el.textContent.slice(0, 80) : '' });
    shown = now;
    const alert = document.querySelector('[role="alertdialog"]');
    if (alert && !window.__alerted) {
      window.__alerted = true;
      log.push({ t: t(), e: 'alert', text: alert.textContent.slice(0, 120) });
    }
  }).observe(document, { subtree: true, childList: true, characterData: true });
  document.addEventListener('visibilitychange', () => log.push({ t: t(), e: 'vis-' + document.visibilityState }));
}, transport === 'ws');

const mark = (e) => page.evaluate((e) => window.__netlog.push({ t: Math.round(performance.now()), e: 'STEP ' + e }), e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(`${base}/r/${room.code}`, { waitUntil: 'load' });
// a name, if asked
for (let i = 0; i < 20; i++) {
  const picked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /pick one for me/i.test(x.textContent || ''));
    if (b) b.click();
    return !!b;
  });
  if (picked) break;
  await sleep(500);
}
await sleep(12000);
await mark('joined');
await sleep(15000);

await mark('freeze 5 s');
await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
await sleep(5000);
await cdp.send('Page.setWebLifecycleState', { state: 'active' });
await sleep(20000);

await mark('offline 3 s');
await cdp.send('Network.enable');
await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await sleep(3000);
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await sleep(20000);

await mark('rotate to portrait 5 s');
await page.setViewport({ ...landscape, width: 375, height: 812, isLandscape: false });
await sleep(5000);
await page.setViewport(landscape);
await sleep(15000);

await mark('another tab in front 8 s');
const other = await browser.newPage();
await other.bringToFront();
await sleep(8000);
await page.bringToFront();
await other.close();
await sleep(20000);

await mark('4G latency 300 ms each way, 30 s');
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 300, downloadThroughput: 200_000, uploadThroughput: 100_000 });
await sleep(30000);
await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
await sleep(15000);
await mark('end');
const log = await page.evaluate(() => window.__netlog);
writeFileSync(out, JSON.stringify({ room: room.code, transport, log }, null, 1));
for (const l of log) console.log(String(l.t).padStart(7), l.e, l.u ?? '', l.code ?? '', l.reason ?? '', l.text ?? '');
await browser.close();
