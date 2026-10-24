/**
 * "Install Military Forge, play full screen" (the owner, 23 Oct; Pen: PWA · INSTALL TOAST · phones):
 * a Field Print toast on a Frost plate, on Home and Results only. Android Chrome and Samsung Internet:
 * Install opens the browser's own prompt. iPhone Safari: the two taps (Share, Add to Home Screen).
 * When it shows is install.ts's call (shouldOffer); it never shows once installed.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Icon } from '../ui/Icon';
import { useTourFacts } from '../tour/live';
import { install, markShown, notNow, pwaStore } from './index';
import { shouldOffer } from './install';
import './pwa.css';

export function InstallToast({ where }: { where: 'home' | 'results' }) {
  const s = useSyncExternalStore(pwaStore.subscribe, pwaStore.getState, pwaStore.getState);
  const facts = useTourFacts();
  const matches = facts?.matches.finished ?? 0;
  // decided once per screen visit: the toast doesn't pop in under a thumb mid-tap
  const [open, setOpen] = useState(() => shouldOffer(s.memory, { kind: s.kind, installed: s.installed, matchesFinished: matches, shownThisSession: s.shown }));
  // Android's prompt arrives a moment after load: Home may already be up
  useEffect(() => {
    if (!open && s.kind === 'prompt' && shouldOffer(s.memory, { kind: s.kind, installed: s.installed, matchesFinished: matches, shownThisSession: s.shown })) setOpen(true);
  }, [s.kind, open, s.memory, s.installed, s.shown, matches]);
  useEffect(() => {
    if (open) markShown();
  }, [open]);
  // iPhone Safari's guide on Home: in the top bar's empty middle when the box is wide enough (pwa.css)
  const [top] = useState(() => where === 'home' && s.kind === 'ios' && wideBox());
  if (!open || !s.kind) return null;
  const close = () => {
    notNow(matches);
    setOpen(false);
  };
  return (
    <aside className={`mf-install mf-install--${where}${s.kind === 'ios' ? ' mf-install--ios' : ''}${top ? ' mf-install--top' : ''}`} role="dialog" aria-label={s.kind === 'ios' ? 'Add Military Forge to your Home Screen' : 'Install Military Forge'}>
      <span className="mf-install__tile" aria-hidden="true">
        {s.kind === 'ios' ? <Icon name="share" /> : <Icon name="download" />}
      </span>
      {s.kind === 'ios' ? (
        <>
          <span className="mf-install__words">
            <span className="mf-install__eyebrow">Full screen on iPhone</span>
            <b className="mf-install__title display">Add to Home Screen</b>
            <span className="mf-install__steps">
              <span className="mf-install__step">
                <i>1</i>Tap <Icon name="share" size="sm" /> <b>Share</b>
              </span>
              <Icon name="chev-right" size="sm" className="mf-install__then" />
              <span className="mf-install__step">
                <i>2</i>Tap <b>Add to Home Screen</b>
              </span>
            </span>
          </span>
          <button type="button" className="mf-install__go m-p8" onClick={close}>
            Got it
          </button>
        </>
      ) : (
        <>
          <span className="mf-install__words">
            <span className="mf-install__eyebrow">Play full screen</span>
            <b className="mf-install__title display">Install Military Forge</b>
            <span className="mf-install__line">No browser bars. It opens sideways, from your home screen.</span>
          </span>
          <button type="button" className="mf-install__later" onClick={close}>
            Not now
          </button>
          <button
            type="button"
            className="mf-install__go m-p8"
            onClick={() => {
              setOpen(false);
              void install(matches);
            }}
          >
            <Icon name="download" size="sm" />
            Install
          </button>
        </>
      )}
    </aside>
  );
}

/** The phone screens' box (ui/fit.ts --phone-w, design px) leaves the top bar a free middle wide enough for the guide. */
export const TOP_BAR_ROOM = 1000;

function wideBox(): boolean {
  if (typeof document === 'undefined') return false;
  return (parseFloat(document.documentElement.style.getPropertyValue('--phone-w')) || 0) >= TOP_BAR_ROOM;
}
