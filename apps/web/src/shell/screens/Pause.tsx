/**
 * 12 · Pause / Esc menu (round two's data-screen="pause"): the match keeps running behind it. Resume,
 * Invite friends (a room), Tune the game (the room's host, where the page offers it: pnpm playtest
 * --tune), Settings, the controls card, and Leave (asked once more: "Leave this match?"). The game
 * behind dims over --m-fast, the menu focus-pulls in (P1) and its items rise in turn (P3).
 */
import { MatchPhase } from '@military-forge/sim';
import { useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { Icon } from '../../ui/Icon';
import { Cap } from '../../ui/Kbd';
import { Screen, blurAfter } from '../../ui/Screen';
import { useCtl } from '../context';
import { formatClock, type MatchView } from '../matchView';
import type { ShellStore } from '../store';
import { ROOM_SLOTS } from './Lobby';

/** What leaving costs, in the confirm dialog's words. */
export function leaveCost(match: MatchView | null, inRoom: boolean): string {
  const back = inRoom ? ' You can come back with the room link while the room is open.' : '';
  if (match?.phase === MatchPhase.InProgress) return `Your score (${match.myScore}) won't count.${back}`;
  return inRoom ? 'You can come back with the room link while the room is open.' : 'Nothing from training is kept.';
}

export function Pause({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const screen = useStore(store, (s) => s.screen);
  const match = useStore(store, (s) => s.match);
  const lobby = useStore(store, (s) => s.lobby);
  const [confirm, setConfirm] = useState(false);
  const room = screen.name === 'room' ? screen.code : null;
  const playing = match?.phase === MatchPhase.InProgress;
  const what = room ? (playing ? 'match' : 'room') : 'training';
  const open = lobby ? Math.max(0, ROOM_SLOTS - lobby.players.length) : 0;
  // the host's live tuning (pnpm playtest --tune): the room's host, or anyone in training
  const tune = ctl.canTune();

  const row = (i: number) => ({ '--i': i }) as CSSProperties;
  const leaveLabel = room ? (playing ? 'Leave match' : 'Leave room') : 'Quit training';
  return (
    <Screen name="pause" kind="game" kit="v2" states={[tune ? 'host' : 'guest', confirm ? 'confirm-leave' : 'menu']} label="Menu" modal>
      <div className="pause__dim mf-pause__dim" aria-hidden="true"></div>
      <nav className="pause plate m-p1" aria-label="Menu">
        <span className="eyebrow">{room ? 'Comms · the match keeps running' : 'Training keeps running'}</span>
        <b className="display pause__title">Paused</b>
        {playing && match && (
          <p className="mf-pause__score">
            <span className="hud-label">{match.untimed ? 'Played' : 'Left'}</span> <b className="num" data-bind="match.timeLeft">{formatClock(match.untimed ? match.secondsElapsed : match.secondsLeft)}</b> · <span className="hud-label">You</span>{' '}
            <b className="num" data-bind="match.myScore">
              {match.myScore}
            </b>{' '}
            · <span className="hud-label">Lead{match.leaderName ? ` · ${match.leaderName}` : ''}</span>{' '}
            <b className="num" data-bind="match.leaderScore">
              {match.leaderScore}
            </b>
          </p>
        )}
        <button className="btn btn--paper btn--xl btn--block pause__btn m-p3 m-p8" style={row(0)} type="button" autoFocus onClick={blurAfter(() => ctl.closeOverlay())}>
          <Icon name="play" />
          Resume
        </button>
        {room && (
          <button className="btn btn--volt btn--xl btn--block pause__btn m-p3 m-p8" style={row(1)} type="button" onClick={blurAfter(() => void ctl.shareLink(room))}>
            <Icon name="users-plus" />
            <span className="btn__stack">
              Invite friends
              <span className="btn__sub">
                {open} {open === 1 ? 'slot' : 'slots'} left · {playing ? 'they join the next match' : 'share the link'}
              </span>
            </span>
          </button>
        )}
        {tune && (
          <button className="btn btn--ink btn--xl btn--block pause__btn m-p3 m-p8" style={row(2)} type="button" onClick={blurAfter(() => ctl.openTuning())}>
            <Icon name="sliders" />
            <span className="btn__stack">
              Tune the game
              <span className="btn__sub">{room ? 'Host · changes it for everyone' : 'Changes this training match'}</span>
            </span>
            {room && (
              <span className="tag tag--host pause__tag">
                <Icon name="crown" />
                Host
              </span>
            )}
          </button>
        )}
        <button className="btn btn--ink btn--xl btn--block pause__btn m-p3 m-p8" style={row(3)} type="button" onClick={blurAfter(() => ctl.openSettings())}>
          <Icon name="gear" />
          Settings
        </button>
        <button className="btn btn--ink btn--xl btn--block pause__btn m-p3 m-p8" style={row(4)} type="button" onClick={blurAfter(() => ctl.showTips())}>
          <Icon name="keyboard" />
          <span className="btn__stack">
            Controls
            <span className="btn__sub">Your keys and tips</span>
          </span>
        </button>
        <button className="btn btn--ghost btn--xl btn--block pause__btn m-p3 m-p8" style={row(5)} type="button" onClick={blurAfter(() => setConfirm(true))}>
          <Icon name="door-out" />
          {leaveLabel}
        </button>
        <p className="pause__foot">
          <Cap>Esc</Cap> back to the fight
        </p>
      </nav>
      {confirm && (
        <div className="pause__confirm ticket m-p1" role="alertdialog" aria-labelledby="leave-t" aria-describedby="leave-desc">
          <h2 id="leave-t" className="display">
            {what === 'training' ? 'Quit training?' : `Leave the ${what}?`}
          </h2>
          <p id="leave-desc">{leaveCost(match, !!room)}</p>
          <div className="conn__actions">
            <button className="btn btn--danger btn--xl m-p8" type="button" onClick={blurAfter(() => ctl.leave())}>
              <Icon name="door-out" />
              {what === 'training' ? 'Quit training' : what === 'match' ? 'Leave match' : 'Leave room'}
            </button>
            <button className="btn btn--paper btn--xl m-p8" type="button" autoFocus onClick={blurAfter(() => setConfirm(false))}>
              Stay
            </button>
          </div>
        </div>
      )}
    </Screen>
  );
}
