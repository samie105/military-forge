/* global process */
/**
 * Tall maps (maps-vertical, NOTES §48): the minimap, the big map and the flight lean in a real
 * training match, and what a big map costs, on a desktop or a phone-sized screen.
 *   cd apps/web && pnpm exec vite --port 5197 --strictPort
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/tall-map-shots.mjs [--base http://127.0.0.1:5197]
 *     [--out <dir>] [--map vertical-test] [--bots 6] [--phone] [--cpu 4] [--hw] [--seconds 20] [--shots] [--name tag]
 * Prints: the nav graph's idle-time build (navWarm.ts: wall and work ms, slices, the longest slice),
 * how long training took to start, then every 5 s the 3D view's frame times, draws and triangles,
 * the main thread's long tasks (> 50 ms) and the JS heap. Headless Chrome can't throttle the GPU:
 * with --hw it renders on this machine's GPU, without it in software GL. --cpu slows the CPU the
 * way DevTools does (4: a mid phone).
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://127.0.0.1:5197');
const out = resolve(arg('out', '.'));
const mapId = arg('map', 'vertical-test');
const bots = Number(arg('bots', '6'));
const cpu = Number(arg('cpu', '1'));
const seconds = Number(arg('seconds', '20'));
const phone = process.argv.includes('--phone');
const hw = process.argv.includes('--hw');
const shots = process.argv.includes('--shots');
const name = arg('name', phone ? 'phone' : 'desktop');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';

mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'tall-map-')),
  args: [...(hw ? ['--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']), '--enable-precise-memory-info'],
  protocolTimeout: 600_000,
});
try {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|\/api\/|WebSocket/.test(m.text())) problems.push(`console error: ${m.text()}`);
  });
  const cdp = await page.createCDPSession();
  if (phone) {
    await page.emulate({ viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true }, userAgent: PHONE_UA });
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'pointer', value: 'coarse' }, { name: 'any-pointer', value: 'coarse' }, { name: 'hover', value: 'none' }] });
  } else await page.setViewport({ width: 1920, height: 1080 });
  await page.evaluateOnNewDocument(() => {
    // a dev server serves hundreds of modules: room for every resource entry (the map art is counted at the end)
    performance.setResourceTimingBufferSize(20000);
    window.__long = [];
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__long.push({ at: e.startTime, ms: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(`${base}/?app&map=${mapId}&bots=${bots}&time=600`, { waitUntil: 'load' });
  if (phone) {
    await page.evaluate(() => {
      localStorage.setItem('mf.touch.settings.v1', JSON.stringify({ mode: 'on' }));
      localStorage.setItem('mf.touch.drill.v1', 'done');
      localStorage.setItem('mf.touch.hints.v1', JSON.stringify(['dash-swipe', 'grenade-types', 'swap-radial', 'take', 'shield-hold']));
    });
    await page.reload({ waitUntil: 'load' });
  }
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await page.waitForFunction(() => window.__game?.shell?.controller, { timeout: 120_000 });
  // the idle-time nav build has the menus to run in (navWarm.ts: a worker)
  // (--cold: straight in, as before navWarm.ts: training's bots build the graph on its first frame)
  const cold = process.argv.includes('--cold');
  for (let i = 0; i < 240 && !cold && !(await page.evaluate(() => !!window.__navWarm)); i++) await sleep(500);
  const warm = await page.evaluate(() => window.__navWarm ?? null);
  const t0 = Date.now();
  await page.evaluate(() => { window.__long.length = 0; window.__game.shell.controller.go({ to: 'training' }); });
  await page.waitForFunction(() => window.__game?.mode?.update && window.__game.mode.me, { timeout: 120_000 });
  const startMs = Date.now() - t0;
  const firstFrames = await page.evaluate(() => window.__long.filter((e) => e.ms > 50).map((e) => Math.round(e.ms)).slice(-6));
  // the title screen over it: any key
  await sleep(800);
  await page.keyboard.press('Enter');
  await page.mouse.click(phone ? 400 : 960, phone ? 180 : 500);
  await page.waitForSelector('#hud[data-active-state~="match"]', { timeout: 120_000 }).catch(() => {});
  for (let i = 0; i < 12; i++) {
    const got = await page.$('xpath/.//button[contains(normalize-space(.), "Got it")]');
    if (got) {
      await got.click();
      break;
    }
    await sleep(500);
  }
  await page.evaluate(() => (window.__long.length = 0));
  console.log(`${name}: ${mapId}, ${bots} bots, ${phone ? '812×375 phone (dpr 2, touch)' : '1920×1080'}${cpu > 1 ? `, CPU ×${cpu} slower` : ''}, ${hw ? "this machine's GPU" : 'software GL'}`);
  console.log(
    `  nav graph before training (${warm?.how ?? "?"}): ${warm ? `${warm.wallMs.toFixed(0)} ms wall, ${warm.workMs.toFixed(0)} ms of build, the page busy ${warm.longestMs.toFixed(1)} ms at most` : "not reported"} · training started in ${startMs} ms (long tasks then: ${firstFrames.join(', ') || 'none'} ms)`,
  );
  const report = async (label) => {
    const s = await page.evaluate(() => {
      const v = window.__game.view3d?.stats?.() ?? null;
      const long = window.__long.splice(0);
      const mem = performance.memory ? performance.memory.usedJSHeapSize / 1e6 : 0;
      return { v, long, mem };
    });
    const v = s.v;
    const longest = s.long.reduce((m, e) => Math.max(m, e.ms), 0);
    console.log(
      `  ${label}: ${v ? `${v.preset} · ${v.width}×${v.height} · frame p50 ${v.frameP50.toFixed(1)} / p90 ${v.frameP90.toFixed(1)} / p99 ${v.frameP99.toFixed(1)} ms · cpu ${v.cpuMean.toFixed(2)} ms · ${v.calls} draws · ${(v.triangles / 1000).toFixed(0)}K tris` : '2D'} · long tasks ${s.long.length} (longest ${longest.toFixed(0)} ms) · heap ${s.mem.toFixed(0)} MB`,
    );
  };
  for (let t = 5; t <= seconds; t += 5) {
    await sleep(5000);
    await report(`${String(t).padStart(3)} s`);
  }

  if (shots) {
    const shot = async (file) => {
      await sleep(400);
      await page.screenshot({ path: join(out, `${name}-${file}.png`) });
      console.log(`  ${join(out, `${name}-${file}.png`)}`);
    };
    // on the second tier, then climbing an updraft, then falling from high up (any tall map)
    const place = (what) =>
      page.evaluate((what) => {
        const m = window.__game.mode;
        const map = m.map;
        const tiers = map.tiers ?? [{ y: map.spawns[0].y }, { y: map.spawns[0].y }];
        const up = (map.zones ?? []).find((z) => z.kind === 'updraft');
        const mid = (map.bounds.minX + map.bounds.maxX) / 2;
        if (what === 'tier') {
          const s = map.spawns.find((p) => Math.abs(p.y - tiers[1].y) < 1) ?? map.spawns[0];
          Object.assign(m.me, { x: s.x, y: s.y + 0.05, vx: 0, vy: 0 });
        } else if (what === 'climb') Object.assign(m.me, { x: up ? (up.rect[0] + up.rect[2]) / 2 : mid, y: tiers[1].y + 5, vy: 6 });
        else Object.assign(m.me, { x: mid + 4, y: tiers[tiers.length - 1].y + 8, vy: -12 });
      }, what);
    await place('tier');
    await sleep(1200);
    await shot('minimap-tier2');
    await place('climb');
    await sleep(700);
    await shot('climbing-updraft');
    await place('fall');
    await sleep(500);
    await shot('falling');
    await sleep(2500);
    // the big map
    if (phone) {
      const r = await page.evaluate(() => {
        const b = document.querySelector('.mf-mm--small').getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await page.touchscreen.tap(r.x, r.y);
    } else await page.keyboard.press('KeyM');
    await sleep(600);
    await shot('big-map');
    if (phone) {
      await page.evaluate(() => document.querySelector('.mf-mm--big .mf-mm__btn:last-child').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })));
    } else await page.keyboard.press('KeyM');
  }
  // the map art this page fetched (kits, painted backdrops, billboards): what a first load of the map costs
  const art = await page.evaluate(() => {
    const sum = { kits: 0, backdrops: 0, ads: 0, files: 0 };
    for (const e of performance.getEntriesByType('resource')) {
      const m = /\/assets\/(kits|backdrops|ads)\//.exec(e.name);
      if (!m) continue;
      sum[m[1]] += e.encodedBodySize || e.transferSize || 0;
      sum.files++;
    }
    return sum;
  });
  console.log(`  map art fetched: ${art.files} files, kits ${(art.kits / 1024).toFixed(0)} KB, backdrops ${(art.backdrops / 1024).toFixed(0)} KB, ads ${(art.ads / 1024).toFixed(0)} KB, total ${((art.kits + art.backdrops + art.ads) / 1024).toFixed(0)} KB`);
  if (problems.length) console.log(`  problems:\n    ${problems.slice(0, 10).join('\n    ')}`);
} finally {
  await browser.close();
}
