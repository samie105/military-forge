/**
 * App shell entry (docs/06 §4, L5 + L4): mounts the React screens over the game and bridges the
 * running mode into the shell store once per frame. Only visible changes reach React.
 */
import type { Match } from '@military-forge/sim';
import { createRoot } from 'react-dom/client';
import type { MapEventView } from '../view';
import { App } from './App';
import { bannerOf, sameBanner } from './mapEventBanner';
import { matchView, sameView } from './matchView';
import { createShellStore, findRoute, onRoutesChanged, type ShellActions, type ShellStore } from './store';
import './shell.css';

export { useMapEventBanner } from './App';
export { localMatchRules } from './localMatch';
export { bannerOf, type MapEventBanner } from './mapEventBanner';
export { registerRoute, type ShellRoute } from './store';

/** What the shell needs from a game mode: local mode now, online mode in Milestone B. */
export interface MatchSource extends ShellActions {
  readonly match: Match | null;
  readonly localId: number;
}

export interface Shell {
  readonly store: ShellStore;
  /** once per frame with the running mode (null: no match, e.g. sandbox or online for now) */
  update(source: MatchSource | null): void;
  /**
   * The map-event banner hook (docs/02 §20.7): once per frame with the frame's map event (local or
   * online, any match state). The store changes only when the banner's text does.
   */
  setMapEvent(view: MapEventView | null | undefined): void;
}

export function mountShell(parent: HTMLElement = document.body): Shell {
  const el = document.createElement('div');
  el.id = 'shell';
  parent.appendChild(el);

  let source: MatchSource | null = null;
  const store = createShellStore();
  store.setState({
    actions: {
      playAgain: () => source?.playAgain(),
      backToLobby: () => source?.backToLobby(),
      ready: () => source?.ready(),
    },
  });
  const syncRoute = () => store.setState({ route: findRoute(location.hash.replace(/^#\/?/, '')) });
  window.addEventListener('hashchange', syncRoute);
  onRoutesChanged(syncRoute);
  syncRoute();

  createRoot(el).render(<App store={store} />);

  return {
    store,
    update(next) {
      source = next;
      const view = next?.match ? matchView(next.match, next.localId) : null;
      if (!sameView(store.getState().match, view)) store.setState({ match: view });
    },
    setMapEvent(view) {
      const banner = bannerOf(view);
      if (!sameBanner(store.getState().mapEvent, banner)) store.setState({ mapEvent: banner });
    },
  };
}
