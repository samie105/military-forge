/**
 * The VS poster's layouts (docs/design/character-feel-research.md §8.2), as data: who stands where, and
 * what the stamp says. Free-for-all is the only mode the sim plays today; team splits (2v2 to 4v4,
 * 4v4v4, 2v2v2v2) lay out the same way once team modes exist (`teams`).
 */
import type { Fighter } from '../looks/book';

export interface VsFighter extends Fighter {
  you: boolean;
  host: boolean;
}

export type VsKind =
  /** one fighter (training alone): the roll call of one */
  | 'solo'
  /** 1v1: mirrored halves, a big VS between */
  | 'duel'
  /** free-for-all, 3–8: a roll call in one row */
  | 'row'
  /** free-for-all, 9–16: two rows of compact cards */
  | 'rows'
  /** teams: one side per team, VS marks between */
  | 'teams';

export interface VsLayout {
  kind: VsKind;
  /** the stencil stamp: ALL VS ALL, VS */
  stamp: string;
  /** one list per side (FFA: a single side; rows: two) */
  sides: VsFighter[][];
}

/** You first (lifted, underlined); then the room's order (humans before bots). */
export function rollCall(fighters: readonly VsFighter[]): VsFighter[] {
  return [...fighters].sort((a, b) => Number(b.you) - Number(a.you) || Number(a.isBot) - Number(b.isBot) || a.id - b.id);
}

/**
 * The layout for these fighters. `teams` lists each team's player ids (null: free-for-all). A
 * free-for-all of exactly two plays as a duel.
 */
export function vsLayout(fighters: readonly VsFighter[], teams: readonly (readonly number[])[] | null = null): VsLayout {
  if (teams && teams.length >= 2) {
    const byId = new Map(fighters.map((f) => [f.id, f]));
    const sides = teams.map((ids) => rollCall(ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []))));
    return { kind: 'teams', stamp: 'VS', sides };
  }
  const all = rollCall(fighters);
  if (all.length <= 1) return { kind: 'solo', stamp: 'ALL VS ALL', sides: [all] };
  if (all.length === 2) return { kind: 'duel', stamp: 'VS', sides: [[all[0]!], [all[1]!]] };
  if (all.length <= 8) return { kind: 'row', stamp: 'ALL VS ALL', sides: [all] };
  const half = Math.ceil(all.length / 2);
  return { kind: 'rows', stamp: 'ALL VS ALL', sides: [all.slice(0, half), all.slice(half)] };
}

/** A name as a card shows it: no bot tag (the card says Bot), at most 16 characters (the name rules' own cap). */
export function cardName(f: Pick<Fighter, 'name' | 'isBot'>): string {
  const name = f.isBot ? f.name.replace(/^\s*\[\s*bot\s*\]\s*/i, '') : f.name;
  const chars = [...name.trim()];
  return chars.length > 16 ? `${chars.slice(0, 15).join('')}…` : chars.join('');
}

/** The poster's rules line ("First to 20 · 5 min"). */
export function rulesLine(killLimit: number, timeLimit: number): string {
  const kills = killLimit > 0 ? `First to ${killLimit}` : 'No kill limit';
  const time = timeLimit <= 0 ? 'No time limit' : timeLimit % 60 === 0 ? `${timeLimit / 60} min` : `${Math.floor(timeLimit / 60)}:${String(timeLimit % 60).padStart(2, '0')}`;
  return `${kills} · ${time}`;
}
