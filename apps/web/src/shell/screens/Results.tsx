/**
 * 10 · Results (round two's data-screen="results"): the winner and why the match ended, your place
 * and numbers, the final standings, the MVP card and the rematch vote. Local matches (training) and
 * rooms share it; rooms add the host's "Back to lobby", sharing and leaving. Motion: the screen
 * floods from the clock (P6), the winner focus-pulls in (P1), the MVP card stamps (P7), the standings
 * rise in turn (P3), and each vote pip stamps as its vote lands (P7).
 *
 * The kit's highlight reel (longest shot, biggest launch, dash kills), the per-weapon report, best
 * streaks, main guns and the MVP card as a square image aren't recorded by the match yet: the
 * standings take the middle column, and the share button shares the room (the PR lists the gaps).
 */
import { MatchEndReason, MatchPhase, TICK_RATE, type MatchResults, type MatchStanding } from '@military-forge/sim';
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { Icon } from '../../ui/Icon';
import { viewport } from '../../ui/landscape';
import { flood } from '../../ui/motion';
import { Screen, blurAfter } from '../../ui/Screen';
import { ControllerContext } from '../context';
import { formatClock, ordinal, playerName, type MatchView } from '../matchView';
import type { ShellActions } from '../store';
import { Backdrop, NetPill } from './frame';
import { PlayerAvatar } from '../../presentation/PlayerAvatar';
import { SavedAdsList } from '../../ads/SavedAds';

export interface ResultsExtras {
  /** a room: the host may send everyone back to the lobby */
  isHost: boolean;
  /** the host's player id (the Host badge), -1 = none */
  hostId: number;
  /** the room's code (the MVP card's challenge, sharing) */
  code?: string;
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
  return { icon: 'ok', text: `Match over · ${formatClock(Math.round(results.durationTicks / TICK_RATE))}`, state: 'over' };
}

const thousands = (n: number) => n.toLocaleString('en-US');


export function Results({ view, results, actions, room, training }: { view: MatchView; results: MatchResults; actions: ShellActions; room?: ResultsExtras | undefined; training?: { leave(): void } | undefined }) {
  // ids are slots: after a leave, the leaver's row can carry your id, so skip departed rows
  const me = results.standings.find((s) => s.id === view.localId && !s.left);
  const winner = winnerOf(results.standings);
  const top = results.standings.find((s) => s.placement === 1);
  const chip = reasonChip(results, view.killLimit);
  const mvp = results.standings.find((s) => s.mvp);
  const voting = view.phase === MatchPhase.Ending || view.phase === MatchPhase.Postgame;
  const closed = view.phase === MatchPhase.Closed;
  const humans = Math.max(view.humans, view.votes);
  const host = !room || room.isHost;
  const states = [chip.state === 'time-up' ? 'time-up' : 'kill-limit', host ? 'host' : 'guest', view.voted ? 'voted' : 'not-voted'];
  const code = room?.code;
  const ctl = useContext(ControllerContext);

  // the match ends with a flood from the clock (P6) that contracts onto the winner's name; the screen's
  // entrances (the winner's P1, the standings' P3, the MVP's P7) wait until it has covered the screen
  const [held, setHeld] = useState(true);
  useEffect(() => {
    void flood({ x: viewport().w / 2, y: 60 }, { to: () => document.querySelector('.res__name'), onCovered: () => setHeld(false) });
  }, []);

  return (
    <Screen name="results" kind="menu" states={states} label="Match results" className={held ? 'mf-held' : undefined}>
      <Backdrop word="GG" />
      <div className="menu">
        <header className="menu-top">
          <span className="eyebrow">
            Debrief · Match {results.number} · {view.mapName}
          </span>
          <span className="res__why" data-bind="results.reason">
            <Icon name={chip.icon} size="sm" /> <b>{chip.text}</b>
          </span>
          <span className="menu-top__spacer"></span>
          <NetPill />
        </header>
        <div className="menu-body res">
          <section className="res__win" aria-labelledby="res-title">
            <div className="res__poster">
              <Icon name="trophy" className="mf-res__trophy" />
              <span className="stamp stamp--ink stamp--lg res__stamp m-p7">{winner.draw ? 'Draw' : 'Winner'}</span>
            </div>
            <h1 id="res-title" className="display res__name m-p1" data-bind="results.winner">
              {winner.name}
            </h1>
            {top && !winner.draw && (
              <p className="res__line">
                <b className="num">{top.kills}</b> kills · <b className="num">{top.deaths}</b> deaths · <b className="num">{thousands(top.damageDealt)}</b> damage
              </p>
            )}
            {me && (
              <div className="ticket rivets res__you m-p3" style={{ '--i': 1 } as CSSProperties}>
                <span className="rank">
                  <Icon name="rank" />
                </span>
                <span className="stamp stamp--ink" data-bind="results.me.placement">
                  {ordinal(me.placement)}
                </span>
                <span>
                  <b>You</b> · <span className="num" data-bind="results.me.kills">{me.kills}</span> kills · <span className="num" data-bind="results.me.deaths">{me.deaths}</span> deaths ·{' '}
                  <span className="num" data-bind="results.me.damage">
                    {thousands(me.damageDealt)}
                  </span>{' '}
                  damage
                </span>
              </div>
            )}
          </section>

          <section className="res__mid" aria-labelledby="st-title">
            <span className="label label--volt" id="st-title">
              Final standings
            </span>
            <div className="card card--print res__wpn">
              <table className="wtable mf-standings">
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">Player</th>
                    <th scope="col">Kills</th>
                    <th scope="col">Deaths</th>
                    <th scope="col" className="mf-col-dmg">Damage</th>
                    <th scope="col">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {results.standings.map((s, i) => {
                    const you = s === me;
                    const won = !winner.draw && s.placement === 1;
                    const cls = ['m-p3', 'm-p3--tight', won ? 'is-winner' : '', you ? 'is-you' : '', s.isBot ? 'is-bot' : ''].filter(Boolean).join(' ');
                    return (
                      <tr key={s.key} className={cls} style={{ '--i': i } as CSSProperties}>
                        <td className="num">{won ? <Icon name="trophy" label="Winner" /> : s.placement}</td>
                        <th scope="row">
                          <span className="mf-standings__who">
                            {/* their soldier as their avatar (presentation/); a player who left: the silhouette (ids are reused) */}
                            <PlayerAvatar id={s.left ? -1 : s.id} name={s.name} bot={s.isBot} />
                            {playerName(s.name, s.isBot)}
                            {room && !s.left && s.id === room.hostId && (
                              <span className="tag tag--host">
                                <Icon name="crown" />
                                Host
                              </span>
                            )}
                            {you && <span className="tag tag--you">You</span>}
                            {s.mvp && (
                              <span className="tag tag--brass">
                                <Icon name="medal" />
                                MVP
                              </span>
                            )}
                            {s.isBot && <span className="tag tag--bot">Bot</span>}
                            {s.left && <span className="tag tag--ghost">Left</span>}
                          </span>
                        </th>
                        <td className="num">{s.kills}</td>
                        <td className="num">{s.deaths}</td>
                        <td className="num mf-col-dmg">{thousands(s.damageDealt)}</td>
                        <td className="num">{s.score}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* the billboard ads the player saved during play (tap-to-save): only what they chose */}
            <SavedAdsList where="results" />
          </section>

          <section className="res__share" aria-label="Share and play again">
            {mvp && (
              <figure className="mvp m-p7" data-bind="results.mvp" aria-label="MVP card">
                <div className="mvp__inner halftone-ink">
                  <span className="mvp__kicker">
                    <Icon name="emblem" className="mvp__emblem" />
                    Decorated · match MVP · {view.mapName}
                  </span>
                  <b className="display mvp__big">MVP</b>
                  <b className="display mvp__name" data-bind="results.mvp.name">
                    {playerName(mvp.name, mvp.isBot)}
                  </b>
                  <div className="mvp__stats">
                    <span>
                      <b className="num">{mvp.kills}</b>kills
                    </span>
                    <span>
                      <b className="num">{mvp.deaths}</b>deaths
                    </span>
                    <span>
                      <b className="num">{thousands(mvp.damageDealt)}</b>damage
                    </span>
                  </div>
                  {code && (
                    <span className="mvp__cta">
                      Beat me · room code <b data-bind="room.code">{code}</b>
                    </span>
                  )}
                </div>
              </figure>
            )}
            {code && ctl && (
              <button className="btn btn--volt btn--xl btn--block m-p8" type="button" onClick={blurAfter(() => void ctl.shareLink(code))}>
                <Icon name="share" />
                <span className="btn__stack">
                  Share the room
                  <span className="btn__sub">Your share sheet, or the link copied</span>
                </span>
              </button>
            )}
            <div className="votes card" aria-label="Play again votes">
              <div className="votes__top">
                <b>Play again?</b>
                <span className="pips votes__pips" aria-hidden="true">
                  {Array.from({ length: humans }, (_, i) => (
                    <i key={i} className={i < view.votes ? 'on m-p7' : undefined}></i>
                  ))}
                </span>
                <span className="num" data-bind="results.votes">
                  {closed ? 'Room closed' : `${view.votes}/${humans}${view.phase === MatchPhase.Postgame ? ` · ${view.secondsLeft} s` : ''}`}
                </span>
              </div>
              <div className="votes__act">
                {view.voted ? (
                  <button className="btn btn--ghost m-p8" type="button" aria-pressed="true" disabled>
                    <Icon name="check" />
                    You voted
                  </button>
                ) : (
                  <button className="btn btn--paper m-p8" type="button" disabled={!voting} onClick={blurAfter(actions.playAgain)}>
                    <Icon name="refresh" />
                    Play again
                  </button>
                )}
                {host && (
                  <button className="btn btn--ghost m-p8" type="button" disabled={closed} onClick={blurAfter(actions.backToLobby)}>
                    <Icon name="users-plus" />
                    Back to lobby
                  </button>
                )}
                {(room ?? training) && (
                  <button className="btn btn--ghost m-p8" type="button" onClick={blurAfter(() => (room ?? training)!.leave())}>
                    <Icon name={room ? 'door-out' : 'back'} />
                    {room ? 'Leave room' : 'Home'}
                  </button>
                )}
              </div>
            </div>
          </section>
        </div>
      </div>
    </Screen>
  );
}
