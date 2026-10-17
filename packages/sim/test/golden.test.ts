/**
 * Golden replays (docs/06 §9): every input log in test/replays is re-simulated and its per-tick
 * state hashes must match test/golden. Any change to movement/combat that alters outcomes fails
 * here; if the change is intentional, run `pnpm golden:update` and commit the new hashes.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runReplay, type ReplayFile } from '../src';

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
const files = existsSync(REPLAYS) ? readdirSync(REPLAYS).filter((f) => f.endsWith('.replay.json')).sort() : [];

describe('golden replays', () => {
  it('has replays to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(file, () => {
      const replay = JSON.parse(readFileSync(join(REPLAYS, file), 'utf8')) as ReplayFile;
      const { hashes } = runReplay(replay);
      const actual = hashes.map(hex);
      const goldenPath = join(GOLDEN, file.replace('.replay.json', '.hashes.json'));

      if (UPDATE || !existsSync(goldenPath)) {
        if (!UPDATE && process.env.CI) throw new Error(`missing golden file for ${file}; run pnpm golden:update`);
        mkdirSync(GOLDEN, { recursive: true });
        const golden: GoldenFile = { name: replay.name, ticks: replay.ticks, hashes: actual };
        writeFileSync(goldenPath, JSON.stringify(golden, null, 0) + '\n');
        return;
      }

      const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as GoldenFile;
      expect(actual.length).toBe(golden.hashes.length);
      const firstDiff = actual.findIndex((h, i) => h !== golden.hashes[i]);
      expect(firstDiff, `${file} diverges at tick ${firstDiff}`).toBe(-1);
    });
  }

  it('re-running a replay is bit-identical', () => {
    const replay = JSON.parse(readFileSync(join(REPLAYS, files[0]!), 'utf8')) as ReplayFile;
    expect(runReplay(replay).hashes).toEqual(runReplay(replay).hashes);
  });
});
