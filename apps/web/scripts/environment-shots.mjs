/* global process */
/**
 * Map environment screenshots (Street Market) on a stepped clock, and the map's frame-time /
 * draw-call measurement with six players and explosions.
 *   cd apps/web && pnpm exec vite --port 5198 --strictPort        # in another shell
 *   node apps/web/scripts/environment-shots.mjs [--base http://localhost:5198] [--out docs/screenshots/environments]
 *        [--prefix after-] [--query '&env=off'] [--gfx low] [--hw] [--only wide,mid]
 *   node apps/web/scripts/environment-shots.mjs --gpu [--size 1920x1080] [--gfx low|high] [--map street-market] [--uncapped]
 *
 * Screenshots run the game on a virtual clock (requestAnimationFrame and performance.now are
 * replaced once the 3D view is ready) so every run gives the same frames, however slow software GL
 * is. `--hw` takes them on the GPU (High's MSAA and shadow map are slow on SwiftShader).
 *
 * --only audit (only when asked for): a 7x overview and two gameplay-zoom views, with the camera,
 * the collision and the decor boxes dumped next to each shot for scripts/bullet-audit.py (what
 * stops bullets vs what only looks solid).
 *
 * --gpu uses the machine's GPU on a real clock and only measures: five scripted players jet-strafe
 * around the local player, who fires the Buzz and throws a frag every 0.6 s for 8 s; then frame
 * interval, GPU time (timer query) and draw calls over the last 240 frames.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5198');
const out = resolve(arg('out', 'docs/screenshots/environments'));
const prefix = arg('prefix', '');
const extra = arg('query', '');
const mapId = arg('map', 'street-market');
const only = arg('only', '')
  .split(',')
  .filter(Boolean);
const gpu = process.argv.includes('--gpu');
const hw = gpu || process.argv.includes('--hw');
/** --uncapped: no vsync and no frame-rate limit, so the frame interval is the real cost of a frame */
const uncapped = process.argv.includes('--uncapped');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'environment-shots-')),
  args: hw
    ? ['--enable-gpu', '--ignore-gpu-blocklist', ...(uncapped ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])]
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

/** Installed before the page's scripts: a clock the script can stop and step (window.__clock). */
function installClock() {
  const realNow = performance.now.bind(performance);
  const realRaf = window.requestAnimationFrame.bind(window);
  let virtual = false;
  let now = 0;
  const queue = [];
  performance.now = () => (virtual ? now : realNow());
  window.requestAnimationFrame = (cb) => {
    if (!virtual) return realRaf(cb);
    queue.push(cb);
    return queue.length;
  };
  window.__clock = {
    stop() {
      now = realNow();
      virtual = true;
      return new Promise((resolve) => realRaf(() => resolve()));
    },
    flush() {
      return new Promise((resolve) => realRaf(() => resolve()));
    },
    step(frames = 1, ms = 1000 / 60) {
      for (let i = 0; i < frames; i++) {
        now += ms;
        for (const cb of queue.splice(0)) cb(now);
      }
    },
  };
}

async function open(query, viewport, { clock = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  if (clock) await page.evaluateOnNewDocument(installClock);
  page.on('pageerror', (e) => console.error('[page]', e.message));
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && console.error(`[console.${m.type()}]`, m.text()));
  await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  for (let i = 0; i < 180 && !(await page.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
  await page.evaluate(() => {
    document.getElementById('panel').style.display = 'none';
    document.getElementById('bar').style.display = 'none';
    document.getElementById('perf3d')?.remove();
    window.__game.view3d.pinScale(1);
  });
  return page;
}

const step = (page, frames) => page.evaluate((n) => window.__clock.step(n), frames);

/** The local player at (x, y) holding `loadout`, every other player removed, the camera settled. */
async function place(page, x, y, loadout = [1, 0]) {
  await page.evaluate(
    ({ x, y, loadout }) => {
      const m = window.__game.mode;
      for (const p of m.game.players) if (p && p !== m.me) m.game.removePlayer(p.id);
      m.setLoadout(loadout);
      m.me.spawn(x, y, m.game.tuning);
      m.me.frags = 3;
    },
    { x, y, loadout },
  );
  await step(page, 90);
}

/** Scripted players (sim dummies) at the given feet positions. */
async function addPlayers(page, list) {
  await page.evaluate((list) => {
    const m = window.__game.mode;
    for (const d of list) m.game.addDummy(d);
  }, list);
}

/** Mouse at an offset from the local player's shoulder, in metres (the camera leans toward it: aim a few times). */
async function aimAt(page, dx, dy) {
  for (let i = 0; i < 4; i++) {
    const at = await page.evaluate(
      ({ dx, dy }) => {
        const g = window.__game;
        const me = g.mode.me;
        return { x: g.camera.toScreenX(me.x + dx), y: g.camera.toScreenY(me.y + 1.1 + dy) };
      },
      { dx, dy },
    );
    await page.mouse.move(at.x, at.y);
    await page.evaluate(() => window.__clock?.flush());
    if (i < 3) await step(page, 30);
  }
}

async function zoom(page, level) {
  await page.evaluate((level) => window.__game.camera.setZoom(level, 7), level);
  await step(page, 40);
}

/** Steps the clock until the billboards are between crossfades (the shared 10 s beat, 0.5 s fade). */
async function steady(page) {
  const tick = await page.evaluate(() => window.__game.mode.game.tick);
  const into = tick % 600;
  if (into < 45) await step(page, 45 - into);
}

async function shot(page, name) {
  mkdirSync(out, { recursive: true });
  await page.screenshot({ path: join(out, `${prefix}${name}.png`) });
  console.log(`  ${prefix}${name}.png`);
}

const want = (name) => only.length === 0 || only.includes(name);

if (!gpu) {
  const page = await open(`?map=${mapId}&sandbox&gfx=${arg('gfx', 'low')}${extra}`, { width: 1280, height: 720 });
  await page.evaluate(() => window.__clock.stop());

  if (want('wide')) {
    // the widest zoom (the Widow allows 7 levels: 82.8 m): the whole centre of the market from the catwalk
    await place(page, 0, 10.05, [4, 1]);
    await zoom(page, 6);
    await aimAt(page, 6, -1);
    await step(page, 60);
    await steady(page);
    await shot(page, 'wide');
    await zoom(page, 0);
  }

  if (want('adlum')) {
    // the widest zoom over the market, plus the lit billboards' screen rectangles (for brightness checks)
    await place(page, 0, 10.05, [4, 1]);
    await zoom(page, 6);
    await aimAt(page, 6, -1);
    await step(page, 60);
    await steady(page);
    await shot(page, 'adlum');
    const rects = await page.evaluate(() => {
      const v = window.__game.view3d;
      const cam = window.__game.camera;
      const boards = v.env?.boards;
      if (!boards) return [];
      const pose = v.pose;
      return boards.slots
        .map((s, i) => ({ s, lit: boards.limiter.lit[i] }))
        .filter((b) => b.lit > 0.5)
        .map(({ s }) => {
          const k = pose.z / (pose.z - s.pos[2]);
          const px = (x) => cam.toScreenX(pose.x + (x - pose.x) * k);
          const py = (y) => cam.toScreenY(pose.y + (y - pose.y) * k);
          return { slot: s.slotId, x0: px(s.pos[0] - s.size[0] / 2), x1: px(s.pos[0] + s.size[0] / 2), y0: py(s.pos[1] + s.size[1] / 2), y1: py(s.pos[1] - s.size[1] / 2) };
        });
    });
    writeFileSync(join(out, `${prefix}adlum.json`), JSON.stringify({ rects, gpuBytes: await page.evaluate(() => window.__game.view3d.env?.boards?.gpuBytes() ?? 0) }));
    await zoom(page, 0);
  }

  if (only.includes('audit')) {
    // bullet audit: the 7× overview and two 1× views, each with the camera and collision dumped so
    // scripts/bullet-audit.py can mark what stops bullets (solids), what lets them through
    // (one-ways) and what is drawn without collision (decoration)
    const dump = async (name) => {
      const data = await page.evaluate(async () => {
        const g = window.__game;
        const v = g.view3d;
        const cam = g.camera;
        const map = g.mode.map;
        const env = v.env;
        let panels = [];
        if (env?.def?.backdrop) {
          const b = env.def.backdrop;
          const idx = await fetch(b.base + 'index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
          panels = b.layers.flatMap((l) => l.panels.map((p) => {
            const size = idx?.files?.[p.file]?.size ?? [21, 9];
            return { name: `${l.name}:${p.file}`, x0: p.x - p.width / 2, x1: p.x + p.width / 2, y0: l.y, y1: l.y + (p.width * size[1]) / size[0], z: l.z };
          }));
        }
        return {
          pose: { ...v.pose },
          cam: { x: cam.x, y: cam.y, ppm: cam.ppm, width: cam.width, height: cam.height },
          solids: map.solids.map((s) => s.points),
          oneWays: map.oneWays,
          decor: env?.decorBoxes ?? [],
          panels,
        };
      });
      writeFileSync(join(out, `${prefix}${name}.json`), JSON.stringify(data));
    };
    const spots = await page.evaluate(() => {
      const m = window.__game.mode.map;
      const cx = (m.bounds.minX + m.bounds.maxX) / 2;
      const s = [...m.spawns].sort((a, b) => Math.abs(a.x - cx) - Math.abs(b.x - cx));
      const high = [...m.spawns].sort((a, b) => b.y - a.y);
      return { mid: s[0], left: high.find((p) => p.x < cx) ?? s[0], right: high.find((p) => p.x > cx) ?? s[0] };
    });
    await place(page, spots.mid.x, spots.mid.y + 0.05, [4, 1]);
    await zoom(page, 6);
    await aimAt(page, 6, 2);
    await step(page, 60);
    await steady(page);
    await shot(page, 'audit-overview');
    await dump('audit-overview');
    await zoom(page, 0);
    for (const [k, p] of [['left', spots.left], ['right', spots.right]]) {
      await place(page, p.x, p.y + 0.05, [4, 1]);
      await zoom(page, 1);
      await aimAt(page, k === 'left' ? 7 : -7, -1);
      await step(page, 60);
      await steady(page);
      await shot(page, `audit-${k}`);
      await dump(`audit-${k}`);
    }
    await zoom(page, 0);
  }

  if (want('mid')) {
    // 1.4×: the west houses, a balcony and the stalls
    await place(page, -45, 8.05, [4, 1]);
    await zoom(page, 2);
    await aimAt(page, 7, -2);
    await step(page, 60);
    await steady(page);
    await shot(page, 'mid');
    await zoom(page, 0);
  }

  if (want('stalls')) {
    // 1×: a fight at the west stalls: you on an awning, three players around the umbrella stall
    await place(page, -38, 3.1);
    await addPlayers(page, [
      { name: 'Kestrel', x: -30, y: 3.1, script: { kind: 'idle' } },
      { name: 'Vane', x: -26, y: 0.05, script: { kind: 'crouch', periodTicks: 120 } },
      { name: 'Ash', x: -34, y: 6.5, script: { kind: 'jet', periodTicks: 50, burstTicks: 18 } },
    ]);
    await step(page, 30);
    await aimAt(page, 8, -1.6);
    await step(page, 10);
    await page.mouse.down();
    await step(page, 8);
    await shot(page, 'stalls-fight');
    await page.mouse.up();
    // a frag lobbed onto the umbrella stall: just after the blast
    await aimAt(page, 5, 3);
    await page.keyboard.down('KeyG');
    await step(page, 2);
    await page.keyboard.up('KeyG');
    const toBlast = await page.evaluate(() => window.__game.mode.game.grenades.find((x) => x.alive)?.fuse ?? 0);
    await step(page, toBlast + 6);
    await shot(page, 'stalls-blast');
    await step(page, 50);
    // the debug overlay (H): the sim's collision over the art
    await page.keyboard.press('KeyH');
    await step(page, 2);
    await shot(page, 'stalls-hitboxes');
    await page.keyboard.press('KeyH');
  }

  if (want('centre')) {
    // 1×: the minibuses and the tank tower in the middle of the street
    await place(page, -4, 0.05);
    await aimAt(page, 6, 1);
    await step(page, 60);
    await steady(page);
    await shot(page, 'centre');
    await page.keyboard.press('KeyH');
    await step(page, 2);
    await shot(page, 'centre-hitboxes');
    await page.keyboard.press('KeyH');
  }

  if (want('overview')) {
    // any map: the widest zoom from the spawn nearest the middle
    const at = await page.evaluate(() => {
      const m = window.__game.mode.map;
      const cx = (m.bounds.minX + m.bounds.maxX) / 2;
      return m.spawns.reduce((a, b) => (Math.abs(b.x - cx) < Math.abs(a.x - cx) ? b : a));
    });
    await place(page, at.x, at.y + 0.05, [4, 1]);
    await zoom(page, 6);
    await aimAt(page, 6, 2);
    await step(page, 60);
    await steady(page);
    await shot(page, 'overview');
    await zoom(page, 0);
  }

  if (want('ground')) {
    // any map: 1× from the first spawn, and 1.4× from the highest spawn
    const [low, high] = await page.evaluate(() => {
      const s = window.__game.mode.map.spawns;
      return [s[0], s.reduce((a, b) => (b.y > a.y ? b : a))];
    });
    await place(page, low.x, low.y + 0.05);
    await aimAt(page, 7, 1);
    await step(page, 60);
    await steady(page);
    await shot(page, 'ground');
    await place(page, high.x, high.y + 0.05, [4, 1]);
    await zoom(page, 2);
    await aimAt(page, 7, -1);
    await step(page, 60);
    await steady(page);
    await shot(page, 'high');
    await zoom(page, 0);
  }

  if (want('east')) {
    // 1×: the east roofs, the rooftop hoarding behind them
    await place(page, 47, 8.05);
    await aimAt(page, -7, 0);
    await step(page, 60);
    await steady(page);
    await shot(page, 'east');
  }
} else {
  const [w, h] = arg('size', '1920x1080').split('x').map(Number);
  const page = await open(`?map=${mapId}&sandbox&gfx=${arg('gfx', 'low')}${extra}`, { width: w, height: h }, { clock: false });
  await page.evaluate(() => window.__game.view3d.pinScale(null));
  await page.evaluate(() => {
    const v = window.__game.view3d;
    const gl = v.renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    window.__gpuMs = [];
    window.__calls = [];
    window.__tris = [];
    window.__frames = [];
    let last = 0;
    const render = v.renderer.render.bind(v.renderer);
    const pending = [];
    v.renderer.render = (scene, camera) => {
      const now = performance.now();
      if (last) window.__frames.push(now - last);
      last = now;
      const q = ext && gl.createQuery();
      if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      render(scene, camera);
      window.__calls.push(v.renderer.info.render.calls);
      window.__tris.push(v.renderer.info.render.triangles);
      if (!q) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(q);
      while (pending.length && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const done = pending.shift();
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) window.__gpuMs.push(gl.getQueryParameter(done, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(done);
      }
    };
  });
  const info = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown';
  });
  // six players at the west stalls: you on an awning, five scripted players jet-strafing around you
  await page.evaluate(() => {
    const m = window.__game.mode;
    m.setLoadout([1, 0]);
    m.me.spawn(-38, 3.1, m.game.tuning);
    const s = (minX, maxX, periodTicks, burstTicks) => ({ kind: 'strafeJet', minX, maxX, periodTicks, burstTicks });
    m.game.addDummy({ name: 'A', x: -30, y: 3.1, script: s(-33, -24, 70, 20) });
    m.game.addDummy({ name: 'B', x: -26, y: 0.05, script: s(-29, -20, 90, 25) });
    m.game.addDummy({ name: 'C', x: -44, y: 0.05, script: s(-49, -40, 80, 22) });
    m.game.addDummy({ name: 'D', x: -47, y: 8.05, script: s(-50, -44, 60, 15) });
    m.game.addDummy({ name: 'E', x: -20, y: 12.05, script: s(-22, -18, 100, 30) });
  });
  await sleep(1500);
  const at = await page.evaluate(() => {
    const g = window.__game;
    const me = g.mode.me;
    return { x: g.camera.toScreenX(me.x + 7), y: g.camera.toScreenY(me.y + 2.5) };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await page.evaluate(() => {
      const me = window.__game.mode.me;
      me.frags = 3;
      me.hp = 100;
      for (const w of me.weapons) w.reserve = 250;
    });
    await page.keyboard.down('KeyG');
    await sleep(100);
    await page.keyboard.up('KeyG');
    await sleep(500);
  }
  await page.mouse.up();
  const window240 = await page.evaluate(() => {
    const pct = (arr, p) => {
      const t = arr.slice(-240).sort((a, b) => a - b);
      return t.length ? Math.round(t[Math.min(t.length - 1, Math.floor(t.length * p))] * 100) / 100 : null;
    };
    const calls = window.__calls.slice(-240);
    return {
      frameP50: pct(window.__frames, 0.5),
      frameP90: pct(window.__frames, 0.9),
      frameP99: pct(window.__frames, 0.99),
      gpuP50: pct(window.__gpuMs, 0.5),
      gpuP90: pct(window.__gpuMs, 0.9),
      callsP50: pct(calls, 0.5),
      callsMax: Math.max(...calls),
      trisMax: Math.max(...window.__tris.slice(-240)),
      players: window.__game.mode.game.players.filter(Boolean).length,
    };
  });
  const s = await page.evaluate(() => window.__game.view3d.stats());
  console.log(JSON.stringify({ renderer: info, viewport: `${w}x${h}`, gfx: arg('gfx', 'low'), ...s, ...window240 }, null, 1));
}
await browser.close();
