/**
 * The pre-match VS poster (owner, 23 Oct; docs/design/character-feel-research.md §8; Pen board "MATCH
 * PRESENTATION · avatars, teams, VS"): once a match is chosen, the fighters in their real looks, the map
 * and the rules, with a stencil stamp. It lives inside the existing countdown: it comes in as the
 * countdown starts, holds, then folds into a slim strip at the top while 3-2-1 and GO play as before.
 * It never delays GO (the sim's countdown runs regardless) and does no WebGL work: it only shows
 * pictures the lobby already rendered (warm.ts), with the silhouettes for any that aren't there yet.
 *
 * Any key, tap or click folds it early, for this player only. Reduce motion: a plain cross-fade.
 */
import { useEffect, useSyncExternalStore, type CSSProperties } from 'react';
import { lookBook } from '../looks/book';
import { PlayerPortrait } from '../portrait/Portrait';
import { defaultPosterPose, type PortraitPose } from '../portrait';
import type { MatchView } from '../shell/matchView';
import { PhoneScreen, usePhoneLayout } from '../shell/screens/phone/layout';
import { Screen } from '../ui/Screen';
import { cardName, rulesLine, vsLayout, type VsFighter, type VsLayout } from './layout';
import { showPoster } from './state';
import { TeamMark } from '../teams/TeamRoster';
import { TEAM_NAMES } from '../teams/palette';
import './vs.css';

/** Everyone in the room as the poster shows them (follows ROSTER and MATCH_STATE). */
export function useFighters(): VsFighter[] {
  useSyncExternalStore(
    (fn) => lookBook.subscribe(fn),
    () => lookBook.version,
    () => 0,
  );
  const me = lookBook.localId;
  const host = lookBook.hostId;
  return lookBook.fighters().map((f) => ({ ...f, you: f.id === me, host: f.id === host }));
}

/** Team modes (v21): each team's player ids, in team order; null in a free-for-all. */
export function useTeamLists(fighters: readonly VsFighter[]): number[][] | null {
  const n = lookBook.teams;
  if (n <= 0) return null;
  return Array.from({ length: n }, (_, t) => fighters.filter((f) => lookBook.teamOf(f.id) === t).map((f) => f.id));
}

/** The pose a fighter strikes on the poster: theirs once they can pick one; by look until then. */
function poseOf(f: VsFighter): PortraitPose {
  const look = lookBook.drawn(f.id);
  return look ? defaultPosterPose(look) : 'poster-1';
}

function Tags({ f }: { f: VsFighter }) {
  if (!f.you && !f.host && !f.isBot) return null;
  return (
    <span className="vs__tags">
      {f.you && <span className="tag tag--you">You</span>}
      {f.host && <span className="tag tag--host">Host</span>}
      {f.isBot && <span className="tag tag--bot">Bot</span>}
    </span>
  );
}

/** A full-body card (row and duel layouts) or a compact portrait card (two rows, teams, phones' rows). */
function Card({ f, i, compact, side }: { f: VsFighter; i: number; compact: boolean; side?: 'l' | 'r' }) {
  return (
    <li className={['vs__card', compact ? 'vs__card--compact' : '', f.you ? 'is-you' : '', side ? `vs__card--${side}` : ''].filter(Boolean).join(' ')} style={{ '--i': i } as CSSProperties}>
      {compact ? (
        <PlayerPortrait id={f.id} name={f.name} size={128} className="vs__face" />
      ) : (
        <PlayerPortrait id={f.id} name={f.name} size={512} pose={poseOf(f)} className="vs__body" />
      )}
      <b className="vs__name">{cardName(f)}</b>
      <Tags f={f} />
    </li>
  );
}

function Lineup({ layout, phone }: { layout: VsLayout; phone: boolean }) {
  if (layout.kind === 'duel') {
    const [a, b] = [layout.sides[0]![0]!, layout.sides[1]![0]!];
    return (
      <div className="vs__duel">
        <ul className="vs__side vs__side--l">
          <Card f={a} i={0} compact={false} side="l" />
        </ul>
        <b className="vs__stamp vs__stamp--big display" aria-hidden="true">
          VS
        </b>
        <ul className="vs__side vs__side--r">
          <Card f={b} i={1} compact={false} side="r" />
        </ul>
      </div>
    );
  }
  if (layout.kind === 'teams') {
    return (
      <div className="vs__teams" data-teams={layout.sides.length}>
        {layout.sides.map((side, s) => (
          <div key={s} className="vs__team" data-team={s} style={{ '--tc': `var(--c-team-${s}, currentColor)` } as CSSProperties}>
            <ul className="vs__col">
              <li className="vs__teamhead">
                <TeamMark team={s} />
                <b className="display">Team {TEAM_NAMES[s]}</b>
              </li>
              {side.map((f, i) => (
                <Card key={f.id} f={f} i={i + s * 4} compact />
              ))}
            </ul>
            {s < layout.sides.length - 1 && (
              <b className="vs__stamp vs__stamp--mark display" aria-hidden="true">
                VS
              </b>
            )}
          </div>
        ))}
      </div>
    );
  }
  // free-for-all: one row (two on a full room); compact cards on a phone's second row
  const compact = layout.kind === 'rows' || (phone && layout.kind !== 'solo' && layout.sides[0]!.length > 8);
  return (
    <div className={`vs__rows vs__rows--${layout.kind}`}>
      {layout.sides.map((side, s) => (
        <ul key={s} className="vs__row">
          {side.map((f, i) => (
            <Card key={f.id} f={f} i={i + s * 8} compact={compact} />
          ))}
        </ul>
      ))}
    </div>
  );
}

/**
 * The poster itself. `leaving`: folding away (the countdown's intro-leaving), `held`: the flood still
 * covers the screen (it waits, unseen). `onSkip`: any key or tap.
 */
export function VsPoster({ view, fighters, leaving, held, onSkip, teams = null }: { view: MatchView; fighters: readonly VsFighter[]; leaving: boolean; held: boolean; onSkip?: () => void; teams?: readonly (readonly number[])[] | null }) {
  const phone = usePhoneLayout();
  const layout = vsLayout(fighters, teams);
  // while it covers the screen, the portraits it waits for may still render (portrait policy)
  useEffect(() => (leaving ? undefined : showPoster()), [leaving]);
  useEffect(() => {
    if (!onSkip || leaving || held) return undefined;
    const skip = () => onSkip();
    window.addEventListener('keydown', skip);
    window.addEventListener('pointerdown', skip);
    return () => {
      window.removeEventListener('keydown', skip);
      window.removeEventListener('pointerdown', skip);
    };
  }, [onSkip, leaving, held]);
  const body = (
    <div className={['vs', `vs--${layout.kind}`, leaving ? 'is-leaving' : '', held ? 'is-held' : ''].filter(Boolean).join(' ')} role="status" aria-label={`Match ${view.number} on ${view.mapName}: ${layout.stamp.toLowerCase()}, ${fighters.length} fighters`}>
      <div className="vs__bg" aria-hidden="true">
        <i className="vs__slash"></i>
        <i className="vs__slash vs__slash--brass"></i>
      </div>
      <header className="vs__head">
        <span className="vs__kicker">
          Match {view.number} · {teams ? 'Team deathmatch' : 'Deathmatch'}
        </span>
        <h1 className="display vs__map">{view.mapName}</h1>
        <span className="vs__rules">{rulesLine(view.killLimit, view.timeLimit).replace(/^First to/, teams ? 'First team to' : 'First to')}</span>
      </header>
      {layout.kind !== 'duel' && layout.kind !== 'teams' && (
        <b className="vs__stamp display" aria-hidden="true">
          {layout.stamp}
        </b>
      )}
      <Lineup layout={layout} phone={phone} />
      {!phone && (
        <p className="vs__skip">
          <span className="kbd">Any key</span> skip to the countdown
        </p>
      )}
    </div>
  );
  return phone ? (
    <PhoneScreen name="m-vs-poster" kind="game" label="Match poster" className="vs-screen">
      {body}
    </PhoneScreen>
  ) : (
    <Screen name="vs-poster" kind="game" label="Match poster" className="vs-screen">
      {body}
    </Screen>
  );
}

/** The poster folded: a slim strip at the top with the map, the rules and everyone's face (during 3-2-1). */
export function VsStrip({ view, fighters, teams = null }: { view: MatchView; fighters: readonly VsFighter[]; teams?: readonly (readonly number[])[] | null }) {
  const phone = usePhoneLayout();
  const layout = vsLayout(fighters, teams);
  const faces = layout.sides.flat();
  const body = (
    <div className="vs-strip" aria-hidden="true">
      <b className="display vs-strip__map">{view.mapName}</b>
      <span className="vs-strip__mode">
        {teams ? `Team deathmatch · ${rulesLine(view.killLimit, view.timeLimit).replace(/^First to/, 'First team to')}` : `${layout.stamp} · ${rulesLine(view.killLimit, view.timeLimit)}`}
      </span>
      <span className="vs-strip__faces">
        {faces.slice(0, phone ? 8 : 16).map((f) => (
          <span key={f.id} className={f.you ? 'vs-strip__face is-you' : 'vs-strip__face'}>
            <PlayerPortrait id={f.id} name={f.name} size={64} />
          </span>
        ))}
      </span>
    </div>
  );
  return phone ? (
    <PhoneScreen name="m-vs-strip" kind="game" label="Match" className="vs-screen">
      {body}
    </PhoneScreen>
  ) : (
    <Screen name="vs-strip" kind="game" label="Match" className="vs-screen">
      {body}
    </Screen>
  );
}
