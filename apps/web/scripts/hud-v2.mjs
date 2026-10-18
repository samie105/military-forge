/**
 * Round two's desktop HUD, shot in headless Chrome (throwaway profile, 1920×1080), for its PR:
 *
 *   states   the HUD in the states of the kit's reference shots (docs/design/v2-shots/08*, 09, 10*),
 *            one PNG each, plus the normal state at 1280×720 and 2560×1440 (the fit)
 *   strips   frame strips of the HUD's transitions (docs/design/ui-motion-spec.md §4.1 and §5): one PNG
 *            per 16 ms of animation time. Every running animation is paused at the trigger and
 *            stepped 16 ms at a time (Web Animations currentTime), with the HUD's own updates held,
 *            so each frame is exactly where the motion is at that time, however slow the machine.
 *            Also the same transitions under Reduce motion (nothing moves) and Reduce flashes.
 *
 * It plays training in the app and overrides the frame's values through the dev hook (as
 * hud-states.mjs does), so it needs the dev server with the API (for the name):
 *
 *   cd apps/web && DEV_API=http://127.0.0.1:8791 pnpm exec vite --port 5191 --strictPort
 *   node apps/web/scripts/hud-v2.mjs [http://127.0.0.1:5191] [out dir] [states|strips|all] [strip,names]
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5191').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'hud-v2-shots');
const what = process.argv[4] ?? 'all';
/** strips: only these (comma-separated names), when given */
const only = process.argv[5] ? new Set(process.argv[5].split(',')) : null;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** content's weapon indices and its crates (WEAPON_PICKUP_BASE + weapon index: packages/content/src/pickups.ts) */
const W = { hammer: 0, buzz: 1, k47: 2, widow: 4, machete: 5, hawk: 6, thumper: 14, dragon: 18, none: 63 };
const crate = (weapon) => 7 + weapon;
const FRAME_MS = 16;
/** DevTools: the animation clock's rate (slowed while a strip's trigger lands, so nothing ends before it is paused) */
let cdp = null;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'hud-v2-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  defaultViewport: { width: 1920, height: 1080 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));

/**
 * Values for the local player and the frame, applied after every update: `me` an object, or the
 * source of a function of the player (it runs in the page: no closures); `frame` the source of
 * (f, me) => values, or 'null'.
 */
const patch = (me, frame = 'null') => page.evaluate(`window.__hudPatch.me = ${typeof me === 'string' ? me : JSON.stringify(me)}; window.__hudPatch.frame = ${frame};`);
/** the source of a patch: both slots' guns (def, mag, reserve…) and other values */
const guns = (a, b, extra = {}) => `(me) => Object.assign(${JSON.stringify(extra)}, { weapons: [{ ...me.weapons[0], reloadTicks: 0, ...${JSON.stringify(a)} }, { ...me.weapons[1], reloadTicks: 0, ...${JSON.stringify(b)} }] })`;
const settings = (s) => page.evaluate((s) => window.__game.shell.controller.updateSettings(s), s);
const frames = (n = 1) => page.evaluate((n) => new Promise((done) => { const step = (k) => (k <= 0 ? done() : requestAnimationFrame(() => step(k - 1))); step(n); }), n);
/** sim events into the HUD, with `me` and the bots' ids filled in: (me, [a, b, c]) => events */
const events = (fn) =>
  page.evaluate(`(() => {
    const g = window.__game;
    const me = g.mode.localId;
    const bots = g.mode.game.players.filter((p) => p && p.id !== me).map((p) => p.id);
    while (bots.length < 3) bots.push(bots[0] ?? me);
    g.hud.onEvents((${fn})(me, bots), me);
  })()`);
const reset = async () => {
  await patch({});
  await page.evaluate(() => {
    window.__game.mode.tuning = window.__hudPatch.tuning;
    window.__game.hud.setScoreboardKeys(['Tab']);
  });
  await settings({ reduceMotion: false, reduceFlashes: false, blood: false, netGraph: false });
  await page.mouse.move(1300, 420);
  await sleep(900);
};

async function start() {
  await page.goto(`${base}/?app&time=600`, { waitUntil: 'load' });
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await sleep(1200);
  await page.click('button[type=submit]');
  await (await page.waitForSelector('xpath/.//button[contains(normalize-space(.), "Training")]', { timeout: 30_000 })).click();
  await page.waitForFunction(() => window.__game?.mode?.update, { timeout: 30_000 });
  await sleep(1500);
  const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
  if (got) await got.click();
  // past the countdown: the match is on
  await page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 60_000 });
  await sleep(500);
  await page.evaluate(() => {
    const mode = window.__game.mode;
    const update = mode.update.bind(mode);
    // keepAlive: the training bots may take us out mid-shoot; the HUD is shot alive unless a state says otherwise
    window.__hudPatch = { me: {}, frame: null, hold: false, last: null, tuning: mode.tuning, keepAlive: true };
    mode.update = (dt) => {
      // held: the world stands still while a strip is shot
      if (window.__hudPatch.hold && window.__hudPatch.last) return window.__hudPatch.last;
      const f = update(dt);
      const me = f.players.find((p) => p.id === f.localId);
      if (me && window.__hudPatch.keepAlive && !me.alive) Object.assign(me, { alive: true, respawnTicks: 0, hp: 100 });
      if (me) Object.assign(me, typeof window.__hudPatch.me === 'function' ? window.__hudPatch.me(me) : window.__hudPatch.me);
      if (window.__hudPatch.frame) Object.assign(f, window.__hudPatch.frame(f, me));
      window.__hudPatch.last = f;
      return f;
    };
    // the HUD's last input, so a change can be applied (and held) in the same turn as its trigger
    const hud = window.__game.hud;
    const live = hud.update.bind(hud);
    hud.__live = (input) => {
      window.__hudInput = input;
      live(input);
    };
    hud.update = hud.__live;
  });
  cdp = await page.createCDPSession();
  await cdp.send('Animation.enable');
  await page.mouse.move(1300, 420);
}

// ---------------------------------------------------------------- states (the kit's shots)

const FEED = (me, [a, b, c]) => [
  { type: 'death', victim: c, killer: a, source: 18 },
  { type: 'hit', attacker: b, target: a, damage: 90, zone: 1, source: 4 },
  { type: 'death', victim: a, killer: b, source: 4 },
  { type: 'death', victim: c, killer: me, source: 0 },
  { type: 'death', victim: b, killer: c, source: 14 },
  { type: 'death', victim: a, killer: a, source: 61 },
];
const EVENT = (kind, name, description, phase, secondsLeft) =>
  `() => ({ mapEvent: { id: 'ev', kind: '${kind}', name: '${name}', description: '${description}', phase: '${phase}', secondsLeft: ${secondsLeft}, progress: 0.45, color: 0, zones: [], occurrence: ${phase === 'warning' ? 1 : 2}, bulletRangeMul: 1 } })`;
const GRAVITY = (phase, s) => EVENT('lowGravity', 'Gravity pocket', 'Low gravity inside the zone · jumps and blasts go twice as far', phase, s);
const tune = (over) =>
  page.evaluate((over) => {
    const mode = window.__game.mode;
    const t = { ...window.__hudPatch.tuning.call(mode), ...over };
    mode.tuning = () => t;
  }, over);

async function states() {
  const dir = join(out, 'states');
  mkdirSync(dir, { recursive: true });
  /**
   * The HUD as it is now, held: its updates stop (short-lived cues such as a hit marker or the quick
   * throw's stamp stay up however slow the machine is) and the world stands still; entrances finish
   * playing before the shot.
   */
  const shot = async (name, settle = 700) => {
    await sleep(settle);
    await frames(2);
    await page.evaluate(() => {
      window.__hudPatch.hold = true;
      window.__game.hud.update = () => {};
    });
    await sleep(450);
    await page.screenshot({ path: join(dir, `${name}.png`) });
    await page.evaluate(() => {
      window.__game.hud.update = window.__game.hud.__live;
      window.__hudPatch.hold = false;
    });
    console.log(`wrote states/${name}.png`);
  };
  const normal = { hp: 82, fuel: 90, grenadeCounts: [3, 1, 2, 1, 0, 1], grenadeType: 0, active: 0 };
  const hammerBuzz = (extra = {}) => guns({ def: W.hammer, mag: 4, reserve: 30 }, { def: W.buzz, mag: 40, reserve: 250 }, { ...normal, ...extra });

  await reset();
  await settings({ netGraph: true });
  await patch(hammerBuzz());
  await events(FEED);
  await shot('08-hud');
  for (const [w, h] of [[1280, 720], [2560, 1440]]) {
    await page.setViewport({ width: w, height: h });
    await shot(`08-hud-${w}x${h}`, 1200);
  }
  await page.setViewport({ width: 1920, height: 1080 });

  // switching, aiming a throw, a headshot marker, standing on a crate
  await reset();
  const onCrate = `(f, me) => ({ pickups: [{ id: 9, def: ${crate(W.dragon)}, x: me.x, y: me.y }] })`;
  await patch(hammerBuzz({ active: 0 }), onCrate);
  await sleep(700);
  // short-lived cues go in with now(): applied and held in one turn
  await now({ me: hammerBuzz({ active: 1, swapTicks: 12 }), frame: onCrate, ev: `(me, [a]) => [{ type: 'hit', attacker: me, target: a, damage: 45, zone: 1, source: 0 }]`, input: '{ throwAim: 1 }' });
  await shot('08b-hud-switch-aim-headshot-crate', 0);

  // dual, the dash recharging, launched by a blast
  await reset();
  const dual = guns({ def: W.hawk, mag: 7, reserve: 42 }, { def: W.hawk, mag: 5, reserve: 42 }, { ...normal, dual: true, dashCooldown: 36, grounded: false, vx: 24, vy: 9 });
  await patch(dual);
  await sleep(700);
  await now({ me: dual, ev: `(me, [a]) => [{ type: 'hit', attacker: a, target: me, damage: 35, zone: 1, source: 14 }]` });
  await shot('08c-hud-dual-dashcd-launched', 0);

  // melee only, a throw aimed while the gravity pocket bends its arc
  await reset();
  await patch(guns({ def: W.machete, mag: 0, reserve: 0 }, { def: W.none, mag: 0, reserve: 0 }, normal), GRAVITY('active', 14));
  await sleep(900);
  await now({ input: '{ throwAim: 2 }' });
  await shot('08d-hud-melee-only-arcwarn', 0);

  // empty, a quick throw, a heavy hit
  await reset();
  await patch(guns({ def: W.hammer, mag: 0, reserve: 30 }, { def: W.buzz, mag: 40, reserve: 250 }, normal));
  await sleep(700);
  await now({ ev: `(me, [a]) => [{ type: 'hit', attacker: a, target: me, damage: 70, zone: 1, source: 4 }]`, input: '{ quickThrowAt: performance.now() }' });
  await shot('08e-hud-empty-quickthrow-heavy', 0);

  // the shield up, tuned by the host, a kill
  await reset();
  await tune({ gravity: 12, dashSpeed: 16.8 });
  await patch(hammerBuzz({ shield: 'front', shieldHp: 212 }));
  await sleep(700);
  await now({ ev: `(me, [a]) => [{ type: 'hit', attacker: me, target: a, damage: 90, zone: 2, source: 0 }, { type: 'death', victim: a, killer: me, source: 0 }]`, input: '{ tuning: window.__game.mode.tuning() }' });
  await shot('08f-hud-shield-tuned-kill', 0);

  // dead: the respawn card
  await reset();
  await page.evaluate(() => (window.__hudPatch.keepAlive = false));
  await patch({ alive: false, respawnTicks: 150 });
  await sleep(200);
  await events((me, [a]) => [{ type: 'hit', attacker: a, target: me, damage: 90, zone: 0, source: 4 }, { type: 'death', victim: me, killer: a, source: 4 }]);
  await shot('08g-hud-spectating', 200);

  // a flashbang with Reduce flashes
  await page.evaluate(() => (window.__hudPatch.keepAlive = true));
  await reset();
  await settings({ reduceFlashes: true });
  await patch(hammerBuzz({ blind: 0.95 }));
  await shot('08h-hud-flash-reduced');

  // blood on, low health, just hurt
  await reset();
  await settings({ blood: true });
  await patch(hammerBuzz({ hp: 22 }));
  await sleep(700);
  await now({ ev: `(me, [a]) => [{ type: 'hit', attacker: a, target: me, damage: 20, zone: 1, source: 2 }]`, input: '{ blood: true }' });
  await shot('08i-hud-blood-on', 0);

  // the scoreboard (hold Tab)
  await reset();
  await patch(hammerBuzz());
  await page.keyboard.down('Tab');
  await shot('09-scoreboard', 900);
  await page.keyboard.up('Tab');

  // the map event, running and incoming
  await reset();
  await patch(hammerBuzz(), GRAVITY('active', 18));
  await shot('10-map-event', 900);
  await patch(hammerBuzz(), GRAVITY('warning', 5));
  await shot('10b-map-event-warning', 900);
  await patch({});
}

// ---------------------------------------------------------------- strips (the transitions)

/**
 * Applies a change to the HUD and holds it, in one turn: the local player's values (`me`: an object,
 * or the source of a function of the player), the frame's (`frame`: the source of (f, me) => values),
 * sim events (`ev`: the source of (me, bots) => events) and HudInput fields (`input`: source of an
 * object). The HUD runs one update with them at once, then stops updating and the world holds: its
 * own clock (a marker's 180 ms) can't run out however slow the machine.
 */
const now = ({ me = '{}', frame = 'null', ev = null, input = '{}' } = {}) =>
  page.evaluate(`(() => {
    const g = window.__game;
    const last = window.__hudInput;
    const f = last.frame;
    const id = f.localId;
    const was = f.players.find((p) => p.id === id);
    const over = (${typeof me === 'string' ? me : JSON.stringify(me)});
    const mine = { ...was, ...(typeof over === 'function' ? over(was) : over) };
    const fo = (${frame});
    const frame = { ...f, players: f.players.map((p) => (p.id === id ? mine : p)) };
    if (fo) Object.assign(frame, fo(frame, mine));
    ${ev ? `const bots = g.mode.game.players.filter((p) => p && p.id !== id).map((p) => p.id); while (bots.length < 3) bots.push(bots[0] ?? id); g.hud.onEvents((${ev})(id, bots), id);` : ''}
    g.hud.__live({ ...last, ...(${input}), frame });
    g.hud.update = () => {};
    window.__hudPatch.hold = true;
  })()`);
/** Holds the HUD as it is (a trigger that isn't `now`'s). */
const hold = () =>
  page.evaluate(() => {
    window.__game.hud.update = () => {};
    window.__hudPatch.hold = true;
  });

/**
 * One transition: `before` sets the state up (and lets it settle), `trigger` changes it, with the
 * animation clock slowed 20× and the HUD's timers parked so nothing ends or is removed before it is
 * paused; then every animation the trigger started is paused and each frame stepped FRAME_MS on
 * (currentTime). What was already running (a pulse) goes on from where it was.
 */
async function strip(name, { clip, ms, before = async () => {}, trigger }) {
  if (only && !only.has(name)) return;
  const dir = join(out, 'strips', name);
  mkdirSync(dir, { recursive: true });
  await before();
  await sleep(700);
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 0.05 });
  await page.evaluate(() => {
    window.__trigAt = document.timeline.currentTime;
    // the HUD's timeouts (an arc's removal, a feed row's exit) wait until the strip is shot
    const real = window.setTimeout;
    window.__realTimeout = real;
    window.setTimeout = (fn, ms2, ...rest) => real(fn, (ms2 ?? 0) + 1e7, ...rest);
  });
  await trigger();
  await frames(1);
  const count = await page.evaluate(() => {
    window.__game.hud.update = () => {};
    window.__hudPatch.hold = true;
    const anims = document.getAnimations().filter((a) => a.playState !== 'finished');
    window.__strip = anims.map((a) => {
      const fresh = a.startTime === null || a.startTime >= window.__trigAt - 1;
      const t0 = fresh ? 0 : Number(a.currentTime) || 0;
      a.pause();
      return { a, t0 };
    });
    return anims.length;
  });
  const n = Math.floor(ms / FRAME_MS) + 1;
  for (let k = 0; k < n; k++) {
    await page.evaluate((t) => {
      for (const { a, t0 } of window.__strip) a.currentTime = t0 + t;
      return new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    }, k * FRAME_MS);
    await page.screenshot({ path: join(dir, `${String(k * FRAME_MS).padStart(4, '0')}ms.png`), clip });
  }
  await page.evaluate(() => {
    for (const { a } of window.__strip) {
      try {
        a.finish();
      } catch {
        a.play();
      }
    }
    window.__strip = [];
    window.setTimeout = window.__realTimeout;
    // what the parked timeouts would have removed
    for (const e of document.querySelectorAll('.mf-hud-desktop .dmg__arc, .mf-hud-desktop .killfeed .kf')) e.remove();
    window.__game.hud.update = window.__game.hud.__live;
    window.__hudPatch.hold = false;
  });
  await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
  console.log(`strip ${name}: ${n} frames, ${count} animations`);
}

const R = {
  feed: { x: 1180, y: 20, width: 720, height: 300 },
  reticle: { x: 1130, y: 260, width: 360, height: 300 },
  arcs: { x: 560, y: 140, width: 800, height: 800 },
  vitals: { x: 20, y: 840, width: 660, height: 220 },
  slots: { x: 1180, y: 860, width: 720, height: 200 },
  belt: { x: 1460, y: 720, width: 440, height: 160 },
  dash: { x: 470, y: 840, width: 200, height: 220 },
  pickup: { x: 600, y: 760, width: 720, height: 300 },
  banner: { x: 480, y: 100, width: 960, height: 300 },
  board: { x: 340, y: 160, width: 1240, height: 760 },
  tuned: { x: 20, y: 20, width: 600, height: 140 },
};

async function strips() {
  const all = async (suffix = '') => {
    await reset();
    if (suffix === '-reduce-motion') await settings({ reduceMotion: true });
    if (suffix === '-reduce-flashes') await settings({ reduceFlashes: true });
    const s = (name) => `${name}${suffix}`;

    const hammerBuzz = (extra = {}) => guns({ def: W.hammer, mag: 4, reserve: 30 }, { def: W.buzz, mag: 40, reserve: 250 }, extra);
    const isOn = (token) => `document.getElementById('hud').dataset.activeState.split(' ').includes('${token}')`;
    await strip(s('killfeed-row'), { clip: R.feed, ms: 240, trigger: () => now({ ev: `(me, [a, b]) => [{ type: 'hit', attacker: a, target: b, damage: 50, zone: 0, source: 4 }, { type: 'death', victim: b, killer: a, source: 4 }]` }) });
    await strip(s('killfeed-leave'), {
      clip: R.feed,
      ms: 192,
      before: () => events((me, [a, b]) => [{ type: 'death', victim: b, killer: a, source: 2 }]),
      trigger: async () => {
        await hold();
        await page.evaluate(() => document.querySelector('.mf-hud-desktop .killfeed .kf')?.classList.add('is-leaving'));
      },
    });
    if (suffix === '-reduce-flashes') {
      await strip(s('quick-throw'), { clip: R.reticle, ms: 160, trigger: () => now({ input: '{ quickThrowAt: performance.now() }' }) });
      await strip(s('low-hp'), { clip: { x: 0, y: 0, width: 1920, height: 1080 }, ms: 704, before: () => patch({ hp: 60 }), trigger: () => now({ me: { hp: 24 } }) });
      return;
    }
    await strip(s('map-event-in'), { clip: R.banner, ms: 272, before: () => patch({}), trigger: () => now({ frame: GRAVITY('warning', 5) }) });
    await strip(s('map-event-start'), { clip: R.banner, ms: 192, before: () => patch({}, GRAVITY('warning', 1)), trigger: () => now({ frame: GRAVITY('active', 18) }) });
    await strip(s('map-event-leave'), { clip: R.banner, ms: 192, before: () => patch({}, GRAVITY('active', 1)), trigger: async () => { await patch({}); await page.waitForFunction(isOn('event-leaving'), { polling: 'raf', timeout: 5000 }); await hold(); } });
    await strip(s('weapon-switch'), { clip: R.slots, ms: 368, before: () => patch(hammerBuzz({ active: 0 })), trigger: () => now({ me: hammerBuzz({ active: 1, swapTicks: 21 }) }) });
    if (suffix) return;
    await strip('hit-marker', { clip: R.reticle, ms: 192, trigger: () => now({ ev: `(me, [a]) => [{ type: 'hit', attacker: me, target: a, damage: 30, zone: 2, source: 0 }]` }) });
    await strip('headshot-kill-marker', { clip: R.reticle, ms: 192, trigger: () => now({ ev: `(me, [a]) => [{ type: 'hit', attacker: me, target: a, damage: 90, zone: 1, source: 0 }, { type: 'death', victim: a, killer: me, source: 0 }]` }) });
    await strip('damage-arc', { clip: R.arcs, ms: 1312, trigger: () => now({ ev: `(me, [a]) => [{ type: 'hit', attacker: a, target: me, damage: 30, zone: 1, source: 2 }]` }) });
    await strip('hp-hit-ghost', { clip: R.vitals, ms: 208, before: () => patch({ hp: 90 }), trigger: () => now({ me: { hp: 55 }, ev: `(me, [a]) => [{ type: 'hit', attacker: a, target: me, damage: 35, zone: 1, source: 2 }]` }) });
    await strip('low-hp-edge', { clip: R.vitals, ms: 704, before: () => patch({ hp: 60 }), trigger: () => now({ me: { hp: 24 } }) });
    await strip('ammo-roll', { clip: R.slots, ms: 128, before: () => patch(guns({ def: W.k47, mag: 30, reserve: 90 }, { def: W.hammer, mag: 6, reserve: 30 }, { active: 0 })), trigger: () => now({ me: guns({ def: W.k47, mag: 29, reserve: 90 }, { def: W.hammer, mag: 6, reserve: 30 }, { active: 0 }) }) });
    await strip('ammo-empty', { clip: R.slots, ms: 192, before: () => patch(hammerBuzz({ active: 0 })), trigger: () => now({ me: guns({ def: W.hammer, mag: 0, reserve: 30 }, { def: W.buzz, mag: 40, reserve: 250 }, { active: 0 }) }) });
    await strip('belt-cycle', { clip: R.belt, ms: 304, before: () => patch({ grenadeCounts: [3, 2, 1, 1, 2, 1], grenadeType: 0 }), trigger: () => now({ me: { grenadeCounts: [3, 2, 1, 1, 2, 1], grenadeType: 1 } }) });
    await strip('throw-meter', { clip: R.reticle, ms: 192, trigger: () => now({ input: '{ throwAim: 4 }' }) });
    await strip('quick-throw', { clip: R.reticle, ms: 160, trigger: () => now({ input: '{ quickThrowAt: performance.now() }' }) });
    await strip('dash-ready', { clip: R.dash, ms: 192, before: () => patch({ dashCooldown: 2 }), trigger: () => now({ me: { dashCooldown: 0 } }) });
    await strip('pickup-in', { clip: R.pickup, ms: 272, before: () => patch(hammerBuzz({ active: 0 })), trigger: () => now({ me: hammerBuzz({ active: 0 }), frame: `(f, me) => ({ pickups: [{ id: 9, def: ${crate(W.dragon)}, x: me.x, y: me.y }] })` }) });
    await strip('pickup-leave', {
      clip: R.pickup,
      ms: 192,
      before: () => patch(hammerBuzz({ active: 0 }), `(f, me) => ({ pickups: [{ id: 9, def: ${crate(W.dragon)}, x: me.x, y: me.y }] })`),
      trigger: async () => {
        await patch(hammerBuzz({ active: 0 }), '() => ({ pickups: [] })');
        await page.waitForFunction(isOn('pickup-crate-leaving'), { polling: 'raf', timeout: 5000 });
        await hold();
      },
    });
    await strip('tuned-by-host', { clip: R.tuned, ms: 192, before: () => patch({}), trigger: async () => { await tune({ gravity: 12, dashSpeed: 16.8 }); await now({ input: '{ tuning: window.__game.mode.tuning() }' }); } });
    await strip('scoreboard-open', { clip: R.board, ms: 400, trigger: async () => { await page.keyboard.down('Tab'); await now(); } });
    await page.keyboard.up('Tab');
    await reset();
  };
  await all();
  await all('-reduce-motion');
  await all('-reduce-flashes');
}

try {
  await start();
  if (what === 'states' || what === 'all') await states();
  if (what === 'strips' || what === 'all') await strips();
} finally {
  await browser.close();
}
