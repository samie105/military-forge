/**
 * Small parts the phone menus share: the system share sheet with what came of it (the "Shared" chip),
 * the bottom sheet (rises on --ease-arrive, drops on --ease-leave), and a number that rolls (P4).
 */
import { GAME_NAME } from '@military-forge/shared';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { rollText } from '../../../ui/motion';
import { inviteText, roomLink } from '../../controller';

export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

type ShareNavigator = Pick<Navigator, 'clipboard'> & { share?: (data: ShareData) => Promise<void> };

/**
 * The phone's share: the system sheet (navigator.share) where there is one, else the link copied. Says
 * what happened so the screen can stamp "Shared" or "Copied" (a cancelled sheet says nothing).
 */
export async function shareData(data: ShareData, nav: ShareNavigator = navigator): Promise<ShareOutcome> {
  if (nav.share) {
    try {
      await nav.share(data);
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'cancelled';
    }
  }
  const text = [data.text, data.url].filter(Boolean).join(' ');
  try {
    await nav.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** The room's invitation: the same words and link as the desktop's Copy link and WhatsApp. */
export function shareRoom(code: string, nav?: ShareNavigator): Promise<ShareOutcome> {
  return shareData({ title: GAME_NAME, text: inviteText(), url: roomLink(code) }, nav);
}

/** The chip after a share: "Shared" or "Copied" for 1.6 s (P7), nothing for a cancelled sheet. */
export function useShareChip(): [ShareOutcome | null, (outcome: ShareOutcome) => void] {
  const [chip, setChip] = useState<ShareOutcome | null>(null);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = (outcome: ShareOutcome) => {
    if (outcome === 'cancelled') return;
    setChip(outcome);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setChip(null), 1600);
  };
  return [chip, show];
}

export function ShareChip({ outcome }: { outcome: ShareOutcome | null }) {
  if (!outcome) return null;
  const ok = outcome !== 'failed';
  return (
    <span key={outcome} className={`stamp ${ok ? 'stamp--ok' : 'stamp--bad'} pm-chip m-p7`} role="status">
      <svg className="ic ic--sm" aria-hidden="true">
        <use href={ok ? '#icon-check' : '#icon-warn'} />
      </svg>
      {outcome === 'shared' ? 'Shared' : outcome === 'copied' ? 'Link copied' : 'Could not share'}
    </span>
  );
}

/**
 * A bottom sheet over the screen: rises from the bottom edge on --ease-arrive, drops on --ease-leave
 * (kept mounted for its exit, interruptible: opening again takes over). The scrim closes it.
 */
export function Sheet({ open, onClose, label, children }: { open: boolean; onClose: () => void; label: string; children: ReactNode }) {
  const [shown, setShown] = useState(open);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (open) {
      setShown(true);
      setLeaving(false);
      return undefined;
    }
    if (!shown) return undefined;
    setLeaving(true);
    const t = window.setTimeout(() => {
      setShown(false);
      setLeaving(false);
    }, 180);
    return () => window.clearTimeout(t);
  }, [open, shown]);
  if (!shown) return null;
  return (
    <>
      <div className={`pm-scrim${leaving ? ' is-leaving' : ''}`} onClick={onClose} aria-hidden="true"></div>
      <div className={`pm-sheet plate${leaving ? ' is-leaving' : ''}`} role="dialog" aria-label={label}>
        {children}
      </div>
    </>
  );
}

/**
 * A number that rolls when it changes (P4: ui/motion.ts rollText), tabular figures. React renders the
 * first value; later ones are rollText's (React's child never changes, so the two never fight).
 */
export function Roll({ value, className }: { value: string | number; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  const text = String(value);
  const firstText = useRef(text).current;
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    if (node.dataset.roll === undefined) node.dataset.roll = firstText;
    if (node.dataset.roll !== text) rollText(node, text);
  }, [text, firstText]);
  return (
    <span ref={el} className={['num', className].filter(Boolean).join(' ')}>
      {firstText}
    </span>
  );
}

export function initial(name: string): string {
  return ([...name.trim()][0] ?? '?').toUpperCase();
}
