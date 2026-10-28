/**
 * 12 · Pause / Esc menu (round two's data-screen="pause"). Training really pauses behind it
 * (LocalMode.paused); an online match can't, and the menu says so ("Match continues"). Resume,
 * Invite friends (a room), Tune the game (the room's host, where the page offers it: pnpm playtest
 * --tune), Settings, the controls card, and Leave (asked once more: "Leave this match?"). Resume stays
 * at the top and Leave at the foot, always in view; the items between scroll when the plate can't
 * hold them, and the list's lower edge fades while there's more below. The game behind dims over
 * --m-fast, the menu focus-pulls in (P1) and its items rise in turn (P3).
 */
import { MatchPhase } from '@military-forge/sim';
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { useStore } from 'zustand';
import { Icon } from '../../ui/Icon';
import { ButtonFadeQuick } from './ButtonFade';
import { Cap } from '../../ui/Kbd';
import { Screen, blurAfter } from '../../ui/Screen';
import { useCtl } from '../context';
import { formatClock, type MatchView } from '../matchView';
import type { ShellStore } from '../store';
import { ROOM_SLOTS } from './Lobby';
import { inviteFriends } from '../../social/SocialLayer';
import { CommsButton } from '../../voice/Radio';
import { SendReport } from '../../diag/SendReport';

/** What leaving costs, in the confirm dialog's words. */
export function leaveCost(match: MatchView | null, inRoom: boolean): string {
  const back = inRoom ? ' You can come back with the room link while the room is open.' : '';
  if (match?.phase === MatchPhase.InProgress) return `Your score (${match.myScore}) won't count.${back}`;
  return inRoom ? 'You can come back with the room link while the room is open.' : 'Nothing from training is kept.';
}

/**
 * What the menu's head says. Training holds still behind it: "Paused". An online match plays on (the
 * others are still fighting), so it never claims to pause: "Match continues". A room between matches:
 * its menu.
 */
export function pauseHeading(inRoom: boolean, phase: MatchPhase | null | undefined): { eyebrow: string; title: string } {
  if (!inRoom) return { eyebrow: 'Training on hold', title: 'Paused' };
  if (phase === MatchPhase.Countdown || phase === MatchPhase.InProgress) return { eyebrow: "Online play can't pause", title: 'Match continues' };
  return { eyebrow: 'Room', title: 'Menu' };
}

/**
 * A list that scrolls when it can't fit: `has-more` while there's more below its lower edge (the edge
 * fades: menus.css), so a player sees the menu goes on.
 */
export function useMoreBelow(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const check = () => el.classList.toggle('has-more', el.scrollHeight - el.scrollTop - el.clientHeight > 2);
    check();
    el.addEventListener('scroll', check, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(check);
    ro?.observe(el);
    for (const child of el.children) ro?.observe(child);
    // a panel opening inside it (Send a report) changes its height without a resize of the list
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(check);
    mo?.observe(el, { childList: true, subtree: true });
    return () => {
      el.removeEventListener('scroll', check);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [ref]);
}

export function Pause({ store }: { store: ShellStore }) {
  const ctl = useCtl();
  const screen = useStore(store, (s) => s.screen);
  const match = useStore(store, (s) => s.match);
  const lobby = useStore(store, (s) => s.lobby);
  const [confirm, setConfirm] = useState(false);
  const room = screen.name === 'room' ? screen.code : null;
  // First flight runs (the onboarding tour): Restart it, or Skip training
  const tour = screen.name === 'training' && !!screen.tour;
  const playing = match?.phase === MatchPhase.InProgress;
  const what = room ? (playing ? 'match' : 'room') : 'training';
  const open = lobby ? Math.max(0, ROOM_SLOTS - lobby.players.length) : 0;
  // the host's live tuning (pnpm playtest --tune): the room's host, or anyone in training
  const tune = ctl.canTune();

  const list = useRef<HTMLDivElement>(null);
  useMoreBelow(list);
  const heading = pauseHeading(!!room, match?.phase);

  const row = (i: number) => ({ '--i': i }) as CSSProperties;
  const leaveLabel = room ? (playing ? 'Leave match' : 'Leave room') : 'Quit training';
  return (
    <Screen name="pause" kind="game" states={[tune ? 'host' : 'guest', confirm ? 'confirm-leave' : 'menu', room ? 'online' : 'paused']} label="Menu" modal dialog>
      <div className="pause__dim mf-pause__dim" aria-hidden="true"></div>
      <nav className="pause plate m-p1" aria-label="Menu">
        <span className="eyebrow">{heading.eyebrow}</span>
        <b className={heading.title.length > 8 ? 'display pause__title pause__title--long' : 'display pause__title'}>{heading.title}</b>
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
        {/* the items between Resume and Leave: they scroll when the plate can't hold them all */}
        <div ref={list} className="pause__list">
          {tour && (
            <div className="pause__tour m-p3" style={row(1)}>
              <button className="btn btn--ink btn--block pause__btn m-p8" type="button" onClick={blurAfter(() => ctl.restartTour())}>
                <Icon name="rotate" />
                Restart First flight
              </button>
              <button className="btn btn--ghost btn--block pause__btn m-p8" type="button" onClick={blurAfter(() => ctl.skipTour())}>
                Skip training
              </button>
            </div>
          )}
          {room && (
            <button className="btn btn--volt btn--xl btn--block pause__btn m-p3 m-p8" style={row(1)} type="button" onClick={blurAfter(() => inviteFriends(ctl, () => void ctl.shareLink(room)))}>
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
          {/* voice (voice/Radio.tsx): the comms sheet, for the mouse, the keyboard and a controller */}
          {room && <CommsButton className="btn btn--ink btn--xl btn--block pause__btn m-p3 m-p8" />}
          <button className="btn btn--ink btn--xl btn--block pause__btn m-p3 m-p8" style={row(3)} type="button" onClick={blurAfter(() => ctl.openSettings())}>
            <Icon name="gear" />
            Settings
          </button>
          {/* a touch screen (a tablet): the buttons' fade, right here (the owner, 23 Oct) */}
          <ButtonFadeQuick className="m-p3" />
          <SendReport context={room !== null ? 'pause: in a room' : 'pause: training'} className="m-p3" />
          <button className="btn btn--ink btn--xl btn--block pause__btn m-p3 m-p8" style={row(4)} type="button" onClick={blurAfter(() => ctl.showTips())}>
            <Icon name="keyboard" />
            <span className="btn__stack">
              Controls
              <span className="btn__sub">Your keys and tips</span>
            </span>
          </button>
        </div>
        <div className="pause__end">
          <button className="btn btn--ghost btn--xl btn--block pause__btn m-p3 m-p8" style={row(5)} type="button" onClick={blurAfter(() => setConfirm(true))}>
            <Icon name="door-out" />
            {leaveLabel}
          </button>
          <p className="pause__foot">
            <Cap>Esc</Cap> back to the fight
          </p>
        </div>
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
