/**
 * Bot feel numbers (NOTES §23): hit rate and time-to-kill against a standing target, per level,
 * next to the sim's human baseline (perfect torso aim, packages/sim/scripts/feel-lib.ts).
 *   pnpm --filter @military-forge/bots feel [samples=20]
 */
import { weapons } from '@military-forge/content';
import { measureWeapon } from '../../sim/scripts/feel-lib';
import { measureDuel } from '../test/feelLib';

const samples = Number(process.argv[2] ?? 20);
const cases = [
  ['buzz', 12],
  ['k47', 12],
  ['hammer44', 12],
  ['k47', 20],
  ['widow', 30],
] as const;
const human = new Map(cases.map(([w, d]) => [`${w}@${d}`, measureWeapon(weapons.find((x) => x.id === w)!.index, d, false, {}, samples)]));
const rows: string[][] = [['level', 'weapon', 'dist', 'human hits', 'human TTK', 'pinned hits', 'pinned TTK', '× human', 'moving hits', 'moving TTK', 'kills']];
for (const level of ['easy', 'normal', 'hard'] as const) {
  for (const [weapon, dist] of cases) {
    const h = human.get(`${weapon}@${dist}`)!;
    const pinned = measureDuel(level, weapon, dist, true, samples);
    const moving = measureDuel(level, weapon, dist, false, samples);
    rows.push([
      level,
      weapon,
      `${dist} m`,
      `${(100 * h.hitRate).toFixed(0)}%`,
      `${h.ttk.toFixed(2)} s`,
      `${(100 * pinned.hitRate).toFixed(0)}%`,
      `${pinned.ttk.toFixed(2)} s`,
      `${(pinned.ttk / h.ttk).toFixed(2)}×`,
      `${(100 * moving.hitRate).toFixed(0)}%`,
      `${moving.ttk.toFixed(2)} s`,
      `${(100 * moving.killRate).toFixed(0)}%`,
    ]);
  }
}
const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
for (const r of rows) console.log(r.map((v, c) => v.padEnd(widths[c]!)).join('  '));
