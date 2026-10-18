/**
 * 10 · Results (the kit's data-screen="results"): the winner and why the match ended, your place and
 * numbers with the MVP, the final standings, and the rematch vote. Local matches (training) and
 * rooms share it; rooms add the host's "Back to lobby" and leaving.
 */
import { MatchEndReason, MatchPhase, TICK_RATE, type MatchResults, type MatchStanding } from '@military-forge/sim';
import { Icon } from '../../ui/Icon';
import { Screen, blurAfter } from '../../ui/Screen';
import { formatClock, ordinal, playerName, type MatchView } from '../matchView';
import type { ShellActions } from '../store';

export interface ResultsExtras {
  /** a room: the host may send everyone back to the lobby */
  isHost: boolean;
  /** the host's player id (the Host badge), -1 = none */
  hostId: number;
  leave(): void;
}

export interface Winner {
  /** the winner's name, or "Draw" when the top score is shared */
  name: string;
  draw: boolean;
}

/** Who won: the best score alone, else a draw (a 0–0 time-out too). */
export function winnerOf(standings: readonly Pick<MatchStanding, 'name' | 'score' | 'isBot'>[]): Winner {
  if (!standings.length) return { name: '–', draw: false };
  const top = Math.max(...standings.map((s) => s.score));
  const best = standings.filter((s) => s.score === top);
  return best.length > 1 ? { name: 'Draw', draw: true } : { name: playerName(best[0]!.name, best[0]!.isBot), draw: false };
}

/** The reason chip: "Kill limit reached · 10 kills", "Time's up · 5:00". */
export function reasonChip(results: Pick<MatchResults, 'reason' | 'durationTicks'>, killLimit: number): { icon: string; text: string; state: 'kill-limit' | 'time-up' | 'over' } {
  if (results.reason === MatchEndReason.KillLimit) return { icon: 'target', text: `Kill limit reached · ${killLimit} kills`, state: 'kill-limit' };
  if (results.reason === MatchEndReason.TimeLimit) return { icon: 'clock', text: `Time's up · ${formatClock(Math.round(results.durationTicks / TICK_RATE))}`, state: 'time-up' };
  return { icon: 'flag', text: `Match over · ${formatClock(Math.round(results.durationTicks / TICK_RATE))}`, state: 'over' };
}

const thousands = (n: number) => n.toLocaleString('en-US');

function initial(name: string): string {
  return ([...name.trim()][0] ?? '?').toUpperCase();
}

export function Results({ view, results, actions, room, training }: { view: MatchView; results: MatchResults; actions: ShellActions; room?: ResultsExtras | undefined; training?: { leave(): void } | undefined }) {
  // ids are slots: after a leave, the leaver's row can carry your id, so skip departed rows
  const me = results.standings.find((s) => s.id === view.localId && !s.left);
  const winner = winnerOf(results.standings);
  const chip = reasonChip(results, view.killLimit);
  const mvp = results.standings.find((s) => s.mvp);
  const voting = view.phase === MatchPhase.Ending || view.phase === MatchPhase.Postgame;
  const closed = view.phase === MatchPhase.Closed;
  const humans = Math.max(view.humans, view.votes);
  const host = !room || room.isHost;
  const states = [chip.state === 'time-up' ? 'time-up' : 'kill-limit', host ? 'host' : 'guest', view.voted ? 'voted' : 'not-voted'];

  return (
    <Screen name="results" kind="menu" states={states} label="Match results">
      <div className="screen-body results">
        <div className="results__left">
          <p className="eyebrow">
            <Icon name="trophy" size="sm" />
            Match {results.number} · {view.mapName} · Deathmatch
          </p>
          <p className="results__winlabel">{winner.draw ? 'Top score shared' : 'Winner'}</p>
          <h1 id="res-winner" className="results__winner display" data-bind="results.winner">
            {winner.name}
          </h1>
          <p className="results__reason" data-bind="results.reason">
            <span className="results__chip">
              <Icon name={chip.icon} />
              {chip.text}
            </span>
          </p>

          {me && (
            <div className="you-card ticks">
              <div className="you-card__place">
                <span className="eyebrow">You placed</span>
                <span className="you-card__ord display" data-bind="results.me.placement">
                  {ordinal(me.placement)}
                </span>
                <span className="muted">
                  of <span data-bind="results.playerCount">{results.standings.length}</span>
                </span>
              </div>
              <dl className="you-card__stats">
                <div>
                  <dt>Kills</dt>
                  <dd className="num" data-bind="results.me.kills">
                    {me.kills}
                  </dd>
                </div>
                <div>
                  <dt>Deaths</dt>
                  <dd className="num" data-bind="results.me.deaths">
                    {me.deaths}
                  </dd>
                </div>
                <div>
                  <dt>Damage</dt>
                  <dd className="num" data-bind="results.me.damage">
                    {thousands(me.damageDealt)}
                  </dd>
                </div>
                {mvp && (
                  <div className="you-card__mvp">
                    <dt>
                      <Icon name="medal" size="sm" />
                      MVP
                    </dt>
                    <dd>
                      <span data-bind="results.mvp.name">{playerName(mvp.name, mvp.isBot)}</span>
                      <span className="small muted" data-bind="results.mvp.reason">
                        {mvp.kills} kills · {thousands(mvp.damageDealt)} damage
                      </span>
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>

        <section className="panel results__table" aria-labelledby="st-title">
          <div className="panel__head">
            <h2 className="h3" id="st-title">
              Final standings
            </h2>
          </div>
          <table className="table table--results">
            <thead>
              <tr>
                <th scope="col" className="t-rank">
                  #
                </th>
                <th scope="col">Player</th>
                <th scope="col" className="t-num">
                  Kills
                </th>
                <th scope="col" className="t-num">
                  Deaths
                </th>
                <th scope="col" className="t-num">
                  Damage
                </th>
                <th scope="col" className="t-num">
                  Score
                </th>
              </tr>
            </thead>
            <tbody>
              {results.standings.map((s) => {
                const you = s === me;
                const won = !winner.draw && s.placement === 1;
                const cls = [won ? 'is-winner' : '', you ? 'is-you' : '', s.isBot ? 'is-bot' : ''].filter(Boolean).join(' ');
                return (
                  <tr key={s.key} className={cls || undefined}>
                    <td className="t-rank">{won ? <Icon name="trophy" label="Winner" /> : s.placement}</td>
                    <td>
                      <span className="t-player">
                        {s.isBot ? (
                          <span className="avatar avatar--sm avatar--bot">
                            <Icon name="chip" size="sm" />
                          </span>
                        ) : (
                          <span className="avatar avatar--sm">{initial(s.name)}</span>
                        )}
                        {playerName(s.name, s.isBot)}
                        {room && !s.left && s.id === room.hostId && (
                          <span className="badge badge--host">
                            <Icon name="star" />
                            Host
                          </span>
                        )}
                        {you && <span className="badge badge--you">You</span>}
                        {s.mvp && (
                          <span className="badge badge--mvp">
                            <Icon name="medal" />
                            MVP
                          </span>
                        )}
                        {s.isBot && (
                          <span className="badge badge--bot">
                            <Icon name="chip" />
                            Bot
                          </span>
                        )}
                        {s.left && <span className="badge badge--bot">Left</span>}
                      </span>
                    </td>
                    <td className="t-num">{s.kills}</td>
                    <td className="t-num">{s.deaths}</td>
                    <td className="t-num">{thousands(s.damageDealt)}</td>
                    <td className="t-num t-score">{s.score}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </div>

      <footer className="results__bar">
        {view.voted ? (
          <button className="btn btn--secondary btn--xl results__voted" aria-pressed="true" disabled>
            <Icon name="check-circle" size="lg" />
            You voted to play again
          </button>
        ) : (
          <button className="btn btn--primary btn--xl" disabled={!voting} onClick={blurAfter(actions.playAgain)}>
            <Icon name="refresh" size="lg" />
            Play again
          </button>
        )}
        <div className="votes" aria-label="Play again votes">
          <span className="votes__pips" aria-hidden="true">
            {Array.from({ length: humans }, (_, i) => (
              <i key={i} className={i < view.votes ? 'on' : undefined}></i>
            ))}
          </span>
          <span>
            {closed ? (
              'Room closed'
            ) : (
              <>
                <b className="num" data-bind="results.votes">
                  {view.votes}/{humans}
                </b>{' '}
                want a rematch{view.phase === MatchPhase.Postgame ? ` · ${view.secondsLeft} s` : ''}
              </>
            )}
          </span>
        </div>
        <span className="topbar__spacer"></span>
        {host && (
          <button className="btn btn--secondary btn--xl" disabled={closed} onClick={blurAfter(actions.backToLobby)}>
            <Icon name="users" />
            Back to lobby
          </button>
        )}
        {(room ?? training) && (
          <button className="btn btn--ghost btn--xl" onClick={blurAfter(() => (room ?? training)!.leave())}>
            <Icon name={room ? 'door-out' : 'home'} />
            {room ? 'Leave room' : 'Home'}
          </button>
        )}
      </footer>
    </Screen>
  );
}
