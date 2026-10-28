/* global process, Buffer */
/**
 * Weapon skin screenshots for PRs (docs/screenshots/skins), headless Chrome with a throwaway profile:
 *   cd apps/web && pnpm exec vite --port 5195 --strictPort        # in another shell
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/skin-shots.mjs [--base http://localhost:5195] [--out docs/screenshots/skins]
 * Shots (the K-47 Galaxy Relic, docs/17 §3.6–3.7):
 *   locker        the Locker's Gun skins tab with the Galaxy Relic on the stand (a dev build's ?grant= unlocks it)
 *   held          the skinned K-47 in the hand next to the base K-47, in the animation lab's real renderer
 *   tracers       both firing: the skin's hues above, the base tracer below, mid-flight
 *   kill-effect   the stardust kill effect, frame by frame; kill-effect-still: its Reduce motion variant
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5195');
const out = resolve(arg('out', 'docs/screenshots/skins'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'skin-shots-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});

async function page(path, viewport = { width: 1280, height: 720 }) {
  const p = await browser.newPage();
  p.on('pageerror', (e) => console.error('[page]', e.message));
  await p.setViewport(viewport);
  await p.goto(`${base}/${path}`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
  return p;
}

function save(name, dataUrl) {
  writeFileSync(join(out, `${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`  ${name}.png`);
}

try {
  // --- the Locker: Gun skins tab, the Galaxy Relic + Stardust tried on ---
  {
    const p = await page('locker.html?grant=skin_k47_galaxy_relic_fx', { width: 1280, height: 800 });
    await p.waitForSelector('[data-tab]', { timeout: 120_000 });
    await p.evaluate(() => [...document.querySelectorAll('[data-tab]')].find((b) => /Gun skins/.test(b.textContent ?? ''))?.click());
    await p.waitForSelector('[data-id="skin_k47_galaxy_relic_fx"]', { timeout: 60_000 });
    await p.click('[data-id="skin_k47_galaxy_relic_fx"]');
    await sleep(6000); // the soldier, then the gun GLB, then a few drawn frames
    await p.screenshot({ path: join(out, 'locker.png') });
    console.log('  locker.png');
    await p.close();
  }

  // --- the animation lab: the real Renderer3D, scripted players and events ---
  const lab = await page('animlab.html', { width: 800, height: 600 });
  for (let i = 0; i < 300 && !(await lab.evaluate(() => window.__lab?.ready)); i++) await sleep(500);
  await lab.evaluate(() => {
    const { view, camera } = window.__lab;
    const canvas = document.getElementById('view3d');
    const DT = 1 / 60;
    const pv = (id, x, y, over = {}) => ({
      id, name: `p${id}`, isBot: false, isLocal: false, alive: true, x, y, vx: 0, vy: 0, grounded: y === 0, crouched: false, jetting: y > 0,
      aim: 0.05, hp: 100, fuel: 100, fuelRegenDelay: 0, frags: 0, active: 0, dual: false,
      weapons: [{ def: window.__k47, mag: 30, reserve: 90, reloadTicks: 0 }, { def: 0, mag: 6, reserve: 30, reloadTicks: 0 }],
      respawnTicks: 0, kills: 0, deaths: 0, ...over,
    });
    const width = (w) => Object.defineProperty(camera, 'viewWidth', { get: () => w, configurable: true });
    // the local look (DEFAULT, through the directory) with the K-47 in `skin`
    const look = (skin) => {
      const d = view.loadouts.for({ id: -1, isLocal: true });
      return { items: { ...d.items, skin_k47: skin }, dyes: d.dyes };
    };
    const frame = (players) => ({ tick: 0, localId: -1, players, grenades: [] });
    // render (yielding, so the GLBs load) until every player's soldier is drawn and any skin it asked for has
    // arrived, then let the poses settle
    async function settle(players, seconds = 1.2) {
      const loading = () => [...view.kit.skinModels.values()].some((m) => m === 'loading');
      for (let i = 0; i < 600; i++) {
        view.render(frame(players), DT);
        await new Promise((r) => setTimeout(r, 10));
        if (i > 20 && players.every((p) => view.avatars.get(p.id)) && !loading()) break;
      }
      for (let t = 0; t < seconds; t += DT) view.render(frame(players), DT);
    }
    const crop = (cx, cy, w, h) => {
      const ppm = canvas.width / camera.viewWidth;
      const o = document.createElement('canvas');
      o.width = Math.round(w * ppm);
      o.height = Math.round(h * ppm);
      o.getContext('2d').drawImage(canvas, (canvas.width - o.width) / 2 + cx * ppm, (canvas.height - o.height) / 2 - cy * ppm, o.width, o.height, 0, 0, o.width, o.height);
      return o;
    };
    const label = (c, lines) => {
      const o = document.createElement('canvas');
      o.width = c.width;
      o.height = c.height + 26 * lines.length;
      const x = o.getContext('2d');
      x.fillStyle = '#0d1117';
      x.fillRect(0, 0, o.width, o.height);
      x.drawImage(c, 0, 0);
      x.fillStyle = '#e6edf3';
      x.font = '18px system-ui, sans-serif';
      lines.forEach((l, i) => x.fillText(l, 10, c.height + 20 + 26 * i));
      return o;
    };
    window.__sk = { view, camera, pv, width, look, frame, settle, crop, label, DT, canvas };
  });
  await lab.evaluate(async () => {
    window.__k47 = (await import('/@id/@military-forge/content')).K47.index;
  });

  // held: the skinned K-47 (left) and the base K-47 (right), close up
  save('held', await lab.evaluate(async () => {
    const { view, camera, pv, width, look, settle, crop, label } = window.__sk;
    width(3.2);
    const x = 124;
    camera.x = x;
    camera.y = 0.85;
    view.loadouts.setLooks(new Map([[1, look('skin_k47_galaxy_relic_fx')], [2, look('skin_k47_standard')]]));
    const players = [pv(1, x - 0.75, 0, { aim: 0.05 }), pv(2, x + 0.75, 0, { aim: 0.05 })];
    await settle(players);
    return label(crop(0, 0, 3.2, 1.9), ['K-47 Galaxy Relic (left) and the base K-47 (right), held: same size, nodes and hold']).toDataURL('image/png');
  }));

  // tracers: both fire to the right; the skinned shooter above, the base below; caught mid-flight
  save('tracers', await lab.evaluate(async () => {
    const { view, camera, pv, width, look, settle, crop, label, frame } = window.__sk;
    width(9);
    const x = 121;
    camera.x = x + 3;
    camera.y = 1.6;
    view.loadouts.setLooks(new Map([[3, look('skin_k47_galaxy_relic_fx')], [4, look('skin_k47_standard')]]));
    const players = [pv(3, x, 2.2, { aim: 0 }), pv(4, x, 0, { aim: 0 })];
    await settle(players, 0.5);
    const k47 = window.__k47;
    // a short burst each, then the frame where the bolts are mid-flight (hitscan: they reach the end in ≤ 50 ms)
    const shot = (id, y) => ({ type: 'shot', shooter: id, weapon: k47, ox: x + 0.45, oy: y + 1.08, ex: x + 7.5, ey: y + 1.08, hit: 0, target: -1, zone: 0 });
    view.onEvents([shot(3, 2.2), shot(4, 0)]);
    view.render(frame(players), 0.006); // 6 ms after the shot: the bolts mid-flight over their path lines
    // magnified: 2 m of each tracer just ahead of the muzzle, ×4.5
    const zoom = (y) => crop(-1, y - camera.y, 2, 0.2);
    const top = zoom(2.2 + 1.08);
    const bottom = zoom(1.08);
    const full = crop(0, 0.15, 9, 4.6);
    const o = document.createElement('canvas');
    o.width = full.width;
    const k = full.width / top.width;
    o.height = full.height + 2 * top.height * k + 30;
    const c = o.getContext('2d');
    c.fillStyle = '#0d1117';
    c.fillRect(0, 0, o.width, o.height);
    c.drawImage(full, 0, 0);
    c.imageSmoothingEnabled = false;
    c.drawImage(top, 0, full.height + 10, o.width, top.height * k);
    c.drawImage(bottom, 0, full.height + 20 + top.height * k, o.width, bottom.height * k);
    return label(o, ['Tracers mid-flight: Galaxy Relic (above: violet bolt, aquamarine trail), base K-47 (below); magnified below', 'Same width, length, speed and brightness (±10%): only the hues move (docs/17 V5)']).toDataURL('image/png');
  }));

  // the kill effect: a strip from the kill to 0.9 s (the killer, off screen, wears the Galaxy Relic + Stardust)
  const strip = async (reduced) =>
    lab.evaluate(async (reduced) => {
      const { view, camera, pv, width, look, settle, crop, frame, DT } = window.__sk;
      view.setReducedMotion(reduced);
      width(3.2);
      const x = 124;
      const victim = reduced ? 11 : 10;
      camera.x = x;
      camera.y = 0.85;
      view.loadouts.setLooks(new Map([[50, look('skin_k47_galaxy_relic_fx')], [victim, look('skin_k47_standard')]]));
      const alive = pv(victim, x, 0, { aim: Math.PI - 0.1 });
      await settle([alive], 0.6);
      const times = [-0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 0.9];
      const cells = [];
      let t = -0.04;
      let fired = false;
      for (const at of times) {
        while (t < at) {
          if (!fired && t >= 0) {
            view.onEvents([{ type: 'death', victim, killer: 50, source: window.__k47 }]);
            fired = true;
          }
          view.render(frame([pv(victim, x, 0, { aim: Math.PI - 0.1, alive: t < 0, respawnTicks: t < 0 ? 0 : 180 })]), DT);
          t += DT;
        }
        cells.push([crop(0, 0, 1.6, 2.0), at < 0 ? 'alive' : `+${Math.round(at * 1000)} ms`]);
      }
      const w = cells[0][0].width;
      const h = cells[0][0].height;
      const o = document.createElement('canvas');
      o.width = w * cells.length;
      o.height = h + 60;
      const c = o.getContext('2d');
      c.fillStyle = '#0d1117';
      c.fillRect(0, 0, o.width, o.height);
      c.fillStyle = '#e6edf3';
      c.font = 'bold 18px system-ui, sans-serif';
      c.fillText(reduced ? 'Stardust, the still variant (Reduce motion / Reduce flashes / Low): a flat tint fade, no particles' : 'Stardust kill effect: a kill with the Galaxy Relic K-47, 0.8 s, inside the body envelope', 10, 22);
      c.font = '16px system-ui, sans-serif';
      cells.forEach(([cell, cap], i) => {
        c.drawImage(cell, i * w, 30);
        c.fillStyle = '#9aa4ad';
        c.fillText(cap, i * w + 8, h + 52);
      });
      view.setReducedMotion(false);
      return o.toDataURL('image/png');
    }, reduced);
  save('kill-effect', await strip(false));
  save('kill-effect-still', await strip(true));
} finally {
  await browser.close();
}
