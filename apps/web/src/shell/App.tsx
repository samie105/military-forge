/**
 * Shell screens over the game canvas. Milestone A: warm-up lobby bar, countdown, match clock and
 * score, results + Play again. Home, rooms, settings and the production HUD (hud/) come next.
 */
import { MatchPhase, TICK_RATE, type MatchResults } from '@military-forge/sim';
import { useEffect, useRef, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import type { MapEventBanner as MapEventBannerView } from './mapEventBanner';
import { END_REASON, formatClock, kdRatio, ordinal, placeholderXp, type MatchView } from './matchView';
import { closeRoute, runCleanup, type ShellActions, type ShellRoute, type ShellStore } from './store';

export function App({ store }: { store: ShellStore }) {
  const match = useStore(store, (s) => s.match);
  const route = useStore(store, (s) => s.route);
  const actions = useStore(store, (s) => s.actions);
  const banner = useMapEventBanner(store);
  if (route) return <RouteView route={route} />;
  return (
    <>
      {banner && <MapEventBanner key={banner.key} banner={banner} />}
      {match && <MatchScreen match={match} actions={actions} />}
    </>
  );
}

function MatchScreen({ match, actions }: { match: MatchView; actions: ShellActions }) {
  switch (match.phase) {
    case MatchPhase.Waiting:
      return <Lobby view={match} actions={actions} />;
    case MatchPhase.Countdown:
      return <Countdown view={match} />;
    case MatchPhase.InProgress:
      return <MatchStatus view={match} />;
    default:
      return match.results ? <Results view={match} results={match.results} actions={actions} /> : null;
  }
}

/** The HUD banner hook (docs/02 §20.7): the map event to announce, null when none. */
export function useMapEventBanner(store: ShellStore): MapEventBannerView | null {
  return useStore(store, (s) => s.mapEvent);
}

/** "EMP STORM in 3 · Jetpacks offline", then "EMP STORM · Jetpacks offline · 6 s". */
export function MapEventBanner({ banner }: { banner: MapEventBannerView }) {
  const warning = banner.phase === 'warning';
  return (
    <div className={`mm-event${warning ? ' mm-event-warning' : ''}`} style={{ '--mm-event': banner.color } as CSSProperties} role="status" aria-live="polite">
      <div className="mm-event-title">
        {banner.title}
        {warning && <span className="mm-event-in"> in {banner.seconds}</span>}
      </div>
      <div className="mm-event-line">
        {banner.line}
        {!warning && <span className="mm-dim"> · {banner.seconds} s</span>}
      </div>
    </div>
  );
}

function RouteView({ route }: { route: ShellRoute }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape') closeRoute();
    };
    window.addEventListener('keydown', onKey);
    const cleanup = route.mount(el.current!, closeRoute);
    return () => {
      window.removeEventListener('keydown', onKey);
      runCleanup(cleanup);
    };
  }, [route]);
  return (
    <div className="mm-route" aria-label={route.title}>
      <div ref={el} className="mm-route-body" />
      <button className="mm-btn mm-route-back" onClick={closeRoute}>
        ← Back
      </button>
    </div>
  );
}

export function Lobby({ view, actions }: { view: MatchView; actions: ShellActions }) {
  return (
    <div className="mm-lobby mm-panel">
      <div>
        <b>Warm-up</b> · nothing counts until the match starts
      </div>
      <button className="mm-btn mm-primary" disabled={view.ready} onClick={actions.ready}>
        {view.ready ? 'Ready · waiting for players' : 'Ready'}
      </button>
    </div>
  );
}

export function Countdown({ view }: { view: MatchView }) {
  return (
    <div className="mm-countdown" role="status">
      <div className="mm-kicker">Match {view.number} · Deathmatch{view.killLimit > 0 ? ` · first to ${view.killLimit}` : ''}</div>
      <div key={view.secondsLeft} className="mm-countdown-n">
        {view.secondsLeft}
      </div>
    </div>
  );
}

export function MatchStatus({ view }: { view: MatchView }) {
  return (
    <div className="mm-status mm-panel" role="status">
      <div className="mm-clock" title={view.untimed ? 'Time played (no time limit)' : 'Time left'}>
        {formatClock(view.untimed ? view.secondsElapsed : view.secondsLeft)}
      </div>
      <div className="mm-scoreline">
        You <b>{view.myScore}</b> · Leader <b>{view.leaderScore}</b>
        {view.killLimit > 0 && <span className="mm-dim"> / {view.killLimit}</span>}
      </div>
    </div>
  );
}

export function Results({ view, results, actions }: { view: MatchView; results: MatchResults; actions: ShellActions }) {
  // ids are slots: after a leave, the leaver's row can carry your id, so skip departed rows
  const me = results.standings.find((s) => s.id === view.localId && !s.left);
  const voting = view.phase === MatchPhase.Ending || view.phase === MatchPhase.Postgame;
  const note =
    view.phase === MatchPhase.Closed
      ? 'Room closed'
      : `Rematch ${view.votes}/${view.humans}${view.phase === MatchPhase.Postgame ? ` · ${view.secondsLeft} s` : ''}`;
  return (
    <div className="mm-backdrop">
      <section className="mm-results mm-panel" aria-label="Match results">
        <header>
          <div className="mm-kicker">
            Match {results.number} · {END_REASON[results.reason]} · {formatClock(Math.round(results.durationTicks / TICK_RATE))}
          </div>
          {me && (
            <>
              <h1 className={me.placement === 1 ? 'mm-win' : ''}>{me.placement === 1 ? 'Victory' : `${ordinal(me.placement)} place`}</h1>
              <dl className="mm-mine">
                <div><dt>K/D</dt><dd>{kdRatio(me)}</dd></div>
                <div><dt>Damage</dt><dd>{me.damageDealt}</dd></div>
                <div><dt>Best streak</dt><dd>{me.bestStreak}</dd></div>
                <div><dt>XP</dt><dd>+{placeholderXp(me)} <small>preview</small></dd></div>
              </dl>
            </>
          )}
        </header>
        <table className="mm-table">
          <thead>
            <tr>
              <th>#</th><th className="mm-name">Player</th><th>Score</th><th>K</th><th>D</th><th>A</th><th>K/D</th><th>Dmg</th>
            </tr>
          </thead>
          <tbody>
            {results.standings.map((s) => (
              <tr key={s.key} className={s.id === view.localId && !s.left ? 'mm-me' : s.left ? 'mm-left' : ''}>
                <td>{s.placement}</td>
                <td className="mm-name">
                  {s.name}
                  {s.mvp && <span className="mm-badge mm-mvp">MVP</span>}
                  {s.isBot && <span className="mm-badge">BOT</span>}
                  {s.left && <span className="mm-badge">LEFT</span>}
                </td>
                <td>{s.score}</td><td>{s.kills}</td><td>{s.deaths}</td><td>{s.assists}</td><td>{kdRatio(s)}</td><td>{s.damageDealt}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <footer>
          <button className="mm-btn mm-primary" disabled={!voting || view.voted} onClick={actions.playAgain}>
            {view.voted ? 'Waiting for others…' : 'Play again'}
          </button>
          <button className="mm-btn" disabled={view.phase === MatchPhase.Closed} onClick={actions.backToLobby}>
            Back to lobby
          </button>
          <span className="mm-dim">{note}</span>
        </footer>
      </section>
    </div>
  );
}
