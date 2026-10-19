/**
 * 6 · Map intro and countdown (round two's data-screen="map-intro" and "countdown"): as the countdown
 * begins the screen floods from the button that started it (P6) and the map intro shows for 1.6 s;
 * then "Match 1" (P1) while more than three seconds are left, 3, 2, 1 in a ring that empties (each
 * focus-pulls in), and GO stamps (P7) for a moment once play starts. Over the live game; it never
 * takes the mouse.
 */
import { maps } from '@military-forge/content';
import { MatchPhase } from '@military-forge/sim';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { eventLook } from '../../hud/model';
import { Icon } from '../../ui/Icon';
import { Kbd } from '../../ui/Kbd';
import { flood, sharedElement, type Box } from '../../ui/motion';
import { Screen } from '../../ui/Screen';
import type { Bindings } from '../controls';
import { formatClock, type MatchView } from '../matchView';
import { take } from './frame';
import { MAP_CARDS, eventChip, mapEvents } from './Lobby';

export type CountdownState = 'intro' | 'intro-leaving' | 'match' | '3' | '2' | '1' | 'go';

/** How long GO stays up after the match starts, ms. */
export const GO_MS = 900;
/** How long the map intro shows as the countdown begins, then its exit (ms; motion spec §4.1). */
export const INTRO_MS = 1600;
const LEAVE_MS = 170;

export function countdownState(view: Pick<MatchView, 'phase' | 'secondsLeft'>): CountdownState | null {
  if (view.phase !== MatchPhase.Countdown) return null;
  if (view.secondsLeft > 3) return 'match';
  return String(Math.max(1, view.secondsLeft)) as '3' | '2' | '1';
}

export function rulesLine(view: Pick<MatchView, 'killLimit' | 'timeLimit'>): { kills: string; time: string } {
  return {
    kills: view.killLimit > 0 ? `first to ${view.killLimit}` : 'no kill limit',
    time: view.timeLimit > 0 ? formatClock(view.timeLimit) : 'no time limit',
  };
}

/**
 * The countdown while it runs, and GO for a moment after (keeps the last view to say it). As the
 * countdown begins, the screen floods in from the button that started it (P6: the lobby's Start or
 * Ready; the centre otherwise) and contracts onto the map intro, which then shows for INTRO_MS and
 * leaves. `held` is on while the flood covers the screen (what arrives under it waits).
 */
export function useCountdown(view: MatchView | null): { state: CountdownState; view: MatchView; held: boolean } | null {
  const [go, setGo] = useState<MatchView | null>(null);
  const [intro, setIntro] = useState<'intro' | 'intro-leaving' | null>(null);
  const [held, setHeld] = useState(false);
  const last = useRef<MatchPhase | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    const was = last.current;
    last.current = view?.phase ?? null;
    if (view && was !== MatchPhase.Countdown && view.phase === MatchPhase.Countdown) {
      setIntro('intro');
      setHeld(true);
      const start = take('start');
      const from = start ? { x: start.left + start.width / 2, y: start.top + start.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
      // the intro's time starts once it is uncovered (the world's first frames can be slow to come)
      void flood(from, {
        to: () => document.querySelector('.intro__inner'),
        onCovered: () => {
          setHeld(false);
          timers.current.push(
            window.setTimeout(() => setIntro((i) => (i ? 'intro-leaving' : i)), INTRO_MS),
            window.setTimeout(() => setIntro(null), INTRO_MS + LEAVE_MS),
          );
        },
      });
    }
    if (view && was === MatchPhase.Countdown && view.phase === MatchPhase.InProgress) {
      setGo(view);
      setIntro(null);
      setHeld(false);
      timers.current.push(window.setTimeout(() => setGo(null), GO_MS));
    } else if (view?.phase !== MatchPhase.InProgress) setGo(null);
  }, [view]);
  if (go) return { state: 'go', view: go, held: false };
  const state = view && countdownState(view);
  if (state === 'match' && view && intro) return { state: intro, view, held };
  return state && view ? { state, view, held } : null;
}

/** The map the match is on, by its name (MatchView carries the name). */
function mapIdByName(name: string): string | null {
  return Object.values(maps).find((m) => m.name === name)?.id ?? null;
}

/**
 * The map intro (round two's data-screen="map-intro"), as the countdown begins: the lobby's picked
 * map card grows into it (P2), the place stamps in (P1), and it leaves to the top edge (P9).
 */
function MapIntro({ view, leaving, held }: { view: MatchView; leaving: boolean; held: boolean }) {
  const inner = useRef<HTMLDivElement>(null);
  // the lobby's card, taken as the intro mounts; it grows into the intro once the flood has covered the screen
  const from = useRef<Box | null | undefined>(undefined);
  if (from.current === undefined) from.current = take('map');
  useLayoutEffect(() => {
    if (held || !from.current || !inner.current) return;
    sharedElement(from.current, inner.current);
    from.current = null;
  }, [held]);
  const id = mapIdByName(view.mapName);
  const card = id ? MAP_CARDS[id] : undefined;
  const rules = rulesLine(view);
  return (
    <div className={leaving ? 'intro m-p9 is-leaving' : 'intro'} role="status">
      <div className="intro__band" aria-hidden="true"></div>
      <div ref={inner} className="intro__inner">
        {card?.place && (
          <span className="stamp stamp--ink intro__place m-p1">
            <span data-bind="intro.place">{card.place}</span>
          </span>
        )}
        <h1 className="display intro__name" data-bind="intro.name">
          {view.mapName}
        </h1>
        {card?.tagline && (
          <p className="intro__tag" data-bind="intro.tagline">
            {card.tagline}
          </p>
        )}
        <div className="intro__meta">
          <span>
            <Icon name="target" size="sm" />
            <b>Deathmatch</b>
          </span>
          <span>
            <Icon name="skull" size="sm" />
            <b>{rules.kills}</b>
          </span>
          <span>
            <Icon name="clock" size="sm" />
            <b>{rules.time}</b>
          </span>
          {view.humans > 0 && (
            <span>
              <Icon name="users-plus" size="sm" />
              <b>
                {view.humans} {view.humans === 1 ? 'player' : 'players'}
              </b>
            </span>
          )}
        </div>
        {id && (
          <span className="intro__events">
            {mapEvents(id).map((e) => (
              <span key={e.name} className={`chip ${eventChip(e.kind)}`}>
                <Icon name={eventLook(e.kind).icon} />
                {e.name}
              </span>
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

export function Countdown({ view, state, held = false, bindings }: { view: MatchView; state: CountdownState; held?: boolean; bindings?: Bindings }) {
  const rules = rulesLine(view);
  const total = Math.max(1, Math.min(3, view.countdownTotal || 3));
  const n = Number(state);
  // the ring empties over each second: from n/total to (n-1)/total (app.css animates between them)
  const ring = n > 0 ? { '--count-from': Math.min(1, n / total), '--count': Math.max(0, (n - 1) / total) } : { '--count-from': 1, '--count': 1 };
  const intro = state === 'intro' || state === 'intro-leaving';
  return (
    <Screen name="countdown" kind="game" kit="v2" states={[state]} label="Countdown" className={held ? 'mf-held' : undefined}>
      {intro ? (
        <MapIntro view={view} leaving={state === 'intro-leaving'} held={held} />
      ) : (
        <>
          <div className="cd__dim" aria-hidden="true"></div>
          <div className="cd" role="timer" aria-live="assertive">
            {state === 'match' && (
              <div className="cd__match m-p1">
                <span className="label label--volt">Stand by</span>
                <b className="display cd__match-title" data-bind="match.label">
                  Match {view.number}
                </b>
                <span className="cd__match-sub">
                  <span data-bind="match.map">{view.mapName}</span> · Deathmatch · {rules.kills} · <span className="num">{rules.time}</span>
                </span>
              </div>
            )}
            {n > 0 && (
              <div className="cd__num" style={ring as CSSProperties}>
                {/* new keys every second restart the ring's and the number's animations (siblings: never the same key) */}
                <svg key={`ring-${state}`} className="cd__ring mf-cd__ring" viewBox="0 0 200 200" aria-hidden="true">
                  <circle cx="100" cy="100" r="90" className="cd__track" />
                  <circle cx="100" cy="100" r="90" pathLength="100" className="cd__fill" />
                </svg>
                <b key={`num-${state}`} className="display num m-p1" data-bind="countdown.value">
                  {state}
                </b>
              </div>
            )}
            {state === 'go' && <b className="display cd__go m-p7">Go!</b>}
          </div>
          {state !== 'go' && bindings && (
            <p className="cd__hint plate">
              Tip: <Kbd code={bindings.dash[0]} /> dash · hold <Kbd code={bindings.grenade[0]} /> to aim a grenade
            </p>
          )}
        </>
      )}
    </Screen>
  );
}
