/**
 * 12 · Pause / Esc menu (the kit's data-screen="pause"): the match keeps running behind it. Resume,
 * Settings, the controls card, Tune the game (the room's host, where the page offers it: pnpm
 * playtest --tune), and Leave (asked once more: "Leave this match?"); the side panel shows the match
 * and, in a room, how to bring a friend in.
 */
import { MatchPhase } from '@military-forge/sim';
import { useState } from 'react';
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

  return (
    <Screen name="pause" kind="game" states={[confirm ? 'confirm-leave' : 'menu']} label="Menu" modal>
      <div className="pause">
        <div className="pause__menu">
          <p className="eyebrow">
            <span className="live-dot"></span>
            {room ? 'Match still running' : 'Training still running'}
          </p>
          <h1 className="display h1">Menu</h1>
          <nav className="pause__list" aria-label="Menu">
            <button className="pause__item pause__item--primary" autoFocus onClick={blurAfter(() => ctl.closeOverlay())}>
              <Icon name="play" size="lg" />
              <span>Resume</span>
              <Cap lg>Esc</Cap>
            </button>
            <button className="pause__item" onClick={blurAfter(() => ctl.openSettings())}>
              <Icon name="gear" size="lg" />
              <span>Settings</span>
            </button>
            <button className="pause__item" onClick={blurAfter(() => ctl.showTips())}>
              <Icon name="keyboard" size="lg" />
              <span>Controls and tips</span>
            </button>
            {tune && (
              <button className="pause__item" onClick={blurAfter(() => ctl.openTuning())}>
                <Icon name="gravity" size="lg" />
                <span>Tune the game</span>
              </button>
            )}
            <button className="pause__item pause__item--danger" onClick={blurAfter(() => setConfirm(true))}>
              <Icon name="door-out" size="lg" />
              <span>{room ? (playing ? 'Leave match' : 'Leave room') : 'Quit training'}</span>
            </button>
          </nav>
        </div>

        <aside className="pause__side panel ticks" aria-label="Match status">
          <p className="eyebrow">Deathmatch · {match?.mapName ?? lobby?.mapName ?? ''}</p>
          <div className="pause__stats">
            <div>
              <span className="hud-label">{match?.untimed ? 'Time played' : 'Time left'}</span>
              <b className="num" data-bind="match.timeLeft">
                {playing && match ? formatClock(match.untimed ? match.secondsElapsed : match.secondsLeft) : '–'}
              </b>
            </div>
            <div>
              <span className="hud-label">You</span>
              <b className="num" data-bind="match.myScore">
                {match?.myScore ?? 0}
              </b>
            </div>
            <div>
              <span className="hud-label">
                Leader{match?.leaderName ? ` · ${match.leaderName}` : ''}
              </span>
              <b className="num" data-bind="match.leaderScore">
                {match?.leaderScore ?? 0}
              </b>
            </div>
          </div>
          {room && (
            <>
              <hr className="rule" />
              <p className="h3">Bring a friend in</p>
              <p className="muted">
                {playing ? 'They join the next match. ' : 'They join this room. '}Room{' '}
                <b className="num" data-bind="room.code">
                  {room}
                </b>
                , {open} open {open === 1 ? 'slot' : 'slots'}.
              </p>
              <div className="pause__share">
                <button className="btn btn--primary" onClick={blurAfter(() => void ctl.copyLink(room))}>
                  <Icon name="link" />
                  Copy link
                </button>
                <button className="btn btn--whatsapp" onClick={blurAfter(() => ctl.shareOnWhatsApp(room))}>
                  <Icon name="chat-send" />
                  WhatsApp
                </button>
              </div>
            </>
          )}
        </aside>

        {confirm && (
          <>
            <div className="modal-scrim" onClick={() => setConfirm(false)}></div>
            <div className="modal panel" role="alertdialog" aria-labelledby="leave-title" aria-describedby="leave-desc">
              <span className="alert__icon alert__icon--bad">
                <Icon name="door-out" size="xl" />
              </span>
              <h2 id="leave-title" className="display h2">
                {what === 'training' ? 'Quit training?' : `Leave this ${what}?`}
              </h2>
              <p id="leave-desc" className="lead">
                {leaveCost(match, !!room)}
              </p>
              <div className="alert__actions">
                <button className="btn btn--danger btn--xl" onClick={blurAfter(() => ctl.leave())}>
                  <Icon name="door-out" />
                  {what === 'training' ? 'Quit training' : what === 'match' ? 'Leave match' : 'Leave room'}
                </button>
                <button className="btn btn--primary btn--xl" autoFocus onClick={blurAfter(() => setConfirm(false))}>
                  Stay
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Screen>
  );
}
