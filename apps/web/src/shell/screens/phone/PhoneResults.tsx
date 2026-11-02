/**
 * M5 · Phone debrief (the kit's data-screen="m-results"): the MVP card (the match's most valuable
 * player, their kills and best streak), who won and why as the headline at the top, your place and
 * numbers, then Play again: the one primary action, always (UX-40), carrying the room's vote (its pips
 * and count) when there are people to vote; then sharing the result, Add friend, the host's Lobby and
 * Leave, and the first matches' debrief. Same data and actions as the desktop Results. Training is the
 * player's own: their result is the headline (the MVP card only when it's theirs), and it ends with Play
 * again or Leave (no vote). A bot that won says it is a bot (its avatar's badge and the Bot tag).
 *
 * Not faked: the kit's three highlight tiles (longest shot, blast launch, dash kills) need numbers the
 * sim doesn't keep yet, so they stay out; the MVP card has no soldier render (the kit's is a preview
 * image); sharing sends the result as words and the room link (the square MVP image is the desktop
 * results' phase-4 work).
 *
 * Motion: the MVP card focus-pulls in (P1) and its kicker stamps (P7); the result, your line and Play
 * again rise in a stagger (P3); a vote landing stamps its pip (P7); the counts roll (P4).
 */
import { GAME_NAME } from '@military-forge/shared';
import { MatchPhase, type MatchResults } from '@military-forge/sim';
import { useEffect, useRef, type CSSProperties } from 'react';
import { Icon } from '../../../ui/Icon';
import { blurAfter } from '../../../ui/Screen';
import { roomLink } from '../../controller';
import { noun, ordinal, playerName, resultHeadline, type MatchView } from '../../matchView';
import type { ShellActions } from '../../store';
import { BotTag, humanMvp, humansAtEnd, reasonChip, winnerOf, winnerStanding, type ResultsExtras } from '../Results';
import { PlayerAvatar } from '../../../presentation/PlayerAvatar';
import { AddFriendButton, RowActions } from '../../../social/AddFriend';
import { BotsMoved } from '../../../tour/PlayNowBots';
import { AgainEasy } from '../../../tour/DebriefLines';
import { MatchXp } from '../Progress';
import { PhoneScreen, rise } from './layout';
import { Roll, ShareChip, shareData, useShareChip } from './parts';
import { SavedAdsList } from '../../../ads/SavedAds';
import { DebriefLines } from '../../../tour/DebriefLines';
import { TeamStandings, teamWinner } from '../../../teams/TeamResults';
import { KeepName } from '../KeepName';
import { useVoice } from '../../../voice/Radio';

/** The words a shared result says: who won the match, where, and how you did. */
export function resultText(view: Pick<MatchView, 'mapName'>, results: MatchResults, localId: number): string {
  const winner = (results.teamScores?.length ?? 0) > 0 ? teamWinner(results) : winnerOf(results.standings);
  const me = results.standings.find((s) => s.id === localId && !s.left);
  const top = winner.draw ? `A draw on ${view.mapName}` : `${winner.name} won on ${view.mapName}`;
  const mine = me ? `: I came ${ordinal(me.placement)} with ${me.kills} ${noun(me.kills, 'kill')}` : '';
  return `${top} in ${GAME_NAME}${mine}.`;
}

export function PhoneResults({ view, results, actions, room, training, code }: { view: MatchView; results: MatchResults; actions: ShellActions; room?: ResultsExtras | undefined; training?: { leave(): void } | undefined; code?: string | undefined }) {
  const me = results.standings.find((s) => s.id === view.localId && !s.left);
  // team modes (v21): the winning team, and the teams' scores in the ticket
  const teamMode = (results.teamScores?.length ?? 0) > 0;
  const winner = teamMode ? teamWinner(results) : winnerOf(results.standings);
  // the one winner's own row (their soldier on the ticket; a bot says so), none on a draw or a team's win
  const champ = teamMode ? null : winnerStanding(results.standings);
  const chip = reasonChip(results, view.killLimit);
  // training (solo), or a room where you were the only person (audit 2 P-02): the player is the
  // headline; a bot's MVP card never takes the screen
  const solo = !!training && !room;
  const alone = !!room && !!me && humansAtEnd(results.standings) === 1;
  // a room with people in it: Play again is a vote, its pips and count ride in the button
  const vote = !solo && !alone;
  const headline = (solo || alone) && me && !teamMode ? resultHeadline(me, results.standings.filter((s) => !s.left)) : null;
  const best = humanMvp(results.standings);
  const mvp = (solo || alone) && best !== me ? undefined : best;
  const online = !!room && !room.local;
  // the people you just played with (audit 2 P-06): Add friend for each
  const people = online ? results.standings.filter((s) => !s.isBot && !s.left && s !== me) : [];
  // the room's radio sits top right (voice/VoiceHud.tsx) while there's someone to talk to: the headline starts under it
  const radio = useVoice((s) => s.active) && people.length > 0;
  const voting = view.phase === MatchPhase.Ending || view.phase === MatchPhase.Postgame;
  const closed = view.phase === MatchPhase.Closed;
  const humans = Math.max(1, view.humans, view.votes);
  const host = !room || room.isHost;
  const [shared, showShared] = useShareChip();
  const share = () => {
    const url = code ? roomLink(code) : undefined;
    void shareData({ title: GAME_NAME, text: resultText(view, results, view.localId), ...(url ? { url } : {}) }).then(showShared);
  };
  // the screen opens at its top: the headline and Play again (UX-41: it landed scrolled, the top line cut)
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const col = column.current;
    if (col) col.scrollTop = 0;
    if (col?.parentElement) col.parentElement.scrollTop = 0;
  }, []);
  const bot = champ?.isBot ? <BotTag className="pm-result__bot" /> : null;
  const mvpName = mvp ? playerName(mvp.name, mvp.isBot) : '';
  const voteSaid = closed ? 'Room closed' : `${view.votes} of ${humans} voted to play again`;

  return (
    <PhoneScreen name="m-results" label="Debrief" word="GG" states={[chip.state === 'time-up' ? 'time-up' : 'kill-limit', host ? 'host' : 'guest', view.voted ? 'voted' : 'not-voted', mvp ? 'mvp' : 'no-mvp']}>
      <div className="pm pm--res">
        {mvp && (
          <figure className="mvp pm-mvp m-p1" data-bind="results.mvp">
            <div className="mvp__inner halftone-ink">
              <span className="mvp__kicker m-p7">
                <svg className="mvp__emblem" aria-hidden="true">
                  <use href="#icon-emblem" />
                </svg>
                Decorated · MVP
              </span>
              <b className="display mvp__big" aria-hidden="true">
                MVP
              </b>
              {/* a long name stays on the card: it shrinks with its length (UX-41) */}
              <b className="display mvp__name" data-bind="results.mvp.name" style={{ '--len': [...mvpName].length } as CSSProperties}>
                {mvpName}
              </b>
              <div className="mvp__stats">
                <span>
                  <b className="num">{mvp.kills}</b>
                  {noun(mvp.kills, 'kill')}
                </span>
                <span>
                  <b className="num">{mvp.bestStreak}</b>
                  streak
                </span>
              </div>
            </div>
          </figure>
        )}
        <div className={radio ? 'pm-res pm-res--radio' : 'pm-res'} ref={column}>
          <span className="eyebrow m-p3" style={rise(0)}>
            Debrief · {view.mapName}
          </span>
          {/* who won and why: the headline, at the top (UX-41) */}
          <div className="ticket pm-result m-p3" style={rise(0)}>
            {champ && <PlayerAvatar id={champ.id} name={champ.name} bot={champ.isBot} className="pm-result__av" />}
            <span className="pm-result__text">
              <span className="label">
                <Icon name={chip.icon} size="sm" />
                {chip.text}
              </span>
              <b className="display" data-bind="results.winner">
                {headline ? (
                  headline.win ? (
                    'You win'
                  ) : winner.draw ? (
                    headline.text
                  ) : (
                    <>
                      {headline.text} · {bot}
                      {winner.name} won
                    </>
                  )
                ) : winner.draw ? (
                  teamMode ? (
                    'Teams level: a draw'
                  ) : (
                    'Top score shared'
                  )
                ) : (
                  <>
                    {bot}
                    {winner.name} wins
                  </>
                )}
              </b>
            </span>
            {teamMode && <TeamStandings results={results} myTeam={view.myTeam ?? -1} compact />}
          </div>
          {me && (
            <div className="pm-res__you m-p3" style={rise(1)}>
              <span className="rank" aria-hidden="true">
                <Icon name="rank" />
              </span>
              <span className="stamp stamp--paper" data-bind="results.me.placement">
                {ordinal(me.placement)}
              </span>
              <span>
                <b>You</b> · {me.kills} {noun(me.kills, 'kill')} · {me.deaths} {noun(me.deaths, 'death')}
              </span>
            </div>
          )}
          {/* the one primary action, always (UX-40); in a room with people it is the vote, its pips and count inside it */}
          <button type="button" className="btn btn--volt btn--block m-p3 pm-res__again" style={rise(2)} data-pad-first disabled={!voting || view.voted} onClick={blurAfter(actions.playAgain)}>
            <Icon name={view.voted ? 'check' : 'refresh'} />
            {view.voted ? (vote ? 'Voted' : 'Starting again') : 'Play again'}
            {vote && (
              <span className="pm-res__votes">
                <span className="pips votes__pips" aria-hidden="true">
                  {Array.from({ length: humans }, (_, i) => (
                    // keyed by the vote, so a pip turning on stamps in (P7)
                    <i key={`${i}-${i < view.votes ? 'on' : 'off'}`} className={i < view.votes ? 'on m-p7' : undefined}></i>
                  ))}
                </span>
                <span className="num" data-bind="results.votes" aria-hidden="true">
                  {closed ? (
                    'Room closed'
                  ) : (
                    <>
                      <Roll value={view.votes} />/{humans}
                    </>
                  )}
                </span>
                <span className="vh">{voteSaid}</span>
              </span>
            )}
          </button>
          {/* a vote landing, said (the button's own words don't announce a change) */}
          {vote && (
            <span className="vh" role="status">
              {view.votes > 0 ? voteSaid : ''}
            </span>
          )}
          {(solo || alone) && <AgainEasy />}
          {/* sharing is the second thing: paper with people here, a quiet button alone (audit 2 P-03) */}
          <button type="button" className={vote ? 'btn btn--paper btn--block btn--sm m-p3' : 'btn btn--ghost btn--block btn--sm m-p3'} style={rise(3)} onClick={blurAfter(share)}>
            <Icon name="share" />
            Share the result
          </button>
          {people.length > 0 && (
            <ul className="pm-res__people m-p3" style={rise(4)} aria-label="Played with">
              {people.map((p) => (
                <li key={p.key}>
                  <b>{playerName(p.name, p.isBot)}</b>
                  <RowActions>
                    <AddFriendButton name={p.name} />
                  </RowActions>
                </li>
              ))}
            </ul>
          )}
          {(room || training) && (
            <div className="pm-res__more m-p3" style={rise(5)}>
              {room?.isHost && (
                <button type="button" className="btn btn--ghost btn--sm" disabled={closed} onClick={blurAfter(actions.backToLobby)}>
                  <Icon name="back" />
                  Lobby
                </button>
              )}
              <button type="button" className="btn btn--ghost btn--sm" data-pad-leave onClick={blurAfter(() => (room ?? training)!.leave())}>
                <Icon name="door-out" />
                Leave
              </button>
            </div>
          )}
          {/* this match's XP and the level, online only (audit 2 P-04); Auto moving Play now's bots (P-01) */}
          {me && <MatchXp me={me} online={online} matchKey={`${code ?? 'local'}:${results.number}`} />}
          <BotsMoved />
          {/* after the first match: keep the callsign the first visit was given? (KeepName.tsx) */}
          <KeepName where="phone" />
          {/* the first few matches: what you did, one thing to try, the next order (the onboarding tour) */}
          <DebriefLines />
          {/* the billboard ads the player saved during play (tap-to-save) */}
          <SavedAdsList where="results" variant="strip" />
          <ShareChip outcome={shared} />
        </div>
      </div>
    </PhoneScreen>
  );
}
