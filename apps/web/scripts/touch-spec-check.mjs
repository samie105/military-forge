/* global process */
/**
 * The controls spec's phone checks for its items 1, 3, 5 and 6 (docs/design/controls-research.md §4.11:
 * sticks §4.3, gestures §4.6), in a phone-sized headless Chrome. Real CDP touches, timestamped where
 * timing matters (the controls time gestures by the events' own clocks); every sim tick's sampled
 * Input is read through a wrapper on the local game's sampler (dev builds).
 *
 *   cd apps/web && pnpm exec vite --port 5199 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/touch-spec-check.mjs http://localhost:5199
 *
 * Exits 1 if a check fails.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const [base = 'http://localhost:5199'] = process.argv.slice(2);
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const VIEW = { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true };
/** packages/sim Btn's bits (input.ts) */
const BTN = { Left: 1 << 0, Right: 1 << 1, Jet: 1 << 2, Down: 1 << 3, Fire: 1 << 4, Dash: 1 << 13 };

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'touch-spec-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
const cdp = await page.createCDPSession();
await page.emulate({ viewport: VIEW, userAgent: PHONE_UA });
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
// Classic has no dash button since the owner's essentials (23 Oct): these checks pin it, as a player can
// in the editor (only on a fresh layout, so an edited one survives a reload)
await page.evaluateOnNewDocument(() => {
  try {
    if (!localStorage.getItem('mf.touch.layout.v3')) localStorage.setItem('mf.touch.layout.v3', JSON.stringify({ placements: {}, pinned: ['dash'] }));
  } catch {
    /* no storage */
  }
});
await page.goto(`${base}/?sandbox&render=2d`);
await page.waitForFunction(() => window.__game?.mode?.me && document.querySelector('.mf-touch') && !document.querySelector('.mf-touch').hidden, { timeout: 300_000 });
await sleep(800);

// ---------- the first run: no fire chooser (the owner, 23 Oct); Auto, the right stick aims and fires ----------
{
  await sleep(2500);
  const st = await page.evaluate(() => ({ card: !!document.querySelector('.mf-choose:not([hidden])'), s: window.__touch.getTouchSettings(), fireBtn: !!document.querySelector('.mf-ctl-fire:not(.mf-off)') }));
  check('first run: no "How do you want to shoot?" card; Auto, and no FIRE button', !st.card && st.s.fire === 'auto' && !st.fireBtn, `card ${st.card}; fire ${st.s.fire}; FIRE button ${st.fireBtn}`);
  await page.evaluate(() => window.__touch.setTouchSettings({ fire: 'pull' }));
}

// every sim tick's sampled Input (touch included), newest last; and when each finger went down
await page.evaluate(() => {
  const s = window.__game.mode.sampler;
  const orig = s.sample.bind(s);
  window.__samples = [];
  s.sample = (...a) => {
    const out = orig(...a);
    window.__samples.push({ t: performance.now(), b: out.buttons, aim: out.aim });
    window.__sampleCount = (window.__sampleCount ?? 0) + 1;
    if (window.__samples.length > 4000) window.__samples.splice(0, 2000);
    return out;
  };
  window.__downs = [];
  window.__actAt = [];
  const acts = window.__touch.actions;
  const push = acts.push.bind(acts);
  acts.push = (...a) => {
    for (const x of a) window.__actAt.push([performance.now(), x]);
    return push(...a);
  };
  window.addEventListener('pointerdown', () => window.__downs.push(performance.now()), { capture: true });
});

/** Samples since `t` (page ms). */
const since = (t) => page.evaluate((t) => window.__samples.filter((s) => s.t >= t), t);
const now = () => page.evaluate(() => performance.now());
/** Waits for a fresh sim sample, so each step is seen. */
const tick = async () => {
  // a count that only grows (the sample list itself is trimmed now and then)
  const n = await page.evaluate(() => window.__sampleCount ?? 0);
  await page.waitForFunction((n) => (window.__sampleCount ?? 0) > n + 1, { timeout: 30_000, polling: 25 }, n).catch(async (e) => {
    const why = await page.evaluate(() => ({ samples: window.__samples.length, hidden: document.hidden, alive: window.__game?.mode?.me?.alive, screen: document.querySelector('[data-screen]')?.getAttribute('data-screen'), blocked: document.querySelector('.mf-touch')?.classList.contains('mf-touch-menus') }));
    console.error('no new sim samples:', JSON.stringify(why));
    throw e;
  });
};
const pt = (id, x, y) => ({ x, y, id, radiusX: 8, radiusY: 8, force: 1 });
const down = new Map();
const send = (type, ts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: [...down.values()], ...(ts !== undefined ? { timestamp: ts } : {}) });
const touch = async (id, x, y, ts) => {
  const fresh = !down.has(id);
  down.set(id, pt(id, x, y));
  await send(fresh ? 'touchStart' : 'touchMove', ts);
};
const lift = async (id, ts) => {
  down.delete(id);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [...down.values()], ...(ts !== undefined ? { timestamp: ts } : {}) });
};
const ctlCentre = (sel) =>
  page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
/** Is (x, y) empty play space (no control under it)? */
const empty = (x, y) =>
  page.evaluate((x, y) => {
    // what the controls start a stick on (controller.ts onDown): the page, a canvas, or the touch layer's own space
    const t = document.elementFromPoint(x, y);
    if (!t || t.closest('[data-mf-control], [data-mf-edit], button, a[href], [role="button"]')) return false;
    return t === document.documentElement || t === document.body || t instanceof HTMLCanvasElement || !!t.closest('.mf-touch');
  }, x, y);
/** The nearest empty point to (x, y), searching outward in 10 px steps. */
const emptyNear = async (x, y) => {
  for (let r = 0; r <= 120; r += 10) for (const [dx, dy] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) if (await empty(x + dx, y + dy)) return { x: x + dx, y: y + dy };
  return { x, y };
};
const settle = async () => {
  await sleep(400);
  await tick();
};

try {
  // ---------- §4.3 origin: a thumb near an edge starts at rest ----------
  {
    const spots = [
      [60, 300],
      [128, 340],
      [755, 300],
      [790, 300],
      [700, 345],
    ];
    for (const [x, y] of spots) {
      await settle();
      const aim0 = (await since(0)).at(-1).aim;
      const t0 = await now();
      await touch(1, x, y);
      await sleep(250);
      const got = await since(t0);
      await lift(1);
      const bad = got.reduce((b, s) => b | (s.b & (BTN.Left | BTN.Down | BTN.Fire)), 0);
      const swung = got.some((s) => s.aim !== aim0);
      check(`origin: a thumb landing at (${x}, ${y}) and holding 250 ms does nothing`, bad === 0 && !swung, `bits ${bad}${swung ? ', the aim swung' : ''}`);
    }
  }

  // ---------- §4.3 thresholds: 1 px sweeps from rest ----------
  const sweep = async (id, x, y, dx, dy, bit, max = 60) => {
    await settle();
    await touch(id, x, y);
    await tick();
    let at = -1;
    for (let i = 1; i <= max; i++) {
      await touch(id, x + dx * i, y + dy * i);
      await tick();
      const last = (await since(0)).at(-1);
      if (last.b & bit) {
        at = i;
        break;
      }
    }
    await lift(id);
    return at;
  };
  const L = { x: 200, y: 250 };
  const R = { x: 620, y: 240 };
  const run = await sweep(1, L.x, L.y, 1, 0, BTN.Right);
  check('run starts at 16 ± 1 px', Math.abs(run - 16) <= 1, `${run} px`);
  const jet = await sweep(1, L.x, L.y, 0, -1, BTN.Jet);
  check('jet starts at 30 ± 1 px straight up', Math.abs(jet - 30) <= 1, `${jet} px`);
  const crouch = await sweep(1, L.x, L.y - 40, 0, 1, BTN.Down);
  check('crouch starts at 38 ± 1 px straight down', Math.abs(crouch - 38) <= 1, `${crouch} px`);
  const pull = await sweep(2, R.x, R.y, 1, 0, BTN.Fire);
  check('Pull (hold) fires at 27 ± 1 px', Math.abs(pull - 27) <= 1, `${pull} px`);

  // ---------- §4.3 jet cone ----------
  {
    const push = async (deg) => {
      await settle();
      const r = 60;
      await touch(1, L.x, L.y);
      await touch(1, L.x + Math.cos((deg * Math.PI) / 180) * r, L.y - Math.sin((deg * Math.PI) / 180) * r);
      await tick();
      await tick();
      const b = (await since(0)).at(-1).b;
      await lift(1);
      return b;
    };
    const j25 = (await push(25)) & BTN.Jet;
    const j40 = (await push(40)) & BTN.Jet;
    const j50 = (await push(50)) & BTN.Jet;
    check('jet cone: no jet at 25° or 40°, jet at 50°', !j25 && !j40 && !!j50, `25° ${!!j25}, 40° ${!!j40}, 50° ${!!j50}`);
    await settle();
    await touch(1, L.x, L.y);
    let lowest = 90;
    for (let deg = 80; deg >= 10; deg -= 2) {
      await touch(1, L.x + Math.cos((deg * Math.PI) / 180) * 60, L.y - Math.sin((deg * Math.PI) / 180) * 60);
      await tick();
      if ((await since(0)).at(-1).b & BTN.Jet) lowest = deg;
      else break;
    }
    await lift(1);
    check('once jetting, it keeps jetting down to 16°', lowest <= 16 && lowest >= 14, `kept down to ${lowest}°`);
  }

  // ---------- §4.3 follow ----------
  {
    await settle();
    await touch(1, L.x, L.y);
    for (let i = 1; i <= 12; i++) {
      await touch(1, L.x + i * 10, L.y);
      await tick();
    }
    let back = -1;
    for (let i = 1; i <= 140; i++) {
      await touch(1, L.x + 120 - i, L.y);
      await tick();
      if ((await since(0)).at(-1).b & BTN.Left) {
        back = i;
        break;
      }
    }
    await lift(1);
    const radius = await page.$eval('.mf-ctl-move', (el) => el.getBoundingClientRect().width / 2);
    check('follow: after a 120 px push, Left comes within 1.2 radii + 16 px of reversing', back > 0 && back <= Math.ceil(1.2 * radius + 17), `${back} px back (radius ${radius.toFixed(0)} px; without follow: ${120 + 16} px)`);
  }

  // ---------- §4.6 flicks ----------
  const stroke = async (holdMs, moving) => {
    await settle();
    const t0 = Date.now() / 1000 - 2;
    const s0 = await now();
    const p = (x) => [pt(9, x, L.y)];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: p(L.x), timestamp: t0 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(L.x + 30), timestamp: t0 + 0.02 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(L.x + 62), timestamp: t0 + 0.04 });
    if (moving) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(L.x + 80), timestamp: t0 + (holdMs - 20) / 1000 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(L.x + 100), timestamp: t0 + (holdMs - 4) / 1000 });
    } else await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(L.x + 62), timestamp: t0 + (holdMs - 10) / 1000 });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: t0 + holdMs / 1000 });
    await tick();
    await tick();
    const actions = await page.evaluate(() => window.__touch.actions.splice(0));
    return { dashed: actions.includes('dash'), chain: actions.includes('chain'), s0 };
  };
  await page.evaluate(() => window.__touch.actions.splice(0));
  const n100 = await stroke(100, false);
  const n150 = await stroke(150, false);
  const n200 = await stroke(200, false);
  check('nudges: a full push held still and lifted after 100, 150, 200 ms is not a dash', !n100.dashed && !n150.dashed && !n200.dashed, `${n100.dashed}, ${n150.dashed}, ${n200.dashed}`);
  const f120 = await stroke(120, true);
  check('a 120 ms flick still moving at the lift dashes', f120.dashed);
  {
    // two flicks 100 ms apart chain (the sim's chain window)
    await settle();
    await page.evaluate(() => window.__touch.actions.splice(0));
    const flick = async (t0) => {
      const p = (x) => [pt(9, x, L.y)];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: p(L.x), timestamp: t0 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(L.x + 40), timestamp: t0 + 0.04 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(L.x + 90), timestamp: t0 + 0.08 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(L.x + 110), timestamp: t0 + 0.11 });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: t0 + 0.12 });
    };
    // the second flick starts 100 ms after the first lifts, on the events' clocks and the page's
    await flick(Date.now() / 1000 - 2);
    await sleep(100);
    await flick(Date.now() / 1000 - 2);
    await tick();
    await tick();
    await sleep(200);
    const actions = await page.evaluate(() => window.__touch.actions.splice(0));
    // the chain itself is the sim's (dashChainWindow 0.35 s, unchanged): a busy headless page takes
    // ~70 ms per CDP touch event, so two strokes can't land inside it here (a device check)
    check('two flicks in a row: both dash', actions.filter((a) => a === 'dash').length === 2, `${actions.filter((a) => a === 'dash').length} dashes${actions.includes('chain') ? ', chained' : ''}`);
  }

  // ---------- §4.6 the dash button, stick idle: decided within 90 ms ----------
  {
    await settle();
    const d = await ctlCentre('.mf-ctl-dash');
    const t0 = await now();
    await touch(4, d.x, d.y);
    await sleep(260); // held well past 90 ms, not lifted
    const got = await since(t0);
    const pressAt = await page.evaluate(() => window.__downs.at(-1));
    const decided = await page.evaluate((t) => window.__actAt.find(([at, a]) => at >= t && a === 'dash')?.[0] ?? -1, t0);
    await lift(4);
    const first = got.find((s) => s.b & BTN.Dash);
    // decided by a 90 ms timer (a busy headless page runs timers a little late), sent with the next
    // sim sample (one frame: slow here, software GL)
    check('the dash button with the stick idle dashes 90 ms after pointerdown, before the lift', decided > 0 && decided - pressAt <= 90 + 30 && !!first, `decided at ${(decided - pressAt).toFixed(0)} ms, in the Input at ${first ? (first.t - pressAt).toFixed(0) : '–'} ms`);
  }

  // ---------- §4.6 a second finger never cancels a thumb ----------
  {
    await settle();
    await touch(2, R.x, R.y);
    for (let i = 1; i <= 6; i++) {
      await touch(2, R.x + i * 10, R.y);
      await tick();
    }
    await sleep(50);
    const t1 = await now();
    const spot = await emptyNear(R.x - 90, R.y + 60); // empty right-side space, 20 mm and more away
    await touch(5, spot.x, spot.y);
    await sleep(300);
    const got = await since(t1);
    await lift(5);
    await lift(2);
    const fired = got.length > 0 && got.every((s) => s.b & BTN.Fire);
    const camera = (await page.evaluate(() => window.__touch.actions.splice(0))).includes('pinch');
    check('a second finger on empty aim-side space: fire continues, no camera', fired && !camera, `${got.filter((s) => s.b & BTN.Fire).length}/${got.length} samples firing`);
  }

  // ---------- §4.6 aim and fire resume after a button (the hop test) ----------
  {
    await settle();
    await touch(2, R.x, R.y);
    for (let i = 1; i <= 6; i++) {
      await touch(2, R.x + i * 10, R.y);
      await tick();
    }
    const aimBefore = (await since(0)).at(-1).aim;
    // where things are, found before the hop (the hop itself is quick: well inside 0.7 s)
    // a button on the HUD (reload only shows in the context slot now: the dash is always there)
    const rl = await ctlCentre('.mf-ctl-dash');
    const back = await emptyNear(R.x - 30, R.y + 20); // lands somewhere else in the aim zone, doesn't move
    await lift(2);
    await touch(6, rl.x, rl.y);
    await sleep(60);
    await lift(6);
    await sleep(80);
    const memo = await page.evaluate(() => window.__touch.sticks()?.resume);
    const t2 = await now();
    await touch(2, back.x, back.y);
    await tick();
    await tick();
    const st = await page.evaluate(() => window.__touch.sticks());
    // the samples from the moment the thumb landed (CDP delivers a touch a little after it's sent)
    const landed = await page.evaluate(() => window.__downs.at(-1));
    const got = await since(Math.max(t2, landed));
    await lift(2);
    const firstTwo = got.slice(0, 2);
    check('hop test: after a button, re-landing fires again on the first tick, with the same aim', firstTwo.length > 0 && firstTwo.every((s) => s.b & BTN.Fire) && firstTwo[0].aim === aimBefore, `${firstTwo.map((s) => (s.b & BTN.Fire ? 'fire' : '-')).join(' ')}; aim ${aimBefore} → ${firstTwo[0]?.aim}; after the button ${JSON.stringify(memo)}; on landing ${JSON.stringify({ aimActive: st?.aimActive, aimFire: st?.aimFire, mag: st?.aim.mag?.toFixed(2) })} at (${back.x}, ${back.y})`);
  }
  // ---------- item 3 · fire modes (§4.4, §4.11) ----------
  const mag = () => page.evaluate(() => { const p = window.__game.mode.me; return p.weapons[p.active].mag; });
  const setFire = async (fire) => {
    await page.evaluate((fire) => window.__touch.setTouchSettings({ fire }), fire);
    await sleep(200);
  };
  // the nearest dummy: its direction from the player's shoulder (the world's: y up), as a screen drag
  const toDummy = () =>
    page.evaluate(() => {
      const m = window.__game.mode;
      const me = m.me;
      let best = null;
      for (const p of m.game.players) {
        if (!p || p.id === me.id || !p.alive) continue;
        const d = Math.hypot(p.x - me.x, p.y + 0.9 - (me.y + 1.3));
        if (!best || d < best.d) best = { d, a: Math.atan2(p.y + 0.9 - (me.y + 1.3), p.x - me.x) };
      }
      return best;
    });
  {
    // Auto: aim near a dummy in range: fire after the dwell; aim 10° off: stops within the linger
    await setFire('auto');
    // the range dummies stand far from the spawn: stand 8 m from the nearest one (the local sim, dev)
    await page.evaluate(() => {
      const m = window.__game.mode;
      const me = m.me;
      let best = null;
      for (const p of m.game.players) if (p && p.id !== me.id && p.alive && (!best || Math.abs(p.x - me.x) < Math.abs(best.x - me.x))) best = p;
      if (best) {
        me.x = best.x - 8;
        me.y = best.y;
        me.vx = 0;
        me.vy = 0;
      }
    });
    await sleep(800);
    await settle();
    // the exact direction: from the shoulder the sim aims from, to the point Auto tests (the dev hook)
    const st0 = await page.evaluate(() => window.__touch.sticks());
    const tg = st0?.targets?.[0];
    const dm = tg ? { d: Math.hypot(tg.x - st0.shoulder.x, tg.y - st0.shoulder.y), a: Math.atan2(tg.y - st0.shoulder.y, tg.x - st0.shoulder.x) } : await toDummy();
    if (dm) {
      const push = 40; // well short of the rim (0.90 ≈ 60 px): only Auto's own trigger fires
      const aimAt = async (a) => touch(2, R.x + Math.cos(a) * push, R.y - Math.sin(a) * push);
      await touch(2, R.x, R.y);
      // first well away from it (the trigger off), then onto it
      await aimAt(dm.a + Math.PI / 2);
      await sleep(400);
      const t0 = await now();
      await aimAt(dm.a);
      await sleep(600);
      const dbg = await page.evaluate(() => window.__touch.sticks());
      const on = await since(t0);
      const t1 = await now();
      await aimAt(dm.a + (10 * Math.PI) / 180 * (dm.a > 0 ? -1 : 1));
      await sleep(500);
      const off = await since(t1);
      await lift(2);
      const firstFire = on.find((x) => x.b & BTN.Fire);
      const lastFire = [...off].reverse().find((x) => x.b & BTN.Fire);
      const stopAfter = lastFire ? lastFire.t - t1 : 0;
      // the linger is 150 ms; the turn reaches the sim a frame or two late on a busy headless page
      const gaps = off.slice(1).map((x, i) => x.t - off[i].t).filter((g) => g > 1).sort((a, b) => a - b);
      const frame = gaps[Math.floor(gaps.length / 2)] ?? 17;
      check('Auto: aimed at a dummy in range it fires by itself (after the 100 ms dwell)', !!firstFire && firstFire.t - on[0].t >= 80, firstFire ? `first shot ${(firstFire.t - on[0].t).toFixed(0)} ms after aiming (dummy ${dm.d.toFixed(1)} m)` : `no shot (dummy ${dm.d.toFixed(1)} m at ${((dm.a * 180) / Math.PI).toFixed(0)}°; ${JSON.stringify({ fire: dbg?.fire, visible: dbg?.visible, range: dbg?.range, aim: dbg?.aim })})`);
      check('Auto: aimed 10° off, it stops within the 150 ms linger (plus two frames)', off.slice(-3).every((x) => !(x.b & BTN.Fire)) && stopAfter <= 150 + 2 * Math.max(frame, 60), `last shot ${stopAfter.toFixed(0)} ms after turning away; a frame here ${frame.toFixed(0)} ms`);
    } else check('Auto: a dummy to aim at', false, 'no dummy');
  }
  {
    // Fire button: FIRE fires on the first tick; dragging it 40 px up aims up
    await setFire('button');
    await settle();
    const shown = await page.evaluate(() => !document.querySelector('.mf-ctl-fire')?.classList.contains('mf-off'));
    const f = await ctlCentre('.mf-ctl-fire');
    const t0 = await now();
    await touch(7, f.x, f.y);
    await tick();
    for (let i = 1; i <= 4; i++) {
      await touch(7, f.x, f.y - i * 10);
      await tick();
    }
    const got = await since(t0);
    const landed = await page.evaluate(() => window.__downs.at(-1));
    await lift(7);
    const after = got.filter((x) => x.t >= landed);
    const up = after.at(-1)?.aim ?? -1;
    // the sim's aim: u16 of the angle (0 = right, a quarter turn = straight up)
    check('Fire button: FIRE shows, fires on the first tick, and a 40 px drag up aims up', shown && after.length > 0 && !!(after[0].b & BTN.Fire) && Math.abs(up - 16384) < 1200, `first tick ${after[0] && after[0].b & BTN.Fire ? 'fire' : '-'}; aim ${up} (up = 16384)`);
  }
  {
    // Release: drag 30 px and lift: one shot; drag 30 px, back to the middle, lift: none
    await setFire('release');
    await settle();
    const m0 = await mag();
    await touch(2, R.x, R.y);
    for (let i = 1; i <= 3; i++) {
      await touch(2, R.x + i * 10, R.y);
      await tick();
    }
    await lift(2);
    await sleep(400);
    const m1 = await mag();
    await touch(2, R.x, R.y);
    for (let i = 1; i <= 3; i++) {
      await touch(2, R.x + i * 10, R.y);
      await tick();
    }
    for (let i = 2; i >= 0; i--) {
      await touch(2, R.x + i * 10, R.y);
      await tick();
    }
    await lift(2);
    await sleep(400);
    const m2 = await mag();
    check('Release: drag and lift fires one shot; back to the middle and lift: none', m1 === m0 - 1 && m2 === m1, `mag ${m0} → ${m1} → ${m2}`);
  }
  // ---------- item 6 · aim assist levels (§4.5; the shared core, input/assist.ts) ----------
  {
    // Fire button mode: the stick only aims, so nothing fires while we measure the aim
    await setFire('button');
    await page.evaluate(() => {
      const m = window.__game.mode;
      const me = m.me;
      let best = null;
      for (const p of m.game.players) if (p && p.id !== me.id && p.alive && (!best || Math.abs(p.x - me.x) < Math.abs(best.x - me.x))) best = p;
      if (best) {
        me.x = best.x - 10;
        me.y = best.y;
        me.vx = 0;
        me.vy = 0;
      }
    });
    await sleep(800);
    await settle();
    const st0 = await page.evaluate(() => window.__touch.sticks());
    const tg = st0?.targets?.[0];
    if (!tg) check('aim assist: a dummy in sight to aim near', false, JSON.stringify({ visible: st0?.visible, assist: st0?.assist }));
    else {
      const a0 = Math.atan2(tg.y - st0.shoulder.y, tg.x - st0.shoulder.x);
      const d0 = Math.hypot(tg.x - st0.shoulder.x, tg.y - st0.shoulder.y);
      const deg = (r) => (r * 180) / Math.PI;
      // the sim's aim (u16) as degrees off the dummy
      const offOf = (u16) => Math.abs(((((u16 / 65536) * 360 - deg(a0)) % 360) + 540) % 360 - 180);
      const push = 50; // ≈ 0.8 of the stick: past touch magnetism's 0.30
      // whole pixels, as a finger lands; the angle the stick really points at comes back
      const aimAt = async (a) => {
        const dx = Math.round(Math.cos(a) * push);
        const dy = Math.round(-Math.sin(a) * push);
        await touch(2, R.x + dx, R.y + dy);
        return Math.atan2(-dy, dx);
      };
      /** The stick 3° off the dummy for `hold` ms, then (optionally) let go: the aim's offsets, held and after. */
      const run = async (level, liftAfter = false) => {
        await page.evaluate((assist) => window.__touch.setTouchSettings({ assist }), level);
        await sleep(200);
        await touch(2, R.x, R.y);
        await aimAt(a0 + Math.PI / 3); // away first: no target chosen
        await sleep(300);
        const t0 = await now();
        const stick = deg((await aimAt(a0 + (3 * Math.PI) / 180)) - a0);
        await sleep(500);
        const held = (await since(t0)).map((x) => offOf(x.aim));
        let after = [];
        if (liftAfter) {
          const t1 = await now();
          await lift(2);
          await sleep(500);
          after = (await since(t1)).map((x) => offOf(x.aim));
        } else await lift(2);
        await sleep(200);
        return { held, after, stick: Math.abs(stick) };
      };
      const off = await run('off');
      const std = await run('standard', true);
      const strong = await run('strong', true);
      const fmt = (a) => a.slice(-1).map((o) => o.toFixed(2)).join() + '°';
      const steps = (a) => a.slice(1).map((o, i) => Math.abs(o - a[i]));
      // Off: the aim sits where the stick points (3° off) once it has turned there
      check('aim assist Off: the stick 3° off a dummy, the aim stays where it points', Math.abs(off.held.at(-1) - off.stick) < 0.3, `settled ${fmt(off.held)}, the stick ${off.stick.toFixed(2)}° (dummy ${d0.toFixed(1)} m)`);
      // Standard: magnetism pulls it nearer, never more than 3° a tick once there
      const settled = std.held.slice(std.held.findIndex((o) => o < 6));
      check('aim assist Standard: 3° off, the aim settles nearer the dummy, at most 3° a tick', std.held.at(-1) < std.stick - 0.5 && steps(settled).every((d) => d <= 3.05), `settled ${fmt(std.held)}, the stick ${std.stick.toFixed(2)}°; the biggest step ${Math.max(0, ...steps(settled)).toFixed(2)}°`);
      // let go: Standard leaves the aim where it was; Strong's lock brings it onto the dummy
      check('aim assist Standard, let go: the aim stays put (no lock)', Math.abs(std.after.at(-1) - std.held.at(-1)) < 0.2, `${fmt(std.held)} → ${fmt(std.after)}`);
      check('aim assist Strong, let go: the lock holds the aim on the dummy', strong.after.at(-1) < 0.5 && strong.after.at(-1) < strong.held.at(-1), `${fmt(strong.held)} → ${fmt(strong.after)}`);
      await page.evaluate(() => window.__touch.setTouchSettings({ assist: 'standard' }));
    }
  }
  await setFire('pull');
} catch (e) {
  console.error(e);
  check('the checks ran to the end', false, e.message);
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
