/**
 * Shared by the soak test and scripts/soak.ts: runs a game of bots and measures stuck time. A bot
 * is stuck when it's trying to get somewhere (its navigator has a plan, or it's roaming, hunting
 * or going for an item) and has moved less than 0.5 m in 3 s. Holding a firing spot or waiting in cover isn't.
 */
import type { Game } from '@military-forge/sim';
import { BotBrain } from '../src/brain';

export interface SoakResult {
  /** stuck bot-seconds / alive bot-seconds */
  stuckFraction: number;
  worstStuckSeconds: number;
  deaths: number;
  kills: number;
  metresPerBotMinute: number;
  /** where bots were stuck, "(x,y)" rounded, most frequent first */
  stuckAt: string[];
}

/** a bot is stuck when it moved less than this over the window */
const STUCK_METRES = 0.5;
const WINDOW_TICKS = 180;
const SAMPLE_EVERY = 30;

/** `before(game, t)`, if given, runs before each tick (to set things off around the bots). */
export function soakMap(game: Game, ticks: number, before?: (game: Game, t: number) => void): SoakResult {
  const bots = game.players.filter((p) => p?.isBot).map((p) => p!);
  const history = new Map<number, { x: number; y: number; alive: boolean; trying: boolean }[]>();
  const stuckSamples = new Map<number, number>();
  const aliveSamples = new Map<number, number>();
  const stuckPlaces = new Map<string, number>();
  let moved = 0;
  const last = new Map<number, { x: number; y: number }>();
  let deaths = 0;
  let kills = 0;
  for (let t = 0; t < ticks; t++) {
    before?.(game, t);
    game.step([]);
    for (const e of game.events) {
      if (e.type === 'death') {
        deaths++;
        if (e.killer !== e.victim) kills++;
      }
    }
    for (const p of bots) {
      if (!p.alive) {
        last.delete(p.id);
        continue;
      }
      const l = last.get(p.id);
      if (l) moved += Math.sqrt((p.x - l.x) * (p.x - l.x) + (p.y - l.y) * (p.y - l.y));
      last.set(p.id, { x: p.x, y: p.y });
    }
    if (t % SAMPLE_EVERY !== 0) continue;
    for (const p of bots) {
      const h = history.get(p.id) ?? [];
      const brain = p.brain instanceof BotBrain ? p.brain : null;
      const trying = !brain || brain.nav.busy || brain.mode === 'roam' || brain.mode === 'hunt' || brain.mode === 'grab';
      h.push({ x: p.x, y: p.y, alive: p.alive, trying });
      if (h.length > WINDOW_TICKS / SAMPLE_EVERY + 1) h.shift();
      history.set(p.id, h);
      if (!p.alive || game.inputsFrozen) continue;
      aliveSamples.set(p.id, (aliveSamples.get(p.id) ?? 0) + 1);
      if (h.length < WINDOW_TICKS / SAMPLE_EVERY + 1 || h.some((s) => !s.alive)) continue;
      const span = Math.max(...h.map((s) => Math.abs(s.x - p.x) + Math.abs(s.y - p.y)));
      if (h.every((s) => s.trying) && span < STUCK_METRES) {
        stuckSamples.set(p.id, (stuckSamples.get(p.id) ?? 0) + 1);
        const key = `(${p.x.toFixed(0)},${p.y.toFixed(0)})`;
        stuckPlaces.set(key, (stuckPlaces.get(key) ?? 0) + 1);
      }
    }
  }
  let stuck = 0;
  let alive = 0;
  let worst = 0;
  for (const p of bots) {
    const s = stuckSamples.get(p.id) ?? 0;
    stuck += s;
    alive += aliveSamples.get(p.id) ?? 0;
    worst = Math.max(worst, (s * SAMPLE_EVERY) / 60);
  }
  return {
    stuckFraction: alive ? stuck / alive : 0,
    worstStuckSeconds: worst,
    deaths,
    kills,
    metresPerBotMinute: moved / bots.length / (ticks / 3600),
    stuckAt: [...stuckPlaces].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`),
  };
}
