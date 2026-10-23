/**
 * The desktop swap, played for real (owner, 23 Oct: "you didn't update the ui for swapping guns"):
 * training with the range dummies, the real Q key and mouse. A tap of Q swaps (the draw card, the
 * loadout bar, the trading weapon cards); a hold opens the quick-select at the reticle, the mouse
 * points, letting go takes it (checked: the gun or grenade type actually changes in the sim). Then
 * the other 23 Oct moments at 1280×720 (ground tags, the compare card, a map event, the kill
 * confirm). Frame strips: the HUD held and its animations stepped 16 ms at a time.
 *
 *   node apps/web/scripts/hud-swap-shots.mjs <after url> <out dir> [<before url>]
 *
 * Exits 1 on a page error or a check that fails.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const after = (process.argv[2] ?? 'http://127.0.0.1:8232').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/hud-premium/desktop-v2');
const before = process.argv[4]?.replace(/\/$/, '') ?? null;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONTENT = fileURLToPath(new URL('../../../packages/content/src/index.ts', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
mkdirSync(join(out, 'frames'), { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'hud-swap-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 600_000 });

async function open(base, w, h) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await page.setViewport({ width: w, height: h });
  await page.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem('mf-creator-seen', '1'); // the first-run creator (creator/model.ts)
    } catch {
      /* fine */
    }
  });
  await page.goto(`${base}/?app&time=600&bots=0`, { waitUntil: 'load' });
  // the title screen (press any key), then the name, then whatever first-run screens come (skip them) and Training
  await sleep(1500);
  await page.keyboard.press('Enter');
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await sleep(1500);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__game?.mode?.update)); i++) {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      const skip = buttons.find((b) => /^(skip|skip all|not now|later|i'?ve played|veteran)/i.test((b.textContent ?? '').trim()));
      const training = buttons.find((b) => /training/i.test(b.textContent ?? ''));
      (skip ?? training)?.click();
    });
    await sleep(800);
  }
  await page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 90_000 });
  for (let i = 0; i < 16; i++) {
    const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
    if (got) {
      await got.click();
      break;
    }
    await sleep(500);
  }
  await sleep(800);
  // the frame's grenades (a belt worth choosing from) and, on request, extra frame values; the guns are the sim's own
  await page.evaluate(async (content) => {
    try {
      window.__content = await import(/* @vite-ignore */ `/@fs${content}`);
    } catch {
      window.__content = null; // another checkout's server (the before shots): not needed there
    }
    const mode = window.__game.mode;
    const sim = mode.game.players.find((p) => p && p.id === mode.localId);
    if (sim) {
      sim.grenadeCounts = [3, 2, 1, 1, 0, 1];
      sim.alive = true;
    }
    const update = mode.update.bind(mode);
    window.__extra = null;
    window.__hold = false;
    window.__last = null;
    mode.update = (dt) => {
      if (window.__hold && window.__last) return window.__last;
      const f = update(dt);
      const me = f.players.find((p) => p.id === f.localId);
      if (me) Object.assign(me, { hp: 100, alive: true, respawnTicks: 0 });
      if (window.__extra) Object.assign(f, window.__extra(f, me));
      window.__last = f;
      return f;
    };
    window.__game.hud.__live = window.__game.hud.update.bind(window.__game.hud);
  }, CONTENT);
  await page.mouse.move(w * 0.68, h * 0.42);
  await sleep(400);
  return page;
}

const shot = (page, name, clip) => page.screenshot({ path: join(out, `${name}.png`), ...(clip ? { clip } : {}) }).then(() => console.log(`wrote ${name}.png`));
const freeze = (page, at = null) =>
  page.evaluate((at) => {
    window.__hold = true;
    window.__game.hud.update = () => {};
    for (const a of document.getAnimations()) {
      a.pause();
      if (at !== null) a.currentTime = at;
    }
  }, at);
const thaw = (page) =>
  page.evaluate(() => {
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
    window.__game.hud.update = window.__game.hud.__live;
    window.__hold = false;
  });
const state = (page) => page.evaluate(() => document.querySelector('#hud').dataset.activeState ?? '');
const sim = (page) =>
  page.evaluate(() => {
    const m = window.__game.mode;
    const p = m.game.players.find((x) => x && x.id === m.localId);
    return { active: p.active, grenadeType: p.grenadeType, swapTicks: p.swapTicks };
  });
const waitFor = async (page, token, ms = 3000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if ((await state(page)).split(' ').includes(token)) return true;
    await sleep(15);
  }
  return false;
};

/** A real tap of Q: the HUD frozen just as the draw starts, then its frames 16 ms apart. */
async function tapStrip(page, name, clip, count = 30) {
  await page.keyboard.down('KeyQ');
  await sleep(70);
  await page.keyboard.up('KeyQ');
  if (!(await waitFor(page, 'switching'))) problems.push(`${name}: a tap of Q didn't start a draw`);
  await freeze(page);
  for (let i = 0; i < count; i++) {
    await page.evaluate((t) => {
      for (const a of document.getAnimations()) a.currentTime = t;
    }, i * 16);
    await page.screenshot({ path: join(out, 'frames', `${name}-${String(i).padStart(2, '0')}.png`), ...(clip ? { clip } : {}) });
  }
  await thaw(page);
  console.log(`strip ${name}: ${count} frames`);
}

try {
  // ---- before (main as merged, #181): the same tap of Q at 1920×1080
  if (before) {
    const page = await open(before, 1920, 1080);
    await shot(page, 'before-1920-idle');
    await page.keyboard.down('KeyQ');
    await sleep(70);
    await page.keyboard.up('KeyQ');
    await waitFor(page, 'switching');
    await freeze(page, 200);
    await shot(page, 'before-1920-swap');
    await thaw(page);
    await page.close();
  }

  for (const [w, h] of [
    [1920, 1080],
    [1280, 720],
  ]) {
    const page = await open(after, w, h);
    const tag = `${w}x${h}`;
    await shot(page, `${tag}-01-idle-loadout-bar`);
    // a tap: the draw card, frozen 200 ms in, and after the landing
    const was = (await sim(page)).active;
    await page.keyboard.down('KeyQ');
    await sleep(70);
    await page.keyboard.up('KeyQ');
    if (!(await waitFor(page, 'switching'))) problems.push(`${tag}: no draw after a tap`);
    await freeze(page, 200);
    await shot(page, `${tag}-02-tap-drawing`);
    await thaw(page);
    if (!(await waitFor(page, 'drawn', 2000))) problems.push(`${tag}: no landing`);
    await freeze(page, 120);
    await shot(page, `${tag}-03-tap-landed`);
    await thaw(page);
    if ((await sim(page)).active === was) problems.push(`${tag}: the tap didn't swap guns in the sim`);
    await sleep(1500);

    // a hold: the quick-select at the reticle; point at a grenade type and let go
    const g0 = (await sim(page)).grenadeType;
    await page.keyboard.down('KeyQ');
    if (!(await waitFor(page, 'quick-open', 2000))) problems.push(`${tag}: holding Q didn't open the quick-select`);
    await sleep(250);
    await shot(page, `${tag}-04-quick-select-open`);
    const target = await page.evaluate(() => {
      const items = [...document.querySelectorAll('#hud .mf-hud-desktop .mf-qs__item--grenade')];
      const it = items[items.length - 1];
      const r = it.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, name: it.querySelector('b').textContent };
    });
    await page.mouse.move(target.x, target.y, { steps: 6 });
    await sleep(250);
    await shot(page, `${tag}-05-quick-select-grenade`);
    await page.keyboard.up('KeyQ');
    await sleep(600);
    const g1 = (await sim(page)).grenadeType;
    if (g1 === g0) problems.push(`${tag}: picking ${target.name} in the quick-select didn't change the grenade (${g0})`);
    // hold again and take the other gun with the wheel and a click
    const a0 = (await sim(page)).active;
    await page.keyboard.down('KeyQ');
    await waitFor(page, 'quick-open', 2000);
    await page.mouse.wheel({ deltaY: 100 });
    await sleep(120);
    await page.mouse.wheel({ deltaY: -100 });
    await sleep(120);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up('KeyQ');
    await sleep(900);
    if ((await sim(page)).active === a0) problems.push(`${tag}: the wheel + click on the slung gun didn't swap`);
    await page.mouse.move(w * 0.68, h * 0.42);
    await sleep(1200);

    // the frame strip of a tap (the bottom-centre area: the draw card, the loadout bar, the weapon cards)
    await tapStrip(page, `${tag}-strip-swap`, w === 1920 ? { x: 520, y: 520, width: 1400, height: 560 } : { x: 300, y: 330, width: 980, height: 390 });
    await sleep(1500);

    // the other moments, at this size: the ground tags and the compare card, a map event, the kill confirm
    await page.evaluate(() => {
      const c = window.__content;
      const crate = (id) => c.weaponPickup(c.weapons.find((x) => x.id === id).index).index;
      window.__extra = (f, me) => ({ pickups: [{ id: 901, def: crate('k47'), x: me.x, y: me.y }, { id: 902, def: crate('widow'), x: me.x + 6, y: me.y }, { id: 903, def: crate('thumper'), x: me.x + 14, y: me.y }] });
    });
    await sleep(900);
    await shot(page, `${tag}-06-ground-tags-compare`);
    await page.evaluate(() => {
      window.__extra = () => ({ mapEvent: { id: 'surge', kind: 'gravitySurge', name: 'GRAVITY SURGE', description: 'Everything is heavier: jets climb slowly', phase: 'warning', secondsLeft: 2.6, progress: 0.35, color: 0, zones: [], occurrence: 7, bulletRangeMul: 1 } });
    });
    await sleep(900);
    await shot(page, `${tag}-07-event-warning`);
    await page.evaluate(() => {
      window.__extra = () => ({ mapEvent: { id: 'surge', kind: 'gravitySurge', name: 'GRAVITY SURGE', description: 'Everything is heavier: jets climb slowly', phase: 'active', secondsLeft: 11.2, progress: 0.25, color: 0, zones: [], occurrence: 7, bulletRangeMul: 1 } });
    });
    await sleep(1600);
    await shot(page, `${tag}-08-event-active`);
    await page.evaluate(() => (window.__extra = null));
    await sleep(500);
    await page.evaluate(() => {
      const g = window.__game;
      const me = g.mode.localId;
      const others = g.mode.game.players.filter((p) => p && p.id !== me).map((p) => p.id);
      g.hud.onEvents([{ type: 'death', victim: others[0], killer: me, source: 0 }, { type: 'hit', attacker: me, target: others[1] ?? others[0], damage: 90, zone: 1, source: 0 }, { type: 'death', victim: others[1] ?? others[0], killer: me, source: 0 }], me);
    });
    await sleep(250);
    await shot(page, `${tag}-09-kill-confirm`);
    await page.close();
  }
} finally {
  await browser.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('all checks passed');
