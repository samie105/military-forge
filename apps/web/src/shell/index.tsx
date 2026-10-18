/**
 * App shell entry (docs/06 §4, L5 + L4): mounts the React screens over the game and bridges the
 * running mode into the shell store once per frame. Only visible changes reach React.
 *
 * Two ways to mount it:
 * - with a GameHost (the app: production builds, /r/CODE links, ?app): home, names, rooms,
 *   training, settings; the shell starts and stops game modes itself;
 * - without (the dev debug client at `/`): match overlays for the local mode main.ts runs.
 */
import type { Match } from '@military-forge/sim';
import { createRoot } from 'react-dom/client';
import type { MapEventView } from '../view';
import { Api } from './api';
import { App } from './App';
import { ShellController, type GameHost } from './controller';
import { bannerOf, sameBanner } from './mapEventBanner';
import { matchView, sameView } from './matchView';
import { lobbyView, onlineMatchView, sameLobby } from './onlineView';
import { startFitting } from '../ui/fit';
import { mountSprite } from '../ui/sprite';
import { createShellStore, findRoute, onRoutesChanged, type ConnectionView, type ShellActions, type ShellStore } from './store';
// the kit's stylesheet (tokens, components) is linked from index.html so the loading screen has it
// before any script runs; app.css is how the app hosts the kit's screens
import '../ui/app.css';

export { useMapEventBanner } from './App';
export { localMatchRules } from './localMatch';
export { bannerOf, type MapEventBanner } from './mapEventBanner';
export { registerRoute, type ShellRoute, type Settings } from './store';
export type { GameHost } from './controller';

/** What the shell needs from a local game mode. */
export interface MatchSource extends ShellActions {
  readonly match: Match | null;
  readonly localId: number;
}

export interface Shell {
  readonly store: ShellStore;
  /** the app's controller (null for the debug client) */
  readonly controller: ShellController | null;
  /** once per frame; the debug client passes its local mode (null: no match, e.g. sandbox or online) */
  update(source?: MatchSource | null): void;
  /**
   * The map-event banner hook (docs/02 §20.7): once per frame with the frame's map event (local or
   * online, any match state). The store changes only when the banner's text does.
   */
  setMapEvent(view: MapEventView | null | undefined): void;
}

export interface ShellOptions {
  /** the app: the shell drives navigation and game modes */
  host?: GameHost;
  api?: Api;
}

const sameConnection = (a: ConnectionView | null, b: ConnectionView | null) =>
  a === b || (!!a && !!b && a.state === b.state && a.code === b.code && a.detail === b.detail && a.attempt === b.attempt && a.since === b.since && a.until === b.until && a.lastPingMs === b.lastPingMs);

export function mountShell(parent: HTMLElement = document.body, options: ShellOptions = {}): Shell {
  const el = document.createElement('div');
  el.id = 'shell';
  el.className = 'mf';
  parent.appendChild(el);
  mountSprite();
  startFitting();

  const store = createShellStore();
  const host = options.host ?? null;
  const controller = host ? new ShellController(store, host, options.api) : null;
  let local: MatchSource | null = null;
  store.setState({
    actions: {
      playAgain: () => (host?.online ? host.online.voteRematch() : local?.playAgain()),
      backToLobby: () => (host?.online ? host.online.returnToLobby() : local?.backToLobby()),
      ready: () => {
        const online = host?.online;
        if (online) online.setReady(!(store.getState().lobby?.ready ?? false));
        else local?.ready();
      },
    },
  });
  const syncRoute = () => {
    const route = findRoute(location.hash.replace(/^#\/?/, ''));
    store.setState({ route });
    host?.setInputBlocked(route !== null || store.getState().overlay !== null);
  };
  window.addEventListener('hashchange', syncRoute);
  onRoutesChanged(syncRoute);
  syncRoute();

  createRoot(el).render(<App store={store} controller={controller} />);
  if (controller) void controller.boot();

  return {
    store,
    controller,
    update(source) {
      const state = store.getState();
      const online = host?.online ?? null;
      local = host ? host.local : (source ?? null);
      let view = null;
      if (online) view = onlineMatchView(online);
      else if (local?.match) view = matchView(local.match, local.localId);
      const lobby = online ? lobbyView(online) : null;
      const connection = online ? online.connection : null;
      if (!sameView(state.match, view) || !sameLobby(state.lobby, lobby) || !sameConnection(state.connection, connection)) {
        store.setState({ match: view, lobby, connection: connection && { ...connection } });
      }
    },
    setMapEvent(view) {
      const banner = bannerOf(view);
      if (!sameBanner(store.getState().mapEvent, banner)) store.setState({ mapEvent: banner });
    },
  };
}
