/**
 * Results by team (team modes, v21; Pen board D7): the teams in finishing order with their scores and
 * their players' faces; every player's own stats stay in the table underneath.
 */
import type { MatchResults } from '@military-forge/sim';
import type { CSSProperties } from 'react';
import { PlayerPortrait } from '../portrait/Portrait';
import { ordinal } from '../shell/matchView';
import { TEAM_NAMES } from './palette';
import { TeamMark } from './TeamRoster';
import './teams.css';

/** The winner's line for a team match: "Team Alpha", or a draw. */
export function teamWinner(results: Pick<MatchResults, 'winnerTeam'>): { name: string; draw: boolean } {
  const t = results.winnerTeam ?? -1;
  return t >= 0 ? { name: `Team ${TEAM_NAMES[t]}`, draw: false } : { name: 'Draw', draw: true };
}

export function TeamStandings({ results, myTeam = -1, compact = false }: { results: Pick<MatchResults, 'teamScores' | 'standings'>; myTeam?: number; compact?: boolean }) {
  const scores = results.teamScores ?? [];
  const order = scores.map((s, t) => ({ t, s })).sort((a, b) => b.s - a.s || a.t - b.t);
  return (
    <ol className={compact ? 'mf-tres mf-tres--compact' : 'mf-tres'} aria-label="Team standings">
      {order.map(({ t, s }, i) => (
        <li key={t} className={t === myTeam ? 'mf-tres__team is-mine' : 'mf-tres__team'} style={{ '--tc': `var(--c-team-${t}, currentColor)` } as CSSProperties}>
          <span className="mf-tres__place">{ordinal(order.findIndex((o) => o.s === s) + 1)}</span>
          <TeamMark team={t} />
          <b className="mf-tres__name">Team {TEAM_NAMES[t]}</b>
          <b className="mf-tres__score num">{s}</b>
          {!compact && (
            <span className="mf-tres__faces" aria-hidden="true">
              {results.standings
                .filter((p) => p.team === t && !p.left)
                .map((p) => (
                  <span key={p.key} className="mf-tres__face">
                    <PlayerPortrait id={p.id} name={p.name} size={64} />
                  </span>
                ))}
            </span>
          )}
          {i === 0 && order.length > 1 && order[1]!.s === s && <span className="tag tag--ghost">Tied</span>}
        </li>
      ))}
    </ol>
  );
}
