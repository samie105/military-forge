/**
 * 6 · Countdown (the kit's data-screen="countdown"): "Match 1 · Get ready" while more than three
 * seconds are left, then 3, 2, 1 in a ring that empties, then GO for a second once play starts.
 * Over the live game; it never takes the mouse.
 */
import { MatchPhase } from '@military-forge/sim';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Screen } from '../../ui/Screen';
import { formatClock, type MatchView } from '../matchView';

export type CountdownState = 'match' | '3' | '2' | '1' | 'go';

/** How long GO stays up after the match starts, ms. */
export const GO_MS = 900;

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

/** The countdown while it runs, and GO for a moment after (keeps the last view to say it). */
export function useCountdown(view: MatchView | null): { state: CountdownState; view: MatchView } | null {
  const [go, setGo] = useState<MatchView | null>(null);
  const last = useRef<MatchPhase | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    const was = last.current;
    last.current = view?.phase ?? null;
    if (view && was === MatchPhase.Countdown && view.phase === MatchPhase.InProgress) {
      setGo(view);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setGo(null), GO_MS);
    } else if (view?.phase !== MatchPhase.InProgress) setGo(null);
  }, [view]);
  if (go) return { state: 'go', view: go };
  const state = view && countdownState(view);
  return state && view ? { state, view } : null;
}

export function Countdown({ view, state }: { view: MatchView; state: CountdownState }) {
  const rules = rulesLine(view);
  const total = Math.max(1, Math.min(3, view.countdownTotal || 3));
  const n = Number(state);
  // the ring empties over each second: from n/total to (n-1)/total (app.css animates between them)
  const ring = state === 'go' || state === 'match' ? { '--count-from': 1, '--count': 1 } : { '--count-from': Math.min(1, n / total), '--count': Math.max(0, (n - 1) / total) };
  const label = `Match ${view.number}`;
  return (
    <Screen name="countdown" kind="game" states={[state]} label="Countdown">
      <div className="countdown" role="status" aria-live="assertive">
        {state !== 'match' && (
          <p className="countdown__eyebrow hud-plate">
            <span data-bind="match.label">{label}</span> · <span data-bind="match.map">{view.mapName}</span>
          </p>
        )}
        {state === 'match' ? (
          <div className="countdown__plate">
            <span className="countdown__match display" data-bind="match.label">
              {label}
            </span>
            <span className="countdown__ready">Get ready</span>
          </div>
        ) : (
          <div className="countdown__plate countdown__plate--num" style={ring as CSSProperties}>
            {/* new keys every second restart the ring's and the number's animations (siblings: never the same key) */}
            <svg key={`ring-${state}`} className="countdown__ring" viewBox="0 0 120 120" aria-hidden="true">
              <circle cx="60" cy="60" r="56" pathLength="100" />
            </svg>
            {state === 'go' ? (
              <span className="countdown__go display">GO</span>
            ) : (
              <span key={`num-${state}`} className="countdown__num display num" data-bind="countdown.value">
                {state}
              </span>
            )}
          </div>
        )}
        <p className="countdown__rules hud-plate">
          <span data-bind="match.mode">Deathmatch</span>
          <i aria-hidden="true">·</i>
          <span data-bind="match.killLimitText">{rules.kills}</span>
          <i aria-hidden="true">·</i>
          <span className="num" data-bind="match.timeLimitText">
            {rules.time}
          </span>
        </p>
      </div>
    </Screen>
  );
}
