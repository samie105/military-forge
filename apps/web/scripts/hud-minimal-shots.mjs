/**
 * The floating HUD bits, the take prompt's button and the gun ring, shot on phones and desktop (owner,
 * 25 Oct: "make them minimal", "if it's square, let it be square", "the X is outside the circle").
 *
 *   node apps/web/scripts/hud-minimal-shots.mjs <url> <out dir> [only-tag]
 *
 * For each size: guns, grenades and the shield on the floor near you (their world tags and the
 * pickup line), a gun underfoot (the compare chip and Take), a kill (the kill line), three of every
 * grenade type (the belt), the gun ring held open (right- and left-handed, a notch), and a controller
 * in play (a DualShock's buttons pressed through a stand-in Gamepad API): its prompt names its button.
 * Checks: the ring's parts sit inside its circle; the take prompt names the control on screen.
 * Exits 1 when a check fails or the page errs. Every step has its own time limit.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5297').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'docs/screenshots/hud-minimal');
const only = process.argv[4] ?? '';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONTENT = fileURLToPath(new URL('../../../packages/content/src/index.ts', import.meta.url));
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const limit = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`timed out: ${what}`)), ms))]);
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: mkdtempSync(join(tmpdir(), 'hud-min-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'], protocolTimeout: 120_000 });

async function open({ w, h, dpr = 1, phone = false, handed = 'right', notch = 0 }) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => {
    const m = `page error: ${(e.stack ?? e.message).split("\n").slice(0, 3).join(" | ")}`;
    if (!problems.includes(m)) problems.push(m);
  });
  const cdp = await page.createCDPSession();
  if (phone) {
    await page.emulate({ viewport: { width: w, height: h, deviceScaleFactor: dpr, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: PHONE_UA });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  } else await page.setViewport({ width: w, height: h, deviceScaleFactor: dpr });
  await page.evaluateOnNewDocument(
    (phone, handed, notch) => {
      // a stand-in Gamepad API: no pad until the script plugs one in (window.__fakePad)
      window.__fakePad = null;
      Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => (window.__fakePad ? [window.__fakePad] : []) });
      try {
        localStorage.setItem('mf-creator-seen', '1');
        if (!phone) localStorage.removeItem('mf.touch.settings.v1');
        if (phone) {
          localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ mode: 'on', handed }));
          localStorage.setItem('mf.touch.drill.v1', 'done');
          localStorage.setItem('mf.touch.hints.v1', JSON.stringify(['dash-swipe', 'grenade-types', 'swap-radial', 'take', 'shield-hold']));
        }
      } catch {
        /* fine */
      }
      // a notch: the safe area's inset on the left (as a phone turned with its notch that way reports it)
      if (notch) {
        const s = document.createElement('style');
        s.textContent = `:root { --sa-l: ${notch}px !important; } .mf-touch-safe { left: ${notch}px !important; } .screen--phone { --safe-l: ${notch}px !important; }`;
        document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s));
      }
    },
    phone,
    handed,
    notch,
  );
  await page.goto(`${base}/?app&time=600&bots=0`, { waitUntil: 'load', timeout: 60_000 });
  for (let i = 0; i < 30 && !(await page.$('input[aria-label="Your name"]')); i++) {
    await sleep(800);
    await page.keyboard.press('Enter').catch(() => {});
    if (phone) await page.touchscreen.tap(w / 2, h * 0.6).catch(() => {});
    else await page.mouse.click(w / 2, h * 0.6).catch(() => {});
  }
  await page.evaluate(() => localStorage.setItem('mf.phone.turnTip.v1', 'seen'));
  await page.waitForSelector('input[aria-label="Your name"]', { timeout: 60_000 });
  await page.type('input[aria-label="Your name"]', `Ade${Math.floor(Math.random() * 900 + 100)}`);
  await sleep(1500);
  await page.keyboard.press('Enter');
  for (let i = 0; i < 60 && !(await page.evaluate(() => !!window.__game?.mode?.update)); i++) {
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
      const skip = buttons.find((b) => /^(skip|skip all|not now|later|i'?ve played|veteran|continue)/i.test((b.textContent ?? '').trim()));
      const training = buttons.find((b) => /training/i.test(b.textContent ?? ''));
      (skip ?? training)?.click();
    });
    await sleep(800);
  }
  await page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 90_000 });
  for (let i = 0; i < 16; i++) {
    const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
    if (got) {
      await got.click().catch(() => {});
      break;
    }
    await sleep(500);
  }
  await sleep(800);
  await page.evaluate(async (content) => {
    window.__content = await import(/* @vite-ignore */ `/@fs${content}`);
    const mode = window.__game.mode;
    const update = mode.update.bind(mode);
    window.__extra = null;
    mode.update = (dt) => {
      const p = mode.game.players.find((x) => x && x.id === mode.localId);
      // three of every grenade type (the 25 Oct spawn rule)
      if (p) p.grenadeCounts = p.grenadeCounts.map(() => 3);
      const f = update(dt);
      const me = f.players.find((x) => x.id === f.localId);
      if (me) Object.assign(me, { hp: 100, alive: true, respawnTicks: 0 });
      if (window.__extra && me) Object.assign(f, window.__extra(f, me));
      return f;
    };
  }, CONTENT);
  await sleep(600);
  return { page, cdp };
}

const has = (page, token) => page.evaluate((t) => (document.querySelector('#hud')?.dataset.activeState ?? '').split(' ').includes(t), token);
const until = async (page, token, ms = 3000) => {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (await has(page, token)) return true;
    await sleep(20);
  }
  return false;
};
const shot = (page, name) => page.screenshot({ path: join(out, `${name}.png`) }).then(() => console.log(`wrote ${name}.png`));

/** Items on the floor near you: a gun 2.5 m right, a frag pair 2 m left, the shield 5 m right, a gun 9 m left. */
async function floor(page, tag) {
  await page.evaluate(() => {
    const c = window.__content;
    const gun = (id) => c.weaponPickup(c.weapons.find((x) => x.id === id).index).index;
    const pair = (id) => c.pickups.findIndex((p) => p.kind === 'grenades' && c.grenades[p.grenade]?.id === id);
    const shield = c.pickups.findIndex((p) => p.kind === 'shield' || /shield/i.test(p.name));
    window.__extra = (f, me) => ({
      pickups: [
        { id: 911, def: gun('k47'), x: me.x + 2.5, y: me.y },
        { id: 912, def: pair('frag'), x: me.x - 2, y: me.y },
        { id: 913, def: shield, x: me.x + 5, y: me.y },
        { id: 914, def: gun(c.weapons.find((x) => x.id !== 'k47' && x.fireMode !== 'melee' && c.weaponPickup(x.index))?.id ?? 'k47'), x: me.x - 9, y: me.y },
      ],
    });
  });
  await sleep(900);
  await shot(page, `${tag}-floor`);
  // a grenade pair close by: its line
  await page.evaluate(() => {
    const c = window.__content;
    const pair = (id) => c.pickups.findIndex((p) => p.kind === 'grenades' && c.grenades[p.grenade]?.id === id);
    window.__extra = (f, me) => ({ pickups: [{ id: 921, def: pair('smoke'), x: me.x + 1.2, y: me.y }] });
  });
  await sleep(700);
  await shot(page, `${tag}-grenade-pair`);
  await page.evaluate(() => (window.__extra = null));
}

/** A gun underfoot: the compare chip, Take (phone) or the crate card (desktop). */
async function crate(page, tag) {
  await page.evaluate(() => {
    const c = window.__content;
    const gun = (id) => c.weaponPickup(c.weapons.find((x) => x.id === id).index).index;
    window.__extra = (f, me) => ({ pickups: [{ id: 901, def: gun('k47'), x: me.x, y: me.y }] });
  });
  if (!(await until(page, 'pickup-crate', 3000))) problems.push(`${tag}: no crate card`);
  await sleep(600);
  await shot(page, `${tag}-crate`);
  const said = await promptCheck(page, tag);
  await page.evaluate(() => (window.__extra = null));
  await sleep(500);
  return said;
}

/**
 * The take prompt names the control on screen: on touch, the Take button's own word; with keys, the
 * key; with a pad, the pad's button. Reads what's drawn, so it holds whatever wrote it.
 */
async function promptCheck(page, tag) {
  const r = await page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const phone = document.querySelector('#hud .mf-hud-phone');
    const onPhone = vis(phone);
    const scope = onPhone ? phone : document.querySelector('#hud .mf-hud-desktop');
    const caps = [...scope.querySelectorAll('[data-take-cap]')].filter(vis).map((e) => ({ text: (e.textContent ?? '').trim(), pad: e.dataset.padCode ?? '', label: e.getAttribute('aria-label') ?? '' }));
    const button = document.querySelector('.mf-ctl-take');
    const buttonWord = vis(button) ? (button.querySelector('.mf-cap')?.textContent ?? '').trim() : '';
    // the desktop card's key ring holds its cap (a pad's HOLD and button too)
    const ring = scope.querySelector('.mf-takekey');
    let keySpill = false;
    if (vis(ring)) {
      const o = ring.getBoundingClientRect();
      keySpill = [...ring.querySelectorAll('*')].some((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.left < o.left - 0.5 || r.right > o.right + 0.5 || r.top < o.top - 0.5 || r.bottom > o.bottom + 0.5);
      });
    }
    return { onPhone, input: document.documentElement.dataset.input ?? '', caps, buttonWord, keySpill };
  });
  console.log(`${tag}: take prompt`, JSON.stringify(r));
  if (r.keySpill) problems.push(`${tag}: the take key spills out of its ring`);
  return r;
}

/** Hold the gun pill (phone) or Q (desktop): the ring opens; its parts must sit inside its circle. */
async function ring(page, cdp, tag, phone) {
  if (phone) {
    const pill = await page.evaluate(() => {
      const r = document.querySelector('.mf-ctl-swap').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pill.x, y: pill.y, radiusX: 8, radiusY: 8, force: 1, id: 3 }] });
    await sleep(800);
    const geo = await page.evaluate(() => {
      const box = (e) => {
        const r = e.getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom, cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
      };
      const radial = document.querySelector('.mf-radial');
      const o = radial.getBoundingClientRect();
      const ring = getComputedStyle(radial, '::before');
      const x = getComputedStyle(radial, '::after');
      const button = box(document.querySelector('.mf-ctl-swap .mf-skin'));
      const items = [...document.querySelectorAll('.mf-radial__it')].map(box);
      return { centre: { x: o.left, y: o.top }, ringR: parseFloat(ring.width) / 2 || 0, xSize: parseFloat(x.width) || 0, button, items, vw: innerWidth, vh: innerHeight };
    });
    await shot(page, `${tag}-ring`);
    if (geo.items.length < 2) problems.push(`${tag}: the ring didn't open`);
    for (const it of geo.items) if (it.l < 0 || it.t < 0 || it.r > geo.vw || it.b > geo.vh) problems.push(`${tag}: a ring choice runs off screen`);
    if (!(geo.ringR > 0)) problems.push(`${tag}: no ring drawn`);
    // the X sits in the ring's middle, on the swap button's centre
    const off = Math.hypot(geo.button.cx - geo.centre.x, geo.button.cy - geo.centre.y);
    if (off > 2) problems.push(`${tag}: the ring's middle is ${off.toFixed(1)} px off the swap button's centre`);
    if (geo.xSize / 2 > geo.ringR) problems.push(`${tag}: the X is bigger than the ring`);
    // every choice, corners and all, inside the ring
    for (const it of geo.items) {
      const far = Math.max(...[[it.l, it.t], [it.r, it.t], [it.l, it.b], [it.r, it.b]].map(([x, y]) => Math.hypot(x - geo.centre.x, y - geo.centre.y)));
      if (far > geo.ringR + 1) problems.push(`${tag}: a ring choice reaches ${far.toFixed(0)} px out, the ring ${geo.ringR.toFixed(0)}`);
    }
    console.log(`${tag}: ring`, JSON.stringify(geo));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await sleep(600);
  } else {
    const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await page.mouse.move(w * 0.55, h * 0.45);
    await page.keyboard.down('KeyQ');
    if (!(await until(page, 'quick-open', 2500))) problems.push(`${tag}: the quick-select didn't open`);
    await sleep(400);
    await shot(page, `${tag}-ring`);
    const spill = await page.evaluate(() => {
      const hub = document.querySelector('#hud .mf-hud-desktop .mf-qs__hub').getBoundingClientRect();
      return [...document.querySelectorAll('#hud .mf-hud-desktop .mf-qs__hub *')].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && (r.left < hub.left - 0.5 || r.right > hub.right + 0.5 || r.top < hub.top - 0.5 || r.bottom > hub.bottom + 0.5);
      }).length;
    });
    if (spill) problems.push(`${tag}: ${spill} part(s) of the quick-select's hub spill out of it`);
    await page.keyboard.up('KeyQ');
    await sleep(800);
  }
}

/** A kill: the kill line. */
async function kill(page, tag) {
  await page.evaluate(() => {
    const g = window.__game;
    const m = g.mode;
    const other = m.game.players.find((x) => x && x.id !== m.localId);
    g.hud.setNames(new Map([[m.localId, 'Ade'], [other?.id ?? 99, 'Strafer']]));
    g.hud.onEvents([{ type: 'death', killer: m.localId, victim: other?.id ?? 99, source: 1 }, { type: 'kill', killer: m.localId, victim: other?.id ?? 99, source: 1, assists: [], streak: 1 }], m.localId);
  });
  await sleep(500);
  await shot(page, `${tag}-kill`);
}

/** A DualShock 4 plugged in and a button pressed: the prompts turn to its buttons. */
async function pad(page, tag) {
  await page.evaluate(() => {
    const buttons = Array.from({ length: 18 }, () => ({ pressed: false, touched: false, value: 0 }));
    window.__fakePad = { id: 'Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)', index: 0, connected: true, mapping: 'standard', timestamp: performance.now(), axes: [0, 0, 0, 0], buttons, vibrationActuator: null };
    window.dispatchEvent(Object.assign(new Event('gamepadconnected'), { gamepad: window.__fakePad }));
  });
  await sleep(300);
  // press and let go of D-pad right (next grenade): harmless, and it makes the pad the device
  await page.evaluate(() => Object.assign(window.__fakePad.buttons[15], { pressed: true, value: 1 }));
  await sleep(200);
  await page.evaluate(() => Object.assign(window.__fakePad.buttons[15], { pressed: false, value: 0 }));
  await sleep(400);
  const said = await crate(page, `${tag}-pad`);
  await page.evaluate(() => {
    window.__fakePad = null;
    window.dispatchEvent(new Event('gamepaddisconnected'));
  });
  await sleep(400);
  return said;
}

const runs = [
  { tag: 'phone-812x375', w: 812, h: 375, dpr: 2, phone: true },
  { tag: 'phone-740x360', w: 740, h: 360, dpr: 2, phone: true },
  { tag: 'phone-915x412', w: 915, h: 412, dpr: 2, phone: true },
  { tag: 'phone-812x375-left-notch', w: 812, h: 375, dpr: 2, phone: true, handed: 'left', notch: 47, ringOnly: true },
  { tag: 'desktop-1280x720', w: 1280, h: 720 },
];
try {
  for (const v of runs) {
    if (only && !v.tag.includes(only)) continue;
    const { page, cdp } = await limit(open(v), 180_000, `${v.tag} open`);
    if (v.phone) await page.waitForSelector('.mf-ctl-swap', { timeout: 30_000 });
    await limit(ring(page, cdp, v.tag, v.phone), 40_000, `${v.tag} ring`);
    if (!v.ringOnly) {
      await limit(floor(page, v.tag), 30_000, `${v.tag} floor`);
      const said = await limit(crate(page, v.tag), 30_000, `${v.tag} crate`);
      if (v.phone && said.buttonWord && !said.caps.some((c) => c.text === said.buttonWord)) problems.push(`${v.tag}: the take prompt says ${JSON.stringify(said.caps)}, the button says "${said.buttonWord}"`);
      await limit(kill(page, v.tag), 20_000, `${v.tag} kill`);
      const padSaid = await limit(pad(page, v.tag), 30_000, `${v.tag} pad`);
      if (padSaid.input === 'pad' && !padSaid.caps.some((c) => c.pad)) problems.push(`${v.tag}: with a pad in play the take prompt shows ${JSON.stringify(padSaid.caps)}, not the pad's button`);
    }
    await page.close();
  }
} catch (e) {
  problems.push(String(e?.message ?? e));
} finally {
  await browser.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('all checks passed');
