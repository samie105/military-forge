/**
 * The kit's building blocks as React: a screen frame (fit to the window), ping with signal bars,
 * a switch, a segmented choice. Markup and class names are the kit's; see kit.css.
 */
import type { CSSProperties, ReactNode } from 'react';

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
  children: ReactNode;
}) {
  const active = states.filter(Boolean).join(' ') || 'default';
  return (
    <div className={`${modal ? 'mf-fit mf-fit--modal' : 'mf-fit'} kit-v2`}>
      <section className={['screen', `screen--${kind}`, className ?? ''].filter(Boolean).join(' ')} data-screen={name} data-active-state={active} aria-label={label} style={style}>
        {children}
      </section>
    </div>
  );
}

/** Ping quality the kit's way: green up to 100 ms, amber to 200, red beyond; 4…1 signal bars. */
export function pingQuality(ms: number): { cls: 'ping--good' | 'ping--mid' | 'ping--bad'; bars: 1 | 2 | 3 | 4 } {
  if (ms <= 50) return { cls: 'ping--good', bars: 4 };
  if (ms <= 100) return { cls: 'ping--good', bars: 3 };
  if (ms <= 200) return { cls: 'ping--mid', bars: 2 };
  return { cls: 'ping--bad', bars: 1 };
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
