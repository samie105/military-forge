/**
 * 10 · Results (round two's data-screen="results"): the winner and why the match ended, your place
 * and numbers, the final standings, the MVP card and the rematch vote. Play again is the one primary
 * action, always (UX-40): the volt button at the top of the right column, carrying the room's vote (its
 * pips and count) when there are people to vote; sharing the room, Back to lobby and Leave come after it.
 * Alone with bots (audit 2 P-02, P-03), you are the headline and no bot gets the MVP card. The poster
 * shows a soldier: yours when you're the headline, else the winner's; a bot winner says it is a bot.
 * Local matches (training) and rooms share it; rooms add the host's "Back to lobby", sharing and leaving.
 * Training is the player's own: they are the headline (Victory, 2nd place…), and it ends with Play again
 * or Leave (no vote, no lobby). Motion: the screen floods from the clock (P6), the winner focus-pulls in
 * (P1), the MVP card stamps (P7), the standings rise in turn (P3), and each vote pip stamps as its vote lands (P7).
 *
 * The kit's highlight reel (longest shot, biggest launch, dash kills), the per-weapon report, best
 * streaks, main guns and the MVP card as a square image aren't recorded by the match yet: the
 * standings take the middle column (the first matches' debrief under them), and the share button
 * shares the room (the PR lists the gaps).
 */
import { DebriefLines } from '../../tour/DebriefLines';
import { MatchEndReason, MatchPhase, TICK_RATE, type MatchResults, type MatchStanding } from '@military-forge/sim';
import { useContext, useEffect, useState, type CSSProperties } from 'react';
import { Icon } from '../../ui/Icon';
import { viewport } from '../../ui/landscape';
import { flood } from '../../ui/motion';
import { Screen, blurAfter } from '../../ui/Screen';
import { ControllerContext } from '../context';
import { formatClock, noun, ordinal, playerName, resultHeadline, type MatchView } from '../matchView';
import type { ShellActions } from '../store';
import { Backdrop, NetPill } from './frame';
import { PlayerAvatar } from '../../presentation/PlayerAvatar';
import { PlayerPortrait } from '../../portrait/Portrait';
import { SavedAdsList } from '../../ads/SavedAds';
import { TeamStandings, teamWinner } from '../../teams/TeamResults';
import { TeamMark } from '../../teams/TeamRoster';
import { PlayerMore } from '../../social/ReportSheet';
import { AddFriendButton, RowActions } from '../../social/AddFriend';
import { useSocial } from '../../social/Squad';
import { BotsMoved } from '../../tour/PlayNowBots';
import { AgainEasy } from '../../tour/DebriefLines';
import { MatchXp } from './Progress';
import { KeepName } from './KeepName';

export interface ResultsExtras {
  /** a room: the host may send everyone back to the lobby */
  isHost: boolean;
  /** the host's player id (the Host badge), -1 = none */
  hostId: number;
  /** the room's code (the MVP card's challenge, sharing) */
  code?: string;
  /** a local room (same Wi-Fi): no XP, and names there aren't accounts (no Add friend) */
  local?: boolean;
  leave(): void;
}

/**
 * The humans still here at the end (audit 2 P-02): one means a solo match against bots, where the
 * player is the headline, and Play again leads.
 */
export function humansAtEnd(standings: readonly Pick<MatchStanding, 'isBot' | 'left'>[]): number {
  return standings.filter((s) => !s.isBot && !s.left).length;
}

/**
 * The match MVP worth a card: a person, never a bot (audit 2 P-02; the server's flag stays as it is), and
 * one who scored: a 0–0 draw decorates nobody (UX-41).
 */
export function humanMvp<T extends Pick<MatchStanding, 'mvp' | 'isBot' | 'kills'>>(standings: readonly T[]): T | undefined {
  return standings.find((s) => s.mvp && !s.isBot && s.kills > 0);
}

export interface Winner {
  /** the winner's name, or "Draw" when the top score is shared */
  name: string;
  draw: boolean;
}

/**
 * Who won: the best score alone, else a draw (a 0–0 time-out too). Among the players still here at
 * the end: one who left keeps their row, not the win.
 */
export function winnerOf(all: readonly (Pick<MatchStanding, 'name' | 'score' | 'isBot'> & { left?: boolean })[]): Winner {
  if (!all.length) return { name: '–', draw: false };
  const best = winnerStanding(all);
  return best ? { name: playerName(best.name, best.isBot), draw: false } : { name: 'Draw', draw: true };
}

/** The winner's own row (their soldier, whether they're a bot), or null on a draw: the same rule as winnerOf. */
export function winnerStanding<T extends Pick<MatchStanding, 'score'> & { left?: boolean }>(all: readonly T[]): T | null {
  const stayed = all.filter((s) => !s.left);
  const standings = stayed.length ? stayed : all;
  if (!standings.length) return null;
  const top = Math.max(...standings.map((s) => s.score));
  const best = standings.filter((s) => s.score === top);
  return best.length === 1 ? best[0]! : null;
}

/** A bot's mark wherever a bot is named on Results (the standings' tag, inline): it says so, plainly. */
export function BotTag({ className }: { className?: string }) {
  return (
    <span className={`tag tag--bot${className ? ` ${className}` : ''}`}>
      <Icon name="bot" />
      Bot
    </span>
  );
}

/** The reason chip: "Kill limit reached · 10 kills", "Time's up · 5:00". */
export function reasonChip(results: Pick<MatchResults, 'reason' | 'durationTicks'>, killLimit: number): { icon: string; text: string; state: 'kill-limit' | 'time-up' | 'over' } {
  if (results.reason === MatchEndReason.KillLimit) return { icon: 'target', text: `Kill limit reached · ${killLimit} ${noun(killLimit, 'kill')}`, state: 'kill-limit' };
  if (results.reason === MatchEndReason.TimeLimit) return { icon: 'clock', text: `Time's up · ${formatClock(Math.round(results.durationTicks / TICK_RATE))}`, state: 'time-up' };
  return { icon: 'ok', text: `Match over · ${formatClock(Math.round(results.durationTicks / TICK_RATE))}`, state: 'over' };
}

const thousands = (n: number) => n.toLocaleString('en-US');


export function Results({ view, results, actions, room, training }: { view: MatchView; results: MatchResults; actions: ShellActions; room?: ResultsExtras | undefined; training?: { leave(): void } | undefined }) {
  // ids are slots: after a leave, the leaver's row can carry your id, so skip departed rows
  const me = results.standings.find((s) => s.id === view.localId && !s.left);
  // team modes (v21): the winning team, and the teams' standings under it
  const teamMode = (results.teamScores?.length ?? 0) > 0;
  const winner = teamMode ? teamWinner(results) : winnerOf(results.standings);
  // the one winner's own row (a person or a bot); none on a draw or a team's win
  const champ = teamMode ? null : winnerStanding(results.standings);
  const botWon = !!champ?.isBot;
  const top = results.standings.find((s) => s.placement === 1);
  const chip = reasonChip(results, view.killLimit);
  // the MVP card is a person's (P-02): a bot is never celebrated
  const mvp = humanMvp(results.standings);
  const voting = view.phase === MatchPhase.Ending || view.phase === MatchPhase.Postgame;
  const closed = view.phase === MatchPhase.Closed;
  const humans = Math.max(view.humans, view.votes);
  const host = !room || room.isHost;
  // training (solo): the player is the headline, and it ends with Play again or Leave
  const solo = !!training && !room;
  // a room where you were the only person (audit 2 P-02, P-03): you are the headline
  const alone = !!room && !!me && humansAtEnd(results.standings) === 1;
  // a room with people in it: Play again is a vote, and its pips and count ride in the button
  const vote = !solo && !alone;
  const present = results.standings.filter((s) => !s.left);
  const headline = (solo || alone) && me && !teamMode ? resultHeadline(me, present) : null;
  // the poster's soldier: yours when you're the headline, else the winner's (a bot's too); a draw or a team's win: the trophy
  const poster = headline && me ? me : champ;
  // XP and friends belong to online rooms (the API records them); training and local rooms say so
  const online = !!room && !room.local;
  const states = [chip.state === 'time-up' ? 'time-up' : 'kill-limit', host ? 'host' : 'guest', view.voted ? 'voted' : 'not-voted'];
  const code = room?.code;
  const ctl = useContext(ControllerContext);
  const leave = room ?? training;
  // the standings' trailing cell: Add friend and report / block for the other people in a room (UX-40: not
  // under their name); only where they work (signed in, online, 18+: useSocial) and there is someone to act on
  const social = useSocial();
  const rowActions = !!room && !!social && results.standings.some((s) => s !== me && !s.isBot);
  const voteLine = closed ? 'Room closed' : `${view.votes}/${humans}${view.phase === MatchPhase.Postgame ? ` · ${view.secondsLeft} s` : ''}`;
  const voteSaid = closed ? 'Room closed' : `${view.votes} of ${humans} voted${view.phase === MatchPhase.Postgame ? `, ${view.secondsLeft} seconds left` : ''}`;

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
              {/* a soldier, not a glyph (UX-40): yours when you're the headline (audit 2 P-02, B-27), else the winner's */}
              {poster ? (
                <span className={poster === me ? 'mf-res__who mf-res__me' : 'mf-res__who'} aria-hidden="true">
                  <PlayerPortrait id={poster.id} name={poster.name} size={256} />
                </span>
              ) : (
                <Icon name="trophy" className="mf-res__trophy" />
              )}
              {/* a bot that won is shown as a bot (UX-40) */}
              {poster?.isBot && (
                <span className="mf-res__bot" aria-hidden="true">
                  <BotTag />
                </span>
              )}
              <span className="stamp stamp--ink stamp--lg res__stamp m-p7">{headline ? (headline.win ? 'Winner' : headline.text === 'Draw' ? 'Draw' : 'Debrief') : winner.draw ? 'Draw' : 'Winner'}</span>
            </div>
            <h1 id="res-title" className="display res__name m-p1" data-bind="results.winner">
              {headline ? (
                headline.text
              ) : (
                <span className="mf-res__fit" style={{ '--len': [...winner.name].length } as CSSProperties}>
                  {botWon && <span className="vh">Bot </span>}
                  {winner.name}
                </span>
              )}
            </h1>
            {teamMode && <TeamStandings results={results} myTeam={view.myTeam ?? -1} />}
            {/* after the first match: keep the callsign the first visit was given? (KeepName.tsx) */}
            <KeepName where="results" />
            {top && !winner.draw && !teamMode && !(headline && top === me) && (
              <p className="res__line">
                {headline && (
                  <>
                    {botWon && <BotTag className="mf-res__tag" />}
                    {winner.name} won ·{' '}
                  </>
                )}
                <b className="num">{top.kills}</b> {noun(top.kills, 'kill')} · <b className="num">{top.deaths}</b> {noun(top.deaths, 'death')} · <b className="num">{thousands(top.damageDealt)}</b> damage
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
                  <b>You</b> · <span className="num" data-bind="results.me.kills">{me.kills}</span> {noun(me.kills, 'kill')} · <span className="num" data-bind="results.me.deaths">{me.deaths}</span> {noun(me.deaths, 'death')} ·{' '}
                  <span className="num" data-bind="results.me.damage">
                    {thousands(me.damageDealt)}
                  </span>{' '}
                  damage
                </span>
              </div>
            )}
            {/* progress you can see (audit 2 P-04): this match's XP and the level, online only */}
            {me && <MatchXp me={me} online={online} matchKey={`${code ?? 'local'}:${results.number}`} />}
            {/* Auto just moved Play now's bots (audit 2 P-01): said once */}
            <BotsMoved />
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
                    {rowActions && (
                      <th scope="col" className="mf-standings__act">
                        <span className="vh">Actions</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {results.standings.map((s, i) => {
                    const you = s === me;
                    const won = !winner.draw && s.placement === 1;
                    const cls = ['m-p3', 'm-p3--tight', won ? 'is-winner' : '', you ? 'is-you' : '', s.isBot ? 'is-bot' : ''].filter(Boolean).join(' ');
                    const name = playerName(s.name, s.isBot);
                    return (
                      <tr key={s.key} className={cls} style={{ '--i': i } as CSSProperties}>
                        {/* a player who left has no place: places count the players still here at the end */}
                        <td className="num">{won ? <Icon name="trophy" label="Winner" /> : s.left ? '–' : s.placement}</td>
                        <th scope="row">
                          {/* one line: the soldier, the name (cut at 12 characters, whole in its tooltip) and its tags (UX-40) */}
                          <span className="mf-standings__who">
                            {/* their soldier as their avatar (presentation/); a player who left: the silhouette (ids are reused) */}
                            <PlayerAvatar id={s.left ? -1 : s.id} name={s.name} bot={s.isBot} />
                            {teamMode && <TeamMark team={s.team ?? -1} small />}
                            <span className="mf-standings__name" title={name}>
                              {name}
                            </span>
                            {/* Host and MVP as their marks (the crown, the medal), so a row stays one line; their words for screen readers and on hover */}
                            {room && !s.left && s.id === room.hostId && (
                              <span className="tag tag--host mf-tag--mark" title="Host">
                                <Icon name="crown" />
                                <span className="vh">Host</span>
                              </span>
                            )}
                            {you && <span className="tag tag--you">You</span>}
                            {s.mvp && !s.isBot && s.kills > 0 && (
                              <span className="tag tag--brass mf-tag--mark" title="MVP">
                                <Icon name="medal" />
                                <span className="vh">MVP</span>
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
                        {rowActions && (
                          <td className="mf-standings__act">
                            {/* the people you just played with: Add friend (audit 2 P-06), and report, block, mute, the host's remove (L-01, L-02, L-11); a player who left has no room id */}
                            {!you && !s.isBot && (
                              <RowActions>
                                {online && !s.left && <AddFriendButton name={s.name} compact />}
                                <PlayerMore target={{ name: s.name, ...(s.left ? {} : { pid: s.id }), place: 'results' }} />
                              </RowActions>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/* the first few matches: what you did, one thing to try, the next order (the onboarding tour), under the standings (UX-41) */}
            <DebriefLines />
            {/* the billboard ads the player saved during play (tap-to-save): only what they chose */}
            <SavedAdsList where="results" />
          </section>

          <section className="res__share" aria-label="Play again and share">
            {/* the one primary action, always (UX-40): where a controller lands (data-pad-first, not Share: audit 2 N-04);
                in a room with people it is the vote, its pips and count inside it ("Play again · 1/2") */}
            <button className="btn btn--volt btn--xl btn--block m-p8 mf-res__again" type="button" data-pad-first disabled={!voting || view.voted} onClick={blurAfter(actions.playAgain)}>
              <Icon name={view.voted ? 'check' : 'refresh'} />
              {vote ? (
                <span className="btn__stack">
                  {view.voted ? 'You voted' : 'Play again'}
                  <span className="btn__sub mf-res__votes">
                    <span className="pips votes__pips" aria-hidden="true">
                      {Array.from({ length: humans }, (_, i) => (
                        <i key={i} className={i < view.votes ? 'on m-p7' : undefined}></i>
                      ))}
                    </span>
                    <span className="num" data-bind="results.votes" aria-hidden="true">
                      {voteLine}
                    </span>
                    <span className="vh">{voteSaid}</span>
                  </span>
                </span>
              ) : view.voted ? (
                'Starting again'
              ) : (
                'Play again'
              )}
            </button>
            {/* a vote landing, said (the button's own words don't announce a change) */}
            {vote && (
              <span className="vh" role="status">
                {view.votes > 0 ? voteSaid : ''}
              </span>
            )}
            {/* a bad loss against bots, alone: one more, a bit easier (P-03) */}
            {(solo || alone) && <AgainEasy />}
            {/* with people here, sharing the room is the second thing (paper); alone, a quiet link below */}
            {vote && code && ctl && (
              <button className="btn btn--paper btn--block m-p8 mf-res__share" type="button" onClick={blurAfter(() => void ctl.shareLink(code))}>
                <Icon name="share" />
                <span className="btn__stack">
                  Share the room
                  <span className="btn__sub">Your share sheet, or the link copied</span>
                </span>
              </button>
            )}
            {((alone && code && ctl) || (host && !solo) || leave) && (
              <div className="mf-res__more">
                {alone && code && ctl && (
                  <button className="btn btn--ghost m-p8" type="button" onClick={blurAfter(() => void ctl.shareLink(code))}>
                    <Icon name="share" />
                    Share the room
                  </button>
                )}
                {/* a room's host: everyone back to the lobby (training has no lobby) */}
                {host && !solo && (
                  <button className="btn btn--ghost m-p8" type="button" disabled={closed} onClick={blurAfter(actions.backToLobby)}>
                    <Icon name="users-plus" />
                    Back to lobby
                  </button>
                )}
                {leave && (
                  <button className="btn btn--ghost m-p8" type="button" data-pad-leave onClick={blurAfter(() => leave.leave())}>
                    <Icon name="door-out" />
                    {room ? 'Leave room' : 'Leave'}
                  </button>
                )}
              </div>
            )}
            {mvp && (
              <figure className="mvp m-p7" data-bind="results.mvp" aria-label="MVP card">
                <div className="mvp__inner halftone-ink">
                  <span className="mvp__kicker">
                    <Icon name="emblem" className="mvp__emblem" />
                    Decorated · match MVP · {view.mapName}
                  </span>
                  <b className="display mvp__big">MVP</b>
                  <b className="display mvp__name" data-bind="results.mvp.name" style={{ '--len': [...playerName(mvp.name, mvp.isBot)].length } as CSSProperties}>
                    {playerName(mvp.name, mvp.isBot)}
                  </b>
                  <div className="mvp__stats">
                    <span>
                      <b className="num">{mvp.kills}</b>
                      {noun(mvp.kills, 'kill')}
                    </span>
                    <span>
                      <b className="num">{mvp.deaths}</b>
                      {noun(mvp.deaths, 'death')}
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
          </section>
        </div>
      </div>
    </Screen>
  );
}
