/**
 * Report, Block, Mute and the host's Remove, from wherever players meet (audit-2 L-01, L-02, L-10,
 * L-11): one sheet. A row's ⋯ (PlayerMore: the lobby's roster, results, the comms sheet, the friends
 * panel's people) opens it on that player; the pause menu's Players (PlayersButton) opens it on the
 * room's people, the way in mid-match (the scoreboard and the death cam are part of the HUD, which
 * takes no clicks). Report asks for one plain reason and an optional note; it never promises what
 * happens next beyond what the owner does. Block says what it does in one line. Remove (the host,
 * protocol v22) asks once.
 *
 * Nothing here without friends working: a signed-in, online, adult player (social.ts socialAllowed).
 * Bots have no account, so they get no ⋯; nor does your own row.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { usePhoneLayout } from '../shell/screens/phone/layout';
import { Icon } from '../ui/Icon';
import { useFocusTrap } from '../ui/focusTrap';
import { voiceChat } from '../voice/index';
import type { ReportReason } from './api';
import { Avatar } from './FriendsPanel';
import { useSocial } from './Squad';
import { REPORT_NOTE_MAX, useSel, type PlayerTarget, type SocialController } from './social';

/** The reasons, in the sheet's words (apps/api REPORT_REASONS). */
export const REPORT_REASONS: readonly (readonly [ReportReason, string])[] = [
  ['name', 'Offensive name'],
  ['voice', 'Abusive voice'],
  ['cheating', 'Cheating'],
  ['spam', 'Spamming requests or invites'],
  ['underage', 'Under 18'],
  ['other', 'Something else'],
];

/** What the sheet says once a report is in: nothing the owner can't keep. */
export const REPORT_THANKS = "Thanks. We read every report and act on the ones that break the rules. We won't tell them it was you.";
export const BLOCK_LINE = "They won't be told, and can't see you or reach you. You won't hear them in any room.";
export const REMOVE_LINE = "They leave now and can't come back to this room.";

const never = () => () => {};

/** The room's people as the sheet needs them: everyone but you and the bots. */
function useRoomPeople(social: SocialController) {
  return useSel(social.shell.store, (s) => s.lobby?.players ?? null);
}

/** A row's ⋯: the sheet on this player. Nothing for bots, your own row, or without friends working. */
export function PlayerMore({ target, className = '', onOpen }: { target: PlayerTarget | null; className?: string; onOpen?: () => void }) {
  const social = useSocial();
  if (!social || !target) return null;
  return (
    <button
      type="button"
      className={`btn btn--ghost btn--sm btn--icon sx-act sx-more-btn ${className}`.trim()}
      aria-label={`Report, block or mute ${target.name}`}
      title="Report, block, mute"
      onClick={(e) => {
        e.stopPropagation();
        onOpen?.();
        social.openPlayer(target);
      }}
    >
      <Icon name="sx-dots" />
    </button>
  );
}

/** The pause menu's Players (an online room): the way to report, block, mute or remove mid-match. */
export function PlayersButton({ className, compact = false }: { className: string; compact?: boolean }) {
  const social = useSocial();
  const count = () => (social ? (social.shell.store.getState().lobby?.players ?? []).filter((p) => !p.isBot && !p.you).length : 0);
  const people = useSyncExternalStore(social ? social.shell.store.subscribe : never, count, count);
  if (!social || people === 0) return null;
  return (
    <button type="button" className={className} onClick={() => social.openPlayers()}>
      <Icon name="user" />
      {compact ? (
        'Players'
      ) : (
        <span className="btn__stack">
          Players
          <span className="btn__sub">Report, block, mute{social.shell.store.getState().lobby?.isHost ? ' or remove' : ''}</span>
        </span>
      )}
    </button>
  );
}

/** The sheet itself (SocialLayer mounts it once). */
export function PlayerSheet({ social }: { social: SocialController }) {
  const sheet = useSel(social.store, (s) => s.sheet);
  const phone = usePhoneLayout();
  const open = sheet !== null;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.type === 'keydown') social.sheetBack();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onKey, true);
    };
  }, [open, social]);
  if (!sheet) return null;
  return <SheetBody social={social} phone={phone} />;
}

function SheetBody({ social, phone }: { social: SocialController; phone: boolean }) {
  const sheet = useSel(social.store, (s) => s.sheet)!;
  const card = useRef<HTMLDivElement>(null);
  useFocusTrap(card, true);
  const t = sheet.target;
  const title = sheet.view === 'players' ? 'Players' : sheet.view === 'report' || sheet.view === 'sent' ? `Report ${t?.name ?? ''}` : sheet.view === 'block' ? `Block ${t?.name ?? ''}?` : sheet.view === 'remove' ? `Remove ${t?.name ?? ''}?` : (t?.name ?? '');
  return (
    <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}mf-fit--modal kit-v2 mf-social`}>
      <section className={`screen screen--game sx-screen${phone ? ' screen--phone sx-screen--phone' : ''}`} data-screen="player-sheet" data-view={sheet.view} aria-label={title}>
        <button type="button" className="sx-scrim" aria-label="Close" tabIndex={-1} onClick={() => social.closeSheet()}></button>
        <div ref={card} className="sx-picker sx-psheet m-p1" role="dialog" aria-modal="true" aria-labelledby="sx-psheet-t" tabIndex={-1}>
          <header className="sx-drawer__head">
            {t && sheet.view !== 'players' && <Avatar name={t.name} look={t.look} />}
            <h2 id="sx-psheet-t" className="display sx-psheet__title">
              {title}
            </h2>
            <span className="menu-top__spacer"></span>
            <button type="button" className="btn btn--ghost btn--icon btn--sm sx-close" aria-label="Close" onClick={() => social.closeSheet()}>
              <Icon name="close" />
            </button>
          </header>
          {sheet.view === 'players' && <PeopleView social={social} />}
          {sheet.view === 'actions' && t && <ActionsView social={social} target={t} />}
          {sheet.view === 'report' && t && <ReportForm social={social} target={t} />}
          {sheet.view === 'sent' && t && <SentView social={social} target={t} />}
          {sheet.view === 'block' && t && <BlockConfirm social={social} target={t} />}
          {sheet.view === 'remove' && t && <RemoveConfirm social={social} target={t} />}
        </div>
      </section>
    </div>
  );
}

/** The room's people (the pause menu's Players). */
function PeopleView({ social }: { social: SocialController }) {
  const players = useRoomPeople(social);
  const people = (players ?? []).filter((p) => !p.isBot && !p.you);
  return (
    <div className="sx-list sx-picker__list">
      {people.length === 0 && <p className="sx-note">Nobody else is in the room. Bots have no one to report.</p>}
      {people.map((p) => (
        <button key={p.id} type="button" className="sx-row sx-row--btn" onClick={() => social.openPlayer({ name: p.name, pid: p.id, place: 'scoreboard' })}>
          <Avatar name={p.name} />
          <span className="sx-row__who">
            <b>{p.name}</b>
            <span className="sx-row__line">{social.isBlocked({ name: p.name }) ? 'Blocked' : p.host ? 'Host' : 'In this room'}</span>
          </span>
          <Icon name="chev-right" />
        </button>
      ))}
    </div>
  );
}

/** One player: Report, Block, Mute (in a room with voice), and Remove (the room's host). */
function ActionsView({ social, target }: { social: SocialController; target: PlayerTarget }) {
  const players = useRoomPeople(social);
  const isHost = useSel(social.shell.store, (s) => s.lobby?.isHost === true && s.screen.name === 'room');
  const active = () => voiceChat.store.getState().active;
  const mutesNow = () => voiceChat.store.getState().mutes;
  const voiceOn = useSyncExternalStore(voiceChat.store.subscribe, active, active);
  const mutes = useSyncExternalStore(voiceChat.store.subscribe, mutesNow, mutesNow);
  const blocked = useSel(social.store, () => social.isBlocked(target));
  const inRoom = target.pid !== undefined ? players?.find((p) => p.id === target.pid && foldEq(p.name, target.name)) : undefined;
  const muted = inRoom ? mutes.includes(inRoom.id) : false;
  return (
    <div className="sx-psheet__acts">
      <button type="button" className="btn btn--ink btn--block sx-psheet__act" onClick={() => social.sheetView('report')}>
        <Icon name="sx-flag" />
        <span className="btn__stack">
          Report
          <span className="btn__sub">Tell us what they did</span>
        </span>
      </button>
      {blocked ? (
        <p className="sx-note sx-psheet__state">
          <Icon name="sx-ban" size="sm" /> Blocked. Unblock them from Friends › Blocked.
        </p>
      ) : (
        <button type="button" className="btn btn--ink btn--block sx-psheet__act" onClick={() => social.sheetView('block')}>
          <Icon name="sx-ban" />
          <span className="btn__stack">
            Block
            <span className="btn__sub">No requests, invites or voice from them</span>
          </span>
        </button>
      )}
      {inRoom && voiceOn && !blocked && (
        <button type="button" className="btn btn--ink btn--block sx-psheet__act" aria-pressed={muted} onClick={() => voiceChat.setMuted(inRoom.id, !muted)}>
          <Icon name={muted ? 'sx-vol' : 'sx-vol-x'} />
          <span className="btn__stack">
            {muted ? 'Unmute voice' : 'Mute voice'}
            <span className="btn__sub">{muted ? 'Hear them again' : 'In every room, on this device'}</span>
          </span>
        </button>
      )}
      {inRoom && isHost && !inRoom.host && (
        <button type="button" className="btn btn--ink btn--block sx-psheet__act" onClick={() => social.sheetView('remove')}>
          <Icon name="user-x" />
          <span className="btn__stack">
            Remove from room
            <span className="btn__sub">Host · they can't come back to this room</span>
          </span>
        </button>
      )}
      <button type="button" className="btn btn--ghost btn--block sx-psheet__back" onClick={() => social.sheetBack()}>
        {social.store.getState().sheet?.fromList ? 'Back' : 'Close'}
      </button>
    </div>
  );
}

function ReportForm({ social, target }: { social: SocialController; target: PlayerTarget }) {
  const sheet = useSel(social.store, (s) => s.sheet);
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [note, setNote] = useState('');
  const sending = sheet?.sending ?? false;
  return (
    <form
      className="sx-psheet__form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason) void social.sendReport(reason, note);
      }}
    >
      <fieldset className="sx-reasons">
        <legend className="sx-note">What did {target.name} do?</legend>
        {REPORT_REASONS.map(([id, label]) => (
          <label key={id} className={`sx-reason${reason === id ? ' is-on' : ''}`}>
            <input type="radio" name="sx-reason" value={id} checked={reason === id} onChange={() => setReason(id)} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <label className="sx-reportnote">
        <span className="sx-note">Anything else? (optional)</span>
        <textarea value={note} maxLength={REPORT_NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} placeholder="What happened, and when" />
        <span className="sx-reportnote__count num" aria-hidden="true">
          {note.length}/{REPORT_NOTE_MAX}
        </span>
      </label>
      {sheet?.error && (
        <p className="sx-note sx-tone--warn" role="alert">
          {sheet.error}
        </p>
      )}
      <div className="sx-psheet__row">
        <button type="submit" className="btn btn--volt sx-act" disabled={!reason || sending}>
          <Icon name="send" />
          {sending ? 'Sending…' : 'Send report'}
        </button>
        <button type="button" className="btn btn--ghost sx-act" onClick={() => social.sheetView('actions')}>
          Back
        </button>
      </div>
    </form>
  );
}

function SentView({ social, target }: { social: SocialController; target: PlayerTarget }) {
  const blocked = useSel(social.store, () => social.isBlocked(target));
  return (
    <div className="sx-psheet__acts" role="status">
      <p className="sx-psheet__lead">{REPORT_THANKS}</p>
      <div className="sx-psheet__row">
        {!blocked && (
          <button type="button" className="btn btn--ink sx-act" onClick={() => social.sheetView('block')}>
            <Icon name="sx-ban" />
            Block {target.name} too
          </button>
        )}
        <button type="button" className="btn btn--paper sx-act" autoFocus onClick={() => social.sheetBack()}>
          Done
        </button>
      </div>
    </div>
  );
}

function BlockConfirm({ social, target }: { social: SocialController; target: PlayerTarget }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="sx-psheet__acts" role="alertdialog" aria-label={`Block ${target.name}?`}>
      <p className="sx-psheet__lead">{BLOCK_LINE}</p>
      <div className="sx-psheet__row">
        <button
          type="button"
          className="btn btn--danger sx-act"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void social.blockPlayer(target).then((ok) => {
              setBusy(false);
              if (ok) social.sheetBack();
            });
          }}
        >
          <Icon name="sx-ban" />
          Block
        </button>
        <button type="button" className="btn btn--ghost sx-act" autoFocus onClick={() => social.sheetView('actions')}>
          Keep
        </button>
      </div>
    </div>
  );
}

function RemoveConfirm({ social, target }: { social: SocialController; target: PlayerTarget }) {
  return (
    <div className="sx-psheet__acts" role="alertdialog" aria-label={`Remove ${target.name}?`}>
      <p className="sx-psheet__lead">{REMOVE_LINE}</p>
      <div className="sx-psheet__row">
        <button
          type="button"
          className="btn btn--danger sx-act"
          onClick={() => {
            social.removeFromRoom(target);
            social.sheetBack();
          }}
        >
          <Icon name="user-x" />
          Remove
        </button>
        <button type="button" className="btn btn--ghost sx-act" autoFocus onClick={() => social.sheetView('actions')}>
          Keep
        </button>
      </div>
    </div>
  );
}

const foldEq = (a: string, b: string) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();

/** A room's row as the sheet's target (null for bots and you). */
export function roomTarget(p: { id: number; name: string; isBot: boolean; you: boolean }, place: PlayerTarget['place']): PlayerTarget | null {
  return p.isBot || p.you ? null : { name: p.name, pid: p.id, place };
}
