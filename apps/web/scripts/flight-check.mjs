/**
 * First flight's checks (docs/design/onboarding-research.md §7, phase 3) in headless Chrome on the real
 * app, against a running dev server. No API is needed (the app takes an offline name):
 *
 *   node apps/web/scripts/flight-check.mjs http://127.0.0.1:5191 [screenshot dir]
 *
 * - The Briefing follows "Create your soldier" the first time; Change cycles the device; Recruit starts
 *   First flight.
 * - Each of the five goals ticks by doing it with the keyboard and mouse (the player's default keys),
 *   then the finish card offers Live fire.
 * - Nothing moves on by itself: 21 s idle on a goal leaves it there, with help and "Skip this" offered.
 * - A reload part-way resumes at the next goal; Skip training ends it for good.
 * - A phone held sideways: the fire-mode chooser comes first, then the ring sits on the move dial
 *   (touchControlRect) within 1 px.
 * Exits 1 on any failure.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://127.0.0.1:5173';
const out = process.argv[3] ?? null;
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (out) mkdirSync(out, { recursive: true });

let failures = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (page, name) => out && page.screenshot({ path: join(out, `${name}.png`) });

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', userDataDir: mkdtempSync(join(tmpdir(), 'flight-')), args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });

/** The callout's title now ('' when none shows). */
const title = (page) => page.evaluate(() => (document.querySelector('.mf-spot:not([hidden]) .mf-spot__title')?.textContent ?? '').trim());
/** Waits until the callout's title is `want` (or one of them). */
async function until(page, want, ms = 30_000) {
  const wants = [want].flat();
  const end = Date.now() + ms;
  let t = '';
  while (Date.now() < end) {
    t = await title(page);
    if (wants.includes(t)) return t;
    await sleep(100);
  }
  return t;
}
/** The centre of the last ring (the world marker's) in page px. */
const lastRing = (page) =>
  page.evaluate(() => {
    const rings = [...document.querySelectorAll('.mf-spot__ring')];
    const r = rings[rings.length - 1]?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
  });

/** Past the name screen when it shows (a new guest, or an offline name without the API). */
async function pastName(page) {
  const input = await page.waitForSelector('input[aria-label="Your name"], [data-screen="home"]', { timeout: 90_000 });
  if (!(await input.evaluate((el) => el.tagName === 'INPUT'))) return;
  await sleep(500);
  await page.type('input[aria-label="Your name"]', `Tester${Math.floor(Math.random() * 900 + 100)}`);
  await page.keyboard.press('Enter');
}

/** A fresh page in the app (the creator already seen), past the name screen. */
async function appPage(viewport, query = '') {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  page.on('pageerror', (e) => check('no page error', false, e.message));
  await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('mf-creator-seen', '1');
  });
  await page.goto(`${base}/?app${query}`, { waitUntil: 'load' });
  await pastName(page);
  return page;
}

try {
  // ---- the five goals, by doing them (1280×720, keyboard and mouse)
  {
    const page = await appPage({ width: 1280, height: 720 }, '&flight');
    check('First flight starts (?flight): Run', (await until(page, 'Run.', 90_000)) === 'Run.');
    await sleep(600);
    const caps = await page.evaluate(() => [...document.querySelectorAll('.mf-spot__keys kbd')].map((k) => k.textContent));
    check('Run shows the player\'s own keys', caps.join(' ') === 'A D', caps.join(' '));
    await shot(page, 'd1-run');
    await page.keyboard.down('KeyA');
    const t1 = await until(page, 'Fly.', 10_000);
    await page.keyboard.up('KeyA');
    check('Run ticks by running 3 m', t1 === 'Fly.', t1);
    await sleep(400);
    const fly = await page.evaluate(() => ({ rings: document.querySelectorAll('.mf-spot__ring').length, fuel: !!document.querySelector('[data-tour="fuel"]') }));
    check('Fly rings the fuel plate and the marker', fly.rings === 2 && fly.fuel, JSON.stringify(fly));
    await shot(page, 'd2-fly');
    await page.keyboard.down('KeyW');
    const t2 = await until(page, 'Fire.', 10_000);
    await page.keyboard.up('KeyW');
    check('Fly ticks by flying 3.5 m up', t2 === 'Fire.', t2);
    await sleep(1500); // land
    await shot(page, 'd3-fire');
    let t3 = '';
    // aim at the ring the way a hand does: the view leans toward the pointer, so settle, look again, fire
    for (let i = 0; i < 40 && t3 !== 'Dash.'; i++) {
      for (let k = 0; k < 3; k++) {
        const p = await lastRing(page);
        if (p) await page.mouse.move(p.x, p.y);
        await sleep(250);
      }
      if (i === 0) await shot(page, 'd3-fire-aimed');
      await page.mouse.down();
      await sleep(100);
      await page.mouse.up();
      if (i % 6 === 5) await page.keyboard.press('KeyR'); // a pistol holds 6
      await sleep(200);
      t3 = await title(page);
    }
    check('Fire ticks on 3 hits on the target', t3 === 'Dash.', t3);
    await shot(page, 'd4-dash');
    await page.keyboard.down('KeyD');
    await page.keyboard.press('ShiftLeft');
    await page.keyboard.up('KeyD');
    const t4 = await until(page, 'Throw.', 5_000);
    check('Dash ticks on a dash', t4 === 'Throw.', t4);
    await shot(page, 'd5-throw');
    const p = await lastRing(page);
    if (p) await page.mouse.move(p.x, p.y);
    await page.keyboard.press('KeyG');
    const t5 = await until(page, 'Flight complete', 5_000);
    check('Throw ticks on a throw; the finish card follows', t5 === 'Flight complete', t5);
    await sleep(400);
    const done = await page.evaluate(() => ({
      primary: document.querySelector('.mf-spot__primary')?.textContent,
      later: document.querySelector('.mf-spot__skip')?.textContent,
      stamp: document.querySelector('.mf-spot__stamp')?.textContent,
      log: JSON.parse(localStorage.getItem('mf.log.v1') ?? '[]').filter((e) => e.t === 'tour.end').map((e) => e.result),
    }));
    check('the finish card: Live fire and Later, stamped Confirmed', done.primary === 'Live fire' && done.later === 'Later' && done.stamp === 'Confirmed', JSON.stringify(done));
    check('the log has tour.end finished', done.log.includes('finished'), done.log.join());
    await shot(page, 'd6-done');
    await page.close();
  }

  // ---- nothing moves on by itself; a reload resumes; Skip training ends it
  {
    const page = await appPage({ width: 1280, height: 720 }, '&flight');
    await until(page, 'Run.', 90_000);
    await page.keyboard.down('KeyA');
    await until(page, 'Fly.', 10_000);
    await page.keyboard.up('KeyA');
    await sleep(21_000);
    const idle = await page.evaluate(() => {
      const help = document.querySelector('.mf-spot__help');
      return { title: document.querySelector('.mf-spot__title')?.textContent, timeout: document.querySelector('.mf-spot')?.classList.contains('is-timeout'), skip: document.querySelector('.mf-spot__skip')?.textContent, help: help ? getComputedStyle(help).display : 'missing' };
    });
    // the strip (mobile audit P1-1) keeps one line: the time-out marks it, Skip stays its one link
    check('21 s idle: still on Fly, the time-out marked, Skip offered', idle.title === 'Fly.' && idle.timeout && idle.skip === 'Skip', JSON.stringify(idle));
    await shot(page, 'd7-help');
    await page.goto(`${base}/?app`, { waitUntil: 'load' });
    await pastName(page);
    const resumed = await until(page, 'Fly.', 90_000);
    check('a reload resumes at the next goal', resumed === 'Fly.', resumed);
    await sleep(500);
    await page.evaluate(() => [...document.querySelectorAll('.mf-spot__skip')].find((b) => b.textContent === 'Skip training')?.click());
    await sleep(1200);
    const after = await page.evaluate(() => ({ home: !!document.querySelector('[data-screen="home"]'), tour: JSON.parse(localStorage.getItem('mf.tour.v1') ?? '{}')['first-flight'] }));
    check('Skip training: Home, the tour closed for good', after.home && after.tour?.skippedAll === true && after.tour?.open === false, JSON.stringify(after));
    await page.goto(`${base}/?app`, { waitUntil: 'load' });
    await sleep(4000);
    check('…and a reload stays on Home', (await title(page)) === '', await title(page));
    await page.close();
  }

  // ---- the Briefing after "Create your soldier" (first time on this device)
  {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    page.on('pageerror', (e) => check('no page error', false, e.message));
    await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${base}/?app`, { waitUntil: 'load' });
    await page.waitForSelector('input[aria-label="Your name"]', { timeout: 90_000 });
    await page.type('input[aria-label="Your name"]', 'Recruit7');
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-screen="creator"] [data-action="skip"]', { timeout: 30_000 });
    await sleep(800);
    await page.click('[data-screen="creator"] [data-action="skip"]');
    await page.waitForSelector('[data-screen="briefing"]', { timeout: 15_000 });
    await sleep(900);
    const b = await page.evaluate(() => ({ q: document.querySelector('.mf-br__q')?.textContent, device: document.querySelector('[data-device]')?.textContent, focus: document.activeElement?.dataset.answer }));
    check('the Briefing follows Create your soldier', b.q === 'First time in a firefight?' && b.focus === 'recruit', JSON.stringify(b));
    await shot(page, 'd0-briefing');
    await page.click('[data-action="change"]');
    const changed = await page.evaluate(() => document.querySelector('[data-device]')?.textContent);
    check('Change cycles the device', changed !== b.device, `${b.device} → ${changed}`);
    await page.click('[data-action="change"]');
    await page.click('[data-action="change"]'); // back round to the detected one
    await page.click('[data-answer="recruit"]');
    const started = await until(page, 'Run.', 30_000);
    check('Recruit starts First flight', started === 'Run.', started);
    const answer = await page.evaluate(() => JSON.parse(localStorage.getItem('mf.log.v1') ?? '[]').find((e) => e.t === 'briefing.answer'));
    check('the answer is logged', answer?.answer === 'recruit' && answer?.changed === false, JSON.stringify(answer));
    await page.close();
  }

  // ---- a phone held sideways: the fire chooser first, then the ring on the move dial
  {
    const page = await appPage({ width: 812, height: 375, isMobile: true, hasTouch: true, deviceScaleFactor: 2, isLandscape: true }, '&flight');
    const chooser = await page.waitForSelector('.mf-choose:not([hidden])', { timeout: 90_000 }).catch(() => null);
    check('phone: the fire-mode chooser comes first', !!chooser);
    check('phone: the tour waits under it', (await title(page)) === '', await title(page));
    if (out) await shot(page, 'p0-chooser');
    await page.evaluate(() => document.querySelector('.mf-choose [data-fire="auto"]')?.click());
    const t = await until(page, 'Run.', 15_000);
    check('phone: Run after the chooser', t === 'Run.', t);
    await sleep(900);
    const geo = await page.evaluate(() => {
      document.querySelectorAll('.mf-spot__ring').forEach((r) => r.getAnimations().forEach((a) => a.finish()));
      const dial = window.__touch?.touchControlRect('move');
      const ring = document.querySelector('.mf-spot__ring')?.getBoundingClientRect();
      const body = document.querySelector('.mf-spot__body')?.textContent;
      return { dial, ring: ring && { left: ring.left, top: ring.top, w: ring.width, h: ring.height }, body, rotated: document.documentElement.classList.contains('mf-rotated') };
    });
    const off = geo.dial && geo.ring ? Math.max(Math.abs(geo.ring.left - (geo.dial.left - 6)), Math.abs(geo.ring.top - (geo.dial.top - 6))) : Infinity;
    check('phone: the ring sits on the move dial within 1 px', off <= 1, `off by ${off.toFixed?.(2) ?? off}`);
    check('phone: the words name the stick', /left stick/.test(geo.body ?? ''), geo.body);
    await shot(page, 'p1-run');
    await page.close();
  }
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : 'all First flight checks passed');
process.exit(failures ? 1 : 0);
