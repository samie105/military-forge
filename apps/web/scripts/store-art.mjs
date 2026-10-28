/* global process, Buffer */
/**
 * The Store's baked art (apps/web/public/assets/store/), headless Chrome with a throwaway profile, the game's own
 * renderer in a Vite dev server:
 *   cd apps/web && pnpm exec vite --port 5195 --strictPort        # in another shell
 *   lockf -k /tmp/military-forge-heavy.lock node apps/web/scripts/store-art.mjs [--base http://localhost:5195]
 * Writes, for every store skin (packages/content cosmetics with source "store" and a model):
 *   <model name>.webp     the gun side on, transparent round it (src/store/bake.ts)
 *   <kill effect id>.webp the kill effect as a frame strip from the animation lab (the game's Renderer3D): a few
 *                         frames of the soldier alive, the effect, a moment empty; the Store loops it (a still
 *                         frame under Reduce motion)
 * and src/store/art.json: each image with the sha256 of what it was baked from (the GLB, the effect's content entry),
 * which the Store reads; apps/web/test/store/art.test.ts fails when either changes without a re-bake.
 * Phones show two small images instead of a 3D view (no WebGL in the Store).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, '..');
const repo = resolve(web, '../..');
const out = join(web, 'public/assets/store');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const base = arg('base', 'http://localhost:5195');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
mkdirSync(out, { recursive: true });

/** the gun image's size (2× the card's largest) and the effect's frames */
const GUN = { width: 960, height: 360 };
const FX = { frameW: 200, frameH: 250, ms: 1700 };

const skins = JSON.parse(readFileSync(join(repo, 'packages/content/cosmetics/weapon-skins.json'), 'utf8')).items.filter((i) => i.source?.kind === 'store' && i.assets?.model);
const effects = JSON.parse(readFileSync(join(repo, 'packages/content/cosmetics/kill-effects.json'), 'utf8')).effects;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  userDataDir: mkdtempSync(join(tmpdir(), 'store-art-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  protocolTimeout: 600_000,
});

const write = (file, dataUrl) => {
  writeFileSync(join(out, file), Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log(`  public/assets/store/${file}`);
};

const manifest = { $comment: 'Baked by apps/web/scripts/store-art.mjs: re-run it when a store skin\'s GLB or its kill effect changes (test/store/art.test.ts checks the hashes).', guns: {}, killEffects: {} };
try {
  const lab = await browser.newPage();
  lab.on('pageerror', (e) => console.error('[page]', e.message));
  await lab.setViewport({ width: 800, height: 600 });
  await lab.goto(`${base}/animlab.html`, { waitUntil: 'domcontentloaded', timeout: 600_000 });
  for (let i = 0; i < 300 && !(await lab.evaluate(() => window.__lab?.ready)); i++) await sleep(500);

  // --- the guns ---
  for (const model of [...new Set(skins.map((s) => s.assets.model))]) {
    const file = `${model.split('/').pop().replace(/\.glb$/, '')}.webp`;
    write(file, await lab.evaluate(async (model, size) => (await import('/src/store/bake.ts')).bakeGun(`/assets/${model}`, size.width, size.height), model, GUN));
    manifest.guns[model] = { image: `store/${file}`, sha256: sha256(readFileSync(join(web, 'public/assets', model))) };
  }

  // --- the kill effects: the victim on the lab's floor, killed by an off-screen K-47 in the skin that carries it ---
  await lab.evaluate(async () => {
    window.__k47 = (await import('/@id/@military-forge/content')).K47.index;
  });
  for (const effect of effects) {
    const skin = skins.find((s) => s.killEffect === effect.id);
    if (!skin) continue;
    const frames = await lab.evaluate(
      async (skinId, fx) => {
        const { view, camera } = window.__lab;
        const canvas = document.getElementById('view3d');
        const DT = 1 / 60;
        const x = 124;
        const victim = 10;
        Object.defineProperty(camera, 'viewWidth', { get: () => 3.2, configurable: true });
        camera.x = x;
        camera.y = 0.85;
        const look = (s) => {
          const d = view.loadouts.for({ id: -1, isLocal: true });
          return { items: { ...d.items, skin_k47: s }, dyes: d.dyes };
        };
        view.loadouts.setLooks(new Map([[50, look(skinId)], [victim, look('skin_k47_standard')]]));
        const pv = (alive) => ({
          id: victim, name: 'p', isBot: false, isLocal: false, alive, x, y: 0, vx: 0, vy: 0, grounded: true, crouched: false, jetting: false,
          aim: Math.PI - 0.1, hp: alive ? 100 : 0, fuel: 100, fuelRegenDelay: 0, frags: 0, active: 0, dual: false,
          weapons: [{ def: window.__k47, mag: 30, reserve: 90, reloadTicks: 0 }, { def: 0, mag: 6, reserve: 30, reloadTicks: 0 }],
          respawnTicks: alive ? 0 : 180, kills: 0, deaths: 0,
        });
        const frame = (alive) => ({ tick: 0, localId: -1, players: [pv(alive)], grenades: [] });
        const loading = () => [...view.kit.skinModels.values()].some((m) => m === 'loading');
        for (let i = 0; i < 600; i++) {
          view.render(frame(true), DT);
          await new Promise((r) => setTimeout(r, 10));
          if (i > 20 && view.avatars.get(victim) && !loading()) break;
        }
        for (let t = 0; t < 0.8; t += DT) view.render(frame(true), DT);
        const grab = () => {
          const ppm = canvas.width / 3.2;
          const w = 1.6 * ppm;
          const h = 2.0 * ppm;
          const o = document.createElement('canvas');
          o.width = fx.frameW;
          o.height = fx.frameH;
          o.getContext('2d').drawImage(canvas, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h, 0, 0, fx.frameW, fx.frameH);
          return o;
        };
        // 3 frames alive, the effect from the kill to its end, 2 frames empty: the loop reads as "kill → shatter → gone"
        const cells = [];
        const alive = grab();
        cells.push(alive, alive, alive);
        const times = [0, 0.08, 0.16, 0.24, 0.32, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
        let t = 0;
        view.onEvents([{ type: 'death', victim, killer: 50, source: window.__k47 }]);
        for (const at of times) {
          while (t < at) {
            view.render(frame(false), DT);
            t += DT;
          }
          if (at === 0) view.render(frame(false), 0.001);
          cells.push(grab());
        }
        while (t < 1.2) {
          view.render(frame(false), DT);
          t += DT;
        }
        const gone = grab();
        cells.push(gone, gone);
        const sheet = document.createElement('canvas');
        sheet.width = fx.frameW * cells.length;
        sheet.height = fx.frameH;
        const c = sheet.getContext('2d');
        cells.forEach((cell, i) => c.drawImage(cell, i * fx.frameW, 0));
        return { url: sheet.toDataURL('image/webp', 0.82), frames: cells.length, still: 3 + times.indexOf(0.32) };
      },
      skin.id,
      FX,
    );
    const file = `${effect.id}.webp`;
    write(file, frames.url);
    manifest.killEffects[effect.id] = { image: `store/${file}`, frames: frames.frames, still: frames.still, frameW: FX.frameW, frameH: FX.frameH, ms: FX.ms, sha256: sha256(JSON.stringify(effect)) };
  }
  writeFileSync(join(web, 'src/store/art.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('  src/store/art.json');
} finally {
  await browser.close();
}
