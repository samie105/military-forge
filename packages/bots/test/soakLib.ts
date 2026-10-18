/**
 * Shared by the soak test and scripts/soak.ts: runs a game of bots and measures stuck time. A bot
 * is stuck when it's trying to get somewhere (its navigator has a plan, it's roaming, hunting or
 * going for an item, or it's in a fight it can't hit its target from) and has moved less than 0.5 m
 * in 3 s. Holding a firing spot or waiting in cover isn't. Also: how long bots are dry, shots at
 * targets the bullets can't reach, and Fire held with nothing to fire.
 */
import { weapons } from '@military-forge/content';
import { Btn, type Game } from '@military-forge/sim';
import { BotBrain } from '../src/brain';
import { BASH_REACH, dry } from '../src/gunner';

export interface SoakResult {
  /** stuck bot-seconds / alive bot-seconds */
  stuckFraction: number;
  worstStuckSeconds: number;
  deaths: number;
  kills: number;
  metresPerBotMinute: number;
  /** where bots were stuck, "(x,y)" rounded, most frequent first */
  stuckAt: string[];
  /** bot shots at their target, and those the bullet couldn't reach (its range, or the map's fog) */
  targetShots: number;
  beyondReach: number;
  /** dry (both guns empty) bot-time / alive bot-time */
  dryFraction: number;
  /** ticks a dry bot held Fire with nobody in bashing reach */
  dryFireTicks: number;
}

/** The weapon range a bullet from the shooter's shoulder uses up getting to q's torso (combat.ts). */
function rangeUsed(game: Game, sx: number, sy: number, tx: number, ty: number): number {
  const dx = tx - sx;
  const dy = ty - sy;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (!game.mech || d < 1e-6) return d;
  game.mech.castBullet(sx, sy, dx / d, dy / d);
  return game.mech.bulletCost(d);
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
  let targetShots = 0;
  let beyondReach = 0;
  let drySamples = 0;
  let dryFireTicks = 0;
  const dryBefore = new Uint8Array(64);
  for (let t = 0; t < ticks; t++) {
    before?.(game, t);
    for (const p of bots) dryBefore[p.id] = p.alive && dry(p) ? 1 : 0;
    game.step([]);
    for (const e of game.events) {
      if (e.type === 'death') {
        deaths++;
        if (e.killer !== e.victim) kills++;
      } else if (e.type === 'shot') {
        const p = game.players[e.shooter];
        const brain = p?.brain instanceof BotBrain ? p.brain : null;
        const q = brain && brain.target >= 0 ? game.players[brain.target] : null;
        if (!p || !q?.alive) continue;
        targetShots++;
        const used = rangeUsed(game, p.shoulderX(game.tuning), p.shoulderY(game.tuning), q.x, q.y + 0.85);
        if (used > weapons[e.weapon]!.range) beyondReach++;
      }
    }
    // Fire held by a bot that was dry going into the tick (the shot that empties a gun isn't one)
    for (const p of bots) {
      if (!p.alive || dryBefore[p.id] === 0 || (p.input.buttons & Btn.Fire) === 0) continue;
      const brain = p.brain instanceof BotBrain ? p.brain : null;
      const q = brain && brain.target >= 0 ? game.players[brain.target] : null;
      if (!q || Math.abs(q.x - p.x) + Math.abs(q.y - p.y) > BASH_REACH * 2) dryFireTicks++;
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
      // a fight it can't hit its target from (no line of fire, out of reach) is a stand-off: it should be moving
      const standOff = brain !== null && brain.mode === 'fight' && !brain.inReach;
      // waiting out a cloud of gas that closes every way on isn't trying (brain.ts gasBound checks it)
      const trying = !brain || brain.nav.busy || brain.mode === 'roam' || brain.mode === 'hunt' || brain.mode === 'grab' || standOff;
      h.push({ x: p.x, y: p.y, alive: p.alive, trying });
      if (h.length > WINDOW_TICKS / SAMPLE_EVERY + 1) h.shift();
      history.set(p.id, h);
      if (!p.alive || game.inputsFrozen) continue;
      aliveSamples.set(p.id, (aliveSamples.get(p.id) ?? 0) + 1);
      if (dry(p)) drySamples++;
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
    targetShots,
    beyondReach,
    dryFraction: alive ? drySamples / alive : 0,
    dryFireTicks,
  };
}
