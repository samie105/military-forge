/**
 * The phone menus' frame (the owner's round-two kit, "MOBILE (812×375)": m-home, m-lobby, m-pause,
 * m-results): when the viewport is a landscape phone, App.tsx shows these instead of the desktop
 * screens. They're 812×375 designs zoomed to the window by fit.ts's --phone-fit, wear round two's
 * components (kit-v2) and move by the shared motion system at phone distances (--m-rise 10 px).
 */
import { useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { useFocusTrap } from '../../../ui/focusTrap';
import { LANDSCAPE_PHONE_QUERY, UPRIGHT_PHONE_QUERY, isPhoneShape, isRotated } from '../../../ui/landscape';

/** A phone held sideways: a finger for a pointer and no more than 500 px of height (tablets keep the desktop menus). */
export const PHONE_QUERY = LANDSCAPE_PHONE_QUERY;

/** Dev builds: `?phone` forces the phone menus in any window (screenshots, a desktop browser). */
function forced(): boolean {
  return import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).has('phone');
}

/** A phone, held sideways or upright (an upright phone plays turned onto its side: ui/landscape.ts). */
export function isPhoneLayout(): boolean {
  if (forced()) return true;
  return isPhoneShape();
}

function subscribe(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mqs = [matchMedia(PHONE_QUERY), matchMedia(UPRIGHT_PHONE_QUERY)];
  for (const mq of mqs) mq.addEventListener('change', onChange);
  return () => mqs.forEach((mq) => mq.removeEventListener('change', onChange));
}

/** True while the phone menus apply; follows the phone turning (and a window resized past the query). */
export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, isPhoneLayout, () => false);
}

function subscribeUpright(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mq = matchMedia(UPRIGHT_PHONE_QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}

/** The page is turned onto an upright phone (ui/landscape.ts) right now. */
export function useRotated(): boolean {
  return useSyncExternalStore(subscribeUpright, isRotated, () => false);
}

/** The touch controls are what the player plays with (a phone; not a pad plugged into it): prompts say what to tap, not a key. */
export function touchPrompts(): boolean {
  if (typeof document === 'undefined') return false;
  const html = document.documentElement;
  return html.hasAttribute('data-touch-controls') && html.dataset.input !== 'pad';
}

function subscribeInput(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {};
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-touch-controls', 'data-input'] });
  return () => mo.disconnect();
}

/** touchPrompts(), following the device (touch/index.ts sets data-touch-controls; gamepad/device.ts data-input). */
export function useTouchPrompts(): boolean {
  return useSyncExternalStore(subscribeInput, touchPrompts, () => false);
}

/** Settings → Text size (main.ts writes --text-scale on <html>): 1 … 1.5. */
export function textScale(): number {
  if (typeof document === 'undefined') return 1;
  return Number(document.documentElement.style.getPropertyValue('--text-scale')) || 1;
}

function subscribeText(onChange: () => void): () => void {
  if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return () => {};
  const mo = new MutationObserver(onChange);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
  return () => mo.disconnect();
}

/** Large text (125 % and up): the phone screens drop decoration and reflow so nothing overlaps (phone.css .is-text-lg). */
export function useLargeText(): boolean {
  return useSyncExternalStore(subscribeText, () => textScale() >= 1.25, () => false);
}

/**
 * <section class="screen screen--menu screen--phone" data-screen="m-home" …> in a phone fit. `word` is
 * the giant outlined word the kit prints behind a menu (never read; aria-hidden); `modal` takes the
 * pointer over a running game (the pause menu).
 */
export function PhoneScreen({
  name,
  kind = 'menu',
  states = [],
  label,
  word,
  modal = false,
  dialog = false,
  className,
  style,
  children,
}: {
  name: string;
  kind?: 'menu' | 'game';
  states?: readonly (string | false | null | undefined)[];
  label: string;
  word?: string;
  modal?: boolean;
  /** a dialog over another screen: role="dialog", focus kept inside (ui/focusTrap.ts) */
  dialog?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const active = states.filter(Boolean).join(' ') || 'default';
  const large = useLargeText();
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, dialog);
  return (
    <div className={`mf-fit mf-fit--phone kit-v2${modal ? ' mf-fit--modal' : ''}${large ? ' is-text-lg' : ''}`}>
      <section
        ref={ref}
        className={['screen', `screen--${kind}`, 'screen--phone', className ?? ''].filter(Boolean).join(' ')}
        data-screen={name}
        data-active-state={active}
        aria-label={label}
        style={style}
        {...(dialog ? { role: 'dialog', 'aria-modal': true, tabIndex: -1 } : {})}
      >
        {word && (
          <div className="bg pbg" aria-hidden="true">
            <div className="bg__scrim"></div>
            <div className="bg__camo"></div>
            <div className="bg__grid"></div>
            <div className="bg__word">{word}</div>
          </div>
        )}
        {children}
      </section>
    </div>
  );
}

/** P3's place in its group (the kit's stagger: `--i`, capped at 10 steps by the class). */
export function rise(i: number): CSSProperties {
  return { '--i': Math.min(10, Math.max(0, i)) } as CSSProperties;
}
