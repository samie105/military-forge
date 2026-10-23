/**
 * The scoreboard by team (team modes, v21; Pen board D6): rows grouped by team (the leading team first),
 * each group under a header with the team's mark, name and score. Pure helpers for the HUD (hud.ts).
 */
import { TEAM_LETTERS, TEAM_NAMES, TEAM_SHAPES } from './palette';
import './teams.css';

export interface TeamRowLike {
  team?: number;
  score: number;
  left: boolean;
}

/** The team's score: its players' scores (kills less self-kills), leavers included, as the server counts them. */
export function teamTotals<T extends TeamRowLike>(rows: readonly T[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of rows) if ((r.team ?? -1) >= 0) out.set(r.team!, (out.get(r.team!) ?? 0) + r.score);
  return out;
}

/** Rows grouped by team (highest team score first, then team order), keeping each team's own order; teamless rows last. */
export function orderByTeam<T extends TeamRowLike>(rows: readonly T[]): T[] {
  const totals = teamTotals(rows);
  const teams = [...totals.keys()].sort((a, b) => totals.get(b)! - totals.get(a)! || a - b);
  return [...teams.flatMap((t) => rows.filter((r) => r.team === t)), ...rows.filter((r) => (r.team ?? -1) < 0)];
}

/** A team's header text: "◆ A · Team Alpha". */
export function teamHeading(team: number): string {
  return `${TEAM_SHAPES[team] ?? ''} ${TEAM_LETTERS[team] ?? ''} · Team ${TEAM_NAMES[team] ?? team + 1}`;
}
