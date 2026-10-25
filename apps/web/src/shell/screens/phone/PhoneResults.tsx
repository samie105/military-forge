/**
 * M5 · Phone debrief (the kit's data-screen="m-results"): the MVP card (the match's most valuable
 * player, their kills and best streak), your place and numbers, who won and why, sharing the result,
 * and the rematch vote; in a room, the host's Lobby (back to it) and Leave. Same data and actions as the
 * desktop Results.
 *
 * Not faked: the kit's three highlight tiles (longest shot, blast launch, dash kills) need numbers the
 * sim doesn't keep yet, so they stay out; the MVP card has no soldier render (the kit's is a preview
 * image); sharing sends the result as words and the room link (the square MVP image is the desktop
 * results' phase-4 work).
 *
 * Motion: the MVP card focus-pulls in (P1) and its kicker stamps (P7); your line, the result and the
 * vote rise in a stagger (P3); a vote landing stamps its pip (P7); the counts roll (P4).
 */
import { GAME_NAME } from '@military-forge/shared';
import { MatchPhase, type MatchResults } from '@military-forge/sim';
import { Icon } from '../../../ui/Icon';
import { blurAfter } from '../../../ui/Screen';
import { roomLink } from '../../controller';
import { ordinal, playerName, type MatchView } from '../../matchView';
import type { ShellActions } from '../../store';
import { reasonChip, winnerOf, type ResultsExtras } from '../Results';
import { PhoneScreen, rise } from './layout';
import { Roll, ShareChip, shareData, useShareChip } from './parts';
import { SavedAdsList } from '../../../ads/SavedAds';
import { DebriefLines } from '../../../tour/DebriefLines';
import { TeamStandings, teamWinner } from '../../../teams/TeamResults';

/** The words a shared result says: who won the match, where, and how you did. */
export function resultText(view: Pick<MatchView, 'mapName'>, results: MatchResults, localId: number): string {
  const winner = (results.teamScores?.length ?? 0) > 0 ? teamWinner(results) : winnerOf(results.standings);
  const me = results.standings.find((s) => s.id === localId && !s.left);
  const top = winner.draw ? `A draw on ${view.mapName}` : `${winner.name} won on ${view.mapName}`;
  const mine = me ? `: I came ${ordinal(me.placement)} with ${me.kills} ${me.kills === 1 ? 'kill' : 'kills'}` : '';
  return `${top} in ${GAME_NAME}${mine}.`;
}

export function PhoneResults({ view, results, actions, room, training, code }: { view: MatchView; results: MatchResults; actions: ShellActions; room?: ResultsExtras | undefined; training?: { leave(): void } | undefined; code?: string | undefined }) {
  const me = results.standings.find((s) => s.id === view.localId && !s.left);
  // team modes (v21): the winning team, and the teams' scores in the ticket
  const teamMode = (results.teamScores?.length ?? 0) > 0;
  const winner = teamMode ? teamWinner(results) : winnerOf(results.standings);
  const chip = reasonChip(results, view.killLimit);
  const mvp = results.standings.find((s) => s.mvp);
  const voting = view.phase === MatchPhase.Ending || view.phase === MatchPhase.Postgame;
  const closed = view.phase === MatchPhase.Closed;
  const humans = Math.max(1, view.humans, view.votes);
  const host = !room || room.isHost;
  const [shared, showShared] = useShareChip();
  const share = () => {
    const url = code ? roomLink(code) : undefined;
    void shareData({ title: GAME_NAME, text: resultText(view, results, view.localId), ...(url ? { url } : {}) }).then(showShared);
  };

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
              <b className="display mvp__name" data-bind="results.mvp.name">
                {playerName(mvp.name, mvp.isBot)}
              </b>
              <div className="mvp__stats">
                <span>
                  <b className="num">{mvp.kills}</b>
                  kills
                </span>
                <span>
                  <b className="num">{mvp.bestStreak}</b>
                  streak
                </span>
              </div>
            </div>
          </figure>
        )}
        <div className="pm-res">
          <span className="eyebrow m-p3" style={rise(0)}>
            Debrief · {view.mapName}
          </span>
          {me && (
            <div className="pm-res__you m-p3" style={rise(1)}>
              <span className="rank" aria-hidden="true">
                <Icon name="rank" />
              </span>
              <span className="stamp stamp--paper" data-bind="results.me.placement">
                {ordinal(me.placement)}
              </span>
              <span>
                <b>You</b> · {me.kills} {me.kills === 1 ? 'kill' : 'kills'} · {me.deaths} {me.deaths === 1 ? 'death' : 'deaths'}
              </span>
            </div>
          )}
          {/* the first few matches: what you did, one thing to try, the next order (the onboarding tour) */}
          <DebriefLines />
          <div className="ticket pm-result m-p3" style={rise(2)}>
            <span className="label">
              <Icon name={chip.icon} size="sm" />
              {chip.text}
            </span>
            <b className="display" data-bind="results.winner">
              {winner.draw ? (teamMode ? 'Teams level: a draw' : 'Top score shared') : `${winner.name} wins`}
            </b>
            {teamMode && <TeamStandings results={results} myTeam={view.myTeam ?? -1} compact />}
          </div>
          <button type="button" className="btn btn--volt btn--block m-p3" style={rise(3)} onClick={blurAfter(share)}>
            <Icon name="share" />
            Share the result
          </button>
          <div className="pm-vote m-p3" style={rise(4)}>
            <b>Play again?</b>
            <span className="pips votes__pips" aria-hidden="true">
              {Array.from({ length: humans }, (_, i) => (
                // keyed by the vote, so a pip turning on stamps in (P7)
                <i key={`${i}-${i < view.votes ? 'on' : 'off'}`} className={i < view.votes ? 'on m-p7' : undefined}></i>
              ))}
            </span>
            <span className="num" data-bind="results.votes" aria-label={`${view.votes} of ${humans} voted to play again`}>
              <Roll value={view.votes} />/{humans}
            </span>
            {view.voted ? (
              <span className="stamp stamp--ok pm-voted m-p7">
                <Icon name="check" />
                Voted
              </span>
            ) : (
              <button type="button" className="btn btn--paper btn--sm" disabled={!voting} onClick={blurAfter(actions.playAgain)}>
                <Icon name="refresh" />
                Vote
              </button>
            )}
          </div>
          {(room || training) && (
            <div className="pm-res__more m-p3" style={rise(5)}>
              {room?.isHost && (
                <button type="button" className="btn btn--ghost btn--sm" disabled={closed} onClick={blurAfter(actions.backToLobby)}>
                  <Icon name="back" />
                  Lobby
                </button>
              )}
              <button type="button" className="btn btn--ghost btn--sm" onClick={blurAfter(() => (room ?? training)!.leave())}>
                <Icon name="door-out" />
                {training ? 'Quit' : 'Leave'}
              </button>
            </div>
          )}
          {/* the billboard ads the player saved during play (tap-to-save) */}
          <SavedAdsList where="results" variant="strip" />
          <ShareChip outcome={shared} />
        </div>
      </div>
    </PhoneScreen>
  );
}
