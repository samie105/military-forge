/**
 * Bots (docs/08 §9): server-side behaviour trees at 10 Hz that play through the same Input as
 * humans. `addBot` puts one in a Game; the sim calls its brain inside Game.step, so local play,
 * replays and golden tests include bots deterministically.
 */
import type { Game, PlayerState, ReplayFile } from '@military-forge/sim';
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
export { navGraphFor } from './nav/cache';
export { LinkKind, buildNavGraph, type NavGraph, type NavLink, type NavNode } from './nav/graph';
export { Navigator } from './nav/navigator';
export { Perception, type Contact } from './perception';

export interface BotSpec {
  /** default Normal */
  level?: BotLevelId;
  /** default the next tagged name ("[BOT] Badger") */
  name?: string;
}

/** bots added to each game so far: the next one's serial (its seed and default name) */
const added = new WeakMap<Game, number>();

/** Adds a bot that plays like a human: same spawns, same Input, its own seeded randomness. */
export function addBot(game: Game, spec: BotSpec = {}): PlayerState {
  const serial = added.get(game) ?? 0;
  added.set(game, serial + 1);
  const p = game.addPlayer(spec.name ?? botName(serial));
  const brain = new BotBrain(game, botLevel(spec.level), serial);
  p.isBot = true;
  p.brain = brain;
  game.setLoadout(p, brain.loadout);
  return p;
}

export function addBots(game: Game, count: number, level: BotLevelId = 'normal'): PlayerState[] {
  const out: PlayerState[] = [];
  for (let i = 0; i < count; i++) out.push(addBot(game, { level }));
  return out;
}

/** The specs to record for a game's bots (ReplayFile.bots), in the order they were added. */
export function botSpecs(game: Game): { name: string; level: string }[] {
  const out: { name: string; level: string; serial: number }[] = [];
  for (const p of game.players) if (p?.brain instanceof BotBrain) out.push({ name: p.name, level: p.brain.level.id, serial: p.brain.serial });
  return out.sort((a, b) => a.serial - b.serial).map(({ name, level }) => ({ name, level }));
}

/** `runReplay(replay, onTick, botReplaySetup(replay))`: puts the replay's bots back, after its humans. */
export function botReplaySetup(replay: ReplayFile): (game: Game) => void {
  return (game) => {
    for (const b of replay.bots ?? []) addBot(game, { level: botLevel(b.level).id, name: b.name });
  };
}
