/**
 * The phone menus (name entry, m-home, m-lobby, m-pause, m-results, the touch tips) in headless Chrome as a landscape phone
 * (812×375, touch, a coarse pointer), plain, at 150 % text and with Reduce motion, and frame strips of
 * their transitions (animations slowed 10× through CDP: a shot every 160 ms = one per 16 ms of
 * animation time; phone-strips.py stitches them). Home and the pause menu are the real app (training);
 * the lobby and the debrief are the shell's store with a sample room (the dev hook holds the shell's
 * own update, so no server is needed). Needs the dev server:
 *
 *   cd apps/web && pnpm exec vite --port 5221 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/phone-menus-shots.mjs http://127.0.0.1:5221 docs/screenshots/phone-ui
 *
 * Exits 1 on a page error, a console error or a missing #icon-* reference.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5221').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/phone-ui');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(join(out, 'frames'), { recursive: true });

const problems = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'phone-menus-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  // the API isn't running in this check: its fetches fail by design (the name check, the server ping)
  if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|\/api\//.test(m.text())) problems.push(`console error: ${m.text()}`);
});
const cdp = await page.createCDPSession();
await page.emulate({
  viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
});
await cdp.send('Emulation.setEmulatedMedia', {
  features: [
    { name: 'pointer', value: 'coarse' },
    { name: 'any-pointer', value: 'coarse' },
    { name: 'hover', value: 'none' },
    { name: 'orientation', value: 'landscape' },
  ],
});
await cdp.send('Animation.enable');

const shot = async (name, settle = 700) => {
  await sleep(settle);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};
async function strip(name, start, count = 24, clip = undefined) {
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
  await start();
  for (let i = 0; i < count; i++) {
    const t = Date.now();
    await page.screenshot({ path: join(out, 'frames', `${name}-${String(i).padStart(2, '0')}.png`), ...(clip ? { clip } : {}) });
    await sleep(Math.max(0, 160 - (Date.now() - t)));
  }
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  console.log(`strip ${name}: ${count} frames`);
}
async function iconsResolve(where) {
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('use')]
      .map((u) => u.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('#') && !document.getElementById(h.slice(1)))
      .filter((h, i, a) => a.indexOf(h) === i),
  );
  for (const h of missing) problems.push(`${where}: missing ${h || '(empty href)'}`);
}
/** Every button on screen is a 48 px target or bigger (the kit's rule), in CSS pixels. */
async function targets(where) {
  const small = await page.evaluate(() =>
    [...document.querySelectorAll('#shell .mf-fit--phone button, .mf-route .mm-locker button')]
      .filter((b) => b.offsetParent !== null)
      .map((b) => {
        const r = b.getBoundingClientRect();
        const style = getComputedStyle(b, '::after');
        const pad = style.content !== 'none' ? 8 : 0;
        return { name: (b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30), w: r.width + pad, h: r.height + pad };
      })
      .filter((t) => t.w < 47.5 || t.h < 47.5),
  );
  for (const t of small) problems.push(`${where}: "${t.name}" is ${t.w.toFixed(0)}×${t.h.toFixed(0)} px`);
}
/** Every one of these buttons is inside the window (not scrolled or pushed off it). */
async function onScreen(where, sel) {
  const off = await page.$$eval(sel, (bs) =>
    bs
      .map((b) => ({ name: b.textContent.trim().slice(0, 20), r: b.getBoundingClientRect() }))
      .filter(({ r }) => r.bottom > innerHeight + 0.5 || r.top < -0.5 || r.right > innerWidth + 0.5)
      .map(({ name, r }) => `${name} at y ${Math.round(r.top)}–${Math.round(r.bottom)}`),
  );
  for (const o of off) problems.push(`${where}: ${o} is off screen`);
}
const setText = (scale) => page.evaluate((s) => document.documentElement.style.setProperty('--text-scale', String(s)), scale);
const reduce = (on) => page.evaluate((v) => document.documentElement.classList.toggle('reduce-motion', v), on);
const store = (fn) => page.evaluate(fn);

// a sample room: four people and a bot, the host is you
const ROOM = `({
  screen: { name: 'room', code: 'KMTXRA' },
  connection: { state: 'connected', detail: '', code: 0, since: 0, until: 0, attempt: 0, lastPingMs: 38, lossPct: 0 },
  lobby: { code: 'KMTXRA', isHost: true, ready: false, minPlayers: 2, timeLimit: 300, killLimit: 20, bots: 4, botLevel: 'normal', mapId: 'lunar-outpost', mapName: 'Lunar Outpost', players: [
    { id: 0, name: 'Ade', isBot: false, ready: false, host: true, you: true, pingMs: 38 },
    { id: 1, name: 'Kemi', isBot: false, ready: true, host: false, you: false, pingMs: 52 },
    { id: 2, name: 'Raja', isBot: false, ready: false, host: false, you: false, pingMs: 91 },
    { id: 3, name: '[BOT] Kestrel', isBot: true, ready: false, host: false, you: false, pingMs: -1 },
  ] },
  match: { phase: 0, number: 1, secondsLeft: 0, untimed: false, secondsElapsed: 0, killLimit: 20, timeLimit: 300, countdownTotal: 3, mapName: 'Lunar Outpost', localId: 0, myScore: 0, leaderScore: 0, leaderName: '', ready: false, votes: 0, humans: 3, voted: false, results: null },
})`;
const standing = (o) => ({ left: false, isBot: false, suicides: 0, assists: 0, damageTaken: 0, headshots: 0, rating: 0, mvp: false, ...o });
const RESULTS = JSON.stringify({
  number: 1,
  reason: 1,
  durationTicks: 13320,
  winnerKey: 1,
  mvpKey: 1,
  standings: [
    standing({ placement: 1, id: 1, key: 1, name: 'Kemi', score: 10, kills: 10, deaths: 3, damageDealt: 1840, bestStreak: 5, mvp: true }),
    standing({ placement: 2, id: 0, key: 0, name: 'Ade', score: 6, kills: 6, deaths: 4, damageDealt: 1210, bestStreak: 3 }),
    standing({ placement: 3, id: 2, key: 2, name: 'Raja', score: 4, kills: 4, deaths: 7, damageDealt: 980, bestStreak: 2 }),
    standing({ placement: 4, id: 3, key: 3, name: '[BOT] Kestrel', isBot: true, score: 2, kills: 2, deaths: 8, damageDealt: 560, bestStreak: 1 }),
  ],
});

try {
  await page.goto(`${base}/?app&time=600`, { waitUntil: 'load' });
  // the controls card (m-tips) is what this run checks: the "Learn the controls" drill, which takes its
  // place the first time in Training, has its own check (phone-gestures-shots.mjs)
  await page.evaluate(() => localStorage.setItem('mf.touch.drill.v1', 'done'));
  await page.waitForSelector('[data-screen="m-name"] input[aria-label="Your name"]', { timeout: 60_000 });
  // ---- name entry: the phone's own (the typing band on top, clear of the keyboard) ----
  await shot('m0-name', 1200);
  await iconsResolve('name');
  await targets('name');
  await setText(1.5);
  await shot('m0-name-text150');
  await onScreen('name 150%', '[data-screen="m-name"] .btn');
  await setText(1);
  await page.type('input[aria-label="Your name"]', 'Ad');
  await shot('m0-name-short', 500);
  await page.type('input[aria-label="Your name"]', `e${Math.floor(Math.random() * 900 + 100)}`);
  await page.waitForSelector('[data-screen="m-name"]:not([data-active-state="checking"])', { timeout: 10_000 });
  await shot('m0-name-typed', 400);
  // a new name and the keyboard's Go straight away, while it's still being checked (Continue is disabled
  // then): it must still submit (#167's enterSubmits); the API decides
  await page.click('input[aria-label="Your name"]', { clickCount: 3 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  const checking = await page.$('[data-screen="m-name"][data-active-state~="checking"]');
  await page.keyboard.press('Enter');
  const went = await page.waitForSelector('[data-screen="m-home"]', { timeout: 15_000 }).catch(() => null);
  if (!checking) console.log('note: the check had settled before Go (nothing to prove this run)');
  if (!went) problems.push('name: Go (Enter) while the name is being checked does nothing');
  else console.log('ok: Go while the name is being checked submits it');
  // the name check (no API here: it settles as unchecked, Continue on)
  for (let i = 0; i < 10 && !(await page.$('[data-screen="m-home"]')); i++) {
    await sleep(1200);
    await page.$eval('button[type=submit]', (b) => b.click()).catch(() => {});
  }
  await page.waitForSelector('[data-screen="m-home"]', { timeout: 30_000 });

  // ---- m-home ----
  await shot('m2-home', 1200);
  await iconsResolve('home');
  await targets('home');
  await setText(1.5);
  await shot('m2-home-text150');
  await setText(1);
  await strip('home-in', () =>
    store(() => {
      const s = window.__game.shell.store;
      s.setState({ screen: { name: 'boot' } });
      requestAnimationFrame(() => s.setState({ screen: { name: 'home' } }));
    }),
  );
  await sleep(600);

  // ---- Edit name over Home ----
  await store(() => window.__game.shell.store.setState({ overlay: 'name' }));
  await page.waitForSelector('[data-screen="m-name"]', { timeout: 10_000 });
  await shot('m0-name-edit', 900);
  await targets('edit name');
  await (await page.waitForSelector('xpath/.//button[normalize-space(.)="Cancel"]')).click();
  await page.waitForFunction(() => !document.querySelector('[data-screen="m-name"]'), { timeout: 10_000 });
  await sleep(500);

  // ---- settings: the phone's own screen (Touch first) ----
  await page.$eval('.pm-nav__i:last-child', (b) => b.click());
  await page.waitForSelector('[data-screen="m-settings"]', { timeout: 10_000 });
  await page.$$eval('.pm-rail__i', (b) => b[0].click());
  await shot('m7-settings-touch', 800);
  await iconsResolve('settings');
  await targets('settings');
  await page.$$eval('.pm-rail__i', (b) => b[3].click());
  await shot('m7-settings-access', 600);
  await setText(1.5);
  await shot('m7-settings-access-text150');
  await targets('settings 150%');
  await setText(1);
  await page.$eval('[data-screen="m-settings"] .btn--volt', (b) => b.click());
  await page.waitForSelector('[data-screen="m-home"]', { timeout: 10_000 });
  await sleep(500);

  // ---- the Locker (a route): the phone layout of today's Locker ----
  await page.evaluate(() => (location.hash = '#/locker'));
  await page.waitForSelector('.mf-route .mm-locker', { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('.mm-overlay')?.hidden !== false, { timeout: 120_000 }).catch(() => {});
  await shot('m6-locker', 2500);
  await targets('locker');
  await page.evaluate(() => (location.hash = ''));
  await page.waitForSelector('[data-screen="m-home"]', { timeout: 10_000 });
  await sleep(600);

  // ---- m-pause: training, then the ❚❚ button ----
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Training")]')).click();
  await page.waitForFunction(() => window.__game?.mode?.update && document.querySelector('.mf-touch:not([hidden])'), { timeout: 60_000 });
  // ---- the first-run tips: the touch card, not the desktop's keys, clear of the controls ----
  await page.waitForSelector('[data-screen="m-tips"]', { timeout: 10_000 });
  if (await page.$('.mf-tips')) problems.push('tips: the desktop keys card shows on a phone');
  await shot('m8-tips', 1500);
  await iconsResolve('tips');
  await targets('tips');
  const clear = async (where) => {
    const hits = await page.evaluate(() => {
      const card = document.querySelector('.pm-tips').getBoundingClientRect();
      return [...document.querySelectorAll('.mf-touch [class*="mf-ctl-"]')]
        .filter((el) => el.offsetParent && !el.closest('[hidden]'))
        .map((el) => ({ c: [...el.classList].find((k) => k.startsWith('mf-ctl-')), r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width && r.left < card.right && r.right > card.left && r.top < card.bottom && r.bottom > card.top)
        .map(({ c }) => c);
    });
    for (const h of hits) problems.push(`${where}: the tips card covers ${h}`);
  };
  await clear('tips');
  await setText(1.5);
  await shot('m8-tips-text150');
  await onScreen('tips 150%', '.pm-tips .btn');
  await clear('tips 150%');
  await setText(1);
  await strip('tips-in', () =>
    store(() => {
      const s = window.__game.shell.store;
      s.setState({ tips: false });
      requestAnimationFrame(() => s.setState({ tips: true }));
    }),
    18,
  );
  // Reduce motion and Reduce flashes: the card fades in where it stands (no rise)
  await reduce(true);
  await page.evaluate(() => document.documentElement.classList.add('reduce-flashes'));
  await strip('tips-in-reduced', () =>
    store(() => {
      const s = window.__game.shell.store;
      s.setState({ tips: false });
      requestAnimationFrame(() => s.setState({ tips: true }));
    }),
    10,
  );
  await reduce(false);
  await page.evaluate(() => document.documentElement.classList.remove('reduce-flashes'));
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Got it")]')).click();
  await page.waitForFunction(() => !document.querySelector('[data-screen="m-tips"]'), { timeout: 5000 });
  await sleep(4000);
  const pause = await page.$eval('.mf-touch .mf-ctl-pause', (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const tapPause = async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pause.x, y: pause.y, id: 9, radiusX: 10, radiusY: 10, force: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await strip('pause-in', tapPause, 22);
  await page.waitForSelector('[data-screen="m-pause"]', { timeout: 10_000 });
  await shot('m4-pause', 600);
  await iconsResolve('pause');
  await targets('pause');
  await setText(1.5);
  await shot('m4-pause-text150');
  await onScreen('pause 150%', '.pm-pause .btn');
  await setText(1);
  await (await page.waitForSelector('xpath/.//nav[contains(@class,"pm-pause")]//button[contains(normalize-space(.), "Leave")]')).click();
  await shot('m4-pause-leave', 600);
  await (await page.waitForSelector('xpath/.//button[normalize-space(.)="Stay"]')).click();
  await sleep(400);
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Resume")]')).click();
  await sleep(600);

  // ---- the shell's own update held: a sample room ----
  await store(() => {
    window.__game.shell.update = () => {};
  });
  await store(new Function(`window.__game.shell.store.setState(${ROOM}); return 0;`));
  await page.waitForSelector('[data-screen="m-lobby"]', { timeout: 10_000 });
  await shot('m3-lobby', 900);
  await iconsResolve('lobby');
  await targets('lobby');
  await setText(1.5);
  await shot('m3-lobby-text150');
  await onScreen('lobby 150%', '.pm-bar .btn, .pm-rules');
  await setText(1.25);
  await sleep(500);
  await onScreen('lobby 125%', '.pm-bar .btn, .pm-rules');
  await setText(1);
  // a share: the system sheet (stubbed: headless Chrome has none) then the "Shared" stamp
  await page.evaluate(() => {
    navigator.share = () => new Promise((r) => setTimeout(r, 200));
  });
  await strip('lobby-share', () => page.$eval('.pm-share__btn', (b) => b.click()), 22);
  await sleep(1800);
  // a player joins: their row rises in, the counts roll
  await strip('lobby-join', () =>
    store(() => {
      const s = window.__game.shell.store;
      const l = s.getState().lobby;
      s.setState({ lobby: { ...l, players: [...l.players, { id: 4, name: 'Tunde', isBot: false, ready: true, host: false, you: false, pingMs: 44 }] } });
    }),
  );
  // the rules: a bottom sheet rising
  await strip('lobby-rules', () => page.$eval('.pm-rules', (b) => b.click()), 20);
  await shot('m3-lobby-rules', 300);
  await iconsResolve('rules');
  await page.$eval('.pm-scrim', (s) => s.click());
  await sleep(500);
  // warm-up: the lobby folds to a strip at the top, the touch controls show under it
  await page.$eval('.pm-warm', (b) => b.click());
  await page.waitForSelector('[data-screen="m-lobby"][data-active-state~="folded"]', { timeout: 5000 });
  await shot('m3-lobby-folded', 600);
  await page.$eval('.pm-strip [aria-label="Open the lobby"]', (b) => b.click());
  await sleep(500);

  // ---- m-results ----
  const ended = (votes, voted) => `window.__game.shell.store.setState({ match: { ...window.__game.shell.store.getState().match, phase: 3, votes: ${votes}, humans: 4, voted: ${voted}, myScore: 6, leaderScore: 10, leaderName: 'Kemi', results: ${RESULTS} } }); return 0;`;
  await strip('results-in', () => store(new Function(ended(1, false))), 26);
  await page.waitForSelector('[data-screen="m-results"]', { timeout: 10_000 });
  await shot('m5-results', 600);
  await iconsResolve('results');
  await targets('results');
  await strip('results-vote', () => store(new Function(ended(2, true))), 14);
  await setText(1.5);
  await shot('m5-results-text150');
  await setText(1);
  await reduce(true);
  await store(new Function(ended(3, true)));
  await shot('m5-results-reduced');
  await reduce(false);
} finally {
  await browser.close();
}
for (const p of problems) console.error(p);
if (problems.length) process.exit(1);
