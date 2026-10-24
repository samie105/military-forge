/**
 * Invites on screen (board "SOCIAL", S3/S4/P3):
 * - InviteToast: a friend's invite, in the menus (top centre) and mid-match (top left, under the
 *   net plate; on phones top centre under the clock), with Join, Decline and Watch (the room as a
 *   spectator, v20: no slot, and it doesn't answer the invite), a 2-minute brass bar, and Later (×).
 *   It never takes the keyboard: the game keeps its keys.
 * - InviteButton: the Invite action on a friend's row, with what became of it (Sent · 1:52,
 *   Declined, Joining).
 * - InvitePicker: "Invite to KMTXRA" from the lobby and the pause menu: friends to invite, and for
 *   people who aren't friends yet, Copy invite link, the phone's share sheet and WhatsApp.
 */
import { MatchPhase } from '@military-forge/sim';
import { useEffect, useState, type CSSProperties } from 'react';
import { usePhoneLayout } from '../shell/screens/phone/layout';
import { Icon } from '../ui/Icon';
import type { Friend } from './api';
import { Avatar } from './FriendsPanel';
import { INVITE_SECONDS, clockText, secondsLeft, statusText, useSel, type ClientInvite, type SocialController } from './social';

/** Re-renders every `ms` while `on` (countdowns). */
function useTick(on: boolean, ms = 1000): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [on, ms]);
}

export function InviteToast({ social }: { social: SocialController }) {
  const invites = useSel(social.store, (s) => s.invites);
  const hidden = useSel(social.store, (s) => s.hidden);
  const screen = useSel(social.shell.store, (s) => s.screen.name);
  const overlay = useSel(social.shell.store, (s) => s.overlay);
  // in play (the countdown, the match): top left, clear of the HUD's middle; otherwise top centre
  const phase = useSel(social.shell.store, (s) => s.match?.phase ?? null);
  const panelOpen = useSel(social.store, (s) => s.panel.open);
  const pickerOpen = useSel(social.store, (s) => s.picker);
  const phone = usePhoneLayout();
  const shown = invites.filter((i) => !hidden[i.id] && secondsLeft(i) > 0);
  const inv = shown[0];
  useTick(!!inv);
  // the panel shows invites itself, and the picker is busy with yours
  if (!inv || panelOpen || pickerOpen) return null;
  const left = secondsLeft(inv);
  const inPlay = (screen === 'room' || screen === 'training') && (phase === MatchPhase.Countdown || phase === MatchPhase.InProgress);
  // top left only over the bare game (a menu over it keeps its own left side)
  const playing = inPlay && overlay === null;
  const inMatch = screen === 'room' && inPlay;
  return (
    <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}kit-v2 mf-social-toast`}>
      <section className={`screen screen--game sx-tscreen${phone ? ' screen--phone sx-tscreen--phone' : ''}`} data-screen="invite-toast" aria-label="Invite">
        <div className={`sx-toast m-p9${playing ? ' sx-toast--play' : ''}`} role="alertdialog" aria-labelledby={`sx-inv-${inv.id}`} key={inv.id}>
          <span className="sx-toast__edge" aria-hidden="true"></span>
          <div className="sx-toast__top">
            <Avatar name={inv.from.nickname} ring />
            <span className="sx-toast__text">
              <span className="label label--volt sx-toast__label">Invite · {inv.from.nickname}</span>
              <b id={`sx-inv-${inv.id}`} className="sx-toast__title">
                Join {inv.from.nickname} in <span className="num">{inv.room}</span>
              </b>
              {!phone && <span className="sx-toast__sub">{shown.length > 1 ? `${shown.length - 1} more waiting in Friends` : 'Joining puts you in their party'}</span>}
            </span>
            <span className="sx-toast__clock num" aria-label={`${left} seconds left`}>
              {clockText(left)}
            </span>
          </div>
          <span className="sx-toast__bar" style={{ '--left': Math.min(1, left / INVITE_SECONDS) } as CSSProperties} aria-hidden="true">
            <i></i>
          </span>
          <div className="sx-toast__acts">
            <button type="button" className="btn btn--volt btn--sm sx-act" onClick={() => void social.acceptInvite(inv)}>
              <Icon name="arrow-right" />
              Join
            </button>
            <button type="button" className="btn btn--ghost btn--sm sx-act" onClick={() => void social.declineInvite(inv)}>
              Decline
            </button>
            {!phone && (
              // the room as a spectator: the invite stays in Friends (Join still works until it runs out)
              <button type="button" className="btn btn--ghost btn--sm sx-act sx-watch" data-hook="watch" title="Watch the match without joining" onClick={() => watchInvite(social, inv)}>
                <Icon name="eye" />
                Watch
              </button>
            )}
            <span className="menu-top__spacer"></span>
            {inMatch && !phone && <span className="sx-toast__note">Joining leaves this match</span>}
            <button type="button" className="btn btn--ghost btn--icon btn--sm sx-act" aria-label="Later: keep it in Friends" onClick={() => social.hideInvite(inv)}>
              <Icon name="close" />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * An invite's Watch: its room as a spectator. The toast goes away and the invite stays in Friends;
 * a room we're in already is left for good first (as Join does), unless it's this one.
 */
export function watchInvite(social: SocialController, inv: ClientInvite): void {
  social.hideInvite(inv);
  const screen = social.shell.store.getState().screen;
  if (screen.name === 'room' && screen.code === inv.room) return;
  if (screen.name === 'room') social.shell.host?.online?.leave();
  social.shell.go({ to: 'watch', code: inv.room });
}

/** A friend row's Invite, and what became of it. Only in a room, for friends who are on and elsewhere. */
export function InviteButton({ social, friend }: { social: SocialController; friend: Friend }) {
  const sent = useSel(social.store, (s) => s.sent[friend.id] ?? null);
  const busy = useSel(social.store, (s) => !!s.busy[friend.id]);
  const room = useSel(social.shell.store, (s) => (s.screen.name === 'room' && !s.screen.local && s.screen.code ? s.screen.code : null));
  const pending = !!sent && !sent.answer && secondsLeft(sent) > 0 && sent.room === room;
  useTick(pending);
  if (!room || friend.status === 'offline' || friend.room === room) return null;
  if (sent && sent.room === room && sent.answer === 'accepted') {
    return (
      <span className="tag sx-tag sx-tag--ok sx-sent">
        <Icon name="check" size="sm" />
        Joining
      </span>
    );
  }
  if (pending) {
    return (
      <span className="tag sx-tag sx-tag--brass sx-sent" aria-label={`Invite sent, ${secondsLeft(sent)} seconds left`}>
        <Icon name="sx-hourglass" size="sm" />
        Sent · {clockText(secondsLeft(sent))}
      </span>
    );
  }
  const declined = !!sent && sent.room === room && sent.answer === 'declined';
  return (
    <button type="button" className={`btn btn--sm sx-act ${declined ? 'btn--ghost' : 'btn--volt'}`} disabled={busy} onClick={() => void social.invite(friend)} title={declined ? 'They said no: ask again' : undefined}>
      <Icon name="send" />
      {declined ? 'Again' : 'Invite'}
    </button>
  );
}

/** Invites to you, at the top of the panel's Friends tab. */
export function IncomingInvites({ social }: { social: SocialController }) {
  const invites = useSel(social.store, (s) => s.invites);
  const live = invites.filter((i) => secondsLeft(i) > 0);
  useTick(live.length > 0);
  if (!live.length) return null;
  return (
    <>
      <h3 className="sx-sec sx-sec--brass">Invites · {live.length}</h3>
      {live.map((inv) => (
        <InviteRow key={inv.id} social={social} inv={inv} />
      ))}
    </>
  );
}

function InviteRow({ social, inv }: { social: SocialController; inv: ClientInvite }) {
  return (
    <div className="sx-row sx-row--invite">
      <Avatar name={inv.from.nickname} ring />
      <span className="sx-row__who">
        <b>{inv.from.nickname}</b>
        <span className="sx-row__line sx-tone--brass">
          Room <span className="num">{inv.room}</span> · {clockText(secondsLeft(inv))} left
        </span>
      </span>
      <button type="button" className="btn btn--volt btn--sm sx-act" onClick={() => void social.acceptInvite(inv)}>
        <Icon name="arrow-right" />
        Join
      </button>
      <button type="button" className="btn btn--ghost btn--sm sx-act" onClick={() => void social.declineInvite(inv)} aria-label={`Decline ${inv.from.nickname}'s invite`}>
        Decline
      </button>
    </div>
  );
}

/** "Invite to KMTXRA": friends first, then the link for everyone else. */
export function InvitePicker({ social }: { social: SocialController }) {
  const open = useSel(social.store, (s) => s.picker);
  const room = useSel(social.shell.store, (s) => (s.screen.name === 'room' && !s.screen.local && s.screen.code ? s.screen.code : null));
  const phone = usePhoneLayout();
  useEffect(() => (open ? social.watch(30_000) : undefined), [open, social]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      social.closePicker();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, social]);
  if (!open || !room) return null;
  return <PickerBody social={social} room={room} phone={phone} />;
}

const PICK_ORDER = { online: 0, in_room: 1, offline: 2 } as const;

function PickerBody({ social, room, phone }: { social: SocialController; room: string; phone: boolean }) {
  const list = useSel(social.store, (s) => s.list);
  const friends = [...(list?.friends ?? [])].sort((a, b) => PICK_ORDER[a.status] - PICK_ORDER[b.status] || a.nickname.localeCompare(b.nickname));
  const shell = social.shell;
  const canShare = typeof navigator !== 'undefined' && 'share' in navigator;
  const [copied, setCopied] = useState(false);
  return (
    <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}mf-fit--modal kit-v2 mf-social`}>
      <section className={`screen screen--game sx-screen${phone ? ' screen--phone sx-screen--phone' : ''}`} data-screen="invite-picker" aria-label="Invite friends">
        <button type="button" className="sx-scrim" aria-label="Close" onClick={() => social.closePicker()}></button>
        <div className="sx-picker m-p1" role="dialog" aria-modal="true" aria-labelledby="sx-pick-t">
          <header className="sx-drawer__head">
            <h2 id="sx-pick-t" className="display sx-picker__title">
              Invite to
            </h2>
            <span className="sx-stamp display num">{room}</span>
            <span className="menu-top__spacer"></span>
            <button type="button" className="btn btn--ghost btn--icon btn--sm sx-close" aria-label="Close" onClick={() => social.closePicker()}>
              <Icon name="close" />
            </button>
          </header>
          {!phone && <p className="sx-note">Friends get your invite wherever they are, in the menus or mid-match. An invite lasts 2 minutes.</p>}
          <div className="sx-list sx-picker__list">
            {!list && <p className="status status--busy sx-note">Loading your friends…</p>}
            {list && friends.length === 0 && (
              <p className="sx-note">
                No friends yet: add them from <b>Friends</b> on Home, or send the link below.
              </p>
            )}
            {friends.map((f) => (
              <div key={f.id} className={`sx-row sx-row--${f.status}`}>
                <Avatar name={f.nickname} status={f.status} ring={f.status === 'in_room'} />
                <span className="sx-row__who">
                  <b>{f.nickname}</b>
                  <span className={`sx-row__line sx-tone--${f.room === room ? 'ok' : f.status === 'in_room' ? 'volt' : f.status === 'online' ? 'ok' : 'muted'}`}>
                    {f.room === room ? 'In this room' : f.status === 'offline' ? 'Offline · invites need them on' : statusText(f)}
                  </span>
                </span>
                {f.room === room ? (
                  <span className="tag sx-tag sx-tag--ok">
                    <Icon name="check" size="sm" />
                    Here
                  </span>
                ) : (
                  <InviteButton social={social} friend={f} />
                )}
              </div>
            ))}
          </div>
          <div className="sx-divider">
            <span className="label label--volt">Not friends yet?</span>
            <i aria-hidden="true"></i>
          </div>
          <div className="sx-share">
            <button
              type="button"
              className="btn btn--paper btn--sm sx-act"
              onClick={() => {
                void shell.copyLink?.(room, true).then((ok) => setCopied(ok));
              }}
            >
              <Icon name={copied ? 'check' : 'link'} />
              {copied ? 'Copied' : phone ? 'Copy link' : 'Copy invite link'}
            </button>
            {canShare && (
              <button type="button" className="btn btn--ghost btn--sm sx-act" onClick={() => void shell.shareLink?.(room)}>
                <Icon name="share" />
                {phone ? 'Share' : 'Share…'}
              </button>
            )}
            <button type="button" className="btn btn--ghost btn--sm sx-act" onClick={() => shell.shareOnWhatsApp?.(room)}>
              <Icon name="chat" />
              WhatsApp
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** The lobby's "Invite friends" block (desktop poster, phone share card): opens the picker. */
export function InviteFriendsBlock({ social, phone = false }: { social: SocialController; phone?: boolean }) {
  const list = useSel(social.store, (s) => s.list);
  useEffect(() => social.watch(60_000), [social]);
  const on = list?.friends.filter((f) => f.status !== 'offline').length ?? 0;
  return (
    <button type="button" className={`sx-invblock m-p8${phone ? ' sx-invblock--phone' : ''}`} onClick={() => social.openPicker()}>
      <Icon name="sx-friends" size={phone ? undefined : 'lg'} />
      <span className="sx-invblock__text">
        <b>Invite friends</b>
        {!phone && <span>{list ? `${on} online · they're alerted anywhere` : "They're alerted anywhere"}</span>}
      </span>
      <Icon name="chev-right" />
    </button>
  );
}
