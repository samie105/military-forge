/**
 * Bots (docs/08 §9): server-side behaviour trees at 10 Hz that play through the same Input as
 * humans. `addBot` puts one in a Game (and `removeBot` takes it out: rooms swap bots for humans);
 * the sim calls its brain inside Game.step, so local play, rooms, replays and golden tests include
 * bots deterministically.
 */
import type { Game, PlayerState, ReplayBot, ReplayFile, ReplaySetup } from '@military-forge/sim';
import { BotBrain } from './brain';
import { botLevel, type BotLevelId } from './levels';
import { botName } from './names';

export { Aim, BODY_HALF_WIDTH, gauss } from './aim';
export { BOT_LOADOUTS, BotBrain, THINK_EVERY, type BotMode } from './brain';
export { Action, Condition, Selector, Sequence, Status, type BtNode } from './bt';
export { solveThrow, type Throw } from './grenadier';
export { Gunner, falloffAt, weaponValue, type Trigger } from './gunner';
export { BOT_LEVELS, botLevel, type BotLevel, type BotLevelId } from './levels';
export { Motor, type MotorGoal } from './motor';
export { BOT_NAMES, BOT_TAG, botName } from './names';
export { PathFinder } from './nav/astar';
export { navGraphFor, warmNavGraphs } from './nav/cache';
export { LinkKind, buildNavGraph, type NavGraph, type NavLink, type NavNode } from './nav/graph';
export { Navigator } from './nav/navigator';
export { Perception, type Contact } from './perception';

export interface BotSpec {
  /** default Normal */
  level?: BotLevelId;
  /** default the serial's tagged name ("[BOT] Badger") */
  name?: string;
  /** its seed serial (a replay puts a bot back with the one it had); default the game's next */
  serial?: number;
}

/** Every bot a game has had, for replays: who, its serial, when it joined and left. */
interface BotRecord {
  name: string;
  level: BotLevelId;
  serial: number;
  joinTick: number;
  /** −1: still in */
  leaveTick: number;
  player: PlayerState | null;
}

/** per game: the next serial (its seed and default name), and every bot it has had */
const rosters = new WeakMap<Game, { next: number; bots: BotRecord[] }>();

function rosterOf(game: Game): { next: number; bots: BotRecord[] } {
  let r = rosters.get(game);
  if (!r) {
    r = { next: 0, bots: [] };
    rosters.set(game, r);
  }
  return r;
}

/** Adds a bot that plays like a human: same spawns, same Input, its own seeded randomness. */
export function addBot(game: Game, spec: BotSpec = {}): PlayerState {
  const roster = rosterOf(game);
  const serial = spec.serial ?? roster.next;
  roster.next = Math.max(roster.next, serial + 1);
  const level = botLevel(spec.level);
  const p = game.addPlayer(spec.name ?? botName(serial));
  const brain = new BotBrain(game, level, serial);
  p.isBot = true;
  p.brain = brain;
  game.setLoadout(p, brain.loadout);
  roster.bots.push({ name: p.name, level: level.id, serial, joinTick: game.tick, leaveTick: -1, player: p });
  return p;
}

/** Takes a bot out of the game (a room making room for a human), noting the tick for replays. */
export function removeBot(game: Game, p: PlayerState): void {
  const record = rosterOf(game).bots.find((b) => b.player === p);
  if (record) {
    record.leaveTick = game.tick;
    record.player = null;
  }
  game.removePlayer(p.id);
}

export function addBots(game: Game, count: number, level: BotLevelId = 'normal'): PlayerState[] {
  const out: PlayerState[] = [];
  for (let i = 0; i < count; i++) out.push(addBot(game, { level }));
  return out;
}

/**
 * What to record for a game's bots (ReplayFile.bots): every bot it has had, in serial order, with
 * the tick it joined and (gone) the tick it left.
 */
export function botSpecs(game: Game): ReplayBot[] {
  return rosterOf(game)
    .bots.slice()
    .sort((a, b) => a.serial - b.serial)
    .map((b) => ({ name: b.name, level: b.level, serial: b.serial, joinTick: b.joinTick, ...(b.leaveTick >= 0 ? { leaveTick: b.leaveTick } : {}) }));
}

/**
 * `runReplay(replay, onTick, botReplaySetup(replay))`: puts the replay's bots back, after its
 * humans, each with its serial; bots that joined or left part-way through do so again at their
 * ticks, leaves before joins (as a room reconciles). Replays from before serials and ticks were
 * recorded: in order, all from the start.
 */
export function botReplaySetup(replay: ReplayFile): ReplaySetup {
  return (game) => {
    const bots = (replay.bots ?? []).map((b, i) => ({ level: botLevel(b.level).id, name: b.name, serial: b.serial ?? i, joinTick: b.joinTick ?? 0, leaveTick: b.leaveTick ?? -1 }));
    const live = new Map<number, PlayerState>();
    const join = (g: Game, b: (typeof bots)[number]) => live.set(b.serial, addBot(g, b));
    for (const b of bots) if (b.joinTick <= game.tick) join(game, b);
    if (!bots.some((b) => b.joinTick > game.tick || b.leaveTick >= 0)) return;
    return (g) => {
      for (const b of bots) {
        const p = b.leaveTick === g.tick ? live.get(b.serial) : undefined;
        if (!p) continue;
        removeBot(g, p);
        live.delete(b.serial);
      }
      for (const b of bots) if (b.joinTick === g.tick && g.tick > 0) join(g, b);
    };
  };
}
