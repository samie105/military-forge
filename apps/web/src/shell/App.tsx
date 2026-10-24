/**
 * The app's screens, the owner's design kit (docs/design/military-forge-ui.html) routed from the
 * shell store: name entry, home, join, the room (connecting, lobby, countdown, results, the
 * reconnecting banner, alerts), training, settings, the in-match menu and the first-run controls
 * card. Without a controller (the dev debug client at `/`) only the match overlays show. Nothing
 * here runs per frame: the store changes when something visible does.
 */
import { MatchPhase } from '@military-forge/sim';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { assetLoad, type AssetLoad } from '../assetLoad';
import { useShownControls } from '../gamepad/react';
import { eventLook } from '../hud/model';
import { Icon } from '../ui/Icon';
import { Screen, blurAfter } from '../ui/Screen';
import { alertFromConnection } from './alerts';
import { ControllerContext, useCtl } from './context';
import type { ShellController } from './controller';
import type { MapEventBanner as MapEventBannerView } from './mapEventBanner';
import { holdLoading } from './mapLoading';
import { formatClock, type MatchView } from './matchView';
import { Alert, Connecting, MapLoading, ReconnectBanner, connectStep } from './screens/Connection';
import { Countdown, useCountdown } from './screens/Countdown';
import { Home } from './screens/Home';
import { Join } from './screens/Join';
import { LanAddPlayer, LanJoin } from './screens/LanPanels';
import { Lobby } from './screens/Lobby';
import { NameEntry } from './screens/NameEntry';
import { Pause } from './screens/Pause';
import { Results } from './screens/Results';
import { SettingsScreen } from './screens/Settings';
import { TipsCard } from './screens/Tips';
import { TitleScreen } from './screens/Title';
import { TuneToast } from './screens/Tune';
import { releaseShellFocus } from './focus';
import { PhoneHome, PhoneJoin, PhoneLanAddPlayer, PhoneLanJoin, PhoneLobby, PhoneNameEntry, PhonePause, PhoneResults, PhoneSettings, PhoneTips, usePhoneLayout } from './screens/phone';
import { closeRoute, runCleanup, type ShellActions, type ShellRoute, type ShellStore } from './store';
import { SocialLayer } from '../social/SocialLayer';
import { PwaHost } from '../pwa/InstallToast';

export { ControllerContext };
export { TipsCard, tipsRows } from './screens/Tips';

const ENDED = new Set<MatchPhase>([MatchPhase.Ending, MatchPhase.Postgame, MatchPhase.Closed]);

export function App({ store, controller = null }: { store: ShellStore; controller?: ShellController | null }) {
  const route = useStore(store, (s) => s.route);
  if (route) return <RouteView route={route} />;
  if (!controller) return <DebugScreens store={store} />;
  return (
    <ControllerContext.Provider value={controller}>
      <AppScreens store={store} />
    </ControllerContext.Provider>
  );
}

function AppScreens({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const screen = useStore(store, (s) => s.screen);
  const overlay = useStore(store, (s) => s.overlay);
  const titleOff = useStore(store, (s) => s.title !== 'on');
  const notice = useStore(store, (s) => s.notice);
  const tuneNote = useStore(store, (s) => s.tuneNote);
  const tips = useStore(store, (s) => s.tips);
  const tipsAsked = useStore(store, (s) => s.tipsAsked === true);
  const match = useStore(store, (s) => s.match);
  // a room still connecting (its Connecting card, then the map loading): the controls card waits, it
  // would sit over the steps (a local room's guest on an iPhone, 24 Oct)
  const inRoomYet = useStore(store, (s) => s.screen.name !== 'room' || (s.connection?.state === 'connected' && s.match !== null));
  const phone = usePhoneLayout();
  // the keyboard's keys, or a controller's buttons while one plays (gamepad/)
  const shown = useShownControls(store);

  // the countdown and the match are play: the shell's buttons (Start now, Ready, the controls card)
  // let go of the keyboard, so Space and the arrows are the game's from the first frame
  const phase = match?.phase;
  useEffect(() => {
    if (phase === MatchPhase.Countdown || phase === MatchPhase.InProgress) releaseShellFocus();
  }, [phase]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && !location.hash) {
        e.preventDefault();
        ctl.toggleMenu();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ctl]);

  let body = null;
  switch (screen.name) {
    case 'boot':
      // the page's own loading screen (index.html) stays up until the first real screen
      break;
    case 'name':
      body = phone ? <PhoneNameEntry store={store} first /> : <NameEntry store={store} first />;
      break;
    case 'home':
      body = phone ? <PhoneHome store={store} /> : <Home store={store} />;
      break;
    case 'finding':
      body = <Connecting code={screen.code} step={0} creating={screen.creating} onCancel={() => ctl.go({ to: 'home' })} />;
      break;
    case 'error':
      body = <Alert alert={screen.alert} onRejoin={screen.retry ? () => ctl.go(screen.retry!) : null} />;
      break;
    case 'room':
      body = <RoomScreen store={store} code={screen.code} />;
      break;
    case 'training':
      body = <TrainingScreen store={store} />;
      break;
  }
  // the controls card: in a room's lobby it's the lobby's own panel; as a card it opens on Home or in
  // play, but never over the countdown or a running match unless the player asked for it (the menu's
  // Controls): the first-run card is queued for a calm moment (controller.releaseTips; mobile audit P0-3)
  const inLobby = screen.name === 'room' && match?.phase === MatchPhase.Waiting;
  const live = match?.phase === MatchPhase.Countdown || match?.phase === MatchPhase.InProgress;
  const playing = screen.name === 'room' || screen.name === 'training' || screen.name === 'home';
  return (
    <>
      {body}
      {tips && playing && inRoomYet && !overlay && !inLobby && (!live || tipsAsked) && (phone ? <PhoneTips /> : <TipsCard bindings={shown.bindings} doubleTapDash={shown.doubleTapDash} />)}
      {overlay === 'menu' && (phone ? <PhonePause store={store} /> : <Pause store={store} />)}
      {overlay === 'settings' && (phone ? <PhoneSettings store={store} /> : <SettingsScreen store={store} />)}
      {overlay === 'join' && (phone ? <PhoneJoin /> : <Join />)}
      {overlay === 'lan-add' && (phone ? <PhoneLanAddPlayer /> : <LanAddPlayer />)}
      {overlay === 'lan-join' && (phone ? <PhoneLanJoin /> : <LanJoin />)}
      {overlay === 'name' && (phone ? <PhoneNameEntry store={store} first={false} /> : <NameEntry store={store} first={false} />)}
      {/* friends (social/): the panel, over the menus and the in-match menu */}
      {/* not under the title: its push channel and panels start once the player is in (mobile audit P1-17) */}
      {titleOff && <SocialLayer />}
      <TuneToast note={tuneNote} />
      <PwaHost />
      <TitleScreen store={store} />
      {notice && (
        <div className="mf-fit mf-toast kit-v2">
          <div className="mf-notice" role="status">
            <Icon name="ok" />
            {notice}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- rooms and training

function RoomScreen({ store, code }: { store: ShellStore; code: string }) {
  const ctl = useCtl();
  const connection = useStore(store, (s) => s.connection);
  const match = useStore(store, (s) => s.match);
  const lobby = useStore(store, (s) => s.lobby);
  const actions = useStore(store, (s) => s.actions);
  const tips = useStore(store, (s) => s.tips);
  const { bindings, doubleTapDash } = useShownControls(store);
  const overlay = useStore(store, (s) => s.overlay);
  const countdown = useCountdown(match);
  const phone = usePhoneLayout();
  // we came to watch (v20): a refused or dropped watcher's alert says so, and its retry watches again
  const watching = useStore(store, (s) => s.screen.name === 'room' && s.screen.watch === true);
  // a local room (same Wi-Fi): its alerts speak of the host's phone and the Wi-Fi, not a server
  const local = useStore(store, (s) => s.screen.name === 'room' && s.screen.local === true);

  const loading = useLoadingHold(connection?.state === 'connected', !!match, match?.phase === MatchPhase.Waiting);
  if (!connection || connection.state === 'connecting' || connection.state === 'joining') {
    return <Connecting code={code} step={connectStep(connection, !!match)} local={local} onCancel={() => ctl.leave()} />;
  }
  if (loading) {
    return <MapLoading code={code} lobby={lobby} mapName={lobby?.mapName || match?.mapName || ''} haveMatch={!!match} load={loading} bindings={bindings} onCancel={() => ctl.leave()} />;
  }
  if (connection.state === 'failed') return <Alert alert={alertFromConnection(connection, code, watching, local)} onRejoin={() => ctl.rejoin()} />;
  const host = lobby?.players.find((p) => p.host);
  return (
    <>
      {match?.phase === MatchPhase.Waiting && lobby && (phone ? <PhoneLobby lobby={lobby} tips={tips && !overlay ? bindings : null} doubleTapDash={doubleTapDash} /> : <Lobby lobby={lobby} tips={tips && !overlay ? bindings : null} doubleTapDash={doubleTapDash} />)}
      {countdown && <Countdown view={countdown.view} state={countdown.state} held={countdown.held} bindings={bindings} />}
      {match &&
        ENDED.has(match.phase) &&
        match.results &&
        (phone ? (
          <PhoneResults view={match} results={match.results} actions={actions} room={{ isHost: lobby?.isHost ?? false, hostId: host?.id ?? -1, code, leave: () => ctl.leave() }} code={code} />
        ) : (
          <Results view={match} results={match.results} actions={actions} room={{ isHost: lobby?.isHost ?? false, hostId: host?.id ?? -1, code, leave: () => ctl.leave() }} />
        ))}
      <ReconnectBanner connection={connection} />
    </>
  );
}

/**
 * The map loading screen's hold (shell/mapLoading.ts): from the room letting us in until the first
 * world update, and in a lobby until the map's art is in (8 s at most). Counted from this room's
 * screen mounting; once let go, it never comes back for this room (later downloads pop in). Returns
 * the load to show while it holds, null once it doesn't.
 */
function useLoadingHold(connected: boolean, haveMatch: boolean, waiting: boolean): AssetLoad | null {
  const [mark] = useState(() => assetLoad.mark());
  const firstWorld = useRef<number | null>(null);
  const released = useRef(false);
  const [, setTick] = useState(0);
  const load = assetLoad.since(mark);
  if (haveMatch && firstWorld.current === null) firstWorld.current = performance.now();
  const heldMs = firstWorld.current === null ? 0 : performance.now() - firstWorld.current;
  const hold = connected && !released.current && holdLoading({ haveMatch, waiting, load, heldMs });
  if (connected && haveMatch && !hold) released.current = true;
  // while it holds, look again 4 times a second (files land without a store change)
  useEffect(() => {
    if (!hold) return undefined;
    const t = window.setInterval(() => setTick((n) => n + 1), 250);
    return () => window.clearInterval(t);
  }, [hold]);
  return hold ? load : null;
}

function TrainingScreen({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const match = useStore(store, (s) => s.match);
  const actions = useStore(store, (s) => s.actions);
  const { bindings } = useShownControls(store);
  const countdown = useCountdown(match);
  const phone = usePhoneLayout();
  return (
    <>
      {match?.phase === MatchPhase.Waiting && <WarmupBar view={match} actions={actions} />}
      {countdown && <Countdown view={countdown.view} state={countdown.state} held={countdown.held} bindings={bindings} />}
      {match &&
        ENDED.has(match.phase) &&
        match.results &&
        (phone ? <PhoneResults view={match} results={match.results} actions={actions} training={{ leave: () => ctl.leave() }} /> : <Results view={match} results={match.results} actions={actions} training={{ leave: () => ctl.leave() }} />)}
    </>
  );
}

/** A local match's warm-up: one Ready (training and the debug client). */
export function WarmupBar({ view, actions }: { view: MatchView; actions: ShellActions }) {
  return (
    <Screen name="lobby" kind="game" states={[view.ready ? 'ready' : 'not-ready']} label="Warm-up">
      <div className="mf-lobby-strip plate m-p9" role="region" aria-label="Warm-up">
        <span className="tag tag--soon">Warm-up</span>
        <span>Nothing counts until the match starts</span>
        {view.ready ? (
          <button className="btn btn--paper" aria-pressed="true" disabled>
            <Icon name="ok" />
            Ready: waiting for players
          </button>
        ) : (
          <button className="btn btn--volt m-p8" onClick={blurAfter(actions.ready)}>
            <Icon name="clock" />
            Ready
          </button>
        )}
      </div>
    </Screen>
  );
}

// ---------------------------------------------------------------- routes (the Locker)

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
    // a full-screen page of its own (the Locker, the creator): a named region (a div can't carry aria-label)
    <section className="mf-route kit-v2" aria-label={route.title}>
      <div ref={el} className="mf-route__body" />
      {!route.ownExit && (
        <button className="btn btn--ghost btn--sm mf-route__back" onClick={closeRoute}>
          <Icon name="back" />
          Back
        </button>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- the debug client (dev `/`)

/** The HUD banner hook (docs/02 §20.7): the map event to announce, null when none. */
export function useMapEventBanner(store: ShellStore): MapEventBannerView | null {
  return useStore(store, (s) => s.mapEvent);
}

/** The kit's map-event banner: "Gravity pocket in 5 s" (warning), then "Gravity pocket 4 s" with what it does. */
export function MapEventBanner({ banner }: { banner: MapEventBannerView }) {
  const warning = banner.phase === 'warning';
  const look = eventLook(banner.kind);
  return (
    <div className={warning ? 'event-banner event-banner--warn' : 'event-banner'} style={{ '--ev': look.color, '--event': 1 } as CSSProperties} role="status" aria-live="polite">
      <span className="event-banner__icon">
        <Icon name={warning ? 'warn' : look.icon} size="lg" />
      </span>
      <div className="event-banner__text">
        <p className="event-banner__title">
          <b>{banner.title}</b>
          <span className="event-banner__time num">{warning ? `in ${banner.seconds} s` : `${banner.seconds} s`}</span>
        </p>
        <p className="event-banner__desc">{banner.line}</p>
      </div>
    </div>
  );
}

/** The debug client keeps its canvas HUD; these are its match overlays (local mode). */
function DebugScreens({ store }: { store: ShellStore }) {
  const match = useStore(store, (s) => s.match);
  const actions = useStore(store, (s) => s.actions);
  const banner = useMapEventBanner(store);
  const bindings = useStore(store, (s) => s.settings.bindings);
  const countdown = useCountdown(match);
  return (
    <>
      {(banner || match?.phase === MatchPhase.InProgress) && (
        <Screen name="hud" kind="game" label="Match clock">
          <div className="hud">
            <div className="hud-match">
              {match?.phase === MatchPhase.InProgress && <DebugClock view={match} />}
              {banner && <MapEventBanner key={banner.key} banner={banner} />}
            </div>
          </div>
        </Screen>
      )}
      {match?.phase === MatchPhase.Waiting && <WarmupBar view={match} actions={actions} />}
      {countdown && <Countdown view={countdown.view} state={countdown.state} held={countdown.held} bindings={bindings} />}
      {match && ENDED.has(match.phase) && match.results && <Results view={match} results={match.results} actions={actions} />}
    </>
  );
}

export function DebugClock({ view }: { view: MatchView }) {
  return (
    <>
      <div className="hud-clock plate">
        <span className="hud-label">Deathmatch</span>
        <span className="hud-clock__time num">{formatClock(view.untimed ? view.secondsElapsed : view.secondsLeft)}</span>
        <span className="hud-label">{view.killLimit > 0 ? `First to ${view.killLimit}` : view.untimed ? 'No time limit' : 'No kill limit'}</span>
      </div>
      <div className="hud-score">
        <div className="hud-score__cell plate is-you">
          <span className="hud-label">You</span>
          <b className="num">{view.myScore}</b>
        </div>
        <div className="hud-score__cell plate">
          <span className="hud-label">Leader{view.leaderName ? ` · ${view.leaderName}` : ''}</span>
          <b className="num">{view.leaderScore}</b>
        </div>
      </div>
    </>
  );
}
