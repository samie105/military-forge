/**
 * M4 · Phone pause (the kit's data-screen="m-pause"). Training really pauses behind it; an online match
 * can't, and the plate says so ("Match continues"). Two plates, each as tall as what's on it: on the
 * left the head, the sitrep (the clock, your score, the lead), Resume and, at the foot, Leave; on the
 * right every other item in two columns, in the desktop Pause's order, scrolling only when a report is
 * being written. Leaving asks once more in a bottom sheet. Same actions as the desktop Pause.
 *
 * Motion: the game dims over --m-fast; the left plate comes in from its edge (P9), the title
 * focus-pulls (P1), the buttons rise in a stagger (P3) and press P8; the items arrive from the right.
 */
import { MatchPhase } from '@military-forge/sim';
import { useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Icon } from '../../../ui/Icon';
import { ButtonFadeQuick } from '../ButtonFade';
import { blurAfter } from '../../../ui/Screen';
import { useCtl } from '../../context';
import { formatClock, leadLine } from '../../matchView';
import type { ShellStore } from '../../store';
import { leaveCost, pauseHeading, useMoreBelow } from '../Pause';
import { PhoneScreen, rise } from './layout';
import { inviteFriends } from '../../../social/SocialLayer';
import { Roll, ShareChip, Sheet, shareRoom, useShareChip } from './parts';
import { InstallButton } from '../../../pwa/InstallButton';
import { SendReport } from '../../../diag/SendReport';
import { PlayersButton } from '../../../social/ReportSheet';

export function PhonePause({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const screen = useStore(store, (s) => s.screen);
  const match = useStore(store, (s) => s.match);
  const lobby = useStore(store, (s) => s.lobby);
  // the browser's Back in a lobby or the results opens the menu on its leave question (audit N-07)
  const [confirm, setConfirm] = useState(() => store.getState().menuAsk === true);
  const [chip, showChip] = useShareChip();
  const room = screen.name === 'room' ? screen.code : null;
  const playing = match?.phase === MatchPhase.InProgress;
  const what = room ? (playing ? 'match' : 'room') : 'training';
  const tune = ctl.canTune();
  const host = lobby?.isHost ?? !room;
  const leaveWord = what === 'training' ? 'Quit training' : what === 'match' ? 'Leave match' : 'Leave room';
  const heading = pauseHeading(!!room, match?.phase);
  const list = useRef<HTMLDivElement>(null);
  useMoreBelow(list);
  const lead = match ? leadLine(match) : null;
  const item = 'btn btn--ink btn--sm btn--block m-p3 m-p8';

  return (
    <PhoneScreen name="m-pause" kind="game" modal dialog label="Menu" states={[host ? 'host' : 'guest', confirm ? 'confirm-leave' : 'menu', room ? 'online' : 'paused']}>
      <div className="pause__dim pm-dim" aria-hidden="true"></div>
      <nav className="pm-pause plate m-p9 m-p9--left" aria-label="Menu">
        <span className="eyebrow">{heading.eyebrow}</span>
        <b className={heading.title.length > 8 ? 'display pm-pause__t pm-pause__t--long m-p1' : 'display pm-pause__t m-p1'}>{heading.title}</b>
        {/* First flight has no match to report on */}
        {(match || lobby) && (
          <div className="pm-score" role="group" aria-label="Match status">
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
            </div>
            {lead && lead.kind !== 'none' && (
              <p className="pm-score__lead">
                <span className="hud-label">{lead.label}</span> <b className="num">{lead.score}</b>
              </p>
            )}
          </div>
        )}
        <button type="button" className="btn btn--paper btn--sm btn--block m-p3 m-p8" style={rise(0)} autoFocus onClick={blurAfter(() => ctl.closeOverlay())}>
          <Icon name="play" />
          Resume
        </button>
        <button type="button" className="btn btn--ghost btn--sm btn--block pm-pause__leave m-p3 m-p8" style={rise(1)} onClick={blurAfter(() => setConfirm(true))}>
          <Icon name="door-out" />
          {leaveWord}
        </button>
        <ShareChip outcome={chip} />
      </nav>

      <div ref={list} className="pm-pause__list plate m-p9 m-p9--right" role="group" aria-label="Menu items">
        {/* First flight runs (the onboarding tour): Restart it, or Skip training (as the desktop's Pause) */}
        {screen.name === 'training' && !!screen.tour && (
          <>
            <button type="button" className={item} style={rise(1)} onClick={blurAfter(() => ctl.restartTour())}>
              <Icon name="rotate" />
              Restart First flight
            </button>
            <button type="button" className={item} style={rise(1)} onClick={blurAfter(() => ctl.skipTour())}>
              <Icon name="arrow-right" />
              Skip training
            </button>
          </>
        )}
        <button type="button" className={item} style={rise(1)} onClick={blurAfter(() => ctl.openSettings())}>
          <Icon name="gear" />
          Settings
        </button>
        <button type="button" className={item} style={rise(2)} onClick={blurAfter(() => ctl.showTips())}>
          <Icon name="keyboard" />
          Controls
        </button>
        {/* the room's people: report, block, mute, the host's remove (audit-2 L-01, L-02, L-11) */}
        {room && <PlayersButton className={item} compact />}
        {room && (
          <button
            type="button"
            className={item}
            style={rise(3)}
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
          <button type="button" className={item} style={rise(3)} onClick={blurAfter(() => ctl.openTuning())}>
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
        {/* training (not a room: it would leave the match): First flight again (audit N-20) */}
        {screen.name === 'training' && !screen.tour && (
          <button type="button" className={item} style={rise(4)} onClick={blurAfter(() => ctl.startFlight())}>
            <Icon name="target" />
            First flight
          </button>
        )}
        <InstallButton className="btn--block" />
        {/* something went wrong: what happened on this phone, to us (diag/) */}
        <SendReport context={room !== null ? 'pause: in a room' : 'pause: training'} buttonClass={item} className="pm-report" />
        {/* the buttons' fade, right here (the owner, 23 Oct: "a way to fade the buttons") */}
        <ButtonFadeQuick className="pm-fadequick m-p3" />
      </div>

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
