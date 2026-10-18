/**
 * 5 · Connection (the kit's data-screen="connection"): getting into a room step by step, the
 * reconnecting banner over the live game, and the alerts when a room can't be reached or ends.
 */
import { Icon } from '../../ui/Icon';
import { Screen, blurAfter } from '../../ui/Screen';
import { ALERT_LOOK } from '../alerts';
import { useCtl, useTicker } from '../context';
import type { AlertInfo, ConnectionView } from '../store';

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

export function Connecting({ code, step, creating = false, onCancel }: { code: string | null; step: ConnectStep; creating?: boolean; onCancel: () => void }) {
  return (
    <Screen name="connection" kind="menu" states={['connecting']} label="Connecting">
      <div className="conn" role="status">
        <div className="conn__radar" aria-hidden="true">
          <span className="spinner conn__spinner"></span>
        </div>
        <h1 className="display h2">{creating && !code ? 'Making your room…' : 'Connecting…'}</h1>
        <p className="lead">
          {code ? (
            <>
              Joining room{' '}
              <b className="num" data-bind="room.code">
                {code}
              </b>
            </>
          ) : creating ? (
            'A room of your own, with a link to send your friends'
          ) : (
            'Looking for the room'
          )}
        </p>
        <ol className="conn__steps">
          {STEPS.map(([now, done], i) =>
            i < step ? (
              <li key={i} className="is-done">
                <Icon name="check-circle" />
                {done}
              </li>
            ) : i === step ? (
              <li key={i} className="is-now">
                <span className="spinner"></span>
                {now}
              </li>
            ) : (
              <li key={i}>
                <Icon name="circle" />
                {now}
              </li>
            ),
          )}
        </ol>
        <button className="btn btn--ghost btn--xl" onClick={blurAfter(onCancel)}>
          Cancel
        </button>
      </div>
    </Screen>
  );
}

/** Whole seconds until the reconnect tries stop. */
export function reconnectSecondsLeft(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

/** Over the live game, under the clock: the match keeps going while we try. */
export function ReconnectBanner({ connection }: { connection: ConnectionView }) {
  useTicker(1000);
  const left = connection.until > 0 ? reconnectSecondsLeft(connection.until, performance.now()) : 0;
  return (
    <Screen name="connection" kind="game" states={['reconnecting']} label="Reconnecting">
      <div className="hud conn__hud">
        <div className="net-banner" role="status">
          <span className="spinner"></span>
          <div>
            <p className="net-banner__title">Reconnecting…</p>
            <p className="net-banner__sub">
              Attempt <span data-bind="net.attempt">{Math.max(1, connection.attempt)}</span>
              {left > 0 ? `, still trying for ${left} s` : ''}. The match keeps going.
            </p>
          </div>
        </div>
      </div>
    </Screen>
  );
}

export function Alert({ alert, onRejoin }: { alert: AlertInfo; onRejoin: (() => void) | null }) {
  const ctl = useCtl();
  const look = ALERT_LOOK[alert.kind];
  return (
    <Screen name="connection" kind="menu" states={[alert.kind]} label={alert.title}>
      <div className="alert" role="alert">
        <span className={`alert__icon alert__icon--${look.tone}`}>
          <Icon name={look.icon} size="xl" />
        </span>
        <h1 className="display h2">{alert.title}</h1>
        <p className="lead">{alert.message}</p>
        <p className="alert__code">Code {alert.code}</p>
        <div className="alert__actions">
          {alert.action === 'reload' ? (
            <button className="btn btn--primary btn--xl" onClick={() => location.reload()}>
              <Icon name="refresh" />
              Reload
            </button>
          ) : alert.action === 'rejoin' && onRejoin ? (
            <button className="btn btn--primary btn--xl" onClick={blurAfter(onRejoin)}>
              <Icon name="refresh" />
              Rejoin
            </button>
          ) : null}
          <button className="btn btn--secondary btn--xl" onClick={blurAfter(() => ctl.go({ to: 'home' }))}>
            <Icon name="home" />
            Home
          </button>
        </div>
      </div>
    </Screen>
  );
}
