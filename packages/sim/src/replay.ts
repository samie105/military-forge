/**
 * Replays = input logs. Because the sim is deterministic, an input log reproduces a whole match.
 * Used for golden tests (docs/06 §9), bug repro and, later, killcams and moderation review.
 */
import type { Tuning } from '@military-forge/content';
import { Game } from './game';
import { hashGame } from './hash';
import { createInput, type Input } from './input';
import { Match, hashMatch, type MatchRules } from './match';

/** [repeatCount, buttons, aim, weaponSelect, throwStrength] */
export type InputRun = [number, number, number, number, number];

export type MatchCommandKind = 'ready' | 'unready' | 'start' | 'rematch' | 'lobby';
/** [tick, human player index, command]: applied before that tick is simulated */
export type MatchCommand = [number, number, MatchCommandKind];

/** A bot in a replay: packages/bots re-creates it from this and the seed (its inputs aren't recorded). */
export interface ReplayBot {
  name: string;
  /** 'easy' | 'normal' | 'hard' (packages/bots) */
  level: string;
  /** its seed serial: the order bots were added to the game, from 0 (default: its place in `bots`) */
  serial?: number;
  /** the tick it joined, before that tick was simulated (default 0: with the humans) */
  joinTick?: number;
  /** the tick it left, before that tick was simulated (absent: it stayed): rooms swap bots for humans */
  leaveTick?: number;
}

/**
 * A replay's setup hook (packages/bots botReplaySetup): puts its bots in at the start, and may
 * return a function to call before every tick (bots joining and leaving part-way through).
 */
export type ReplaySetup = (game: Game) => ((game: Game) => void) | void;

export interface ReplayFile {
  version: 1;
  name: string;
  map: string;
  seed: number;
  dummies: boolean;
  tuning?: Partial<Tuning>;
  ticks: number;
  /** optional start positions (feet) per human player, applied after joining */
  starts?: { x: number; y: number }[];
  /** optional weapon loadouts per human player ([slot 0, slot 1] weapon indices), also used on respawn */
  loadouts?: [number, number][];
  /** optional grenades per human player, counts by grenade type (default: frag ×3), also given on respawn */
  grenadeLoadouts?: number[][];
  /** one run-length encoded input stream per human player, joined in order */
  players: InputRun[][];
  /** run the replay through a Match with these rules (match.ts); absent = plain Game, as before */
  match?: Partial<MatchRules>;
  /** map pickups on (GameOptions.pickups); absent = off, as in replays recorded before pickups existed */
  pickups?: boolean;
  /** lobby commands for the Match (ready-up, rematch votes…) */
  commands?: MatchCommand[];
  /** bots, joined after the humans in this order; replay with packages/bots `botReplaySetup` */
  bots?: ReplayBot[];
}

export function encodeRuns(inputs: readonly Input[]): InputRun[] {
  const runs: InputRun[] = [];
  for (const i of inputs) {
    const last = runs[runs.length - 1];
    if (last && last[1] === i.buttons && last[2] === i.aim && last[3] === i.weaponSelect && last[4] === i.throwStrength) last[0]++;
    else runs.push([1, i.buttons, i.aim, i.weaponSelect, i.throwStrength]);
  }
  return runs;
}

/** Expands runs into one Input per tick (padding with the last input). */
export function decodeRuns(runs: readonly InputRun[], ticks: number): Input[] {
  const out: Input[] = [];
  for (const [count, buttons, aim, weaponSelect, throwStrength] of runs) {
    for (let i = 0; i < count && out.length < ticks; i++) out.push({ buttons, aim, weaponSelect, throwStrength });
  }
  while (out.length < ticks) out.push(out.length ? { ...out[out.length - 1]! } : createInput());
  return out;
}

/**
 * The replay's starting game: map, dummies, then the humans in order. `setup` runs last: replays
 * with `bots` need packages/bots `botReplaySetup(replay)` there (the sim can't build brains).
 */
export function createReplayGame(replay: ReplayFile, setup?: ReplaySetup): Game {
  return startReplay(replay, setup).game;
}

/** createReplayGame, and the setup's per-tick hook (null: none). */
function startReplay(replay: ReplayFile, setup?: ReplaySetup): { game: Game; beforeTick: ((game: Game) => void) | null } {
  if (replay.bots?.length && !setup) throw new Error(`replay "${replay.name}" has bots: run it with @military-forge/bots botReplaySetup`);
  const game = new Game({ mapId: replay.map, seed: replay.seed, dummies: replay.dummies, tuning: replay.tuning ?? {}, pickups: replay.pickups ?? false });
  replay.players.forEach((_, i) => {
    const p = game.addPlayer(`P${i + 1}`);
    const start = replay.starts?.[i];
    if (start) p.spawn(start.x, start.y, game.tuning);
    const loadout = replay.loadouts?.[i];
    if (loadout) game.setLoadout(p, loadout);
    const belt = replay.grenadeLoadouts?.[i];
    if (belt) game.setGrenadeLoadout(p, belt);
  });
  const hook = setup ? setup(game) : undefined;
  return { game, beforeTick: typeof hook === 'function' ? hook : null };
}

export function applyMatchCommand(match: Match, playerId: number, kind: MatchCommandKind): void {
  if (kind === 'ready' || kind === 'unready') match.setReady(playerId, kind === 'ready');
  else if (kind === 'start') match.start();
  else if (kind === 'rematch') match.voteRematch(playerId);
  else match.returnToLobby();
}

/** Runs a replay and returns the state hash after every tick (game + match state when it has one). */
export function runReplay(
  replay: ReplayFile,
  onTick?: (game: Game, match: Match | null) => void,
  setup?: ReplaySetup,
): { hashes: number[]; game: Game; match: Match | null } {
  const { game, beforeTick } = startReplay(replay, setup);
  const match = replay.match ? new Match(game, replay.match) : null;
  const humans = game.players.filter((p) => p && !p.isBot).map((p) => p!.id);
  const streams = replay.players.map((runs) => decodeRuns(runs, replay.ticks));
  const commands = replay.commands ?? [];
  const inputs: (Input | undefined)[] = [];
  const hashes: number[] = [];
  for (let tick = 0; tick < replay.ticks; tick++) {
    humans.forEach((id, i) => (inputs[id] = streams[i]![tick]));
    if (match) for (const [at, player, kind] of commands) if (at === tick) applyMatchCommand(match, humans[player]!, kind);
    // bots joining or leaving now (a room fills itself up between commands and the step)
    beforeTick?.(game);
    if (match) match.step(inputs);
    else game.step(inputs);
    onTick?.(game, match);
    hashes.push(match ? hashMatch(match, hashGame(game)) : hashGame(game));
  }
  return { hashes, game, match };
}

/** Records the local player's inputs while playing, for turning playtests into golden tests. */
export class ReplayRecorder {
  private readonly inputs: Input[] = [];
  private readonly commands: MatchCommand[] = [];

  constructor(
    private readonly meta: Pick<ReplayFile, 'map' | 'seed' | 'dummies' | 'tuning' | 'starts' | 'loadouts' | 'grenadeLoadouts' | 'match' | 'pickups' | 'bots'>,
    private readonly name = 'recorded',
  ) {}

  record(input: Readonly<Input>): void {
    this.inputs.push({ ...input });
  }

  /** A lobby command the local player gave before the next recorded tick. */
  command(kind: MatchCommandKind): void {
    this.commands.push([this.inputs.length, 0, kind]);
  }

  get length(): number {
    return this.inputs.length;
  }

  toFile(): ReplayFile {
    return {
      version: 1,
      name: this.name,
      ...this.meta,
      ticks: this.inputs.length,
      players: [encodeRuns(this.inputs)],
      ...(this.commands.length ? { commands: this.commands.slice() } : {}),
    };
  }
}
