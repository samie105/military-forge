/**
 * The kit's building blocks as React: a screen frame (fit to the window), ping with signal bars,
 * a switch, a segmented choice. Markup and class names are the kit's; see kit.css.
 */
import { useRef, type CSSProperties, type ReactNode } from 'react';
import { useFocusTrap } from './focusTrap';
import { pingQuality } from './ping';

/** The kit's ping bands (ui/ping.ts, which the HUD's scoreboard shares). */
export { pingQuality };

export type ScreenKind = 'menu' | 'game';

/**
 * <section class="screen screen--menu" data-screen="home" data-active-state="…"> fitted to the
 * window. `states` are the kit's state tokens (CSS reads them: [data-active-state~="host"]).
 */
export function Screen({
  name,
  kind,
  states = [],
  label,
  className,
  style,
  modal = false,
  dialog = false,
  children,
}: {
  name: string;
  kind: ScreenKind;
  states?: readonly (string | false | null | undefined)[];
  label?: string;
  className?: string;
  style?: CSSProperties;
  /** a game screen that takes the mouse (the menu over a running match) */
  modal?: boolean;
  /** a dialog over another screen (Settings, Join, the in-match menu): role="dialog", focus kept inside (ui/focusTrap.ts) */
  dialog?: boolean;
  children: ReactNode;
}) {
  const active = states.filter(Boolean).join(' ') || 'default';
  const ref = useRef<HTMLElement>(null);
  useFocusTrap(ref, dialog);
  return (
    <div className={`${modal ? 'mf-fit mf-fit--modal' : 'mf-fit'} kit-v2`}>
      <section
        ref={ref}
        className={['screen', `screen--${kind}`, className ?? ''].filter(Boolean).join(' ')}
        data-screen={name}
        data-active-state={active}
        aria-label={label}
        style={style}
        {...(dialog ? { role: 'dialog', 'aria-modal': true, tabIndex: -1 } : {})}
      >
        {children}
      </section>
    </div>
  );
}


export function Ping({ ms, label, bars = true }: { ms: number; label?: string | undefined; bars?: boolean }) {
  if (!(ms >= 0)) return <span className="ping muted">{label ? `${label} · ` : ''}no ping</span>;
  const q = pingQuality(ms);
  return (
    <span className={`ping ${q.cls}`}>
      {bars && (
        <span className="sig" data-bars={q.bars} aria-hidden="true">
          <i></i>
          <i></i>
          <i></i>
          <i></i>
        </span>
      )}
      {label && <span className="ping__label">{label}</span>}
      <span className="num">{Math.round(ms)} ms</span>
    </span>
  );
}

/** The kit's switch (a button with role="switch"). */
export function Switch({ on, onChange, label, showState = true }: { on: boolean; onChange: (on: boolean) => void; label: string; showState?: boolean }) {
  return (
    <button type="button" className="switch" role="switch" aria-checked={on} aria-label={showState ? label : undefined} onClick={() => onChange(!on)}>
      <span className="switch__track"></span>
      {showState ? <span className="switch__state">{on ? 'On' : 'Off'}</span> : <span>{label}</span>}
    </button>
  );
}

/** Buttons over a running game hand focus back, so Space (jet) never presses them again. */
export function blurAfter(fn: () => void) {
  return (e: { currentTarget: HTMLElement }) => {
    e.currentTarget.blur();
    fn();
  };
}
