/**
 * 5 · Connection (round two's data-screen="connection"): getting into a room step by step, the
 * reconnecting banner over the live game, and the alerts when a room can't be reached or ends: a
 * paper ticket over the scrim, stamped with what happened.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../../ui/Icon';
import { Screen, blurAfter } from '../../ui/Screen';
import { ALERT_LOOK } from '../alerts';
import { useCtl, useTicker } from '../context';
import type { AlertInfo, ConnectionView } from '../store';
import { Backdrop, RollNum } from './frame';

/** 0: the API is finding (or making) the room; 1: the game server is letting us in; 2: the first world update. */
export type ConnectStep = 0 | 1 | 2;

export function connectStep(connection: ConnectionView | null, haveMatch: boolean): ConnectStep {
  if (!connection) return 1;
  if (connection.state === 'connected' && !haveMatch) return 2;
  return 1;
}

const STEPS: readonly [now: string, done: string][] = [
  ['Finding the server', 'Found the server'],
  ['Joining the room', 'Joined the room'],
  ['Loading the map', 'Map loaded'],
];

/** The kit's stamp on each alert: a word and its tone. */
const STAMP: Readonly<Record<AlertInfo['kind'], string>> = {
  'room-full': 'Full',
  'room-not-found': 'No room',
  'new-version': 'Update',
  'server-full': 'Busy',
  'connection-lost': 'Offline',
  offline: 'Offline',
  'slow-down': 'Wait',
  replaced: 'Elsewhere',
  refused: 'Refused',
  error: 'Error',
};
const TONE = { warn: 'stamp--warn', bad: 'stamp--bad', info: 'stamp--volt' } as const;

/**
 * The backdrop and card holder every connection screen shares. The kit shows the game through a
 * scrim, but no world is drawn while we connect or once the link is gone, so the menus' camo stands
 * in for it (the scrim would only turn it black).
 */
function ConnFrame({ states, label, children }: { states: string[]; label: string; children: ReactNode }) {
  return (
    <Screen name="connection" kind="menu" kit="v2" states={states} label={label}>
      <Backdrop word="COMMS" />
      <div className="conn__wrap">{children}</div>
    </Screen>
  );
}

export function Connecting({ code, step, creating = false, onCancel }: { code: string | null; step: ConnectStep; creating?: boolean; onCancel: () => void }) {
  return (
    <ConnFrame states={['connecting']} label="Connecting">
      <div className="conn ticket m-p1" role="alertdialog" aria-labelledby="conn-connecting">
        <span className="tape" style={{ left: '46%', top: -12 }} aria-hidden="true"></span>
        <span className="stamp stamp--volt stamp--lg conn__stamp">{creating && !code ? 'Making' : 'Joining'}</span>
        <Icon name="server" className="conn__ghost" />
        <h1 id="conn-connecting" className="display conn__title">
          {creating && !code ? 'Making your room' : code ? `Joining room ${code}` : 'Finding the room'}
        </h1>
        <p className="conn__body">{creating && !code ? 'A room of your own, with a link to send your friends.' : 'Getting you in: a few seconds.'}</p>
        <ol className="conn__steps">
          {STEPS.map(([now, done], i) =>
            i < step ? (
              <li key={i} className="is-done">
                <Icon name="check" size="sm" />
                {done}
              </li>
            ) : i === step ? (
              <li key={i} className="is-now">
                <span className="spinner"></span>
                {now}
              </li>
            ) : (
              <li key={i}>
                <Icon name="clock" size="sm" />
                {now}
              </li>
            ),
          )}
        </ol>
        <div className="conn__actions">
          <button className="btn btn--ghost btn--xl m-p8" type="button" onClick={blurAfter(onCancel)}>
            <Icon name="close" />
            Cancel
          </button>
        </div>
      </div>
    </ConnFrame>
  );
}

/** Whole seconds until the reconnect tries stop. */
export function reconnectSecondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** How long the "Back" chip shows once a reconnect lands (motion spec §4.1). */
const BACK_MS = 1200;

/**
 * Over the live game: the reconnecting banner comes in from the top edge (P9) while we try, its try
 * count rolling (P4); when the connection is back it leaves accelerating and a green "Back" chip
 * stamps in (P7) for 1.2 s.
 */
export function ReconnectBanner({ connection }: { connection: ConnectionView }) {
  useTicker(1000);
  const reconnecting = connection.state === 'reconnecting';
  const [phase, setPhase] = useState<'off' | 'on' | 'leaving' | 'back'>(reconnecting ? 'on' : 'off');
  const was = useRef(reconnecting);
  useEffect(() => {
    if (reconnecting) {
      was.current = true;
      setPhase('on');
      return undefined;
    }
    if (!was.current) return undefined;
    was.current = false;
    if (connection.state !== 'connected') {
      setPhase('off');
      return undefined;
    }
    setPhase('leaving');
    const t1 = window.setTimeout(() => setPhase('back'), 170);
    const t2 = window.setTimeout(() => setPhase('off'), 170 + BACK_MS);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [reconnecting, connection.state]);
  if (phase === 'off') return null;
  const left = connection.until > 0 ? reconnectSecondsLeft(connection.until, performance.now()) : 0;
  return (
    <Screen name="connection" kind="game" kit="v2" states={[phase === 'back' ? 'back' : 'reconnecting']} label="Reconnecting">
      {phase === 'back' ? (
        <span className="stamp stamp--ok stamp--lg mf-back-chip m-p7" role="status">
          <Icon name="check" />
          Back
        </span>
      ) : (
        <div className={phase === 'leaving' ? 'reconnect plate m-p9 is-leaving' : 'reconnect plate m-p9'} role="status">
          <span className="spinner"></span>
          <span>
            <b>Connection dropped.</b> Reconnecting · try <RollNum value={Math.max(1, connection.attempt)} />
            {left > 0 ? ` · ${left} s left` : ''}
          </span>
          <span className="reconnect__sub">The match keeps running</span>
        </div>
      )}
    </Screen>
  );
}

export function Alert({ alert, onRejoin }: { alert: AlertInfo; onRejoin: (() => void) | null }) {
  const ctl = useCtl();
  const look = ALERT_LOOK[alert.kind];
  return (
    <ConnFrame states={[alert.kind]} label={alert.title}>
      <div className="conn ticket m-p1" role="alertdialog" aria-labelledby="conn-alert">
        <span className="tape" style={{ left: '46%', top: -12 }} aria-hidden="true"></span>
        <span className={`stamp ${TONE[look.tone]} stamp--lg conn__stamp m-p7`}>{STAMP[alert.kind]}</span>
        <Icon name={look.icon} className="conn__ghost" />
        <h1 id="conn-alert" className="display conn__title">
          {alert.title}
        </h1>
        <p className="conn__body">{alert.message}</p>
        <p className="conn__body mf-conn__code num">Code {alert.code}</p>
        <div className="conn__actions">
          {alert.action === 'reload' ? (
            <button className="btn btn--volt btn--xl m-p8" type="button" onClick={() => location.reload()}>
              <Icon name="refresh" />
              Reload now
            </button>
          ) : alert.action === 'rejoin' && onRejoin ? (
            <button className="btn btn--volt btn--xl m-p8" type="button" onClick={blurAfter(onRejoin)}>
              <Icon name="refresh" />
              Try again
            </button>
          ) : alert.kind === 'room-not-found' ? (
            <button className="btn btn--volt btn--xl m-p8" type="button" onClick={blurAfter(() => ctl.openOverlay('join'))}>
              <Icon name="keyboard" />
              Type a code
            </button>
          ) : null}
          <button className="btn btn--ghost btn--xl m-p8" type="button" onClick={blurAfter(() => ctl.go({ to: 'home' }))}>
            <Icon name="back" />
            Home
          </button>
        </div>
      </div>
    </ConnFrame>
  );
}
