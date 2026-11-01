/**
 * Round two's menu frame (docs/design/military-forge-ui-v2.html: every screen--menu): the backdrop
 * (scrim, camo, grid, halftone, slash and the giant stencil word; the live game shows through, so
 * the kit's preview art is left out), the top bar's net pill, and the key hints along the bottom.
 * Plus the hand-off that carries the ID card from name entry into Home's player chip (motion P2).
 */
import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { PadKbd, useInputDevice } from '../../gamepad/react';
import { Icon } from '../../ui/Icon';
import { logicalRect } from '../../ui/landscape';
import { rollText, type Box } from '../../ui/motion';
import { Ping } from '../../ui/Screen';
import './menus.css';
import { useServerPing } from '../context';

/** The menu backdrop: decoration only (aria-hidden). */
export function Backdrop({ word }: { word: string }) {
  return (
    <div className="bg" aria-hidden="true">
      <div className="bg__scrim"></div>
      <div className="bg__camo"></div>
      <div className="bg__grid"></div>
      <div className="bg__dots"></div>
      <div className="bg__slash"></div>
      <div className="bg__word">{word}</div>
    </div>
  );
}

/** What Home says when the game server can't be reached: once, in the Play now poster (desktop and phone). */
export const OFFLINE_LINE = "Can't reach the server. Training with bots still works.";
/** a suspended or banned account (audit-2 L-04): the server answered, it just won't let this account play online */
export const SUSPENDED_LINE = "This account can't play online right now. Training with bots still works.";

/**
 * The connection in the top bar: the kit's signal bars and the round trip (the API's, every 10 s), no
 * server name (the owner, 1 Nov 2026); "Offline" when it can't be reached.
 */
export function NetPill({ offline = false }: { offline?: boolean }) {
  const ping = useServerPing();
  if (offline)
    return (
      <span className="net-pill" aria-label="Offline: can't reach the server">
        <Icon name="unplug" size="sm" />
        Offline
      </span>
    );
  if (!(ping >= 0)) return null;
  return (
    <span className="net-pill" title="Your connection to the game">
      <Ping ms={ping} />
    </span>
  );
}

/**
 * The key hints along the bottom of a menu, and the right-hand note (`end`). While a controller plays
 * they're its buttons (each Hint's `pad`), and the pad's floating hint bar stays away (gamepad/: one
 * set of prompts at a time, in the device in hand: UX audit 2, N-09 and N-15).
 */
export function Hints({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <footer className="menu-hints" data-pad-hints>
      {children}
      {end && <span className="menu-hints__end">{end}</span>}
    </footer>
  );
}

/**
 * One hint: a keycap (or two) and what it does. `pad`: the controller's button(s) for it (glyphs
 * while a pad plays, `padText` its words if they differ); a hint with no pad button hides then, and
 * one with only `pad` shows only then.
 */
export function Hint({ keys, pad, padText, children }: { keys?: ReactNode; pad?: string | readonly string[]; padText?: ReactNode; children: ReactNode }) {
  const padInUse = useInputDevice().kind === 'pad';
  if (padInUse ? !pad : !keys) return null;
  return (
    <span>
      {padInUse ? [pad!].flat().map((code) => <PadKbd key={code} code={code} />) : keys} {padInUse && padText !== undefined ? padText : children}
    </span>
  );
}

const handoffs = new Map<string, Box>();

/** A screen leaves: where `el` was, for the next screen to grow out of (P2) or to flood from (P6). */
export function remember(key: string, el: Element | null): void {
  const r = el ? logicalRect(el) : null; // the page's coordinates (an upright phone plays turned)
  if (r && r.width > 0) handoffs.set(key, { left: r.left, top: r.top, width: r.width, height: r.height });
  else handoffs.delete(key);
}

/** The box remembered under `key`, once (null when nothing handed it over). */
export function take(key: string): Box | null {
  const b = handoffs.get(key) ?? null;
  handoffs.delete(key);
  return b;
}

/** Name entry leaves: where its ID card was, for Home's player chip to grow out of (P2). */
export function rememberCard(el: Element | null): void {
  remember('card', el);
}

/** Home arrives: the card's box, once (null when Home wasn't reached from name entry). */
export function takeCard(): Box | null {
  return take('card');
}

/** A number whose changed digits roll (motion P4) when it changes. */
export function RollNum({ value, className }: { value: number | string; className?: string }) {
  const el = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (el.current) rollText(el.current, String(value));
  }, [value]);
  // rendered on its own (tests, no DOM): the value as text; in the page rollText draws it
  return (
    <span ref={el} className={['num', className ?? ''].filter(Boolean).join(' ')}>
      {typeof document === 'undefined' ? String(value) : null}
    </span>
  );
}
