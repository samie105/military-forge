/**
 * The mobile audit's fixes walked end to end as a stranger on a phone (docs/design/mobile-audit-2026-10-23.md):
 * a Samsung Galaxy S23 profile (780×360 held sideways and 360×780 upright, DPR 3, the Chrome Android user
 * agent), real touch events (CDP), 4× CPU throttling. Against a running dev server; no API is needed.
 *
 *   node apps/web/scripts/mobile-walk.mjs <dev server> <screenshot dir> [scenario ...]
 *
 * Scenarios (all by default):
 *   no-popups   a new player's first training match: no "How to play", tip card or fire chooser opens
 *               during the countdown or the clock, and none stacks; the controls card waits for Home.
 *   home-taps   Home's stops start only on an idle Home (never the one a match ends into); a tap on the
 *               real control acts and ends the pass (never counts as Next); the tap after Skip acts.
 *   slim-cards  First flight's orders and a match's tip are a slim strip at the top edge: at most 15 % of
 *               the 360 px height, clear of the battlefield's centre.
 *   play-now    Home's hero is Play now: one tap to a fight (offline here: training against bots).
 *   creator     the creator on a phone: every target 44 px or more, Save whole, every tab on screen, a tap on a
 *               part-shown card picks it (never Back), and items show their own pictures.
 *   cards-once  "How to play" shows once per device: dismissed by leaving, by starting play, by Escape or by
 *               Got it, then a reload and more games: it never comes back by itself (the menu still opens it).
 *   invite      a new player from an invite link (/r/CODE): the name screen says whose room it is and its
 *               button says Join room (the API's GET /rooms/:code is stubbed: no API runs here).
 *   match-end   a match that ends while the pause menu (or Settings) is open: they close and Results shows;
 *               the pause never says the match is running after its end.
 *   armory      Home's Armory tab opens the Armory in the app (no page load: the page's state survives),
 *               Back returns to Home, and "Try it in training" starts training without a reload.
 * Exits 1 on any failed check.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? join(tmpdir(), 'mobile-walk');
const only = process.argv.slice(4);
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PROFILES = {
  sideways: { width: 780, height: 360, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true },
  upright: { width: 360, height: 780, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: false },
  // the owner's iPhone in Safari, sideways, with the address and tab bars showing: about 844×300 visible
  iphone: { width: 844, height: 300, isMobile: true, hasTouch: true, deviceScaleFactor: 3, isLandscape: true },
};

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: mkdtempSync(join(tmpdir(), 'walk-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });

/** A fresh S23 page (cleared storage), 4× CPU. */
async function phone(profile) {
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setViewport(PROFILES[profile]);
  await page.emulateCPUThrottling(4);
  page.setDefaultNavigationTimeout(120_000); // a loaded machine and 4× CPU: the dev server's first load is slow
  // a phone has no controller: one paired with the machine running the walk would reach headless Chrome
  await page.evaluateOnNewDocument(() => {
    if (typeof navigator.getGamepads === 'function') navigator.getGamepads = () => [];
  });
  page.on('pageerror', (e) => check(`${profile}: no page error`, false, e.message));
  await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  return page;
}

/** Taps (a real touch) the centre of the first visible element matching `sel` whose text includes `text`. */
async function tap(page, sel, text = '') {
  const at = await page.evaluate(
    (s, t) => {
      const el = [...document.querySelectorAll(s)].find((e) => (!t || (e.textContent ?? '').toLowerCase().includes(t.toLowerCase())) && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' }); // a finger scrolls to it first
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    },
    sel,
    text,
  );
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

/** Title → name → (creator: Skip) → Briefing (veteran) → Home, as a new player. */
async function newPlayerToHome(page, profile, query = '') {
  await page.goto(`${base}/?app${query}`, { waitUntil: 'load' });
  await sleep(1500);
  await page.evaluate(() => document.querySelector('.pm-turn__card button')?.click());
  // the title: tap anywhere
  if (await until(page, () => !!document.querySelector('[data-screen="title"]'), 15_000)) {
    await page.touchscreen.tap(PROFILES[profile].width / 2, PROFILES[profile].height / 2);
  }
  await until(page, () => !!document.querySelector('input[aria-label="Your name"], [data-screen="home"], [data-screen="m-home"]'), 90_000);
  if (await page.$('input[aria-label="Your name"]')) {
    await tap(page, 'input[aria-label="Your name"]');
    await page.keyboard.type(`Walk${Math.floor(Math.random() * 900 + 100)}`);
    await page.keyboard.press('Enter');
  }
  // whichever comes next: Create your soldier (Skip), the Briefing (veteran), or Home
  for (let i = 0; i < 3; i++) {
    await until(page, () => !!document.querySelector('[data-screen="creator"] [data-action="skip"], [data-screen="briefing"], [data-screen="home"], [data-screen="m-home"]'), 20_000);
    if (await page.$('[data-screen="creator"] [data-action="skip"]')) {
      await sleep(800);
      await tap(page, '[data-screen="creator"] [data-action="skip"]');
      await sleep(600);
    } else if (await page.$('[data-screen="briefing"]')) {
      await sleep(600);
      await tap(page, '[data-answer="veteran"]');
      await sleep(600);
    } else break;
  }
  return until(page, () => !!document.querySelector('[data-screen="home"], [data-screen="m-home"]'), 20_000);
}

const cardsUp = (page) =>
  page.evaluate(() => {
    const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0;
    const s = window.__game?.shell?.store?.getState();
    return {
      phase: s?.match?.phase ?? null,
      screen: s?.screen?.name,
      tips: vis(document.querySelector('[data-screen="tips"], [data-screen="m-tips"]')),
      chooser: vis(document.querySelector('.mf-choose')),
    };
  });

// ---- P0-3: no pop-ups during a live match
async function noPopups(profile) {
  const page = await phone(profile);
  const home = await newPlayerToHome(page, profile);
  if (!home) await page.screenshot({ path: join(out, `p0-3-${profile}-stuck.png`) });
  check(`${profile}: a new player reaches Home`, home);
  await page.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
  let worst = null;
  let seenLive = false;
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    const c = await cardsUp(page);
    const live = c.phase === 1 || c.phase === 2;
    seenLive ||= live;
    if (live && (c.tips || c.chooser)) worst ??= c;
    await sleep(250);
  }
  await page.screenshot({ path: join(out, `p0-3-${profile}-in-match.png`) });
  check(`${profile}: the match ran (countdown and clock)`, seenLive);
  check(`${profile}: no card opened while the countdown or the clock ran`, worst === null, JSON.stringify(worst));
  // back to Home: the controls card (queued) may open there, once, alone
  await page.evaluate(() => window.__game.shell.controller.leave());
  await until(page, () => !!document.querySelector('[data-screen="home"], [data-screen="m-home"]'), 15_000);
  await sleep(1500);
  const after = await cardsUp(page);
  await page.screenshot({ path: join(out, `p0-3-${profile}-home-after.png`) });
  check(`${profile}: the queued controls card opens on Home, alone`, after.tips && !after.chooser, JSON.stringify(after));
  await page.close();
}

// ---- P1-5: the Home tour never eats a tap
const FACTS = (over) => JSON.stringify({ v: 1, firstSeen: Date.now(), lastSession: Date.now(), sessions: 2, devices: ['touch'], lastDevice: 'touch', experience: 'veteran', promoted: false, invited: false, tours: {}, matches: { local: 1, online: 0, finished: 1, wonInARow: 0 }, kills: 1, deaths: {}, moves: {}, screens: [], rooms: { created: 0, joined: 0, local: 0 }, soldierSaved: true, touch: { missedTaps: 0, hops: 0 }, cards: {}, ...over });

async function homeTaps(profile) {
  const page = await phone(profile);
  await page.evaluate((f) => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.facts.v1', f);
  }, FACTS({}));
  check(`${profile}: to Home`, await newPlayerToHome(page, profile));
  // busy on Home (a tap every 2 s on the brand, which does nothing): no pass
  const taps = [Date.now()];
  for (let i = 0; i < 4; i++) {
    await tap(page, '.pm-brand, .brand');
    taps.push(Date.now());
    await sleep(2000);
  }
  if (process.env.WALK_DEBUG) console.log('taps', taps.map((t) => t - taps[0]), await page.evaluate((t0) => JSON.parse(localStorage.getItem('mf.log.v1') ?? '[]').filter((e) => e.tour).map((e) => `${e.step ?? e.result}:${e.status ?? ''}@${e.at - t0}ms(${e.ms})`), taps[0]));
  const busy = await page.evaluate(() => {
    const el = document.querySelector('.mf-spot:not([hidden])');
    return el ? { title: el.querySelector('.mf-spot__title')?.textContent, cls: el.className, log: JSON.parse(localStorage.getItem('mf.log.v1') ?? '[]').filter((e) => e.tour).map((e) => `${e.tour}:${e.step ?? e.result}:${e.status ?? ''}`) } : null;
  });
  check(`${profile}: no tour while the player is busy`, busy === null, JSON.stringify(busy));
  // idle: the pass comes
  const up = await until(page, () => !!document.querySelector('.mf-spot:not([hidden]) .mf-spot__title'), 15_000);
  const first = await page.evaluate(() => {
    const st = window.__game.shell.store.getState();
    return { title: document.querySelector('.mf-spot:not([hidden]) .mf-spot__title')?.textContent ?? null, state: { screen: st.screen.name, overlay: st.overlay, route: st.route?.id ?? null, tips: st.tips, title: st.title }, log: JSON.parse(localStorage.getItem('mf.log.v1') ?? '[]').filter((e) => e.tour).map((e) => `${e.tour}:${e.step ?? e.result}:${e.status ?? ''}`), facts: JSON.parse(localStorage.getItem('mf.facts.v1') ?? '{}').tours };
  });
  await page.screenshot({ path: join(out, `p1-5-${profile}-stop.png`) });
  check(`${profile}: an idle Home gets the stops`, up, JSON.stringify(first));
  // a tap on the ringed control does it (Join opens), and the pass ends; it never counts as Next
  const ringed = await page.evaluate(() => (document.querySelector('.mf-spot__title')?.textContent ?? '').includes('code') ? 'join' : 'locker');
  await tap(page, `[data-tour="${ringed}"]`);
  await sleep(1200);
  const after = await page.evaluate(() => ({
    spot: !!document.querySelector('.mf-spot:not([hidden]):not(.is-leaving)'),
    overlay: window.__game.shell.store.getState().overlay,
    route: window.__game.shell.store.getState().route?.id ?? null,
    log: JSON.parse(localStorage.getItem('mf.log.v1') ?? '[]').filter((e) => e.tour === 'home-stops').map((e) => (e.step ? `${e.step}:${e.status}` : e.result)),
  }));
  await page.screenshot({ path: join(out, `p1-5-${profile}-tapped.png`) });
  check(`${profile}: the tap on the ringed control acted and ended the pass`, !after.spot && (after.overlay === 'join' || after.route === 'locker') && after.log.includes('finished'), JSON.stringify(after));
  await page.close();

  // Skip, then at once the Locker: the first tap opens it
  const p2 = await phone(profile);
  await p2.evaluate((f) => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.facts.v1', f);
  }, FACTS({}));
  await newPlayerToHome(p2, profile);
  await until(p2, () => !!document.querySelector('.mf-spot:not([hidden]) .mf-spot__skip'), 20_000);
  await sleep(500);
  await tap(p2, '.mf-spot__skip', 'skip');
  await sleep(60);
  await tap(p2, '[data-tour="locker"], .pm-tabs button, button', 'locker');
  await sleep(1500);
  const locker = await p2.evaluate(() => window.__game.shell.store.getState().route?.id ?? null);
  check(`${profile}: after Skip, the very next tap (Locker) acts`, locker === 'locker', String(locker));
  await p2.close();

  // the Home a match ends into: no stops
  const p3 = await phone(profile);
  await p3.evaluate((f) => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.facts.v1', f);
  }, FACTS({}));
  await newPlayerToHome(p3, profile);
  await p3.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
  await sleep(3000);
  await p3.evaluate(() => window.__game.shell.controller.leave());
  await sleep(9000);
  check(`${profile}: no tour on the Home a match just ended into`, !(await p3.evaluate(() => !!document.querySelector('.mf-spot:not([hidden])'))));
  await p3.close();
}

// ---- P1-1: the cards in play are a slim strip at the top edge
async function slimCards(profile) {
  const H = 360; // the logical height, sideways or turned
  const measure = (page) =>
    page.evaluate(() => {
      const c = document.querySelector('.mf-spot:not([hidden]) .mf-spot__callout');
      if (!c) return null;
      // the turned page: logical px are the page's own (offset box), not the screen's
      const turned = document.documentElement.classList.contains('mf-rotated');
      const r = c.getBoundingClientRect();
      const box = turned ? { top: c.offsetTop, height: c.offsetHeight, left: c.offsetLeft, width: c.offsetWidth } : { top: r.top, height: r.height, left: r.left, width: r.width };
      const t = getComputedStyle(c).transform;
      const m = /matrix\(([^)]+)\)/.exec(t);
      if (turned && m) {
        const v = m[1].split(',').map(Number);
        box.left = v[4];
        box.top = v[5];
      }
      return { ...box, title: c.querySelector('.mf-spot__title')?.textContent, w: turned ? innerHeight : innerWidth };
    });
  const page = await phone(profile);
  await page.evaluate((f) => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.facts.v1', f);
  }, FACTS({ matches: { local: 3, online: 0, finished: 3, wonInARow: 0 }, tours: { 'home-stops': { done: [], finished: true, skipped: false } } }));
  await newPlayerToHome(page, profile);
  await page.evaluate(() => window.__game.shell.controller.startFlight());
  await until(page, () => document.querySelector('.mf-choose:not([hidden])') || document.querySelector('.mf-spot:not([hidden]) .mf-spot__callout'), 30_000);
  await page.evaluate(() => document.querySelector('.mf-choose [data-fire="auto"]')?.click());
  await until(page, () => !!document.querySelector('.mf-spot:not([hidden]) .mf-spot__callout'), 20_000);
  await sleep(2500); // past the strip's slide-in
  const flight = await measure(page);
  await page.screenshot({ path: join(out, `p1-1-${profile}-flight.png`) });
  check(`${profile}: First flight's order is a strip ≤ 15 % of the height, at the top edge`, !!flight && flight.height <= H * 0.15 && flight.top + flight.height <= H * 0.2, JSON.stringify(flight));
  // a match tip (dash never used across 3 matches): the same strip
  await page.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
  const tip = await until(page, () => document.querySelector('.mf-spot:not([hidden]) .mf-spot__title')?.textContent === 'Dash.', 40_000);
  await sleep(700); // past the slide-in
  const t = tip ? await measure(page) : null;
  await page.screenshot({ path: join(out, `p1-1-${profile}-tip.png`) });
  const clear = await page.evaluate(() => {
    const c = document.querySelector('.mf-spot:not([hidden]) .mf-spot__callout')?.getBoundingClientRect();
    const hit = (sel) => [...document.querySelectorAll(sel)].some((e) => {
      const b = e.getBoundingClientRect();
      return c && b.width && !(b.right <= c.left || b.left >= c.right || b.bottom <= c.top || b.top >= c.bottom);
    });
    return { clock: hit('.pt-clock'), pause: hit('.mf-ctl-pause') };
  });
  check(`${profile}: a match tip is the same strip, clear of the clock and the pause button`, !!t && t.height <= H * 0.15 && t.top + t.height <= H * 0.3 && !clear.clock && !clear.pause, JSON.stringify({ ...t, ...clear }));
  await page.close();
}

// ---- P0-6: the Armory is a route, never a page load
async function armory(profile) {
  const page = await phone(profile);
  await page.evaluate((f) => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.facts.v1', f);
  }, FACTS({ tours: { 'home-stops': { done: [], finished: true, skipped: false } } }));
  await newPlayerToHome(page, profile);
  await page.evaluate(() => (window.__sameDocument = true));
  await tap(page, '.pm-tabs button, .tab, button', 'armory');
  const open = await until(page, () => window.__game?.shell?.store?.getState().route?.id === 'armory' && !!document.querySelector('[data-screen="armory"], .ar'), 20_000);
  await sleep(2500);
  await page.screenshot({ path: join(out, `p0-6-${profile}-armory.png`) });
  const kept = await page.evaluate(() => ({ same: window.__sameDocument === true, path: location.pathname, hash: location.hash }));
  check(`${profile}: the Armory opens in the app, no page load`, open && kept.same && kept.path === '/', JSON.stringify(kept));
  await tap(page, '[data-action="exit"]');
  const home = await until(page, () => window.__game.shell.store.getState().route === null && !!document.querySelector('[data-screen="m-home"], [data-screen="home"]'), 10_000);
  check(`${profile}: Back returns to Home, same page`, home && (await page.evaluate(() => window.__sameDocument === true)));
  await tap(page, '.pm-tabs button, .tab, button', 'armory');
  await until(page, () => !!document.querySelector('[data-action="try"]'), 20_000);
  await sleep(1500);
  await tap(page, '[data-action="try"]');
  const training = await until(page, () => window.__game.shell.store.getState().screen.name === 'training', 15_000);
  check(`${profile}: Try it in training starts training, same page`, training && (await page.evaluate(() => window.__sameDocument === true)));
  await page.close();
}

// ---- P1-2: the match ends under the menu
async function matchEnd(profile) {
  const page = await phone(profile);
  await page.evaluate((f) => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.facts.v1', f);
  }, FACTS({ tours: { 'home-stops': { done: [], finished: true, skipped: false } } }));
  // a 12 s match
  await newPlayerToHome(page, profile, '&time=12&countdown=1');
  await page.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
  await until(page, () => window.__game.shell.store.getState().match?.phase === 2, 20_000);
  await sleep(1500);
  await tap(page, '[aria-label="Menu"], [aria-label="Pause"], .mf-ctl-pause');
  if (!(await page.evaluate(() => window.__game.shell.store.getState().overlay))) await page.evaluate(() => window.__game.shell.controller.openOverlay('menu'));
  await sleep(800);
  await page.screenshot({ path: join(out, `p1-2-${profile}-paused.png`) });
  const results = await until(page, () => window.__game.shell.store.getState().match?.phase >= 3 && !!document.querySelector('[data-screen="results"], [data-screen="m-results"]'), 30_000);
  await sleep(1500);
  const st = await page.evaluate(() => ({ overlay: window.__game.shell.store.getState().overlay, phase: window.__game.shell.store.getState().match?.phase, running: /still running/i.test(document.body.innerText) }));
  await page.screenshot({ path: join(out, `p1-2-${profile}-results.png`) });
  check(`${profile}: the match ended under the menu: the menu closed and Results shows`, results && st.overlay === null && !st.running, JSON.stringify(st));
  await page.close();
}

// ---- P1-3: the invite link says whose room
async function invite(profile) {
  const page = await phone(profile);
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.method() === 'GET' && /\/api\/rooms\/QRTZPK$/.test(new URL(r.url()).pathname)) void r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ code: 'QRTZPK', host: 'WildCobra535' }) });
    else void r.continue();
  });
  // (a service worker may take over the navigation: the page still loads)
  await page.goto(`${base}/r/QRTZPK`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(1000);
  await page.evaluate(() => document.querySelector('.pm-turn__card button')?.click());
  await until(page, () => !!document.querySelector('input[aria-label="Your name"]'), 60_000);
  const ok = await until(page, () => /WildCobra535/.test(document.querySelector('[data-bind="nameEntry.joining"]')?.textContent ?? ''), 15_000);
  const seen = await page.evaluate(() => ({ line: document.querySelector('[data-bind="nameEntry.joining"]')?.textContent, button: [...document.querySelectorAll('button[type="submit"]')].map((b) => b.textContent?.trim()).find(Boolean) }));
  await page.screenshot({ path: join(out, `p1-3-${profile}-invite.png`) });
  check(`${profile}: the invite's name screen says whose room, and Join room`, ok && /Join room/.test(seen.button ?? ''), JSON.stringify(seen));
  await page.close();
}

// ---- P1-6: one tap to a fight
async function playNow(profile) {
  const page = await phone(profile);
  await page.evaluate((f) => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.facts.v1', f);
  }, FACTS({ tours: { 'home-stops': { done: [], finished: true, skipped: false } } }));
  await newPlayerToHome(page, profile);
  await sleep(1200);
  await page.screenshot({ path: join(out, `p1-6-${profile}-home.png`) });
  const hero = await page.evaluate(() => {
    const b = document.querySelector('[data-tour="play"]')?.getBoundingClientRect();
    const c = document.querySelector('[data-tour="create"]')?.getBoundingClientRect();
    return { play: b && Math.round(b.width * b.height), create: c && Math.round(c.width * c.height) };
  });
  check(`${profile}: Play now is the biggest button, Create room secondary`, !!hero.play && hero.play > (hero.create ?? 0), JSON.stringify(hero));
  await tap(page, '[data-tour="play"]');
  const fight = await until(page, () => {
    const s = window.__game.shell.store.getState();
    return (s.screen.name === 'training' || s.screen.name === 'room' || s.screen.name === 'finding') && true;
  }, 15_000);
  const where = await page.evaluate(() => window.__game.shell.store.getState().screen.name);
  check(`${profile}: one tap to a fight (offline: training against bots)`, fight && where === 'training', where);
  await page.close();
}

// ---- P1-8: the creator's layout on a phone
async function creator(profile) {
  const page = await phone(profile);
  await page.evaluate(() => localStorage.setItem('mf-creator-seen', '1'));
  await page.goto(`${base}/?app#/creator`, { waitUntil: 'load' });
  await until(page, () => !!document.querySelector('[data-screen="creator"]'), 60_000);
  await sleep(2500);
  await page.evaluate(() => document.querySelector('.pm-turn__card button')?.click());
  const audit = () =>
    page.evaluate(() => {
      const vis = (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
      const small = [...document.querySelectorAll('[data-screen="creator"] button')].filter((b) => vis(b) && !b.closest('.items')).map((b) => ({ t: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 14), r: b.getBoundingClientRect() })).filter((x) => Math.min(x.r.width, x.r.height) < 43.5).map((x) => `${x.t} ${Math.round(x.r.width)}x${Math.round(x.r.height)}`);
      const save = document.querySelector('[data-action="save"]');
      const vw = document.documentElement.classList.contains('mf-rotated') ? innerHeight : innerWidth;
      const turned = document.documentElement.classList.contains('mf-rotated');
      const tabs = [...document.querySelectorAll('.mf-cr__tabs .tab')].filter(vis).map((t) => { const r = t.getBoundingClientRect(); return turned ? r.bottom : r.right; });
      const edge = turned ? innerHeight : innerWidth;
      return { small, save: save && vis(save) ? { text: save.textContent.trim(), clipped: [...save.querySelectorAll('span')].some((sp) => vis(sp) && sp.scrollWidth > sp.clientWidth + 1) } : null, tabsOff: tabs.filter((x) => x > edge + 1).length, vw };
    });
  const bodyStep = await audit();
  await page.screenshot({ path: join(out, `p1-8-${profile}-body.png`) });
  check(`${profile}: body step: no target under 44 px, Save whole`, !bodyStep.small.length && !!bodyStep.save && !bodyStep.save.clipped, JSON.stringify(bodyStep));
  await tap(page, '[data-action="next"]');
  await sleep(1500);
  const look = await audit();
  check(`${profile}: look step: no target under 44 px, every tab on screen, Save whole`, !look.small.length && look.tabsOff === 0 && !!look.save && !look.save.clipped, JSON.stringify(look));
  // a part-shown card: a tap on its visible part picks it, never the buttons under the list
  const pick = await page.evaluate(() => {
    const list = document.querySelector('.mf-cr__list').getBoundingClientRect();
    const turned = document.documentElement.classList.contains('mf-rotated');
    const tile = [...document.querySelectorAll('.mf-cr__list .item')].find((t) => { const r = t.getBoundingClientRect(); return turned ? r.left < list.left && r.right > list.left : r.top < list.bottom && r.bottom > list.bottom; });
    if (!tile) return { none: true };
    const r = tile.getBoundingClientRect();
    const x = turned ? (Math.max(r.left, list.left) + r.right) / 2 : r.left + r.width / 2;
    const y = turned ? r.top + r.height / 2 : (r.top + Math.min(r.bottom, list.bottom)) / 2;
    const hit = document.elementFromPoint(x, y);
    return { id: tile.dataset.id, x, y, hits: hit?.closest('.item')?.dataset.id ?? hit?.closest('button')?.dataset.action ?? hit?.className };
  });
  check(`${profile}: a tap on a part-shown card's visible half lands on the card`, pick.none || pick.hits === pick.id, JSON.stringify(pick));
  const thumbs = await until(page, () => document.querySelectorAll('.mf-item__glyph.has-thumb').length >= 2, 40_000);
  await sleep(500);
  await page.screenshot({ path: join(out, `p1-8-${profile}-look.png`) });
  check(`${profile}: items show their own pictures`, thumbs, String(await page.evaluate(() => document.querySelectorAll('.mf-item__glyph.has-thumb').length)));
  await page.close();
}

// ---- the owner's iPhone (24 Oct): First flight's strip at 844×300 (Safari's bars showing)
async function iphoneStrip(profile) {
  const page = await phone(profile);
  await page.evaluate((f) => {
    localStorage.setItem('mf-creator-seen', '1');
    localStorage.setItem('tips.seen.v1', '1');
    localStorage.setItem('mf.facts.v1', f);
  }, FACTS({ tours: { 'home-stops': { done: [], finished: true, skipped: false } } }));
  await newPlayerToHome(page, profile);
  await page.evaluate(() => window.__game.shell.controller.startFlight());
  await until(page, () => !!document.querySelector('.mf-spot:not([hidden]) .mf-spot__callout'), 30_000);
  await sleep(2500);
  const r = await page.evaluate(() => {
    const c = document.querySelector('.mf-spot:not([hidden]) .mf-spot__callout');
    const cb = c.getBoundingClientRect();
    const over = (sel) => [...document.querySelectorAll(sel)].filter((e) => {
      const b = e.getBoundingClientRect();
      return b.width && !(b.right <= cb.left || b.left >= cb.right || b.bottom <= cb.top || b.top >= cb.bottom);
    }).length;
    const body = c.querySelector('.mf-spot__body');
    const skips = [...c.querySelectorAll('.mf-spot__skip')].filter((s) => s.getClientRects().length && getComputedStyle(s).display !== 'none').map((s) => s.textContent);
    // measured at rest (the ring's pulse scales it for 4 s)
    document.querySelectorAll('.mf-spot__ring').forEach((e) => e.getAnimations().forEach((a) => a.finish()));
    // in the page's own (logical) px: the turned upright page's rects are the screen's, rotated
    const turned = document.documentElement.classList.contains('mf-rotated');
    const logical = (e) => {
      const m = new DOMMatrixReadOnly(getComputedStyle(e).transform);
      return { left: m.e, top: m.f, width: e.offsetWidth, height: e.offsetHeight };
    };
    const rings = [...document.querySelectorAll('.mf-spot__ring')].map((e) => (turned ? logical(e) : e.getBoundingClientRect()));
    const dial = window.__touch?.touchControlRect('move');
    const ring = rings[0];
    return {
      text: `${c.querySelector('.mf-spot__title')?.textContent} ${body?.textContent}`,
      height: Math.round(turned ? Math.min(cb.width, cb.height) : cb.height),
      truncated: !!body && body.scrollWidth > body.clientWidth + 1,
      overMinimap: over('.mf-mm'),
      overButtons: over('.mf-ctl-pause, .mf-ctl-scores'),
      skips,
      rings: rings.length,
      ringOff: dial && ring ? Math.round(Math.max(Math.abs(ring.left - (dial.left - 6)), Math.abs(ring.top - (dial.top - 6)))) : null,
    };
  });
  await page.screenshot({ path: join(out, `iphone-${profile}-first-flight.png`) });
  check(`${profile}: the order reads whole in one line, compact`, !r.truncated && r.height <= 44, JSON.stringify(r));
  check(`${profile}: clear of the minimap and the corner buttons`, r.overMinimap === 0 && r.overButtons === 0, JSON.stringify(r));
  check(`${profile}: one small Skip`, r.skips.length === 1 && r.skips[0] === 'Skip', JSON.stringify(r.skips));
  check(`${profile}: one ring, on the move stick`, r.rings === 1 && r.ringOff !== null && r.ringOff <= 1, JSON.stringify(r));
  await page.close();
}

// ---- the owner, 24 Oct: "why is it always showing how to play": once per device, however it closes
async function cardsOnce(profile) {
  const tipsUp = (page) => page.evaluate(() => !!document.querySelector('[data-screen="tips"], [data-screen="m-tips"]'));
  const playOnceAndHome = async (page) => {
    // (a page that reloaded itself, e.g. the service worker's update on Home: wait for the app again)
    await until(page, () => !!window.__game?.shell?.controller, 60_000);
    await page.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
    await sleep(2500);
    await page.evaluate(() => window.__game.shell.controller.leave());
    await until(page, () => !!document.querySelector('[data-screen="home"], [data-screen="m-home"]'), 15_000);
    await sleep(1500);
  };
  for (const how of ['leave', 'start-play', 'escape', 'got-it']) {
    const page = await phone(profile);
    await page.evaluate((f) => {
      localStorage.setItem('mf-creator-seen', '1');
      localStorage.setItem('mf.facts.v1', f);
    }, FACTS({ tours: { 'home-stops': { done: [], finished: true, skipped: false } } }));
    await newPlayerToHome(page, profile);
    await playOnceAndHome(page);
    const first = await until(page, () => !!document.querySelector('[data-screen="tips"], [data-screen="m-tips"]'), 10_000);
    if (how === 'leave') await page.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
    else if (how === 'start-play') await page.evaluate(() => window.__game.shell.controller.startFlight());
    else if (how === 'escape') await page.keyboard.press('Escape');
    else await tap(page, '[data-screen="tips"] button, [data-screen="m-tips"] button', 'got it');
    await sleep(1200);
    // reload, then two more games and Home each time: it must not come back
    await page.goto(`${base}/?app`, { waitUntil: 'load' }).catch(() => {});
    await until(page, () => !!document.querySelector('[data-screen="home"], [data-screen="m-home"]'), 60_000);
    let again = false;
    for (let i = 0; i < 2; i++) {
      try {
        await playOnceAndHome(page);
        again ||= await tipsUp(page);
      } catch {
        await sleep(3000); // the page reloaded under us: the next round looks again
      }
    }
    check(`${profile}: "How to play" shown once, closed by ${how}, never back after a reload`, first && !again, JSON.stringify({ first, again }));
    // the menu still opens it on request
    if (how === 'got-it') {
      await page.evaluate(() => window.__game.shell.controller.go({ to: 'training' }));
      await sleep(2000);
      await page.evaluate(() => window.__game.shell.controller.showTips());
      await sleep(800);
      const asked = await tipsUp(page);
      await page.screenshot({ path: join(out, `cards-once-${profile}-asked.png`) });
      check(`${profile}: the menu's Controls still opens it on request`, asked);
    }
    await page.close();
  }
}

const SCENARIOS = { 'no-popups': noPopups, 'home-taps': homeTaps, 'slim-cards': slimCards, armory, 'match-end': matchEnd, invite, 'play-now': playNow, creator, 'iphone-strip': iphoneStrip, 'cards-once': cardsOnce };
try {
  for (const [name, run] of Object.entries(SCENARIOS)) {
    if (only.length && !only.includes(name)) continue;
    for (const profile of (process.env.PROFILES ?? 'sideways,upright').split(',')) await run(profile);
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all mobile walk checks passed');
process.exit(failures ? 1 : 0);
