/**
 * The lobby's roster in team modes (protocol v21; Pen board "MATCH PRESENTATION", D5): one group per
 * team, its shape, name, colour and size, then its players. The host taps a player, then another
 * team's "Move here" (SetTeam); everyone else just sees where they stand. Teams even themselves out
 * at the countdown (party mates kept together), so the host only needs it for a preference.
 */
import { useState, type CSSProperties } from 'react';
import { PlayerAvatar } from '../presentation/PlayerAvatar';
import { playerName } from '../shell/matchView';
import type { LobbyPlayer } from '../shell/onlineView';
import { Icon } from '../ui/Icon';
import { blurAfter } from '../ui/Screen';
import { TEAM_LETTERS, TEAM_NAMES, TEAM_SHAPES } from './palette';
import './teams.css';

/** "Free-for-all", "2 teams" … for labels; "Team deathmatch" names the mode. */
export function modeName(teams: number): string {
  return teams > 0 ? `Team deathmatch · ${teams} teams` : 'Deathmatch';
}

export function TeamMark({ team, small = false }: { team: number; small?: boolean }) {
  if (team < 0) return null;
  return (
    <span className={small ? 'mf-tm mf-tm--sm' : 'mf-tm'} style={{ '--tc': `var(--c-team-${team}, currentColor)` } as CSSProperties} aria-label={`Team ${TEAM_NAMES[team]}`} role="img">
      <i aria-hidden="true">{TEAM_SHAPES[team]}</i>
      <b aria-hidden="true">{TEAM_LETTERS[team]}</b>
    </span>
  );
}

export function TeamRoster({ players, teams, host, onMove, phone = false }: { players: readonly LobbyPlayer[]; teams: number; host: boolean; onMove: (id: number, team: number) => void; phone?: boolean }) {
  const [picked, setPicked] = useState<number | null>(null);
  const groups = Array.from({ length: teams }, (_, t) => players.filter((p) => p.team === t));
  const loose = players.filter((p) => (p.team ?? -1) < 0 || (p.team ?? -1) >= teams);
  const pickedTeam = players.find((p) => p.id === picked)?.team ?? -1;
  return (
    <div className={phone ? 'mf-teams mf-teams--phone' : 'mf-teams'} data-teams={teams}>
      {groups.map((group, t) => (
        <section key={t} className="mf-team" style={{ '--tc': `var(--c-team-${t}, currentColor)` } as CSSProperties} aria-label={`Team ${TEAM_NAMES[t]}`}>
          <header className="mf-team__head">
            <TeamMark team={t} />
            <b className="mf-team__name">Team {TEAM_NAMES[t]}</b>
            <span className="mf-team__n">
              {group.length} · {group.filter((p) => p.ready || p.isBot).length} ready
            </span>
            {host && picked !== null && pickedTeam !== t && (
              <button
                type="button"
                className="btn btn--sm mf-team__move m-p8"
                onClick={blurAfter(() => {
                  onMove(picked, t);
                  setPicked(null);
                })}
              >
                <Icon name="plus" size="sm" />
                Move here
              </button>
            )}
          </header>
          <ol className="mf-team__rows">
            {group.map((p) => (
              <li key={p.id} className={['mf-team__row', p.you ? 'is-you' : '', picked === p.id ? 'is-picked' : ''].filter(Boolean).join(' ')}>
                {host ? (
                  <button type="button" className="mf-team__pick" aria-pressed={picked === p.id} aria-label={`Move ${playerName(p.name, p.isBot)} to another team`} onClick={blurAfter(() => setPicked(picked === p.id ? null : p.id))}>
                    <PlayerAvatar id={p.id} name={p.name} bot={p.isBot} />
                    <b>{playerName(p.name, p.isBot)}</b>
                  </button>
                ) : (
                  <span className="mf-team__pick">
                    <PlayerAvatar id={p.id} name={p.name} bot={p.isBot} />
                    <b>{playerName(p.name, p.isBot)}</b>
                  </span>
                )}
                {p.host && <span className="tag tag--host">Host</span>}
                {p.isBot && <span className="tag tag--bot">Bot</span>}
                {p.you && <span className="tag tag--you">You</span>}
                {!p.isBot && <span className={p.ready ? 'mf-team__ready is-ready' : 'mf-team__ready'}>{p.ready ? 'Ready' : 'Wait'}</span>}
              </li>
            ))}
          </ol>
        </section>
      ))}
      {loose.length > 0 && <p className="mf-teams__loose">{loose.length} joining: dealt onto a team in a moment</p>}
    </div>
  );
}

/** The host's mode picker: free-for-all, or 2, 3, 4 teams (lobby only). */
export function TeamModePicker({ teams, onTeams, id = 'mode' }: { teams: number; onTeams: (teams: number) => void; id?: string }) {
  return (
    <>
      <span className="label" id={`${id}-label`}>
        Mode
      </span>
      <div className="seg" role="radiogroup" aria-labelledby={`${id}-label`}>
        {[0, 2, 3, 4].map((t) => (
          <button key={t} type="button" className="seg__opt" role="radio" aria-checked={teams === t} onClick={blurAfter(() => onTeams(t))}>
            {t === 0 ? 'Free-for-all' : `${t} teams`}
          </button>
        ))}
      </div>
    </>
  );
}
