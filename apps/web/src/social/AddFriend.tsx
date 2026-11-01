/**
 * Add friend on a match's rows (audit 2 P-06): Results' standings and the lobby's roster, for a human
 * who isn't you, a bot, already a friend or blocked. It sends the panel's own request (by name; the
 * other player gets the usual toast) and turns to "Request sent". Nothing without friends (offline,
 * a local room: names there aren't accounts, so the screens leave it out).
 *
 * `RowActions` is the rows' slot for per-player actions: Add friend sits in it, and the safety work's
 * Report / Block go beside it in the same slot.
 */
import { useEffect, type ReactNode } from 'react';
import { Icon } from '../ui/Icon';
import { useSocial } from './Squad';
import { useSel } from './social';
import './social.css';

export function AddFriendButton({ name, compact = false }: { name: string; compact?: boolean }) {
  const social = useSocial();
  useEffect(() => {
    if (social && !social.store.getState().list) void social.refresh();
  }, [social]);
  if (!social) return null;
  return <AddFriend social={social} name={name} compact={compact} />;
}

function AddFriend({ social, name, compact }: { social: NonNullable<ReturnType<typeof useSocial>>; name: string; compact: boolean }) {
  const relation = useSel(social.store, () => social.relationByName(name));
  const busy = useSel(social.store, (s) => !!s.busy[`name:${name.toLowerCase()}`]);
  if (relation === null || relation === 'friends') return null;
  if (relation === 'sent') {
    return (
      <span className="tag sx-tag sx-tag--muted mf-addfriend mf-addfriend--sent" title="It waits until they answer">
        <Icon name="sx-hourglass" size="sm" />
        {compact ? 'Sent' : 'Request sent'}
      </span>
    );
  }
  const theyAsked = relation === 'incoming';
  return (
    <button type="button" className="btn btn--paper btn--sm mf-addfriend m-p8" disabled={busy} aria-label={theyAsked ? `Accept ${name}'s friend request` : `Add ${name} as a friend`} title={theyAsked ? 'They asked: accept' : 'Add friend'} onClick={() => void social.addByName(name)}>
      <Icon name={theyAsked ? 'check' : 'users-plus'} />
      {!compact && (theyAsked ? 'Accept' : 'Add friend')}
    </button>
  );
}

/** A row's slot for actions on that player (Add friend here; Report and Block beside it). */
export function RowActions({ children }: { children: ReactNode }) {
  return <span className="mf-row-actions">{children}</span>;
}
