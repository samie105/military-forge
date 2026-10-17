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
  /** one run-length encoded input stream per human player, joined in order */
  players: InputRun[][];
  /** run the replay through a Match with these rules (match.ts); absent = plain Game, as before */
  match?: Partial<MatchRules>;
  /** lobby commands for the Match (ready-up, rematch votes…) */
  commands?: MatchCommand[];
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

export function createReplayGame(replay: ReplayFile): Game {
  const game = new Game({ mapId: replay.map, seed: replay.seed, dummies: replay.dummies, tuning: replay.tuning ?? {} });
  replay.players.forEach((_, i) => {
    const p = game.addPlayer(`P${i + 1}`);
    const start = replay.starts?.[i];
    if (start) p.spawn(start.x, start.y, game.tuning);
    const loadout = replay.loadouts?.[i];
    if (loadout) game.setLoadout(p, loadout);
  });
  return game;
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
): { hashes: number[]; game: Game; match: Match | null } {
  const game = createReplayGame(replay);
  const match = replay.match ? new Match(game, replay.match) : null;
  const humans = game.players.filter((p) => p && !p.isBot).map((p) => p!.id);
  const streams = replay.players.map((runs) => decodeRuns(runs, replay.ticks));
  const commands = replay.commands ?? [];
  const inputs: (Input | undefined)[] = [];
  const hashes: number[] = [];
  for (let tick = 0; tick < replay.ticks; tick++) {
    humans.forEach((id, i) => (inputs[id] = streams[i]![tick]));
    if (match) {
      for (const [at, player, kind] of commands) if (at === tick) applyMatchCommand(match, humans[player]!, kind);
      match.step(inputs);
    } else game.step(inputs);
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
    private readonly meta: Pick<ReplayFile, 'map' | 'seed' | 'dummies' | 'tuning' | 'starts' | 'loadouts' | 'match'>,
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
