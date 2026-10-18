/**
 * Bot golden replays (docs/06 §9): every input log in test/replays is re-simulated with its bots
 * put back by `botReplaySetup`, and its per-tick state hashes must match test/golden. Bots record
 * no inputs: they come back from the seed. A change to bot behaviour (or to the sim) that alters a
 * match fails here; if it's intentional, run `pnpm --filter @military-forge/bots golden:update`.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReplayGame, runReplay, type ReplayFile } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { botReplaySetup } from '../src';

const here = dirname(fileURLToPath(import.meta.url));
const REPLAYS = join(here, 'replays');
const GOLDEN = join(here, 'golden');
const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface GoldenFile {
  name: string;
  ticks: number;
  /** one 8-hex-digit hash per tick */
  hashes: string[];
}

const hex = (h: number) => (h >>> 0).toString(16).padStart(8, '0');
const files = readdirSync(REPLAYS).filter((f) => f.endsWith('.replay.json')).sort();
const load = (file: string) => JSON.parse(readFileSync(join(REPLAYS, file), 'utf8')) as ReplayFile;

describe('bot golden replays', () => {
  it('has replays to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(file, () => {
      const replay = load(file);
      // the bots played: each moved and fired (a golden of idle bots would prove little)
      const start = new Map<number, number>();
      const moved = new Set<number>();
      const fired = new Set<number>();
      const { hashes, game } = runReplay(
        replay,
        (g) => {
          for (const p of g.players) {
            if (!p?.brain || !p.alive) continue;
            const x0 = start.get(p.id);
            if (x0 === undefined) start.set(p.id, p.x);
            else if (Math.abs(p.x - x0) > 5) moved.add(p.id);
          }
          for (const e of g.events) if (e.type === 'shot' && g.players[e.shooter]?.brain) fired.add(e.shooter);
        },
        botReplaySetup(replay),
      );
      const bots = game.players.filter((p) => p?.brain).map((p) => p!.id);
      expect(bots.length).toBe(replay.bots!.length);
      expect(bots.filter((id) => moved.has(id)), 'moved').toEqual(bots);
      expect(bots.filter((id) => fired.has(id)), 'fired').toEqual(bots);
      const actual = hashes.map(hex);
      const goldenPath = join(GOLDEN, file.replace('.replay.json', '.hashes.json'));
      if (UPDATE || !existsSync(goldenPath)) {
        if (!UPDATE && process.env.CI) throw new Error(`missing golden file for ${file}; run the bots golden:update`);
        mkdirSync(GOLDEN, { recursive: true });
        const golden: GoldenFile = { name: replay.name, ticks: replay.ticks, hashes: actual };
        writeFileSync(goldenPath, JSON.stringify(golden, null, 0) + '\n');
        return;
      }
      const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenFile;
      expect(actual.length).toBe(golden.hashes.length);
      const firstDiff = actual.findIndex((h, i) => h !== golden.hashes[i]);
      expect(firstDiff, `${file} diverges at tick ${firstDiff}`).toBe(-1);
    }, 60_000);
  }

  it('re-running a bot match is bit-identical', () => {
    const replay = load('bots-flux-lab.replay.json');
    const a = runReplay(replay, undefined, botReplaySetup(replay)).hashes;
    const b = runReplay(replay, undefined, botReplaySetup(replay)).hashes;
    expect(a).toEqual(b);
  });

  it('a replay with bots refuses to run without them (it would play a different match)', () => {
    expect(() => createReplayGame(load('bots-match.replay.json'))).toThrow(/botReplaySetup/);
  });
});
