/* global process */
/**
 * Fixed sticks, the easy dash (the owner's phone report, 25 Oct 2026), in a phone-sized headless
 * Chrome with real CDP touches: each stick stays where it's drawn and reads the thumb from its drawn
 * centre; a small push on the aim stick only aims, past its fire line it fires, and a thumb that lands
 * on the wrong side and drags across fires no stray shot; a brush of the stick fires nothing in
 * Release; a flick measured from the landing dashes the way it swiped; DASH by the left thumb dashes
 * the way the stick was going; left-handed, a thumb held through pause and resume, and a resize with a
 * thumb down. Every sim tick's sampled Input is read through a wrapper on the local game's sampler.
 * Screenshots of the sticks and DASH go to `outDir`.
 *
 *   cd apps/web && pnpm exec vite --port 5199 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/touch-fixed-check.mjs http://localhost:5199 /tmp/touch-fixed
 *
 * Exits 1 if a check fails.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const [base = 'http://localhost:5199', outDir = join(tmpdir(), 'touch-fixed')] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
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

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'touch-fixed-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
const cdp = await page.createCDPSession();
await page.emulate({ viewport: VIEW, userAgent: PHONE_UA });
await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
await page.goto(`${base}/?sandbox&render=2d`);
await page.waitForFunction(() => window.__game?.mode?.me && document.querySelector('.mf-touch') && !document.querySelector('.mf-touch').hidden, { timeout: 300_000 });
await sleep(3000);

// a new player's settings: fixed sticks; Pull, so the stick's own fire line is what fires (no aim assist pulling the aim)
const fresh = await page.evaluate(() => window.__touch.getTouchSettings());
check('a new player gets fixed sticks', fresh.sticks === 'fixed', `sticks ${fresh.sticks}`);
await page.evaluate(() => window.__touch.setTouchSettings({ fire: 'pull', assist: 'off' }));

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
  window.addEventListener('pointerdown', () => window.__downs.push(performance.now()), { capture: true });
});

const since = (t) => page.evaluate((t) => window.__samples.filter((s) => s.t >= t), t);
const now = () => page.evaluate(() => performance.now());
const tick = async () => {
  const n = await page.evaluate(() => window.__sampleCount ?? 0);
  await page.waitForFunction((n) => (window.__sampleCount ?? 0) > n + 1, { timeout: 30_000, polling: 25 }, n);
};
const settle = async () => {
  await sleep(400);
  await tick();
};
const pt = (id, x, y) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: 8, radiusY: 8, force: 1 });
const down = new Map();
const touch = async (id, x, y, ts) => {
  const fresh = !down.has(id);
  down.set(id, pt(id, x, y));
  await cdp.send('Input.dispatchTouchEvent', { type: fresh ? 'touchStart' : 'touchMove', touchPoints: [...down.values()], ...(ts !== undefined ? { timestamp: ts } : {}) });
};
const lift = async (id, ts) => {
  down.delete(id);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [...down.values()], ...(ts !== undefined ? { timestamp: ts } : {}) });
};
/** a dial's base radius (its rect also holds the HP and fuel arcs) */
const baseR = (sel) => page.$eval(`${sel} .dial__base`, (el) => el.getBoundingClientRect().width / 2);
const rectOf = (sel) =>
  page.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
  });
/** samples from the last finger's landing on */
const fromLanding = async (t0) => {
  const landed = await page.evaluate(() => window.__downs.at(-1));
  return (await since(Math.max(t0, landed))).map((s) => ({ ...s, ms: s.t - landed }));
};
const mag = () => page.evaluate(() => { const p = window.__game.mode.me; return p.weapons[p.active].mag; });
/** the sim's aim (u16) points into the left half of the circle */
const aimsLeft = (u16) => u16 > 16384 + 2000 && u16 < 49152 - 2000;
const aimsRight = (u16) => u16 < 16384 - 2000 || u16 > 49152 + 2000;

try {
  const M = await rectOf('.mf-ctl-move');
  const A = await rectOf('.mf-ctl-aim');
  const D = await rectOf('.mf-ctl-dash');
  const MR = await baseR('.mf-ctl-move');
  await page.screenshot({ path: join(outDir, 'fixed-idle.png') });
  check('Classic shows DASH by the left thumb, right of the move dial and clear of it', D.x < VIEW.width / 2 && D.x > M.x && Math.hypot(D.x - M.x, D.y - M.y) - D.r - M.r >= 12, `DASH at (${D.x.toFixed(0)}, ${D.y.toFixed(0)}) ⌀${(2 * D.r).toFixed(0)} px; move dial at (${M.x.toFixed(0)}, ${M.y.toFixed(0)}) ⌀${(2 * M.r).toFixed(0)} px`);

  // ---- the move stick reads from its drawn centre ----
  {
    await settle();
    const t0 = await now();
    await touch(1, M.x + 40, M.y);
    await tick();
    await tick();
    const got = await fromLanding(t0);
    const M1 = await rectOf('.mf-ctl-move');
    const knob = await page.$eval('.mf-ctl-move .mf-knob', (el) => el.style.transform);
    await lift(1);
    check('a thumb landing 40 px right of the move dial runs right on its first tick, and the dial stays put', got.length > 0 && !!(got[0].b & BTN.Right) && Math.hypot(M1.x - M.x, M1.y - M.y) < 1, `first ticks ${got.slice(0, 3).map((s) => s.b).join(' ')}; dial moved ${Math.hypot(M1.x - M.x, M1.y - M.y).toFixed(1)} px; knob ${knob}`);
  }
  {
    await settle();
    const t0 = await now();
    await touch(1, M.x - 1.45 * MR, M.y); // just off the ring: still the stick
    await tick();
    await tick();
    const got = await fromLanding(t0);
    await lift(1);
    check('a thumb landing just off the ring (1.45 radii left) still grabs the stick and runs left', got.length > 0 && !!(got[0].b & BTN.Left), `first ticks ${got.slice(0, 3).map((s) => s.b).join(' ')}`);
  }
  {
    await settle();
    const t0 = await now();
    await touch(1, M.x + 4, M.y - 3); // a resting thumb, a little off the centre
    await sleep(250);
    const got = await fromLanding(t0);
    await lift(1);
    check('a thumb resting 5 px off the centre does nothing (the dead zone)', got.every((s) => (s.b & (BTN.Left | BTN.Right | BTN.Jet | BTN.Down)) === 0), `bits ${got.reduce((b, s) => b | s.b, 0)}`);
  }
  {
    // far from the dial (3.3 radii up and right, on the left half): it reads the drag, the dial stays put
    await settle();
    const x = M.x + 2.4 * MR;
    const y = M.y - 2.3 * MR;
    const t0 = await now();
    await touch(1, x, y);
    await sleep(200);
    const still = await fromLanding(t0);
    for (let i = 1; i <= 4; i++) {
      await touch(1, x + i * 8, y);
      await tick();
    }
    const after = (await since(t0)).at(-1);
    const M1 = await rectOf('.mf-ctl-move');
    await lift(1);
    check('a thumb landing well off the dial does nothing until it drags; a 32 px drag right runs right; the dial stays put', still.every((s) => (s.b & (BTN.Left | BTN.Right | BTN.Jet | BTN.Down)) === 0) && !!(after.b & BTN.Right) && Math.hypot(M1.x - M.x, M1.y - M.y) < 1, `landing bits ${still.reduce((b, s) => b | s.b, 0)}; after the drag ${after.b}`);
  }

  // ---- the aim stick: a small push aims, past the line fires ----
  {
    await settle();
    const t0 = await now();
    await touch(2, A.x - 25, A.y);
    await sleep(300);
    const small = await fromLanding(t0);
    const t1 = await now();
    for (let i = 1; i <= 3; i++) {
      await touch(2, A.x - 25 - i * 8, A.y);
      await tick();
    }
    await sleep(150);
    const past = await since(t1);
    await page.screenshot({ path: join(outDir, 'fixed-aim-firing.png') });
    await lift(2);
    check('fixed aim: a 25 px push aims left at once and never fires', small.length > 0 && small.every((s) => !(s.b & BTN.Fire)) && aimsLeft(small.at(-1).aim), `aim ${small.at(-1)?.aim}; fire ${small.filter((s) => s.b & BTN.Fire).length}/${small.length}`);
    check('fixed aim: pushed on to 49 px (past the 36 px line) it fires', past.slice(-3).every((s) => s.b & BTN.Fire), past.slice(-3).map((s) => (s.b & BTN.Fire ? 'fire' : '-')).join(' '));
  }
  {
    // landing past the line, held still: aims at once, fires once the landing settles (80 ms)
    await settle();
    const t0 = await now();
    await touch(2, A.x + 48, A.y);
    await sleep(400);
    const got = await fromLanding(t0);
    await lift(2);
    const first = got.find((s) => s.b & BTN.Fire);
    check('fixed aim: landing past the line aims at once and fires after the landing settles (80 ms)', aimsRight(got[0]?.aim ?? 16384) && !!first && first.ms >= 70 && first.ms <= 250, `aim on the first tick ${got[0]?.aim}; first shot ${first ? first.ms.toFixed(0) : '–'} ms after landing`);
  }
  {
    // a sloppy landing: past the line on the left, then a quick drag across to the right
    // a thumb's pace: a move every 25 ms, sent without waiting for each to be handled (each CDP call
    // awaited can take a busy headless page tens of ms); the page's own clock says how long the drag took
    await page.evaluate(() => {
      window.__moveAt = [];
      window.addEventListener('pointermove', () => window.__moveAt.push(performance.now()), { capture: true });
    });
    let stray = 0;
    let ends = 0;
    const took = [];
    const N = 4;
    for (let n = 0; n < N; n++) {
      await settle();
      const t0 = await now();
      await page.evaluate(() => window.__moveAt.splice(0));
      down.set(2, pt(2, A.x - 48, A.y + 6));
      const sends = [cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [...down.values()] })];
      for (const dx of [-20, 10, 30, 48]) {
        await sleep(25);
        down.set(2, pt(2, A.x + dx, A.y + 6));
        sends.push(cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [...down.values()] }));
      }
      await Promise.all(sends);
      await sleep(300);
      const got = await fromLanding(t0);
      const landed = await page.evaluate(() => window.__downs.at(-1));
      took.push(Math.round((await page.evaluate(() => window.__moveAt.at(-1))) - landed));
      await lift(2);
      stray += got.filter((s) => s.b & BTN.Fire && aimsLeft(s.aim)).length;
      if (got.slice(-2).every((s) => s.b & BTN.Fire && aimsRight(s.aim))) ends++;
    }
    check('fixed aim: landing past the line on the wrong side and dragging across fires no stray shot that way', stray === 0 && ends === N, `${stray} stray samples firing left over ${N} strokes; ${ends}/${N} ended firing right; drags took ${took.join(', ')} ms`);
  }
  {
    // Release: a brush of the stick fires nothing; a held aim fires once on the lift
    await page.evaluate(() => window.__touch.setTouchSettings({ fire: 'release' }));
    await settle();
    // the shots above may have emptied the magazine: wait for the reload
    await page.waitForFunction(() => { const p = window.__game.mode.me; return p.weapons[p.active].mag >= 2; }, { timeout: 15_000, polling: 100 });
    const m0 = await mag();
    const t = Date.now() / 1000 - 2;
    await touch(2, A.x + 45, A.y, t);
    await lift(2, t + 0.03);
    await sleep(400);
    const m1 = await mag();
    await touch(2, A.x + 45, A.y);
    await sleep(250);
    await lift(2);
    await sleep(400);
    const m2 = await mag();
    check('fixed aim, Release: a 30 ms brush fires nothing; held 250 ms and lifted fires once', m1 === m0 && m2 === m1 - 1, `mag ${m0} → ${m1} → ${m2}`);
    await page.evaluate(() => window.__touch.setTouchSettings({ fire: 'pull' }));
  }

  // ---- dashing ----
  {
    // a flick from left of the centre across to the right: measured from the landing, it dashes right
    await settle();
    await page.evaluate(() => window.__touch.actions.splice(0));
    const t0 = await now();
    const ts = Date.now() / 1000 - 2;
    await touch(9, M.x - 30, M.y, ts);
    await touch(9, M.x, M.y, ts + 0.04);
    await touch(9, M.x + 25, M.y, ts + 0.08);
    await touch(9, M.x + 45, M.y, ts + 0.11);
    await lift(9, ts + 0.12);
    await tick();
    await tick();
    const dash = (await since(t0)).find((s) => s.b & BTN.Dash);
    check('fixed move stick: a flick from left of the centre to the right dashes right', !!dash && !!(dash.b & BTN.Right) && !(dash.b & BTN.Left), dash ? `dash bits ${dash.b}` : 'no dash');
    // the same stroke slowly (300 ms) is a step, not a dash
    await settle();
    const t1 = await now();
    const ts2 = Date.now() / 1000 - 2;
    await touch(9, M.x - 30, M.y, ts2);
    await touch(9, M.x + 10, M.y, ts2 + 0.1);
    await touch(9, M.x + 45, M.y, ts2 + 0.29);
    await lift(9, ts2 + 0.3);
    await tick();
    await tick();
    check('fixed move stick: the same stroke over 300 ms is not a dash', !(await since(t1)).some((s) => s.b & BTN.Dash));
  }
  {
    // hop: run left on the stick, lift, tap DASH: it dashes left (the way the stick was going), not the way you face
    // (the aim tests left the soldier facing right: a dash "the way you face" would go right)
    await settle();
    const t0 = await now();
    await touch(1, M.x - 40, M.y);
    await sleep(300);
    await lift(1);
    await touch(4, D.x, D.y);
    await sleep(40);
    await lift(4);
    await tick();
    await tick();
    const dash = (await since(t0)).find((s) => s.b & BTN.Dash);
    check('DASH right after the left thumb leaves the stick dashes the way the stick was going (left)', !!dash && !!(dash.b & BTN.Left) && !(dash.b & BTN.Right), dash ? `dash bits ${dash.b}` : 'no dash');
    // and a swipe on DASH picks the way
    await settle();
    const t1 = await now();
    await touch(4, D.x, D.y);
    await touch(4, D.x, D.y - 30);
    await sleep(60);
    await lift(4);
    await tick();
    await tick();
    const up = (await since(t1)).find((s) => s.b & BTN.Dash);
    check('a swipe up on DASH dashes up', !!up && !!(up.b & BTN.Jet), up ? `dash bits ${up.b}` : 'no dash');
  }

  // ---- two thumbs, a screenshot with both sticks pushed ----
  {
    await settle();
    await touch(1, M.x + 35, M.y - 20);
    await touch(2, A.x - 50, A.y - 10);
    await sleep(300);
    await page.screenshot({ path: join(outDir, 'fixed-two-thumbs.png') });
    const st = await page.evaluate(() => window.__touch.sticks());
    const last = (await since(0)).at(-1);
    await lift(2);
    await lift(1);
    check('two thumbs on the fixed sticks: running right and firing together', !!(last.b & BTN.Right) && !!(last.b & BTN.Fire), `bits ${last.b}; move ${st.move.x.toFixed(2)},${st.move.y.toFixed(2)}; aim ${st.aim.x.toFixed(2)},${st.aim.y.toFixed(2)}`);
  }

  // ---- pause and resume with a thumb down: the menus block the sampler (as the shell's do; the
  // sandbox has no pause menu), the controls hide and let go; back in play, a new landing reads from
  // the fixed dial again ----
  {
    await settle();
    await touch(1, M.x + 40, M.y);
    await sleep(150);
    await page.evaluate(() => (window.__game.mode.sampler.blocked = true));
    await sleep(400);
    const letGo = await page.evaluate(() => !!document.querySelector('.mf-touch.mf-touch-menus') && window.__touch.sticks().moveActive === false);
    await page.evaluate(() => (window.__game.mode.sampler.blocked = false));
    await sleep(400);
    await lift(1);
    await settle();
    const t0 = await now();
    await touch(1, M.x - 40, M.y);
    await tick();
    await tick();
    const got = await fromLanding(t0);
    await lift(1);
    check('pause with a thumb on the stick lets it go; after resume a new landing runs from the fixed dial', letGo && got.length > 0 && !!(got[0].b & BTN.Left), `let go under the menus ${letGo}; then ${got[0]?.b}`);
  }

  // ---- a resize with a thumb down (a phone turning, Safari's bars): the dial keeps its place, the thumb reads from it ----
  {
    await settle();
    await touch(1, M.x + 40, M.y);
    await sleep(100);
    await page.setViewport({ ...VIEW, width: 844, height: 390 });
    await sleep(500);
    const M2 = await rectOf('.mf-ctl-move');
    await touch(1, M2.x - 40, M2.y);
    await tick();
    await tick();
    const last = (await since(0)).at(-1);
    await lift(1);
    check('resized with a thumb down: the dial goes to its new place and the thumb reads from it (40 px left of it: runs left)', !!(last.b & BTN.Left), `dial (${M.x.toFixed(0)}, ${M.y.toFixed(0)}) → (${M2.x.toFixed(0)}, ${M2.y.toFixed(0)}); bits ${last.b}`);
    await page.setViewport(VIEW);
    await sleep(500);
  }

  // ---- left-handed: mirrored, still fixed ----
  {
    await page.evaluate(() => window.__touch.setTouchSettings({ handed: 'left' }));
    await sleep(400);
    const LM = await rectOf('.mf-ctl-move');
    const LD = await rectOf('.mf-ctl-dash');
    await page.screenshot({ path: join(outDir, 'fixed-left-handed.png') });
    await settle();
    const t0 = await now();
    await touch(1, LM.x - 40, LM.y);
    await tick();
    await tick();
    const got = await fromLanding(t0);
    const LM1 = await rectOf('.mf-ctl-move');
    await lift(1);
    check('left-handed: the move dial and DASH on the right (DASH inboard), a landing 40 px left of the dial runs left, the dial stays put', LM.x > VIEW.width / 2 && LD.x > VIEW.width / 2 && LD.x < LM.x && got.length > 0 && !!(got[0].b & BTN.Left) && Math.hypot(LM1.x - LM.x, LM1.y - LM.y) < 1, `move (${LM.x.toFixed(0)}), DASH (${LD.x.toFixed(0)}); first tick ${got[0]?.b}`);
    await page.evaluate(() => window.__touch.setTouchSettings({ handed: 'right' }));
    await sleep(300);
  }

  // ---- Follow thumb: the setting brings back the sticks that come to the thumb ----
  {
    await page.evaluate(() => window.__touch.setTouchSettings({ sticks: 'follow' }));
    await settle();
    const x = M.x + 2.4 * MR;
    const y = M.y - 2.3 * MR;
    const t0 = await now();
    await touch(1, x, y);
    await sleep(200);
    const got = await fromLanding(t0);
    const M1 = await rectOf('.mf-ctl-move');
    await lift(1);
    check('Follow thumb: the dial comes to where the thumb lands, at rest', Math.hypot(M1.x - x, M1.y - y) < 4 && got.every((s) => (s.b & (BTN.Left | BTN.Right | BTN.Jet | BTN.Down)) === 0), `dial at (${M1.x.toFixed(0)}, ${M1.y.toFixed(0)}), thumb at (${x.toFixed(0)}, ${y.toFixed(0)})`);
    await page.evaluate(() => window.__touch.setTouchSettings({ sticks: 'fixed' }));
  }
} catch (e) {
  console.error(e);
  check('the checks ran to the end', false, e.message);
}

await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed; screenshots in ${outDir}`);
process.exit(failed ? 1 : 0);
