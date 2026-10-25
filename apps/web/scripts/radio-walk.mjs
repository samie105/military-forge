/**
 * Voice (the radio, voice/Radio.tsx) walked as a stranger on a landscape phone (the owner, 24 Oct: "you
 * just put mic everywhere … we keep forgetting it's a mobile device and on landscape").
 * Against a production build behind `pnpm playtest --local --no-build --port <n>` (API, game server and
 * the page on one port; no dev hooks, so everything is reached by touch, like a player would).
 *
 *   node apps/web/scripts/radio-walk.mjs http://127.0.0.1:<port> <room code | new> <out dir> [profile ...]
 *
 * Profiles (all by default): s23 780×360 (Android Chrome), iphone 844×390 (Safari, bars hidden),
 * iphone-bars 844×300 (Safari with its address and tab bars). For each: a desktop player and the phone
 * join the room (two humans, so voice has someone to talk to): the phone's lobby (the radio in its top
 * bar), the match (the radio; hold it to talk, tap it for the comms sheet), the pause menu (no voice
 * card) and Settings. WALK_DESKTOP=1 also shoots the desktop player: the radio over the vitals, V held,
 * the pause menu's Comms. Every shot is checked for anything off screen; small targets are listed.
 * Exits 1 on a page error or a failed check.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:8097').replace(/\/$/, '');
const room = process.argv[3] ?? 'new';
const out = resolve(process.argv[4] ?? 'comms-hud-walk');
const only = process.argv.slice(5);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PROFILES = {
  s23: { ua: ANDROID, view: { width: 780, height: 360, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true } },
  iphone: { ua: IPHONE, view: { width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true } },
  'iphone-bars': { ua: IPHONE, view: { width: 844, height: 300, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true } },
};

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures++;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'comms-walk-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  protocolTimeout: 600_000,
});

const FACTS = JSON.stringify({ v: 1, firstSeen: Date.now(), lastSession: Date.now(), sessions: 3, devices: ['touch'], lastDevice: 'touch', experience: 'veteran', promoted: false, invited: false, tours: { 'first-flight': { status: 'done' }, home: { status: 'done' } }, matches: { local: 2, online: 1, finished: 2, wonInARow: 0 }, kills: 3, deaths: {}, moves: {}, screens: [], rooms: { created: 0, joined: 1, local: 0 }, soldierSaved: true, touch: { missedTaps: 0, hops: 0 }, cards: {} });

let ip = 60;
async function guest(name) {
  const res = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.19.1.${ip++}` }, body: JSON.stringify({ nickname: name }) });
  if (!res.ok) throw new Error(`guest ${name}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** A signed-in returning player in a fresh context: a phone (profile) or the desktop. */
async function player(name, profile) {
  const g = await guest(name);
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => check(`${name}: no page error`, false, e.message));
  if (profile) {
    const p = PROFILES[profile];
    await page.setUserAgent(p.ua);
    await page.setViewport(p.view);
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'orientation', value: 'landscape' }] });
    await page.evaluateOnNewDocument(() => {
      if (typeof navigator.getGamepads === 'function') navigator.getGamepads = () => [];
    });
  } else await page.setViewport({ width: 1600, height: 900 });
  await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.evaluate(
    (t, facts) => {
      localStorage.setItem('session.refreshToken.v1', t);
      localStorage.setItem('tips.seen.v1', '1');
      localStorage.setItem('mf-creator-seen', '1');
      localStorage.setItem('mf.facts.v1', facts);
      localStorage.setItem('mf.touch.drill.v1', 'done');
      localStorage.setItem('mf.touch.hints.v1', JSON.stringify(['move', 'jet', 'fire', 'dash', 'chain', 'cycle', 'throw', 'swap', 'radial', 'reload', 'melee', 'shield', 'zoom', 'scores', 'camera', 'dash-swipe', 'grenade-types', 'swap-radial', 'take', 'shield-hold']));
      localStorage.setItem('mf.install.v1', JSON.stringify({ dismissedAt: Date.now(), stats: {} }));
    },
    g.refreshToken,
    FACTS,
  );
  return page;
}

/** The centre of the first visible element matching `sel` (text: a substring of its text). */
async function centre(page, sel, text = '') {
  return page.evaluate(
    (s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => (!t || (e.textContent ?? '').toLowerCase().includes(t.toLowerCase())) && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    sel,
    text,
  );
}
async function tap(page, sel, text = '') {
  const at = await centre(page, sel, text);
  if (!at) return false;
  await page.touchscreen.tap(at.x, at.y);
  return true;
}
const until = async (page, fn, ms = 30_000, arg) => {
  try {
    await page.waitForFunction(fn, { timeout: ms, polling: 200 }, arg);
    return true;
  } catch {
    return false;
  }
};

/** Nothing sticks out past the right or bottom edge; no visible button smaller than 44 px. */
async function fits(page, label) {
  const r = await page.evaluate(() => {
    const W = innerWidth;
    const H = innerHeight;
    const over = [];
    const small = [];
    for (const el of document.querySelectorAll('button, [role="button"], a.btn, input, select')) {
      if (!el.getClientRects().length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || Number(cs.opacity) === 0 || cs.pointerEvents === 'none') continue;
      const b = el.getBoundingClientRect();
      if (b.width === 0 || b.height === 0) continue;
      // scrolled away inside a scroller is fine; past the screen with no scroller is not
      let clip = el.parentElement;
      let scrolled = false;
      while (clip) {
        const s = getComputedStyle(clip);
        if (/(auto|scroll|hidden)/.test(s.overflowX + s.overflowY) && clip !== document.body && clip !== document.documentElement) {
          scrolled = true;
          break;
        }
        clip = clip.parentElement;
      }
      const name = (el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).toString().trim().slice(0, 40);
      if (!scrolled && (b.right > W + 1 || b.bottom > H + 1 || b.left < -1 || b.top < -1)) over.push(`${name} @${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}×${Math.round(b.height)}`);
      if (el.tagName !== 'INPUT' && Math.min(b.width, b.height) < 40) small.push(`${name} ${Math.round(b.width)}×${Math.round(b.height)}`);
    }
    return { over, small, scrollX: document.documentElement.scrollWidth > W + 1 };
  });
  check(`${label}: nothing off screen`, r.over.length === 0 && !r.scrollX, [...r.over, r.scrollX ? 'page scrolls sideways' : ''].filter(Boolean).join(' | '));
  if (r.small.length) console.log(`  note ${label}: small targets: ${r.small.join(' | ')}`);
  return r;
}

async function shot(page, name) {
  await page.screenshot({ path: join(out, `${name}.png`) });
}

async function walk(profile) {
  const stamp = Date.now().toString(36).slice(-4);
  const host = await player(`Host_${stamp}`, null);
  const phone = await player(`Ade_${stamp}`, profile);
  // the desktop player hosts (first in); the phone joins by the room's link
  // a new room each walk (the host's Create room), unless one was named
  let code = room;
  if (!code || code === 'new') {
    await host.goto(`${base}/?app`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    // the title screen first (press any key), then Create room (Play now, .home__create, is a quick
    // match that starts by itself)
    if (await until(host, () => !!document.querySelector('[data-screen="title"]'), 8000)) await host.keyboard.press('Enter');
    await (await host.waitForSelector('xpath/.//button[contains(normalize-space(.), "Create room")]', { visible: true, timeout: 90_000 })).click();
    await host.waitForFunction(() => /^\/r\/[A-Z]{6}$/.test(location.pathname), { timeout: 60_000 });
    code = await host.evaluate(() => location.pathname.slice(3));
  } else await host.goto(`${base}/r/${code}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await until(host, () => !!document.querySelector('[data-screen="lobby"]'), 90_000);
  await phone.goto(`${base}/r/${code}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  let inLobby = false;
  for (let i = 0; i < 6 && !inLobby; i++) {
    inLobby = await until(phone, () => !!document.querySelector('[data-screen="m-lobby"], [data-screen="lobby"]'), 15_000);
    // a title screen, or a Join room button on the way in: a stranger taps it
    try {
      if (!inLobby && (await phone.$('[data-screen="title"]'))) await phone.touchscreen.tap(PROFILES[profile].view.width / 2, PROFILES[profile].view.height / 2);
      if (!inLobby) await tap(phone, 'button', 'Join room');
    } catch {
      /* the page moved on under us: look again */
    }
  }
  if (!inLobby) await shot(phone, `${profile}-0-stuck`);
  check(`${profile}: the phone reaches the lobby`, inLobby);
  await sleep(2500);
  await phone.touchscreen.tap(PROFILES[profile].view.width / 2, 12);
  await sleep(1200);
  await shot(phone, `${profile}-1-lobby`);
  if (process.env.WALK_DESKTOP) await shot(host, `desktop-1-lobby`);
  await fits(phone, `${profile} lobby`);

  // the match: the host starts the countdown
  await host.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find((x) => x.textContent?.trim() === 'Fill to 4');
    btn?.click();
  });
  const start = await host.waitForSelector('xpath/.//button[@title="Start the countdown now"][not(@disabled)]', { visible: true, timeout: 30_000 }).catch(() => null);
  await start?.click();
  const playing = await until(phone, () => !document.querySelector('[data-screen="m-lobby"], [data-screen="lobby"]') && !!document.querySelector('.mf-touch'), 90_000);
  check(`${profile}: the match starts on the phone`, playing);
  await sleep(7000);
  await shot(phone, `${profile}-2-match`);
  if (process.env.WALK_DESKTOP) {
    await shot(host, `desktop-2-match`);
    await host.keyboard.down('KeyV');
    await sleep(900);
    await shot(host, `desktop-3-talking`);
    await host.keyboard.up('KeyV');
    await host.keyboard.press('Escape');
    const comms = await host.waitForSelector('xpath/.//button[contains(normalize-space(.), "Comms")]', { visible: true, timeout: 10_000 }).catch(() => null);
    check('desktop: the pause menu has Comms', !!comms);
    await comms?.click();
    await sleep(700);
    await shot(host, `desktop-4-comms`);
    await host.keyboard.press('Escape');
    await sleep(300);
    check('desktop: Escape closes the sheet, not the menu', await host.evaluate(() => !document.querySelector('.vc-sheet') && !!document.querySelector('.pause, [data-screen="pause"]')));
    await host.keyboard.press('Escape');
  }
  await fits(phone, `${profile} match`);

  // the voice control in the match: hold it (whatever it is: the walk finds it by its label)
  // (it steps aside while a tip or a card is up: give those time to go)
  await until(phone, () => [...document.querySelectorAll('[data-voice="talk"], .vc-mic__btn')].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'), 20_000);
  const talk = await centre(phone, '[data-voice="talk"], .vc-mic__btn');
  check(`${profile}: a talk control in the match`, !!talk);
  if (talk) {
    await phone.touchscreen.touchStart(talk.x, talk.y);
    await sleep(1500);
    await shot(phone, `${profile}-3-talking`);
    await phone.touchscreen.touchEnd();
    await sleep(600);
    // a quick tap: the comms sheet (the new radio); the old pill had none
    const covers = await phone.evaluate(() =>
      [...document.querySelectorAll("[role='dialog'], [role='alertdialog'], .mf-spot")].filter((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none').map((e) => e.className || e.tagName),
    );
    if (covers.length) console.log(`  ${profile} cards over the game: ${covers.join(' | ')}`);
    await until(phone, () => [...document.querySelectorAll('[data-voice="talk"]')].some((e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden'), 20_000);
    const again = await centre(phone, '[data-voice="talk"]');
    check(`${profile}: the radio is there after talking`, !!again);
    // the press as the page saw it (a loaded machine can stretch a scripted tap past the hold time)
    await phone.evaluate(() => {
      window.__press = {};
      const b = document.querySelector('[data-voice="talk"]');
      b?.addEventListener('pointerdown', (e) => (window.__press.down = e.timeStamp), { once: true });
      b?.addEventListener('pointerup', (e) => (window.__press.up = e.timeStamp), { once: true });
    });
    await phone.touchscreen.tap((again ?? talk).x, (again ?? talk).y);
    let sheetUp = await until(phone, () => !!document.querySelector('.vc-sheet'), 4000);
    const pressMs = await phone.evaluate(() => Math.round((window.__press.up ?? 0) - (window.__press.down ?? 0)));
    if (!sheetUp && pressMs >= 200) {
      // the scripted tap reached the page as a hold (it talked, rightly): open comms the keyboard's way
      console.log(`  ${profile}: the scripted tap took ${pressMs} ms on the page (a hold); comms opened by a click`);
      await phone.evaluate(() => document.querySelector('[data-voice="talk"]')?.click());
      sheetUp = await until(phone, () => !!document.querySelector('.vc-sheet'), 4000);
    } else check(`${profile}: a tap on the radio opens comms`, sheetUp, `${pressMs} ms press`);
    if (sheetUp) {
      await sleep(500);
      await shot(phone, `${profile}-3b-comms`);
      await fits(phone, `${profile} comms sheet`);
      const scroll = await phone.evaluate(() => {
        const b = document.querySelector('.vc-sheet__body');
        return b ? { scrolls: b.scrollHeight > b.clientHeight + 1, overflowY: getComputedStyle(b).overflowY } : null;
      });
      console.log(`  ${profile} comms body: ${JSON.stringify(scroll)}`);
      await tap(phone, '.vc-sheet__head button[aria-label="Close comms"]');
      check(`${profile}: the sheet closes`, await until(phone, () => !document.querySelector('.vc-sheet'), 4000));
    }
  }

  // the pause menu (the touch layer's menu button)
  await tap(phone, '[data-mf-control="pause"]');
  await until(phone, () => !!document.querySelector('[data-screen="m-pause"], .pm-pause'), 15_000);
  await sleep(1200);
  await shot(phone, `${profile}-4-pause`);
  await fits(phone, `${profile} pause`);

  await host.browserContext().close();
  await phone.browserContext().close();
}

const scenarios = (process.env.WALK ?? 'room').split(',');
for (const p of only.length ? only : Object.keys(PROFILES)) {
  for (const [name, fn] of [['room', walk]]) {
    if (!scenarios.includes(name)) continue;
    try {
      await fn(p);
    } catch (e) {
      check(`${p} ${name}: walk ran`, false, e.message);
    }
  }
}
await browser.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
