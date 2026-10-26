/**
 * Team deathmatch end to end, for two things the owner hit on a phone (26 Oct):
 *  1. who's who: screenshots of a desktop host and a phone player (812×375) in a 2-team match and a
 *     free-for-all, and the phone's frame cost with the marking on and off (Renderer3D.stats());
 *  2. frozen ghosts and invisible players: every half second both pages' 3D bookkeeping is checked
 *     against the frame it draws while the match churns (a mid-match join, the tab hidden and back, a
 *     reload, look changes, bots filling and leaving). It fails when
 *       - a soldier is in the scene that no player owns (a frozen ghost),
 *       - a living player has had no soldier for 5 s (only its health bar would show),
 *       - a living player's soldier is hidden or dissolved,
 *       - a soldier is drawn over 1 m from its player for two samples running.
 *
 * Needs the dev hooks (window.__view3d, __mfMode, __lookBook), so a dev server on a local playtest's
 * services:
 *   pnpm playtest --local --no-build --port 5471 --api-port 8471 --game-port 9471 --bots 6 --map street-market
 *   DEV_PROXY_ORIGIN=http://127.0.0.1:5471 DEV_API=http://127.0.0.1:8471 DEV_GAME_SERVER=http://127.0.0.1:9471 \
 *     pnpm --filter @military-forge/web exec vite --port 5472 --strictPort --host 127.0.0.1
 *   NETSIM=rtt=500,jitter=40,loss=3 lockf -k /tmp/military-forge-heavy.lock \
 *     node apps/web/scripts/team-marking-check.mjs http://127.0.0.1:5472 docs/screenshots/team-marking
 * NETSIM (the phone's ?netsim=) makes its soldiers' builds slow to land, as on 4G: that is what exposed
 * the ghosts. Exits 1 on a failed check or a page error.
 */
/* global process */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import puppeteer from 'puppeteer-core';

const base = (process.argv[2] ?? 'http://127.0.0.1:5472').replace(/\/$/, '');
const out = resolve(process.argv[3] ?? 'team-marking-check');
const root = process.cwd();
mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s]`, ...a);
const problems = [];
const fail = (what) => {
  problems.push(what);
  log(`FAIL ${what}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: mkdtempSync(join(tmpdir(), 'team-marking-')),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  protocolTimeout: 300_000,
  defaultViewport: { width: 1600, height: 900 },
});
try {
  let ip = 150;
  const guest = async (name) => {
    const res = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': `198.19.4.${ip++}` }, body: JSON.stringify({ nickname: name }) });
    if (!res.ok) throw new Error(`guest ${name}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  const person = async (name, phone) => {
    const g = await guest(name);
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => fail(`${name} page error: ${e.message}`));
    if (phone) {
      await page.emulate({
        viewport: { width: 812, height: 375, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
      });
    }
    await page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.evaluate((t) => {
      localStorage.setItem('session.refreshToken.v1', t);
      localStorage.setItem('tips.seen.v1', '1');
      localStorage.setItem('mf-creator-seen', '1');
      localStorage.setItem('mf.touch.drill.v1', 'done');
    }, g.refreshToken);
    return { page, name, label: phone ? 'phone' : 'desktop', query: phone && (process.argv[4] ?? process.env.NETSIM) ? `?perf&netsim=${(process.argv[4] ?? process.env.NETSIM)}` : phone ? '?perf' : '', streak: new Map() };
  };

  /** the 3D view's bookkeeping against the frame it draws (page side) */
  // read right after a drawn frame (a rAF callback queued after the game's), so the soldiers and the frame match
  const sample = (p) =>
    p.page.evaluate(async () => {
      await new Promise((r) => requestAnimationFrame(r));
      const v = window.__view3d;
      if (!v?.ready) return null;
      const players = v.online?.out?.players ?? [];
      const pivots = new Set([...v.avatars.values()].map((a) => a.pivot));
      const since = (window.__pendSince ??= new Map());
      for (const id of [...since.keys()]) if (!v.roster.isPending(id) || v.avatars.has(id)) since.delete(id);
      for (const pl of players) if (pl.alive && !v.avatars.has(pl.id) && !since.has(pl.id)) since.set(pl.id, performance.now());
      const orphans = [];
      for (const c of v.scene.children) {
        if (pivots.has(c) || !c.visible || c.name === 'vfx-ghost') continue;
        let soldier = false;
        c.traverse((o) => (soldier ||= o.isSkinnedMesh === true));
        if (soldier) orphans.push(`${c.position.x.toFixed(1)},${c.position.y.toFixed(1)}`);
      }
      return {
        hidden: document.hidden,
        players: players.map((pl) => ({ id: pl.id, x: pl.x, y: pl.y, alive: pl.alive })),
        // a soldier that landed after this frame's draw hasn't been placed yet (posedFrames 0, at the origin): not judged
        soldiers: [...v.avatars]
          .filter(([, a]) => a.posedFrames > 0 || a.pivot.position.lengthSq() > 0)
          .map(([id, a]) => ({ id, x: a.pivot.position.x, y: a.pivot.position.y, shown: a.pivot.visible && a.inst.material.dissolve.value === 0 })),
        orphans,
        missing: [...since].map(([id, at]) => ({ id, ms: performance.now() - at })),
      };
    });
  const judge = (p, d, phase) => {
    if (!d || d.hidden) return;
    const byId = new Map(d.players.map((pl) => [pl.id, pl]));
    for (const o of d.orphans) fail(`${p.label} ${phase}: a soldier nobody owns at ${o}`);
    for (const m of d.missing) if (m.ms > 5000) fail(`${p.label} ${phase}: player ${m.id} alive with no soldier for ${(m.ms / 1000).toFixed(1)} s`);
    for (const s of d.soldiers) {
      const pl = byId.get(s.id);
      if (!pl?.alive) continue;
      if (!s.shown) fail(`${p.label} ${phase}: player ${s.id} alive but its soldier hidden`);
      const far = Math.hypot(s.x - pl.x, s.y - pl.y) > 1;
      const n = far ? (p.streak.get(s.id) ?? 0) + 1 : 0;
      p.streak.set(s.id, n);
      if (n === 2) fail(`${p.label} ${phase}: player ${s.id} drawn at ${s.x.toFixed(1)},${s.y.toFixed(1)}, ${Math.hypot(s.x - pl.x, s.y - pl.y).toFixed(1)} m from where it is (${pl.x.toFixed(1)},${pl.y.toFixed(1)})`);
    }
  };
  const watch = async (people, phase, seconds, act) => {
    log(`phase: ${phase}`);
    for (let i = 0; i < seconds * 2; i++) {
      await act?.(i);
      for (const p of people) judge(p, await sample(p).catch(() => null), phase);
      await sleep(500);
    }
  };
  const mode = (p, fn, arg) => p.page.evaluate((f, a) => window.__mfMode()?.[f]?.(a), fn, arg);
  const walk = (p) => async (i) => {
    const key = i % 8 < 4 ? 'KeyD' : 'KeyA';
    await p.page.keyboard.down(key);
    await sleep(150);
    await p.page.keyboard.up(key);
  };
  const shots = async (people, tag, n) => {
    for (let i = 1; i <= n; i++) {
      await sleep(2500);
      for (const p of people) await p.page.screenshot({ path: join(out, `${tag}-${p.label}-${i}.png`) });
    }
  };
  /** the phone's render cost over `seconds`, marking on or off (Renderer3D.stats(): frame interval and render CPU) */
  const cost = async (p, on, seconds = 8) => {
    await p.page.evaluate((m) => {
      const v = window.__view3d;
      v.__relationOf ??= v.relationOf;
      v.relationOf = m ? v.__relationOf : null;
    }, on);
    await sleep(seconds * 1000);
    return p.page.evaluate(() => {
      const s = window.__view3d.stats();
      return { frameP50: +s.frameP50.toFixed(1), frameP90: +s.frameP90.toFixed(1), cpuMean: +s.cpuMean.toFixed(2), cpuP90: +s.cpuP90.toFixed(2), calls: s.calls, preset: s.preset, soldiers: s.avatars };
    });
  };

  const stamp = Date.now().toString(36).slice(-4);
  const host = await person(`Ade_${stamp}`, false);
  const phone = await person(`Kemi_${stamp}`, true);
  const both = [host, phone];

  // a team deathmatch: the host's room, back to the lobby for 2 teams (the dev room starts at once), then go
  await host.page.goto(`${base}/?app`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await (await host.page.waitForSelector('.home__create', { timeout: 120_000 })).click();
  await host.page.waitForFunction(() => /^\/r\/[A-Z]{6}$/.test(location.pathname), { timeout: 60_000 });
  const code = await host.page.evaluate(() => location.pathname.slice(3));
  log(`room ${code}`);
  await host.page.waitForFunction(() => !!window.__mfMode?.(), { timeout: 60_000 });
  await sleep(3000);
  await mode(host, 'returnToLobby');
  await sleep(2500);
  await mode(host, 'setMatchSettings', { teams: 2, bots: 6 });
  await sleep(1500);
  await mode(host, 'startMatch');
  await sleep(9000);
  // the phone joins mid-match
  await phone.page.goto(`${base}/r/${code}${phone.query}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await phone.page.waitForFunction(() => window.__view3d?.ready && window.__mfMode?.(), { timeout: 120_000 });
  const teams = await host.page.evaluate(() => JSON.stringify([...window.__lookBook.teamById]));
  log(`teams (id, team): ${teams}`);
  if (teams === '[]') fail('the room has no teams');

  await watch(both, 'joined mid-match', 20, walk(host));
  await shots(both, 'tdm', 4);
  const costs = { on: await cost(phone, true), off: await cost(phone, false) };
  costs.onAgain = await cost(phone, true);
  log('phone frame cost', JSON.stringify(costs));
  await watch(both, 'phone tab hidden', 6, async (i) => {
    if (i === 0)
      await phone.page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
  });
  await phone.page.evaluate(() => {
    delete document.hidden;
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await watch(both, 'phone tab back', 12, walk(host));
  for (let k = 0; k < 2; k++) {
    await phone.page.evaluate(async (r) => {
      const c = await import(`/@fs${r}/packages/content/src/index.ts`);
      window.__mfMode()?.setLook?.(c.cosmeticLoadoutWireIds(c.botLook(Math.floor(Math.random() * 1e6))));
    }, root);
    await watch(both, `phone changes look (${k + 1})`, 10, walk(host));
  }
  for (const bots of [3, 8, 2, 8]) {
    await mode(host, 'setMatchSettings', { bots });
    await watch(both, `bots fill to ${bots}`, 12, walk(host));
  }
  await phone.page.reload({ waitUntil: 'domcontentloaded' });
  await phone.page.waitForFunction(() => window.__view3d?.ready && window.__mfMode?.()?.net, { timeout: 120_000 });
  await watch(both, 'phone reloaded', 20, walk(host));

  // a free-for-all: back to the lobby, no teams
  await mode(host, 'returnToLobby');
  await sleep(2500);
  await mode(host, 'setMatchSettings', { teams: 0 });
  await sleep(1500);
  await mode(host, 'startMatch');
  await sleep(8000);
  await watch(both, 'free-for-all', 10, walk(host));
  await shots(both, 'ffa', 3);
} finally {
  await browser.close();
}
log(problems.length ? `${problems.length} problem(s)` : 'all checks passed');
process.exit(problems.length ? 1 : 0);
