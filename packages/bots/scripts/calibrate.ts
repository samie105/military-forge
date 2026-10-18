/**
 * Tier calibration (NOTES §23): a level with parameter overrides (JSON) against a standing target,
 * pinned, at 12 m (Buzz, K-47, Hammer) and with the K-47 at 20 m; TTK as × the human baseline.
 *   pnpm --filter @military-forge/bots calibrate normal '{"aimError":0.8,"aimJitter":1}' ['{…}' …]
 */
import { BOT_LEVELS, type BotLevel, type BotLevelId } from '../src/levels';
import { measureDuel } from '../test/feelLib';
const level = (process.argv[2] ?? 'normal') as BotLevelId;
const human: Record<string, number> = { buzz: 2.54, k47: 1.69, hammer44: 1.82, k4720: 4.03 };
for (const json of process.argv.slice(3).length ? process.argv.slice(3) : ['{}']) {
  Object.assign(BOT_LEVELS[level] as BotLevel, JSON.parse(json));
  const cell = (w: string, d: number, key: string) => {
    const r = measureDuel(level, w, d, true, 30);
    return `${w}@${d} ${(100 * r.hitRate).toFixed(0)}% ×${(r.ttk / human[key]!).toFixed(2)}`;
  };
  console.log(`${json} · ${cell('buzz', 12, 'buzz')} · ${cell('k47', 12, 'k47')} · ${cell('hammer44', 12, 'hammer44')} · ${cell('k47', 20, 'k4720')}`);
}
