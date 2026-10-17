/**
 * Headless-Chrome screenshots of the shell screens for PRs (throwaway profile, never the user's).
 *   cd apps/web && pnpm exec vite --port 5184 --strictPort      (dev server: the __game hook is dev-only)
 *   node apps/web/scripts/shell-screenshots.mjs [http://localhost:5184] [out dir]
 * Plays a real local match: kill limit 3, the player put on the range's cover through the dev hook,
 * the Strafer shot with the mouse until the match ends; then Play again and Back to lobby.
 */
/* global process */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const base = process.argv[2] ?? 'http://localhost:5184';
const out = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), '../../../docs/screenshots/shell');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const Phase = { Waiting: 0, Countdown: 1, InProgress: 2, Ending: 3 };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(out, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'mm-shell-'));
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: profile,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,720'],
  defaultViewport: { width: 1280, height: 720 },
});

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error('page error:', e.message));
  const shot = async (name) => {
    await page.screenshot({ path: join(out, `${name}.png`) });
    console.log(`wrote ${name}.png`);
  };
  const match = () => page.evaluate(() => {
    const m = window.__game.mode.match;
    return { phase: m.phase, number: m.number, score: m.players[window.__game.mode.localId].score };
  });
  const waitPhase = (phase, number = 1) =>
    page.waitForFunction((p, n) => window.__game?.mode?.match?.phase === p && window.__game.mode.match.number === n, { timeout: 120_000, polling: 100 }, phase, number);
  const strafer = () =>
    page.evaluate(() => {
      const { mode, camera } = window.__game;
      const s = mode.game.players.find((p) => p?.name === 'Strafer');
      return s?.alive ? { x: camera.toScreenX(s.x), y: camera.toScreenY(s.y + 0.75) } : null;
    });

  await page.goto(`${base}/?name=Ade&time=90&kills=3&countdown=5`, { waitUntil: 'load' });
  await waitPhase(Phase.Countdown, 0); // Match.number counts from GO
  // stand on the range's 1.2 m cover, clear of it for level shots (the spawn is 150 m away)
  await page.evaluate(() => Object.assign(window.__game.mode.me, { x: 154.5, y: 1.25 }));
  await page.mouse.move(900, 380);
  await delay(1500);
  await shot('01-countdown');

  await waitPhase(Phase.InProgress);
  let tookInMatch = false;
  while ((await match()).phase === Phase.InProgress) {
    const target = await strafer();
    if (target) {
      await page.mouse.move(target.x, target.y);
      await delay(120); // the camera leans toward the reticle: aim again once it settled
      const settled = await strafer();
      if (settled) {
        await page.mouse.move(settled.x, settled.y);
        await page.mouse.down();
        await delay(50);
        await page.mouse.up();
      }
    }
    if (!tookInMatch && (await match()).score >= 1) {
      await delay(300);
      await shot('02-in-match');
      tookInMatch = true;
    }
    await delay(560);
  }

  await waitPhase(Phase.Ending);
  await delay(800);
  await shot('03-results');

  const [playAgain] = await page.$$('xpath/.//button[contains(., "Play again")]');
  await playAgain.click();
  await waitPhase(Phase.Countdown, 1);
  await delay(300);
  await shot('04-play-again');

  await page.evaluate(() => window.__game.mode.backToLobby()); // what "Back to lobby" on the results does
  await waitPhase(Phase.Waiting, 1);
  await delay(300);
  await shot('05-lobby');
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
