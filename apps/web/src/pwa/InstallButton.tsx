/**
 * Install app (the owner, 24 Oct: "make it a PWA so people can download the app"): a permanent button
 * in Home's top bar (phone and desktop), Settings and the pause menu, while the game can be installed
 * and isn't. Android Chrome, Samsung Internet, desktop Chrome and Edge: the browser's own prompt.
 * iPhone Safari: the two-step guide (PwaHost). Gone once installed, or where a browser can't install.
 */
import { useSyncExternalStore } from 'react';
import { Icon } from '../ui/Icon';
import { useTourFacts } from '../tour/live';
import { askInstall, pwaStore } from './index';
import './pwa.css';

/** `inTopBar`: Home's top bar, where the iPhone's suggestion sits while it's up (the button steps aside for it). */
export function InstallButton({ className = '', inTopBar = false }: { className?: string; inTopBar?: boolean }) {
  const s = useSyncExternalStore(pwaStore.subscribe, pwaStore.getState, pwaStore.getState);
  const facts = useTourFacts();
  if (!s.kind || s.installed) return null;
  if (inTopBar && s.kind === 'ios' && (s.toastUp || s.guide)) return null;
  return (
    <button
      type="button"
      className={`btn btn--ghost btn--sm mf-install-btn m-p8 ${className}`.trim()}
      title={s.kind === 'ios' ? 'Add Forged Force to your Home Screen: full screen, no browser bars' : 'Install Forged Force: full screen, from your home screen'}
      onClick={() => askInstall(facts?.matches.finished ?? 0)}
    >
      <Icon name="download" />
      {/* the word gives way first when Home's top bar is tight (menus.css): the icon stays, the name is still read */}
      <span className="mf-install-btn__word">Install app</span>
    </button>
  );
}
