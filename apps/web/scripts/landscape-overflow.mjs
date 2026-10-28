/**
 * Every menu, sheet and dialog on a phone held sideways, checked for overflow (the owner, 24 Oct: "we
 * keep forgetting it's a mobile device and on landscape … some things are overflowing"): at 780×360
 * (a Galaxy S23), 844×390 (an iPhone in standalone) and 844×300 (an iPhone in Safari, its bars
 * showing). On each screen, nothing a player reads or taps may sit outside the window, unless a
 * scroll area it's in can bring it in; nothing may be cut by a box that doesn't scroll; the page
 * itself doesn't scroll sideways; and no scroll area sits inside another.
 *
 *   node apps/web/scripts/landscape-overflow.mjs http://localhost:5227 [out-dir]
 *
 * Exits 1 with the list of problems. The HUD editor and the voice UI are left out (being redesigned).
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5227').replace(/\/$/, '');
const out = process.argv[3] ? resolve(process.argv[3]) : null;
if (out) mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';
const SIZES = [
  { name: '780x360', width: 780, height: 360, ua: ANDROID },
  { name: '844x390', width: 844, height: 390, ua: IPHONE },
  { name: '844x300', width: 844, height: 300, ua: IPHONE },
];
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;

/** Runs in the page: what's out of reach on the screen as it is now. */
function audit() {
  const vw = innerWidth;
  const vh = innerHeight;
  const problems = [];
  const name = (el) => {
    const t = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    const cls = typeof el.className === 'string' ? el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : '';
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}${t ? ` "${t}"` : ''}`;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
      if (e.hasAttribute('inert') || e.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  };
  const scrolls = (e, axis) => {
    const cs = getComputedStyle(e);
    const o = axis === 'y' ? cs.overflowY : cs.overflowX;
    return (o === 'auto' || o === 'scroll') && (axis === 'y' ? e.scrollHeight > e.clientHeight + 1 : e.scrollWidth > e.clientWidth + 1);
  };
  const clips = (e) => {
    const cs = getComputedStyle(e);
    return cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.contain.includes('paint');
  };
  const CUT_OK = '.qr, svg, .mf-vf, .ticker, .ticker__run, .m-p5, .pm-name, .marquee';
  /**
   * Whether `el` can be brought into view: every box that clips it either shows it or scrolls the
   * way it's hidden (and that box can itself be brought into view), and in the end it's in the window.
   * Returns why not, or null.
   */
  const reach = (el, depth = 0) => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      if (!clips(a)) continue;
      const ar = a.getBoundingClientRect();
      const outY = r.bottom > ar.bottom + 1 || r.top < ar.top - 1;
      const outX = r.right > ar.right + 1 || r.left < ar.left - 1;
      if (!outY && !outX) continue;
      const okY = !outY || scrolls(a, 'y');
      const okX = !outX || (scrolls(a, 'x') && a.closest('[data-scroll-x]') !== null);
      if (okY && okX) return depth > 6 ? null : reach(a, depth + 1) && `${reach(a, depth + 1)} (holding ${name(el).slice(0, 30)})`;
      if (a.matches(CUT_OK) || el.closest(CUT_OK)) return null;
      return `cut: ${name(el)} inside ${name(a).slice(0, 50)} (${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)} of ${Math.round(ar.left)},${Math.round(ar.top)}–${Math.round(ar.right)},${Math.round(ar.bottom)})`;
    }
    if (r.bottom > vh + 1 || r.top < -1 || r.right > vw + 1 || r.left < -1) return `off screen: ${name(el)} at ${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)} (window ${vw}×${vh})`;
    return null;
  };
  // what a player reads or taps, in the shell's screens, routes and panels (not the HUD, the touch
  // controls, the editor or the voice UI)
  const roots = document.querySelectorAll('#shell, .mf-route, .sx-layer, .sx-drawer, .mf-pwa-host');
  const SKIP = '.mf-touch, #hud, .mf-touch-editor, .vc-mic, .vc-pause, .voice, [data-voice], .bg, .bg__word, .pbg, .hazard, [aria-hidden="true"]';
  const seen = new Set();
  for (const root of roots) {
    for (const el of root.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="switch"], h1, h2, h3, p, label, li, .label, .display')) {
      if (seen.has(el) || el.closest(SKIP) || !shown(el)) continue;
      seen.add(el);
      const why = reach(el);
      if (why) problems.push(why);
    }
  }
  // nothing floats over a button and hides it (a toast over the Lobby button); a modal over the
  // screen (a sheet, a dialog, the settings over the lobby) hides it on purpose and doesn't count
  const MODAL = '.pm-scrim, .pm-sheet, .mf-fit--modal, .sx-drawer, .sx-scrim, [aria-modal="true"], .screen[role="dialog"], .mm-modal';
  for (const root of roots) {
    for (const el of root.querySelectorAll('button, a[href], [role="button"]')) {
      if (el.closest(SKIP) || !shown(el)) continue;
      const r = el.getBoundingClientRect();
      const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
      const y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
      if (r.left + r.width / 2 < 0 || r.left + r.width / 2 > vw || r.top + r.height / 2 < 0 || r.top + r.height / 2 > vh) continue;
      const hit = document.elementFromPoint(x, y);
      if (!hit || el.contains(hit) || hit.contains(el)) continue;
      if (el.matches('.pm-scrim, .sx-scrim')) continue;
      // a modal over it on purpose: a sheet, a drawer, a dialog the button isn't part of
      const modal = hit.closest(MODAL);
      if (modal && !modal.contains(el)) continue;
      if (hit.closest('.mf-touch, #hud, canvas')) continue;
      const over = hit.closest('aside, [role="dialog"], [role="status"], .mf-install, .toast, .mf-notice, .pm-chip') ?? hit;
      if (over.contains(el)) continue;
      problems.push(`covered: ${name(el)} under ${name(over).slice(0, 50)}`);
    }
  }
  // a button's own words fit it (a label running past the button's edge is cut, or spills)
  for (const root of roots) {
    for (const el of root.querySelectorAll('button, a[href], [role="button"], [role="tab"]')) {
      if (el.closest(SKIP) || !shown(el)) continue;
      if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).whiteSpace !== 'normal') problems.push(`words don't fit: ${name(el)} (${el.scrollWidth} > ${el.clientWidth})`);
    }
  }
  // nothing in a menu scrolls sideways, unless it's a strip made to (tabs, chips: [data-scroll-x])
  for (const root of roots) {
    for (const el of root.querySelectorAll('*')) {
      if (el.closest(SKIP) || el.closest('[data-scroll-x]') || !shown(el)) continue;
      if (scrolls(el, 'x')) problems.push(`scrolls sideways: ${name(el).slice(0, 60)} (${el.scrollWidth} > ${el.clientWidth})`);
    }
  }
  // the page itself never scrolls sideways
  const se = document.scrollingElement;
  if (se && se.scrollWidth > vw + 1) problems.push(`the page scrolls sideways: ${se.scrollWidth} > ${vw}`);
  // no scroll area inside another (two scrollbars, a stuck thumb)
  const areas = [...document.querySelectorAll('#shell *, .mf-route *')].filter((e) => !e.closest(SKIP) && shown(e) && scrolls(e, 'y'));
  for (const a of areas) {
    const outer = areas.find((b) => b !== a && b.contains(a));
    if (outer) problems.push(`scroll inside scroll: ${name(a).slice(0, 40)} in ${name(outer).slice(0, 40)}`);
  }
  return [...new Set(problems)];
}

const problems = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'overflow-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });

async function phone(size) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(() => {
    if (location.protocol === 'about:') return;
    const now = Date.now();
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('mf.touch.drill.v1', 'done');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.install.v1', JSON.stringify({ sessions: 1, dismissedAt: 1, matchesAtDismiss: 0, accepted: false }));
    localStorage.setItem('mf.facts.v1', JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }));
    localStorage.setItem('mf.age.v1', JSON.stringify({ adult: true, birthYear: 1990, at: Date.now() })); // the 18+ step, answered
  });
  await page.emulate({ viewport: { width: size.width, height: size.height, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: size.ua });
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }, { name: 'orientation', value: 'landscape' }] });
  return page;
}

async function check(page, size, what, text = 1) {
  if (ONLY && !ONLY.has(what)) return;
  await page.evaluate((s) => document.documentElement.style.setProperty('--text-scale', String(s)), text);
  await sleep(400);
  // entrances finished (a sheet rising, a panel sliding in): their end is what's measured
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !(a.timeline instanceof DocumentTimeline) || a.effect?.getTiming().iterations === Infinity), { timeout: 5000, polling: 100 })
    .catch(() => {});
  const found = await page.evaluate(audit);
  const label = `${size.name}${text !== 1 ? ` @${Math.round(text * 100)}%` : ''} · ${what}`;
  for (const p of found) problems.push(`${label}: ${p}`);
  console.log(`${found.length ? '✗' : 'ok'} ${label}${found.length ? ` (${found.length})` : ''}`);
  if (out && (found.length || process.env.SHOTS)) await page.screenshot({ path: join(out, `${size.name}-${what.replace(/[^a-z0-9]+/gi, '-')}${text !== 1 ? '-150' : ''}.png`) });
  await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
}
const set = (page, state) => page.evaluate((st) => window.__game.shell.store.setState(st), state);
const click = async (page, xpath, timeout = 10_000) => (await page.waitForSelector(`xpath/${xpath}`, { timeout })).click();

const ROOM = {
  screen: { name: 'room', code: 'KMTXRA' },
  connection: { state: 'connected', detail: '', code: 0, since: 0, until: 0, attempt: 0, lastPingMs: 38, lossPct: 0 },
  lobby: { code: 'KMTXRA', isHost: true, ready: false, minPlayers: 2, timeLimit: 300, killLimit: 20, bots: 4, botLevel: 'normal', mapId: 'street-market', mapName: 'Street Market', players: [
    { id: 0, name: 'Ade', isBot: false, ready: false, host: true, you: true, pingMs: 38 },
    { id: 1, name: 'Kemi', isBot: false, ready: true, host: false, you: false, pingMs: 52 },
    { id: 2, name: 'Raja', isBot: false, ready: false, host: false, you: false, pingMs: 91 },
    { id: 3, name: '[BOT] Kestrel', isBot: true, ready: false, host: false, you: false, pingMs: -1 },
    { id: 4, name: '[BOT] Mantis', isBot: true, ready: false, host: false, you: false, pingMs: -1 },
    { id: 5, name: 'Tunde', isBot: false, ready: true, host: false, you: false, pingMs: 61 },
  ] },
  match: { phase: 0, number: 1, secondsLeft: 0, untimed: false, secondsElapsed: 0, killLimit: 20, timeLimit: 300, countdownTotal: 3, mapName: 'Street Market', localId: 0, myScore: 0, leaderScore: 0, leaderName: '', ready: false, votes: 0, humans: 4, voted: false, results: null },
};
const standing = (o) => ({ left: false, isBot: false, suicides: 0, assists: 0, damageTaken: 0, headshots: 0, rating: 0, mvp: false, ...o });
const RESULTS = { number: 1, reason: 1, durationTicks: 13320, winnerKey: 1, mvpKey: 1, standings: [
  standing({ placement: 1, id: 1, key: 1, name: 'Kemi', score: 10, kills: 10, deaths: 3, damageDealt: 1840, bestStreak: 5, mvp: true }),
  standing({ placement: 2, id: 0, key: 0, name: 'Ade', score: 6, kills: 6, deaths: 4, damageDealt: 1210, bestStreak: 3 }),
  standing({ placement: 3, id: 2, key: 2, name: 'Raja', score: 4, kills: 4, deaths: 7, damageDealt: 980, bestStreak: 2 }),
  standing({ placement: 4, id: 5, key: 5, name: 'Tunde', score: 3, kills: 3, deaths: 6, damageDealt: 700, bestStreak: 1 }),
  standing({ placement: 5, id: 3, key: 3, name: '[BOT] Kestrel', isBot: true, score: 2, kills: 2, deaths: 8, damageDealt: 560, bestStreak: 1 }),
] };

async function walk(size) {
  const page = await phone(size);
  await page.goto(`${base}/?app`, { waitUntil: 'load' });
  await page.waitForSelector('[data-screen="m-name"] input, [data-screen="m-home"]', { timeout: 90_000 });
  await check(page, size, 'name entry');
  if (!(await page.$('[data-screen="m-home"]'))) {
    await page.type('[data-screen="m-name"] input', `Over${Math.floor(Math.random() * 9000 + 1000)}`);
    await page.keyboard.press('Enter');
    for (let i = 0; i < 15 && !(await page.$('[data-screen="m-home"]')); i++) {
      await sleep(800);
      await page.$eval('button[type=submit]', (b) => b.click()).catch(() => {});
    }
  }
  await page.waitForSelector('[data-screen="m-home"]', { timeout: 30_000 });
  await check(page, size, 'home');
  await check(page, size, 'home', 1.5);
  // the overlays and dialogs
  for (const overlay of ['join', 'name', 'lan-add', 'lan-join']) {
    await set(page, { overlay });
    await check(page, size, `overlay ${overlay}`);
    await set(page, { overlay: null });
  }
  // Settings, every tab, at 100 % and 150 %
  for (const tab of ['touch', 'graphics', 'audio', 'accessibility', 'network']) {
    await set(page, { overlay: 'settings', settingsTab: tab });
    await check(page, size, `settings ${tab}`);
    await check(page, size, `settings ${tab}`, 1.5);
  }
  // the reports sheet (Settings → Network → Send a report)
  await set(page, { overlay: 'settings', settingsTab: 'network' });
  await click(page, './/button[contains(normalize-space(.), "Send a report")]').catch(() => {});
  await check(page, size, 'send a report');
  await set(page, { overlay: null });
  // the routes: the Locker, the Armory, the creator
  for (const route of ['locker', 'armory', 'creator']) {
    await page.evaluate((r) => (location.hash = `#/${r}`), route);
    await sleep(2500);
    await check(page, size, `route ${route}`);
    await page.evaluate(() => (location.hash = ''));
    await sleep(800);
  }
  // friends (the social panel), when the API is up
  const friends = await page.$('.sx-fbtn');
  if (friends) {
    await friends.click();
    await sleep(1200);
    await check(page, size, 'friends');
    await page.keyboard.press('Escape');
    await sleep(500);
  }
  // the pause menu (in Training)
  await click(page, './/button[contains(normalize-space(.), "Training")]');
  await sleep(5000);
  await page.keyboard.press('Escape');
  await page.waitForSelector('[data-screen="m-pause"]', { timeout: 15_000 }).catch(() => {});
  await check(page, size, 'pause');
  await check(page, size, 'pause', 1.5);
  await click(page, './/nav[contains(@class,"pm-pause")]//button[contains(normalize-space(.), "Leave")]').catch(() => {});
  await check(page, size, 'pause leave sheet');
  // the lobby, its rules sheet, and Results (the shell's state, held)
  await page.evaluate(() => {
    window.__game.shell.update = () => {};
  });
  await set(page, { overlay: null, ...ROOM });
  await page.waitForSelector('[data-screen="m-lobby"]', { timeout: 10_000 }).catch(() => {});
  await check(page, size, 'lobby');
  await check(page, size, 'lobby', 1.5);
  await page.$eval('.pm-rules', (b) => b.click()).catch(() => {});
  await check(page, size, 'lobby rules');
  await page.$eval('.pm-scrim', (s) => s.click()).catch(() => {});
  await set(page, { match: { ...ROOM.match, phase: 2 } });
  await sleep(300);
  await set(page, { match: { ...ROOM.match, phase: 3, votes: 2, humans: 4, voted: false, myScore: 6, leaderScore: 10, leaderName: 'Kemi', results: RESULTS } });
  await page.waitForSelector('[data-screen="m-results"]', { timeout: 10_000 }).catch(() => {});
  await check(page, size, 'results');
  await check(page, size, 'results', 1.5);
  // a connection alert
  await set(page, { match: null, lobby: null, connection: { state: 'failed', detail: 'connection lost', code: 1006, since: 0, until: 0, attempt: 7, lastPingMs: 412, lossPct: 18 } });
  await check(page, size, 'connection alert');
  await page.close();
}

try {
  for (const size of SIZES) {
    if (process.env.SIZES && !process.env.SIZES.split(',').includes(size.name)) continue;
    await walk(size).catch((e) => problems.push(`${size.name}: run: ${e.message}`));
  }
} finally {
  await browser.close();
}
if (problems.length) {
  console.log(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('\nno overflow on any screen');
