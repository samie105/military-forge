/**
 * M4 · Phone pause (the kit's data-screen="m-pause"): the match keeps running, dimmed behind. The menu
 * plate on the left (Resume, Invite friends in a room, Tune the game for the host where the page offers
 * it, Settings, Leave) and the sitrep on the right (the clock, your score, the leader's). Leaving asks
 * once more in a bottom sheet. Same actions as the desktop Pause.
 *
 * Motion: the game dims over --m-fast; the plate comes in from the left edge (P9), "Paused" focus-pulls
 * (P1), its buttons rise in a stagger (P3) and press P8; the sitrep arrives from the right.
 */
import { MatchPhase } from '@military-forge/sim';
import { useState } from 'react';
import { useStore } from 'zustand';
import { Icon } from '../../../ui/Icon';
import { ButtonFadeQuick } from '../ButtonFade';
import { blurAfter } from '../../../ui/Screen';
import { useCtl } from '../../context';
import { formatClock } from '../../matchView';
import type { ShellStore } from '../../store';
import { leaveCost } from '../Pause';
import { PhoneScreen, rise } from './layout';
import { inviteFriends } from '../../../social/SocialLayer';
import { Roll, ShareChip, Sheet, shareRoom, useShareChip } from './parts';
import { InstallButton } from '../../../pwa/InstallButton';
import { SendReport } from '../../../diag/SendReport';

export function PhonePause({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const screen = useStore(store, (s) => s.screen);
  const match = useStore(store, (s) => s.match);
  const lobby = useStore(store, (s) => s.lobby);
  const [confirm, setConfirm] = useState(false);
  const [chip, showChip] = useShareChip();
  const room = screen.name === 'room' ? screen.code : null;
  const playing = match?.phase === MatchPhase.InProgress;
  const what = room ? (playing ? 'match' : 'room') : 'training';
  const tune = ctl.canTune();
  const host = lobby?.isHost ?? !room;
  const leaveWord = what === 'training' ? 'Quit training' : what === 'match' ? 'Leave match' : 'Leave room';

  return (
    <PhoneScreen name="m-pause" kind="game" modal dialog label="Menu" states={[host ? 'host' : 'guest', confirm ? 'confirm-leave' : 'menu']}>
      <div className="pause__dim pm-dim" aria-hidden="true"></div>
      <nav className="pm-pause plate m-p9 m-p9--left" aria-label="Menu">
        <span className="eyebrow">{room ? 'Match still running' : 'Training still running'}</span>
        <b className="display pm-pause__t m-p1">Paused</b>
        <button type="button" className="btn btn--paper btn--sm btn--block m-p3 m-p8" style={rise(0)} autoFocus onClick={blurAfter(() => ctl.closeOverlay())}>
          <Icon name="play" />
          Resume
        </button>
        {/* First flight runs (the onboarding tour): Restart it, or Skip training (as the desktop's Pause) */}
        {screen.name === 'training' && !!screen.tour && (
          <div className="pm-pause__tour m-p3" style={rise(1)}>
            <button type="button" className="btn btn--ink btn--sm m-p8" onClick={blurAfter(() => ctl.restartTour())}>
              <Icon name="rotate" />
              Restart First flight
            </button>
            <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={blurAfter(() => ctl.skipTour())}>
              Skip training
            </button>
          </div>
        )}
        {room && (
          <button
            type="button"
            className="btn btn--volt btn--sm btn--block m-p3 m-p8"
            style={rise(1)}
            onClick={blurAfter(() => {
              // friends: the invite picker (it has the link too); otherwise the share sheet
              inviteFriends(ctl, () => void shareRoom(room).then(showChip));
            })}
          >
            <Icon name="users-plus" />
            Invite friends
          </button>
        )}
        {tune && (
          <button type="button" className="btn btn--ink btn--sm btn--block m-p3 m-p8" style={rise(2)} onClick={blurAfter(() => ctl.openTuning())}>
            <Icon name="sliders" />
            Tune the game
            {room && (
              <span className="tag tag--host pm-pause__tag">
                <Icon name="crown" />
                Host
              </span>
            )}
          </button>
        )}
        <div className="pm-pause__row m-p3" style={rise(3)}>
          <button type="button" className="btn btn--ink btn--sm m-p8" onClick={blurAfter(() => ctl.openSettings())}>
            <Icon name="gear" />
            Settings
          </button>
          <InstallButton />
          <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={blurAfter(() => setConfirm(true))}>
            <Icon name="door-out" />
            Leave
          </button>
        </div>
        {/* the buttons' fade, right here (the owner, 23 Oct: "a way to fade the buttons") */}
        <ButtonFadeQuick className="pm-fadequick m-p3" />
        {/* something went wrong: what happened on this phone, to us (diag/) */}
        <SendReport context={room !== null ? 'pause: in a room' : 'pause: training'} className="pm-report m-p3" />
        <ShareChip outcome={chip} />
      </nav>

      <aside className="pm-score plate m-p9 m-p9--right" aria-label="Match status">
        <span className="serial">Sitrep · {match?.mapName ?? lobby?.mapName ?? ''}</span>
        <div className="pm-score__row">
          <span>
            <span className="hud-label">{match?.untimed ? 'Played' : 'Clock'}</span>
            <b className="num display" data-bind="match.timeLeft">
              {playing && match ? formatClock(match.untimed ? match.secondsElapsed : match.secondsLeft) : '–'}
            </b>
          </span>
          <span>
            <span className="hud-label">You</span>
            <b className="display" data-bind="match.myScore">
              <Roll value={match?.myScore ?? 0} />
            </b>
          </span>
          <span>
            <span className="hud-label">Lead{match?.leaderName ? ` · ${match.leaderName}` : ''}</span>
            <b className="display" data-bind="match.leaderScore">
              <Roll value={match?.leaderScore ?? 0} />
            </b>
          </span>
        </div>
      </aside>

      <Sheet open={confirm} onClose={() => setConfirm(false)} label={what === 'training' ? 'Quit training?' : `Leave this ${what}?`}>
        <div className="pm-sheet__head">
          <span className="pm-sheet__icon" aria-hidden="true">
            <Icon name="door-out" />
          </span>
          <b className="display">{what === 'training' ? 'Quit training?' : `Leave this ${what}?`}</b>
        </div>
        <p className="pm-sheet__note">{leaveCost(match, !!room)}</p>
        <div className="pm-bar">
          <button type="button" className="btn btn--danger btn--sm m-p8" onClick={blurAfter(() => ctl.leave())}>
            <Icon name="door-out" />
            {leaveWord}
          </button>
          <button type="button" className="btn btn--paper btn--sm m-p8" autoFocus onClick={blurAfter(() => setConfirm(false))}>
            Stay
          </button>
        </div>
      </Sheet>
    </PhoneScreen>
  );
}
