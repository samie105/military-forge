// A carrier dropping a phone's socket without telling the phone (owner's phones, 24 Oct 2026: the
// server saw "TCP FIN before WebSocket close frame" every few minutes; the phone noticed only when
// the silence watchdog fired, and resumed 5.5 s later). A TCP proxy in front of a local server lets
// headless Chrome (as a phone) connect through it; every so often it cuts every connection open at
// that moment: FIN to the server, silence to the page. The page's WebSockets are watched: how long
// from the last message on the dead one to the first on its successor, and whether the reconnect
// banner showed.
//   node apps/web/scripts/mobile-blackhole.mjs <http://127.0.0.1:PORT of a playtest> <proxy port> <out.json> [cuts=5]
import { Buffer } from 'node:buffer';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer-core';

const [target, proxyPortArg, out, cutsArg = '5'] = process.argv.slice(2);
const tu = new URL(target);
const live = new Set();
const from = Buffer.from(`127.0.0.1:${proxyPortArg}`);
const to = Buffer.from(`${tu.hostname}:${tu.port}`);
if (from.length !== to.length) throw new Error('the proxy port needs as many digits as the target port');
function swapHost(d) {
  for (let i = d.indexOf(from); i >= 0; i = d.indexOf(from, i + to.length)) to.copy(d, i);
  return d;
}
const proxy = createServer((client) => {
  const upstream = connect(Number(tu.port), tu.hostname);
  const pair = { client, upstream, dead: false };
  live.add(pair);
  // the page's Origin and Host name the proxy; the server allows its own origin only (same length:
  // the bytes swap in place, and masked WebSocket frames never match)
  client.on('data', (d) => !pair.dead && upstream.write(swapHost(d)));
  upstream.on('data', (d) => !pair.dead && client.write(d));
  const end = () => {
    live.delete(pair);
    if (!pair.dead) {
      client.destroy();
      upstream.destroy();
    }
  };
  client.on('close', end);
  upstream.on('close', end);
  client.on('error', () => {});
  upstream.on('error', () => {});
});
await new Promise((r) => proxy.listen(Number(proxyPortArg), '127.0.0.1', r));
const base = `http://127.0.0.1:${proxyPortArg}`;
/** the carrier's cut: the server gets a FIN, the page hears nothing more on these sockets */
function cut() {
  for (const pair of [...live]) {
    pair.dead = true;
    live.delete(pair);
    pair.upstream.end();
  }
}

const api = async (path, body, token) => {
  const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
};
const guest = await api('/auth/guest', {});
const room = await api('/rooms', {}, guest.accessToken);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'blackhole-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36');
await page.setViewport({ width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: true });
await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('profile.offlineName.v1', 'Phone');
  } catch {
    /* private mode */
  }
  const sockets = (window.__sockets = []);
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(url, p) {
      super(url, p);
      const s = { url: String(url), opened: performance.now(), first: 0, last: 0, closed: 0, n: 0 };
      sockets.push(s);
      this.addEventListener('message', () => {
        const t = performance.now();
        if (!s.n++) s.first = t;
        s.last = t;
      });
      this.addEventListener('close', () => (s.closed = performance.now()));
    }
  };
  const fetches = (window.__fetches = []);
  const f = window.fetch;
  window.fetch = (...a) => {
    const r = { url: String(a[0]?.url ?? a[0]), at: performance.now(), done: 0, ok: false };
    fetches.push(r);
    return f(...a).then(
      (x) => ((r.done = performance.now()), (r.ok = true), x),
      (e) => ((r.done = performance.now()), Promise.reject(e)),
    );
  };
  window.__banner = [];
  let shown = false;
  new MutationObserver(() => {
    const el = document.querySelector('.reconnect');
    const now = !!el;
    if (now !== shown) window.__banner.push({ t: performance.now(), on: now });
    shown = now;
  }).observe(document, { subtree: true, childList: true });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await page.goto(`${base}/r/${room.code}`, { waitUntil: 'load' });
for (let i = 0; i < 20; i++) {
  const picked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /pick one for me/i.test(x.textContent || ''));
    b?.click();
    return !!b;
  });
  if (picked) break;
  await sleep(500);
}
await sleep(12_000);
const cuts = [];
for (let i = 0; i < Number(cutsArg); i++) {
  const at = await page.evaluate(() => performance.now());
  cut();
  cuts.push(at);
  await sleep(15_000);
}
const { sockets, banner, urls, all, fetches, text } = await page.evaluate(() => ({ sockets: window.__sockets.filter((s) => s.url.includes('/ws/')), banner: window.__banner, urls: window.__sockets.map((s) => s.url), all: window.__sockets, fetches: window.__fetches, text: document.body.innerText.slice(0, 300) }));
const gaps = cuts.map((at) => {
  // the socket that was carrying the game when the cut came: the latest message before it
  const before = sockets.filter((s) => s.n && s.first < at).sort((a, b) => Math.min(a.last, at) - Math.min(b.last, at)).at(-1);
  const after = sockets.filter((s) => s.opened >= at - 2000 && s.first > at).sort((a, b) => a.first - b.first)[0];
  const lastBefore = before ? Math.min(before.last, at) : at;
  return { gapMs: after ? Math.round(after.first - lastBefore) : null, bannerShown: banner.some((b) => b.on && b.t > at && b.t < at + 14_000) };
});
const result = { room: room.code, cuts, gaps, sockets: sockets.length, banner, urls, all, fetches, text };
writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify(gaps));
await browser.close();
proxy.close();
