/**
 * Touch controls v3 (docs/design/touch-controls-v3.md) in headless Chrome as a phone, held sideways
 * (812×375) and then upright (375×812: the page turned, ui/landscape.ts), with touch and a coarse pointer.
 * It plays Training with real input (CDP touches) and checks what the gestures do in the sim:
 *   - the "Learn the controls" drill starts by itself the first time, and its goals tick off;
 *   - grenade: a swipe ↑ selects the next type, ↓ the previous (the fan shows the belt), a hold-drag-lift throws;
 *   - gun pill: a tap swaps; a hold opens the radial, sliding to melee and lifting strikes;
 *   - dash: a swipe dashes; two quick ones chain;
 *   - shield: a hold raises it, lifting slings it;
 *   - camera: two fingers on one side pinch; a two-finger double tap recentres;
 *   - a first-time gesture hint shows as a tip (the onboarding's hint engine), ringing its control;
 *   - the Frost glass and its solid fallback;
 *   - Settings → Touch with the new rows, at 150 % text.
 * Shots go to `out`; exits 1 on a failed check, a page error, a console error or a missing #icon-*.
 *
 *   cd apps/web && pnpm exec vite --port 5220 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/phone-gestures-shots.mjs http://localhost:5220 docs/screenshots/phone-ui/v3
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://localhost:5220').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/phone-ui/v3');
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const CONTENT = fileURLToPath(new URL('../../../packages/content/src/index.ts', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(join(out, 'frames'), { recursive: true });

const problems = [];
const check = (ok, what) => {
  if (ok) console.log(`ok: ${what}`);
  else problems.push(what);
};
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'phone-v3-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});
const page = await browser.newPage();
page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|\/api\//.test(m.text())) problems.push(`console error: ${m.text()}`);
});
const cdp = await page.createCDPSession();
const phone = async (portrait) => {
  await page.emulate({
    viewport: portrait ? { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: false } : { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
    userAgent: UA,
  });
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [
      { name: 'pointer', value: 'coarse' },
      { name: 'any-pointer', value: 'coarse' },
      { name: 'hover', value: 'none' },
    ],
  });
};
await phone(false);
await cdp.send('Animation.enable');

const shot = async (name, settle = 400) => {
  await sleep(settle);
  await page.screenshot({ path: join(out, `${name}.png`) });
  console.log(`wrote ${name}.png`);
};
/** A frame strip (animations at a tenth of their speed, a shot every 160 ms = 16 ms of animation; phone-strips.py stitches them). */
async function strip(name, start, count = 16) {
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.1 });
  await start();
  for (let i = 0; i < count; i++) {
    const t = Date.now();
    await page.screenshot({ path: join(out, 'frames', `${name}-${String(i).padStart(2, '0')}.png`) });
    await sleep(Math.max(0, 160 - (Date.now() - t)));
  }
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
}
const centre = (sel) =>
  page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ id: p.id ?? i, x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1 })) });
const rotated = () => page.evaluate(() => document.documentElement.classList.contains('mf-rotated'));
/** A page movement (dx, dy) as the screen sees it. */
const onGlass = async (dx, dy) => ((await rotated()) ? { x: -dy, y: dx } : { x: dx, y: dy });
/** A finger from `from` (screen) moving (dx, dy) in the page's axes over `ms`; held at the end unless `lift`. */
async function swipe(from, dx, dy, { ms = 90, steps = 5, id = 1, lift = true, holdFirst = 0 } = {}) {
  const s = await onGlass(dx, dy);
  if (!holdFirst) {
    // a quick swipe: its events sent together, so a busy headless renderer can't stretch it into a hold
    const evs = [touch('touchStart', [{ id, ...from }])];
    for (let i = 1; i <= steps; i++) evs.push(touch('touchMove', [{ id, x: from.x + (s.x * i) / steps, y: from.y + (s.y * i) / steps }]));
    if (lift) evs.push(touch('touchEnd', []));
    await Promise.all(evs);
    return;
  }
  await touch('touchStart', [{ id, ...from }]);
  if (holdFirst) await sleep(holdFirst);
  for (let i = 1; i <= steps; i++) {
    await touch('touchMove', [{ id, x: from.x + (s.x * i) / steps, y: from.y + (s.y * i) / steps }]);
    await sleep(ms / steps);
  }
  if (lift) await touch('touchEnd', []);
}
/** A tap: down and up sent together (a busy headless renderer would otherwise stretch it into a hold). */
const tap = async (sel) => {
  const c = await centre(sel);
  await Promise.all([touch('touchStart', [{ id: 9, ...c }]), touch('touchEnd', [])]);
};
const actions = () => page.evaluate(() => window.__touch.actions.splice(0));
const me = (fn) => page.evaluate(fn);
async function iconsResolve(where) {
  const missing = await page.evaluate(() =>
    [...document.querySelectorAll('use')]
      .map((u) => u.getAttribute('href') ?? '')
      .filter((h) => h.startsWith('#') && !document.getElementById(h.slice(1)))
      .filter((h, i, a) => a.indexOf(h) === i),
  );
  for (const h of missing) problems.push(`${where}: missing ${h || '(empty href)'}`);
}
const drillGoal = () => page.$eval('.mf-drill', (el) => (el.hidden ? '' : (el.querySelector('.mf-drill__goal')?.textContent ?? '').trim())).catch(() => '');

/** Every gesture, in the page's axes (works the same held sideways or upright). */
async function gestures(where) {
  await page.waitForFunction(() => window.__game.mode.me.alive, { timeout: 15_000 }).catch(() => {});
  await sleep(400);
  // the belt: frag ×3, smoke ×2, flashbang ×2 (the sim's own state, so the cycles are real)
  await me(() => {
    const p = window.__game.mode.me;
    p.grenadeCounts.fill(0);
    p.grenadeCounts[0] = 3;
    p.grenadeCounts[1] = 2;
    p.grenadeCounts[2] = 2;
    p.grenadeType = 0;
  });
  await sleep(300);
  await actions();
  const g = await centre('.mf-ctl-grenade');
  await swipe(g, 0, -50, { lift: false, id: 2 });
  await sleep(120);
  await shot(`${where}-grenade-fan`, 0);
  await touch('touchEnd', []);
  await sleep(300);
  let type = await me(() => window.__game.mode.me.grenadeType);
  check(type === 1, `${where}: a swipe ↑ on the grenade selects the next type (frag → smoke: ${type})`);
  await swipe(g, 0, 40, { id: 3 });
  await sleep(300);
  type = await me(() => window.__game.mode.me.grenadeType);
  check(type === 0, `${where}: a swipe ↓ selects the previous type (smoke → frag: ${type})`);
  await page.waitForFunction(() => window.__game.mode.me.alive, { timeout: 15_000 }).catch(() => {});
  const thrown0 = await me(() => window.__game.mode.me.grenadeCounts[0]);
  let a = await actions();
  await swipe(g, -50, -60, { holdFirst: 400, ms: 200, id: 4 });
  await sleep(150);
  const thrown1 = await me(() => window.__game.mode.me.grenadeCounts[0]);
  a = [...a, ...(await actions())];
  check(thrown1 === thrown0 - 1 && a.includes('aimed-throw'), `${where}: hold, drag and lift throws (frags ${thrown0} → ${thrown1}; ${a.join(' ')})`);
  check(a.filter((x) => x === 'cycle').length === 2, `${where}: the two swipes changed the type and threw nothing`);
  // (a frag landing close can down the soldier: wait for the respawn before the next checks)
  await page.waitForFunction(() => window.__game.mode.me.alive, { timeout: 15_000 }).catch(() => {});
  await sleep(600);

  // (the frag goes off in about two seconds; a soldier caught by it respawns first)
  await sleep(2600);
  await page.waitForFunction(() => window.__game.mode.me.alive && window.__game.mode.me.swapTicks === 0, { timeout: 15_000 }).catch(() => {});
  await sleep(500);

  // the gun pill: a tap swaps; a hold opens the radial, melee picked by a slide
  const active0 = await me(() => window.__game.mode.me.active);
  await tap('.mf-ctl-swap');
  await sleep(700);
  const active1 = await me(() => window.__game.mode.me.active);
  check(active1 !== active0, `${where}: a tap on the gun pill swaps (slot ${active0} → ${active1})`);
  const s = await centre('.mf-ctl-swap');
  await touch('touchStart', [{ id: 5, ...s }]);
  const open = await page.waitForSelector('.mf-radial:not([hidden]) .mf-radial__it', { timeout: 3000 }).catch(() => null);
  check(!!open, `${where}: a hold on the gun pill opens the radial`);
  const melee = await page.$$eval('.mf-radial__it', (els) => {
    const r = els[1].getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await touch('touchMove', [{ id: 5, x: (s.x + melee.x) / 2, y: (s.y + melee.y) / 2 }]);
  await touch('touchMove', [{ id: 5, ...melee }]);
  await sleep(150);
  await shot(`${where}-radial`, 0);
  await touch('touchEnd', []);
  await sleep(200);
  a = await actions();
  check(a.includes('radial'), `${where}: sliding to Melee and lifting picks it`);

  // dash: a swipe, then a quick second one chains
  const d = await centre('.mf-ctl-dash');
  // (sent together, so a busy headless renderer doesn't stretch the gap between them past a chain)
  const up = await onGlass(0, -40);
  const right = await onGlass(40, 0);
  await Promise.all([
    touch('touchStart', [{ id: 6, ...d }]),
    touch('touchMove', [{ id: 6, x: d.x + up.x, y: d.y + up.y }]),
    touch('touchEnd', []),
    touch('touchStart', [{ id: 7, ...d }]),
    touch('touchMove', [{ id: 7, x: d.x + right.x, y: d.y + right.y }]),
    touch('touchEnd', []),
  ]);
  await sleep(200);
  a = await actions();
  check(a.filter((x) => x === 'dash').length === 2 && a.includes('chain'), `${where}: two quick dash swipes dash twice and chain (${a.join(' ')})`);

  // the shield: given one, a hold raises it and lifting slings it
  const hasShield = await page.$('.mf-ctl-shield');
  if (hasShield) {
    // (bots shoot in training: a soldier downed mid-check loses the shield; one more try on a fresh one)
    let up = 0;
    let after = -1;
    let ring = false;
    let hp = '';
    for (let attempt = 0; attempt < 2 && !(up > 0 && after === 0 && ring); attempt++) {
      await page.waitForFunction(() => window.__game.mode.me.alive, { timeout: 15_000 }).catch(() => {});
      await me(() => {
        // a riot shield on the back and the pistol in hand (the shield needs a one-handed gun)
        const p = window.__game.mode.me;
        p.shieldHp = 300;
        p.shieldStowed = true;
        p.active = 0;
        p.dual = false;
      });
      await sleep(300);
      const sh = await centre('.mf-ctl-shield');
      await touch('touchStart', [{ id: 8, ...sh }]);
      await sleep(700);
      up = await me(() => window.__game.mode.me.shieldTicks);
      ring = await page.$eval('.mf-ctl-shield .mf-shield-hp svg', (el) => el.getBoundingClientRect().width > 0).catch(() => false);
      hp = await page.$eval('.mf-ctl-shield .tb__sub', (el) => el.textContent.trim()).catch(() => '');
      await touch('touchEnd', []);
      await sleep(700);
      after = await me(() => window.__game.mode.me.shieldTicks);
    }
    check(up > 0 && after === 0, `${where}: a hold raises the shield, lifting slings it (shieldTicks ${up} → ${after})`);
    check(ring && Number(hp) > 0 && Number(hp) <= 300, `${where}: the shield button carries its HP (a ring and "${hp}"; bots may have chipped it)`);
    await shot(`${where}-shield-hp`, 100);
  }

  // the camera: two fingers landing on the left side pinch; a two-finger double tap recentres
  await actions();
  const L = (await rotated()) ? [{ x: 250, y: 200 }, { x: 250, y: 260 }] : [{ x: 200, y: 180 }, { x: 260, y: 180 }];
  await touch('touchStart', [{ id: 10, ...L[0] }]);
  await sleep(60);
  await touch('touchStart', [{ id: 10, ...L[0] }, { id: 11, ...L[1] }]);
  for (let i = 1; i <= 6; i++) {
    const spread = (await rotated()) ? { x: L[1].x, y: L[1].y + 14 * i } : { x: L[1].x + 14 * i, y: L[1].y };
    await touch('touchMove', [{ id: 10, ...L[0] }, { id: 11, ...spread }]);
    await sleep(30);
  }
  await touch('touchEnd', []);
  await sleep(200);
  for (let k = 0; k < 2; k++) {
    await touch('touchStart', [{ id: 12, ...L[0] }]);
    await sleep(30);
    await touch('touchStart', [{ id: 12, ...L[0] }, { id: 13, ...L[1] }]);
    await sleep(60);
    await touch('touchEnd', []);
    await sleep(120);
  }
  a = await actions();
  check(a.includes('pinch') && a.includes('recentre'), `${where}: a pinch on one side zooms, a two-finger double tap recentres (${a.filter((x) => x === 'pinch' || x === 'recentre').join(' ')})`);
}

try {
  await page.goto(`${base}/?app&time=900`, { waitUntil: 'load' });
  await page.evaluate(() => {
    // the fire mode chosen (the first-run chooser, #204, would hold play), Pull as before
    localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ mode: 'on', fire: 'pull', fireChosen: true }));
    localStorage.removeItem('mf.touch.layout.v1');
    localStorage.removeItem('mf.touch.drill.v1');
    localStorage.removeItem('mf.touch.hints.v1');
    localStorage.removeItem('mf.hints.v1');
    // a returning player (the soldier made, the Briefing answered, First flight and Home's stops done):
    // the name goes straight to Home, as this check needs
    localStorage.setItem('mf-creator-seen', '1');
    const now = Date.now();
    localStorage.setItem('mf.facts.v1', JSON.stringify({ v: 1, firstSeen: now, lastSession: now, sessions: 2, experience: 'veteran', tours: { 'first-flight': { done: [], finished: true, skipped: false }, 'home-stops': { done: [], finished: true, skipped: false } } }));
  });
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  for (let i = 0; i < 10 && !(await page.$('[data-screen="m-home"]')); i++) {
    await sleep(1200);
    await page.$eval('button[type=submit]', (b) => b.click()).catch(() => {});
  }
  await page.waitForSelector('[data-screen="m-home"]', { timeout: 30_000 });

  // Settings → Touch: the new rows, and at 150 %
  await page.$eval('.pm-nav__i:last-child', (b) => b.click());
  await page.waitForSelector('[data-screen="m-settings"]', { timeout: 10_000 });
  await page.$$eval('.pm-rail__i', (b) => b[0].click());
  await shot('v3-settings-touch', 700);
  await page.$eval('.pm-set-panel', (p) => (p.scrollTop = 400));
  await shot('v3-settings-touch-more', 300);
  await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1.5'));
  await page.$eval('.pm-set-panel', (p) => (p.scrollTop = 0));
  await shot('v3-settings-touch-text150', 500);
  await page.evaluate(() => document.documentElement.style.setProperty('--text-scale', '1'));
  const rows = await page.$$eval('.pm-set__text b', (bs) => bs.map((b) => b.textContent));
  for (const r of ['Learn the controls', 'Button gestures', 'Fire', 'Button haptics', 'Pinch to zoom', 'Look-ahead', 'Camera shake']) check(rows.includes(r), `Settings → Touch has "${r}"`);
  // Learn the controls → Training
  await (await page.waitForSelector('xpath/.//button[normalize-space(.)="Start"]')).click();
  await page.waitForFunction(() => window.__game?.mode?.update && document.querySelector('.mf-touch:not([hidden])'), { timeout: 60_000 });

  // the drill: it starts in Training; the first goals tick off with real input
  await page.waitForSelector('.mf-drill:not([hidden])', { timeout: 20_000 });
  await sleep(5500); // past the countdown
  await shot('v3-drill-run', 300);
  await iconsResolve('drill');
  check((await drillGoal()) === 'Run', `the drill starts on "Run" (${await drillGoal()})`);
  const move = await centre('.mf-ctl-move');
  await swipe(move, 70, 0, { lift: false, id: 20, ms: 60 });
  await sleep(400);
  await touch('touchEnd', []);
  await shot('v3-drill-ticked', 100);
  check((await drillGoal()) === 'Fly', `running ticks "Run" off: next "Fly" (${await drillGoal()})`);
  await swipe(move, 0, -70, { lift: false, id: 21, ms: 60 });
  await sleep(400);
  await touch('touchEnd', []);
  await sleep(300);
  check((await drillGoal()) === 'Aim and fire', `flying ticks "Fly" off (${await drillGoal()})`);
  const aim = await centre('.mf-ctl-aim');
  await swipe(aim, 60, -20, { lift: false, id: 22, ms: 60 });
  await sleep(400);
  await touch('touchEnd', []);
  await sleep(300);
  check((await drillGoal()) === 'Dash', `firing ticks "Aim and fire" off (${await drillGoal()})`);
  await shot('v3-drill-dash', 300);
  // the rest of the drill, skipped to the end, then closed
  for (let i = 0; i < 14 && (await page.$('.mf-drill [data-drill="skip"]')); i++) {
    await page.$eval('.mf-drill [data-drill="skip"]', (b) => b.click());
    await sleep(80);
  }
  await shot('v3-drill-done', 300);
  check(/All done/.test(await drillGoal()), 'skipping to the end: "All done", and how to replay it');
  await page.$eval('.mf-drill [data-drill="close"]', (b) => b.click());
  await sleep(300);

  // a first-time gesture hint, a few seconds into play (the onboarding's hint engine shows it, one tip at
  // a time with the rest: tour/hints.ts): "Dash. Swipe the button to dash any way", ringing the dash button
  // the drill just used every gesture, and a gesture the player uses is never taught: Settings' "Show
  // hints again", as a player would
  await page.evaluate(() => window.__touch.resetTouchHints());
  await page.waitForFunction(() => /Tip/i.test(document.querySelector('.mf-spot__eyebrow')?.textContent ?? '') && !!document.querySelector('.mf-spot__ring'), { timeout: 20_000 }).catch(() => null);
  await shot('l-hint', 200);
  const tip = await page.evaluate(() => ({ title: document.querySelector('.mf-spot__title')?.textContent ?? '', body: document.querySelector('.mf-spot__body')?.textContent ?? '', rings: document.querySelectorAll('.mf-spot__ring').length }));
  check(/Dash/.test(tip.title) && /Swipe/.test(tip.body) && tip.rings > 0, `a first-time gesture hint shows as a tip, ringing its control (${tip.title} ${tip.body}; ${tip.rings} ring)`);

  // a strip: the belt fanning out under a swipe
  await me(() => {
    const p = window.__game.mode.me;
    p.grenadeCounts[1] = 2;
    p.grenadeCounts[2] = 2;
  });
  await sleep(300);
  const gc = await centre('.mf-ctl-grenade');
  await strip('fan-in', () => swipe(gc, 0, -50, { lift: false, id: 31 }), 14);
  await touch('touchEnd', []);
  await sleep(1200);

  // every gesture, held sideways
  await gestures('l');
  await shot('l-hud-glass', 600);

  // the phone HUD keeps the hit markers round the reticle
  const marks = await page.$$eval('#hud .mf-hud-phone .reticle .mk', (els) => els.map((e) => [...e.classList].find((c) => c.startsWith('mk--'))));
  check(['mk--hit', 'mk--head', 'mk--rico', 'mk--launch', 'mk--kill'].every((m) => marks.includes(m)), `the phone HUD has the hit markers (${marks.join(' ')})`);

  // the glass's solid fallback (a slow phone, Reduce transparency)
  await page.evaluate(() => document.documentElement.classList.add('mf-glass-off'));
  await shot('l-hud-solid', 300);
  const bf = await page.$eval('.mf-ctl-dash .dial-btn', (el) => getComputedStyle(el).backdropFilter);
  check(bf === 'none', `the solid fallback drops the blur (${bf})`);
  await page.evaluate(() => document.documentElement.classList.remove('mf-glass-off'));
  const bf2 = await page.$eval('.mf-ctl-dash .dial-btn', (el) => getComputedStyle(el).backdropFilter);
  check(/blur/.test(bf2), `the glass blurs what's behind it (${bf2})`);

  // upright: the page turns, every gesture reads the same
  await phone(true);
  await sleep(1500);
  check(await rotated(), 'upright: the page is turned');
  await gestures('r');
  await shot('r-hud-glass', 600);

  // a gun lying close by (not underfoot): the pickup line says to tap Take, and covers no control
  await page.evaluate(async (content) => {
    const c = await import(/* @vite-ignore */ `/@fs${content}`);
    const mode = window.__game.mode;
    const update = mode.update.bind(mode);
    mode.update = (dt) => {
      const f = update(dt);
      const me = f.players.find((p) => p.id === f.localId);
      const w = c.weapons.find((x) => x.id === 'hawk50') ?? c.weapons[3];
      if (me) f.pickups = [...(f.pickups ?? []), { id: 901, def: c.weaponPickup(w.index).index, x: me.x + 1.6, y: me.y }];
      return f;
    };
  }, CONTENT);
  await sleep(1200);
  for (const [where, portrait] of [['r', true], ['l', false]]) {
    await page.waitForFunction(() => window.__game.mode.me.alive, { timeout: 15_000 }).catch(() => {});
    await sleep(600);
    if (!portrait) {
      await phone(false);
      await sleep(1200);
    }
    const line = await page.$eval('#hud .pt-pickup', (el) => (el.offsetParent ? el.textContent.trim() : '')).catch(() => '');
    check(/tap Take/.test(line) && !/\bE\b/.test(line), `${where}: a gun close by: the pickup line says to tap Take, no key ("${line}")`);
    const hits = await page.evaluate(() => {
      const card = document.querySelector('#hud .pt-pickup')?.getBoundingClientRect();
      if (!card || !card.width) return ['(no card)'];
      return [...document.querySelectorAll('.mf-touch [class*="mf-ctl-"]')]
        .filter((el) => !el.classList.contains('mf-off') && el.offsetParent)
        .map((el) => ({ c: [...el.classList].find((k) => k.startsWith('mf-ctl-')), r: el.getBoundingClientRect() }))
        .filter(({ r }) => r.width && r.left < card.right && r.right > card.left && r.top < card.bottom && r.bottom > card.top)
        .map(({ c }) => c);
    });
    check(hits.length === 0, `${where}: the pickup line covers no control (${hits.join(' ') || 'none'})`);
    await shot(`${where}-pickup-line`, 200);
  }
  await iconsResolve('end');
} finally {
  await browser.close();
}
for (const p of problems) console.error(`FAIL: ${p}`);
if (problems.length) process.exit(1);
