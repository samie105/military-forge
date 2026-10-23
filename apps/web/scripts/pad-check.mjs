/* global process */
/**
 * A fake standard-mapping controller in headless Chrome (apps/web/src/gamepad), the controls spec's
 * method (docs/design/controls-research.md §1, §5.9): `navigator.getGamepads` is replaced before the
 * page loads, the local sandbox runs, and every sim tick's sampled `Input` is recorded with the
 * player's x, vx, vy and fuel. Each check sets the pad, waits for ticks and reads the record.
 *
 *   cd apps/web && pnpm exec vite --port 5199 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/pad-check.mjs http://localhost:5199 [out.json]
 *
 * Prints PASS/FAIL per check and exits 1 if one fails; `out.json` gets the per-tick record of each check.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const [base = 'http://localhost:5199', outFile = ''] = process.argv.slice(2);
const chrome = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'pad-check-'));

const Btn = { Left: 1, Right: 2, Jet: 4, Down: 8, Fire: 16, Fire2: 32, Reload: 64, Swap: 128, Grenade: 256, Melee: 512, Interact: 1024, Dual: 2048, CycleGrenade: 4096, Dash: 8192, Shield: 16384 };
const names = (b) => Object.entries(Btn).filter(([, v]) => b & v).map(([k]) => k).join('+') || '-';
const MOVE = Btn.Left | Btn.Right | Btn.Jet | Btn.Down;

const results = [];
const records = {};
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, userDataDir: profile, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.setViewport({ width: 1280, height: 720 });

// the fake pad, in place before any of the page's scripts run
await page.evaluateOnNewDocument(() => {
  const pad = {
    id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)',
    index: 0,
    connected: true,
    mapping: 'standard',
    timestamp: 0,
    axes: [0, 0, 0, 0],
    buttons: Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 })),
    vibrationActuator: { effects: [], playEffect(type, p) { this.effects.push([type, p]); return Promise.resolve('complete'); } },
  };
  Object.defineProperty(navigator, 'getGamepads', { value: () => [pad], configurable: true });
  window.__fakePad = pad;
});

await page.goto(`${base}/?sandbox&render=2d`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__game?.mode?.sampler && window.__pad?.manager, { timeout: 60_000 });

// the recorder: every sample, the Input and the player as the tick begins
await page.evaluate(() => {
  const mode = window.__game.mode;
  const s = mode.sampler;
  const sample = s.sample.bind(s);
  window.__ticks = [];
  s.sample = (...args) => {
    const out = sample(...args);
    const me = mode.me;
    window.__ticks.push({ buttons: out.buttons, aim: out.aim, dashStrength: out.dashStrength, x: +me.x.toFixed(3), y: +me.y.toFixed(3), vx: +me.vx.toFixed(3), vy: +me.vy.toFixed(3), fuel: +me.fuel.toFixed(1), at: performance.now() });
    return out;
  };
  window.dispatchEvent(new Event('gamepadconnected'));
});

const setPad = (patch) =>
  page.evaluate((p) => {
    const pad = window.__fakePad;
    if (p.axes) pad.axes = p.axes;
    for (const [i, v] of Object.entries(p.buttons ?? {})) pad.buttons[Number(i)] = { pressed: v > 0, touched: v > 0, value: v };
    pad.timestamp++;
  }, patch);
const tickCount = () => page.evaluate(() => window.__ticks.length);
/** Waits for `n` more sim ticks, then returns them. */
async function ticks(n) {
  const from = await tickCount();
  await page.waitForFunction((target) => window.__ticks.length >= target, { timeout: 60_000, polling: 10 }, from + n);
  return page.evaluate((a, b) => window.__ticks.slice(a, b), from, from + n);
}
const rest = async () => {
  await setPad({ axes: [0, 0, 0, 0], buttons: Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i, 0])) });
  await ticks(6);
};
const deg = (d, push = 1) => [Math.cos((d * Math.PI) / 180) * push, -Math.sin((d * Math.PI) / 180) * push];
const last = (rec) => rec[rec.length - 1].buttons;

// a button so the page counts the pad as the device in use
await setPad({ buttons: { 0: 1 } });
await ticks(3);
await rest();
check('the pad is the device in use', (await page.evaluate(() => document.documentElement.dataset.input)) === 'pad');

// --- run threshold: a 0.01 sweep from rest
{
  let first = null;
  const rec = [];
  for (let x = 0.2; x <= 0.401; x += 0.01) {
    await rest();
    await setPad({ axes: [x, 0, 0, 0] });
    const r = await ticks(3);
    rec.push({ x: +x.toFixed(2), bits: names(last(r)) });
    if (first === null && last(r) & Btn.Right) first = +x.toFixed(2);
  }
  records.runSweep = rec;
  check('run starts at 0.30 of the raw throw (not at 0.25)', first !== null && first >= 0.27 && first <= 0.31, `first run at ${first}`);
}

// --- the jet angle table, each a full push from rest
{
  const table = {};
  for (const d of [25, 40, 50, 54, 56, 60, 90, 125, 140]) {
    await rest();
    await setPad({ axes: [...deg(d), 0, 0] });
    table[d] = names(last(await ticks(4)) & MOVE);
  }
  records.jetTable = table;
  check('no jet at 25° or 40°', !table[25].includes('Jet') && !table[40].includes('Jet'), `25°: ${table[25]}, 40°: ${table[40]}`);
  check('jet from the 55° cone: 56°, 60°, 90°, 125°', ['56', '60', '90', '125'].every((d) => table[d].includes('Jet')), `56°: ${table[56]}, 60°: ${table[60]}`);
  check('no jet at 50° or 54° (under the cone)', !table[50].includes('Jet') && !table[54].includes('Jet'));
  check('40° and 140° run (right and left)', table[40] === 'Right' && table[140] === 'Left');
}

// --- jet hysteresis: from 80° down to 10° in 5° steps
{
  await rest();
  await setPad({ axes: [...deg(80), 0, 0] });
  await ticks(4);
  let lastJet = 80;
  const rec = [];
  for (let d = 75; d >= 10; d -= 5) {
    await setPad({ axes: [...deg(d), 0, 0] });
    const b = last(await ticks(2));
    rec.push({ deg: d, bits: names(b & MOVE) });
    if (b & Btn.Jet) lastJet = d;
  }
  records.jetHold = rec;
  check('once jetting, it keeps jetting down to 20°, and stops below', lastJet === 20, `last jetting angle ${lastJet}°`);
}

// --- crouch
{
  const table = {};
  for (const d of [-15, -50, -61, -80, -90]) {
    await rest();
    await setPad({ axes: [...deg(d), 0, 0] });
    table[d] = names(last(await ticks(4)) & MOVE);
  }
  records.crouch = table;
  check('a full push 15° below horizontal runs without crouching', table[-15] === 'Right', table[-15]);
  check('crouch only within ±30° of down: none at −50°, crouch at −61°, −80°, −90°', !table[-50].includes('Down') && [-61, -80, -90].every((d) => table[d].includes('Down')), JSON.stringify(table));
}

// --- dash directions (LB with the stick held)
{
  const table = {};
  for (const d of [0, 25, 30, 50, 80, -80, 180]) {
    await rest();
    await setPad({ axes: [...deg(d), 0, 0] });
    await ticks(3);
    await setPad({ buttons: { 4: 1 } });
    const r = await ticks(3);
    const dash = r.find((t) => t.buttons & Btn.Dash);
    table[d] = dash ? names(dash.buttons & MOVE) : 'no dash';
    await setPad({ buttons: { 4: 0 } });
  }
  records.dash = table;
  check('dashes at 25° and 30° go right only', table[25] === 'Right' && table[30] === 'Right', `25°: ${table[25]}, 30°: ${table[30]}`);
  check('a dash at 50° goes up-right, at 80° up', table[50] === 'Right+Jet' && table[80] === 'Jet', `50°: ${table[50]}, 80°: ${table[80]}`);
}

// --- LT jets (press 0.30, let go under 0.20)
{
  const rec = {};
  await rest();
  for (const v of [0.25, 0.35, 0.25, 0.21, 0.19]) {
    await setPad({ buttons: { 6: v } });
    rec[v === 0.25 && rec['0.25'] ? '0.25 (held)' : String(v)] = names(last(await ticks(2)) & Btn.Jet);
  }
  records.ltJet = rec;
  check('LT 0.35 jets; held, it lets go only under 0.20', rec['0.25'] === '-' && rec['0.35'] === 'Jet' && rec['0.25 (held)'] === 'Jet' && rec['0.21'] === 'Jet' && rec['0.19'] === '-', JSON.stringify(rec));
  await rest();
  await setPad({ buttons: { 0: 1 } });
  check('A jets too', (last(await ticks(2)) & Btn.Jet) === Btn.Jet);
}

// --- turnaround: the aim from right to left
{
  await rest();
  await setPad({ axes: [0, 0, 1, 0] });
  await ticks(4);
  await setPad({ axes: [0, 0, -1, 0] });
  const r = await ticks(6);
  const n = r.findIndex((t) => t.aim === 32768) + 1;
  records.flip = r.map((t) => +((t.aim / 65536) * 360).toFixed(1));
  check('a 180° aim flip lands within 3 ticks', n > 0 && n <= 3, `aim by tick: ${records.flip.join('°, ')}°`);
  await setPad({ axes: [0, 0, 0, -0.25] });
  const held = await ticks(3);
  check('the aim holds under 0.30 of raw push', held.every((t) => t.aim === 32768));
}

// --- hold X to take (tap reloads at once)
{
  await rest();
  await setPad({ buttons: { 2: 1 } });
  const pressAt = await page.evaluate(() => performance.now());
  const r = await ticks(30);
  const reloadAt = r.findIndex((t) => t.buttons & Btn.Reload);
  const takeAt = r.findIndex((t) => t.buttons & Btn.Interact);
  const ms = takeAt >= 0 ? r[takeAt].at - pressAt : -1;
  records.holdTake = { reloadTick: reloadAt, takeTick: takeAt };
  check('X reloads on the first tick and takes once held 0.3 s (not before)', reloadAt === 0 && ms >= 290, `reload tick ${reloadAt}, take tick ${takeAt}, ${Math.round(ms)} ms after the press`);
}

// --- aim assist (Standard): the aim stick 3° off a range dummy pulls toward it, at most 3° a tick
{
  await rest();
  // the sandbox's range dummies stand far off: put the player 10 m from the nearest (a test, not play)
  await page.evaluate(() => {
    const mode = window.__game.mode;
    const me = mode.me;
    const dummy = mode.game.players.filter((p) => p && p.id !== me.id && p.alive).sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0];
    if (dummy) {
      me.x = dummy.x - 10;
      me.y = dummy.y;
      me.vx = me.vy = 0;
    }
  });
  await ticks(10);
  /** The angle (rad) from the player's shoulder to the target assist sees (the manager's own list), and its distance. */
  const target = () =>
    page.evaluate(() => {
      const mode = window.__game.mode;
      const t = mode.game.tuning;
      const sx = mode.me.shoulderX(t);
      const sy = mode.me.shoulderY(t);
      const seen = window.__pad.manager.targets ?? [];
      const best = seen.map((p) => ({ d: Math.hypot(p.x - sx, p.y - sy), angle: Math.atan2(p.y - sy, p.x - sx) })).sort((a, b) => a.d - b.d)[0];
      return best ?? null;
    });
  const first = await target();
  if (!first) check('aim assist pulls toward a dummy (no dummy in sight: skipped)', true);
  else {
    // aim straight at it first (no turnaround in the record), then 3° off
    await setPad({ axes: [0, 0, Math.cos(first.angle), -Math.sin(first.angle)] });
    await ticks(6);
    const aimAt = await target();
    const off = aimAt.angle + (3 * Math.PI) / 180;
    await setPad({ axes: [0, 0, Math.cos(off), -Math.sin(off)] });
    const r = await ticks(8);
    const deg = (a) => (a * 180) / Math.PI;
    const offDeg = (u16) => Math.abs(((((u16 / 65536) * 360 - deg(aimAt.angle)) % 360) + 540) % 360 - 180);
    const offs = r.map((t) => offDeg(t.aim));
    const steps = offs.slice(1).map((o, i) => Math.abs(o - offs[i]));
    records.assist = { dummyDistance: +aimAt.d.toFixed(2), offByTick: offs.map((o) => +o.toFixed(2)) };
    check('aim assist (Standard): 3° off a dummy, the aim settles nearer, at most 3° a tick', offs[offs.length - 1] < 2.9 && steps.every((d) => d <= 3.01), `off by tick: ${records.assist.offByTick.join('°, ')}° (dummy at ${records.assist.dummyDistance} m)`);
  }
  await rest();
}

// --- air reversal while jetting, for the record (sim tuning unchanged: spec §5.8, the owner's call)
{
  await rest();
  await setPad({ axes: [...deg(70), 0, 0], buttons: { 6: 1 } });
  await ticks(60);
  await setPad({ axes: [...deg(110), 0, 0] });
  const r = await ticks(60);
  const from = r[0].vx;
  const n = r.findIndex((t) => t.vx <= -from * 0.95);
  records.airReversal = r.map((t) => t.vx);
  check('air reversal while jetting (measured, informational)', true, `vx ${from} → ${r[r.length - 1].vx} m/s; ${n >= 0 ? `${n} ticks (${Math.round((n * 1000) / 60)} ms) to 95% of the reverse` : 'not reached in 60 ticks'}`);
  await rest();
}

// --- the other layouts (spec §5.6)
{
  const layout = (id) => page.evaluate((x) => window.__pad.layout(x), id);
  await layout('bumperJet');
  await rest();
  await setPad({ axes: [...deg(90), 0, 0] });
  const upNoJet = !(last(await ticks(4)) & Btn.Jet);
  await setPad({ axes: [0, 0, 0, 0], buttons: { 4: 1 } });
  const lbJets = !!(last(await ticks(3)) & Btn.Jet);
  await setPad({ buttons: { 4: 0, 6: 1 } });
  const ltDash = (await ticks(3)).some((t) => t.buttons & Btn.Dash);
  check('Bumper Jet: the stick never jets; LB jets; LT dashes', upNoJet && lbJets && ltDash, `stick up: ${upNoJet ? 'no jet' : 'jet'}, LB: ${lbJets ? 'jet' : '-'}, LT: ${ltDash ? 'dash' : '-'}`);

  await layout('southpaw');
  await rest();
  await setPad({ axes: [0, 0, 0.9, 0] });
  const rightMoves = last(await ticks(3)) & MOVE;
  await setPad({ axes: [0, 0, 0, 0], buttons: { 6: 1 } });
  const ltFires = last(await ticks(3)) & Btn.Fire;
  await setPad({ buttons: { 6: 0, 7: 1 } });
  const rtJets = last(await ticks(3)) & Btn.Jet;
  check('Southpaw: the right stick moves, LT fires, RT jets', rightMoves === Btn.Right && !!ltFires && !!rtJets, `right stick: ${names(rightMoves)}`);

  await layout('oneStick');
  await rest();
  // near a range dummy, sticks idle: the aim finds it and the gun fires by itself after the dwell
  await page.evaluate(() => {
    const mode = window.__game.mode;
    const me = mode.me;
    const dummy = mode.game.players.filter((p) => p && p.id !== me.id && p.alive).sort((a, b) => Math.abs(a.x - me.x) - Math.abs(b.x - me.x))[0];
    if (dummy) {
      me.x = dummy.x - 9;
      me.y = dummy.y;
      me.vx = me.vy = 0;
    }
  });
  const r = await ticks(40);
  const firstFire = r.findIndex((t) => t.buttons & Btn.Fire);
  records.oneStick = r.map((t) => [+((t.aim / 65536) * 360).toFixed(1), t.buttons & Btn.Fire ? 1 : 0]);
  check('One-stick: the aim finds the dummy and fires by itself (after the 100 ms dwell)', firstFire > 0, `first shot at tick ${firstFire}; aim ${records.oneStick[Math.max(0, firstFire)]?.[0]}°`);
  await layout('standard');
  await rest();
}

// every tick of the run: [buttons, aim u16, x, vx, vy, fuel]
records.ticks = await page.evaluate(() => window.__ticks.map((t) => [t.buttons, t.aim, t.x, t.vx, t.vy, t.fuel]));
if (outFile) writeFileSync(outFile, JSON.stringify({ results, records }, null, 2));
await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
