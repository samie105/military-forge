/* global process, Buffer */
/**
 * The map posters and the Quick match key art (public/assets/posters/), made from the game itself: each map
 * in a real local match against bots (the debug client: the map's own geometry, light, backdrops,
 * soldiers and effects), on this machine's GPU, with the HUD and the 2D layer hidden. See art/posters/README.md.
 *
 *   cd apps/web && pnpm exec vite --port 5451 --strictPort          # in another shell (the dev hook is dev-only)
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/map-posters.mjs [--base http://127.0.0.1:5451]
 *       [--only street-market,quick-match] [--search] [--keep <dir>]
 *
 * For each shot in art/posters/shots.json the match runs on a stepped clock (the same frames every run, however
 * slow the machine): the camera stands in the shot's region, centred on the soldiers there, and the frame is
 * taken at the shot's `at` seconds. `--search` instead scores a frame every 0.2 s over `search` seconds (soldiers
 * in frame, in the air, jetting, grenades) and keeps the best, printing its `at` for shots.json; `--keep <dir>`
 * also saves every better frame found on the way, to choose by eye.
 *
 * Each frame (3200×1800, the GPU at 2×) gets the set's one grade (a touch of contrast and colour, a soft
 * vignette: the render first), then:
 *   art/posters/<id>.webp                         2560×1440 master (posts, a re-crop)
 *   public/assets/posters/<id>-card[@2x].webp     2:1, 400 / 800 wide (the lobby's map cards, the phone's map choice)
 *   public/assets/posters/<id>-wide[@2x].webp     16:9, 960 / 1920 wide (the loading screen, the countdown's map intro)
 * and the Quick match key art: public/assets/posters/quick-match[@2x].webp, 2:1, 760 / 1520 wide.
 * Needs cwebp (brew install webp). apps/web/test/posters.test.ts checks every selectable map has its files.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const repo = resolve(web, '../..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://127.0.0.1:5451').replace(/\/$/, '');
const only = arg('only', '').split(',').filter(Boolean);
const search = process.argv.includes('--search');
const keep = arg('keep', null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = join(web, 'public/assets/posters');
const masters = join(repo, 'art/posters');
const tmp = mkdtempSync(join(tmpdir(), 'map-posters-'));
mkdirSync(out, { recursive: true });
if (keep) mkdirSync(keep, { recursive: true });

/** the browser window (CSS px) at 2×: a 3200×1800 frame */
const VIEW = { width: 1600, height: 900, deviceScaleFactor: 2 };
/** the files each frame becomes: crop aspect, widths, WebP quality */
const EXPORTS = {
  card: { aspect: 2, widths: [400, 800], q: 86 },
  wide: { aspect: 16 / 9, widths: [960, 1920], q: 72 },
  hero: { aspect: 2, widths: [760, 1520], q: 82 },
};
const config = JSON.parse(readFileSync(join(masters, 'shots.json'), 'utf8'));
const shots = config.shots.filter((s) => only.length === 0 || only.includes(s.id));

/** Installed before the page's scripts: a clock the script can stop and step (environment-shots.mjs's). */
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
      return new Promise((r) => realRaf(() => r()));
    },
    step(frames = 1, ms = 1000 / 60) {
      for (let i = 0; i < frames; i++) {
        now += ms;
        for (const cb of queue.splice(0)) cb(now);
      }
    },
  };
}

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'map-posters-chrome-')),
  // the real GPU (Metal), never SwiftShader: the High preset's shadows, MSAA and lights as players see them
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
  protocolTimeout: 900_000,
});

/** Opens the shot's map in a local match with bots, the clock stopped, only the 3D view showing. */
async function open(shot) {
  const page = await browser.newPage();
  await page.setViewport(VIEW);
  await page.evaluateOnNewDocument(installClock);
  page.on('pageerror', (e) => console.error('[page]', e.message));
  await page.goto(`${base}/?map=${shot.map}&bots=${shot.bots ?? 6}&botlevel=${shot.botLevel ?? 'hard'}&gfx=high`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  for (let i = 0; i < 180 && !(await page.evaluate(() => window.__game?.view3d?.ready)); i++) await sleep(1000);
  const gl = await page.evaluate(() => {
    const c = document.createElement('canvas').getContext('webgl2');
    return c?.getParameter(c.getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? 0x1f01) ?? 'none';
  });
  if (/swiftshader|llvmpipe|software/i.test(String(gl))) throw new Error(`software GL (${gl}): the posters need the GPU`);
  // the map's art in (the environment's files), then the clock stopped
  await page.evaluate(async () => {
    await window.__game.view3d.env?.ready;
  });
  await sleep(1500);
  await page.evaluate((shot) => {
    // only the 3D view: the HUD, the 2D layer (names, damage numbers), the debug bars all go
    let el = document.getElementById('view3d');
    while (el && el !== document.body) {
      for (const s of el.parentElement.children) if (s !== el && !['SCRIPT', 'STYLE', 'LINK'].includes(s.tagName)) s.style.setProperty('display', 'none', 'important');
      el = el.parentElement;
    }
    const g = window.__game;
    g.view3d.pinScale(1);
    // the camera: the shot's view width; where it stands is set before each frame (aim()), after the game's follow
    const cam = g.camera;
    const width = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(cam), 'viewWidth');
    Object.defineProperty(cam, 'viewWidth', { configurable: true, get: () => shot.w ?? width.get.call(cam) });
    const follow = cam.follow.bind(cam);
    window.__aim = null;
    cam.follow = (...a) => {
      follow(...a);
      if (window.__aim) {
        cam.x = window.__aim.x;
        cam.y = window.__aim.y;
      }
    };
    /** The camera on the soldiers in the shot's region (their weighted centre, the view kept inside the region); the frame's score. */
    window.__frame = () => {
      const m = g.mode;
      const { halfW, halfH } = cam.halfExtents;
      const r = shot.region;
      const inRegion = (p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1;
      const people = m.game.players.filter((p) => p && p.alive && p !== m.me && inRegion(p));
      let x = (r.x0 + r.x1) / 2;
      let y = (r.y0 + r.y1) / 2;
      if (people.length) {
        x = people.reduce((s, p) => s + p.x, 0) / people.length;
        y = people.reduce((s, p) => s + p.y, 0) / people.length + 1;
      }
      x += shot.bias?.x ?? 0;
      y += shot.bias?.y ?? 0;
      x = Math.max(r.x0 + halfW, Math.min(r.x1 - halfW, x));
      y = Math.max(r.y0 + halfH, Math.min(r.y1 - halfH, y));
      window.__aim = { x, y };
      let score = 0;
      let seen = 0;
      for (const p of m.game.players) {
        if (!p || !p.alive || p === m.me) continue;
        const dx = Math.abs(p.x - x) / halfW;
        const dy = Math.abs(p.y + 0.9 - y) / halfH;
        if (dx > 0.92 || dy > 0.85) continue;
        seen++;
        const centre = 1 - 0.4 * Math.max(dx, dy);
        score += centre * (1 + (p.grounded ? 0 : 0.6) + (p.jetting ? 0.9 : 0));
      }
      for (const gr of m.game.grenades ?? []) if (gr?.alive && Math.abs(gr.x - x) < halfW && Math.abs(gr.y - y) < halfH) score += 0.8;
      // two soldiers make a fight; one alone is a portrait
      if (seen < 2) score *= 0.3;
      // a map's poster, not an ad's: frames where lit billboards fill the view score less
      const boards = g.view3d.env?.boards;
      let ads = 0;
      if (boards) {
        const pose = g.view3d.pose;
        boards.slots.forEach((b, i) => {
          if ((boards.limiter?.lit?.[i] ?? 1) < 0.5) return;
          const k = pose.z / (pose.z - b.pos[2]);
          const bx0 = pose.x + (b.pos[0] - b.size[0] / 2 - pose.x) * k;
          const bx1 = pose.x + (b.pos[0] + b.size[0] / 2 - pose.x) * k;
          const by0 = pose.y + (b.pos[1] - b.size[1] / 2 - pose.y) * k;
          const by1 = pose.y + (b.pos[1] + b.size[1] / 2 - pose.y) * k;
          const w = Math.max(0, Math.min(bx1, x + halfW) - Math.max(bx0, x - halfW));
          const h = Math.max(0, Math.min(by1, y + halfH) - Math.max(by0, y - halfH));
          ads += (w * h) / (4 * halfW * halfH);
        });
      }
      score *= Math.max(0.1, 1 - 8 * ads);
      return { score, seen, ads, x, y, t: m.game.tick / 60 };
    };
    /** Brings every bot back into the region (the shot's gatherAt points, or the map's spawn points there), so the fight is in the shot. */
    window.__gather = () => {
      const m = g.mode;
      const r = shot.region;
      const spots = shot.gatherAt?.map(([x, y]) => ({ x, y })) ?? m.map.spawns.filter((p) => p.x >= r.x0 && p.x <= r.x1 && p.y >= r.y0 && p.y <= r.y1);
      if (!spots.length) return 0;
      let i = 0;
      for (const p of m.game.players) {
        if (!p || p === m.me || !p.alive) continue;
        const at = spots[i++ % spots.length];
        p.spawn(at.x + ((i * 0.7) % 1.4) - 0.7, at.y, m.game.tuning);
      }
      return i;
    };
  }, shot);
  await page.evaluate(() => window.__clock.stop());
  return page;
}

/** Steps the clock to `seconds` of match time, the camera following the region's soldiers. */
async function runTo(page, seconds) {
  for (;;) {
    const f = await page.evaluate(() => window.__frame());
    if (f.t >= seconds) return f;
    await page.evaluate((n) => window.__clock.step(n), Math.min(30, Math.max(1, Math.round((seconds - f.t) * 60))));
  }
}

/** Whether the search's step `i` (0.2 s each from the search's start) brings the bots back (every gatherEvery s). */
const gatherDue = (shot, i) => !!shot.gatherEvery && i % Math.round(shot.gatherEvery * 5) === 0;

async function frame(page) {
  // two more frames with the camera set: the 3D view draws where it stands now
  await page.evaluate(() => {
    window.__frame();
    window.__clock.step(1);
    window.__frame();
    window.__clock.step(1);
  });
  return page.screenshot({ type: 'png' });
}

/** The set's grade, the crops and the WebP files (the grading runs in a blank page's canvas). */
async function exportFrame(shot, png) {
  const page = await browser.newPage();
  try {
    const files = await page.evaluate(
      async (dataUrl, grade, crops) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const W = img.width;
        const H = img.height;
        const graded = document.createElement('canvas');
        graded.width = W;
        graded.height = H;
        const g = graded.getContext('2d');
        g.filter = `contrast(${grade.contrast}) saturate(${grade.saturate}) brightness(${grade.brightness})`;
        g.drawImage(img, 0, 0);
        g.filter = 'none';
        // a soft vignette in the kit's ink (#0b0e09), the corners only
        const v = g.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.45, W / 2, H / 2, Math.hypot(W, H) * 0.56);
        v.addColorStop(0, 'rgba(11,14,9,0)');
        v.addColorStop(1, `rgba(11,14,9,${grade.vignette})`);
        g.fillStyle = v;
        g.fillRect(0, 0, W, H);
        /** a crop of aspect `aspect` (its centre `cy` of the height, 0–1) at `width`, halved step by step for a clean downscale */
        const crop = (aspect, cy, width) => {
          const ch = Math.min(H, W / aspect);
          const cw = ch * aspect;
          const sy = Math.max(0, Math.min(H - ch, cy * H - ch / 2));
          let src = graded;
          let sx0 = (W - cw) / 2;
          let sy0 = sy;
          let sw = cw;
          let sh = ch;
          while (sw / 2 >= width) {
            const half = document.createElement('canvas');
            half.width = Math.round(sw / 2);
            half.height = Math.round(sh / 2);
            const h = half.getContext('2d');
            h.imageSmoothingQuality = 'high';
            h.drawImage(src, sx0, sy0, sw, sh, 0, 0, half.width, half.height);
            src = half;
            sx0 = 0;
            sy0 = 0;
            sw = half.width;
            sh = half.height;
          }
          const c = document.createElement('canvas');
          c.width = width;
          c.height = Math.round(width / aspect);
          const x = c.getContext('2d');
          x.imageSmoothingQuality = 'high';
          x.drawImage(src, sx0, sy0, sw, sh, 0, 0, c.width, c.height);
          return c.toDataURL('image/png');
        };
        return crops.map((c) => ({ name: c.name, q: c.q, data: crop(c.aspect, c.cy, c.width) }));
      },
      `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
      config.grade,
      [
        { name: join(masters, `${shot.id}.webp`), aspect: 16 / 9, cy: 0.5, width: 2560, q: 86 },
        ...Object.entries(EXPORTS)
          .filter(([kind]) => (shot.id === 'quick-match' ? kind === 'hero' : kind !== 'hero'))
          .flatMap(([kind, e]) =>
            e.widths.map((width, i) => ({
              name: join(out, `${shot.id}${kind === 'hero' ? '' : `-${kind}`}${i ? '@2x' : ''}.webp`),
              aspect: e.aspect,
              cy: shot.cropY?.[kind] ?? 0.5,
              width,
              q: e.q,
            })),
          ),
      ],
    );
    for (const f of files) {
      const src = join(tmp, 'frame.png');
      writeFileSync(src, Buffer.from(f.data.split(',')[1], 'base64'));
      execFileSync('cwebp', ['-quiet', '-q', String(f.q), '-m', '6', '-sharp_yuv', '-metadata', 'none', src, '-o', f.name]);
      console.log(`  ${f.name.replace(`${repo}/`, '')} ${(readFileSync(f.name).length / 1024).toFixed(1)} KB`);
    }
  } finally {
    await page.close();
  }
}

try {
  for (const shot of shots) {
    console.log(`${shot.id} (${shot.map})`);
    const page = await open(shot);
    let png;
    if (search) {
      const [from, to] = shot.search ?? [8, 70];
      await runTo(page, from);
      let best = { score: -1 };
      for (let i = 0; from + i * 0.2 <= to; i++) {
        await runTo(page, from + i * 0.2);
        // every gatherEvery seconds the bots are brought back into the region (shots.json; 0 or none: never)
        if (gatherDue(shot, i)) await page.evaluate(() => window.__gather());
        const f = await page.evaluate(() => window.__frame());
        if (f.score > best.score * 1.04) {
          best = f;
          png = await frame(page);
          if (keep) writeFileSync(join(keep, `${shot.id}-${f.t.toFixed(1)}s-${f.score.toFixed(1)}.png`), png);
        }
      }
      console.log(`  best: "at": ${best.t.toFixed(2)} (score ${best.score.toFixed(2)}, ${best.seen} in frame, billboards ${(best.ads * 100).toFixed(0)}%)`);
    } else {
      // the same gathers as the search made, at the same ticks, then the frame
      const from = (shot.search ?? [8, 70])[0];
      for (let i = 0; from + i * 0.2 <= shot.at; i++) {
        if (!gatherDue(shot, i)) continue;
        await runTo(page, from + i * 0.2);
        await page.evaluate(() => window.__gather());
      }
      const f = await runTo(page, shot.at);
      png = await frame(page);
      console.log(`  at ${f.t.toFixed(2)} s: score ${f.score.toFixed(2)}, ${f.seen} in frame`);
    }
    await page.close();
    await exportFrame(shot, png);
  }
} finally {
  await browser.close();
}
