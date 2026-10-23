/**
 * Friends on Home (board "SOCIAL", S1/P1): the Friends button with its badge (top bar), the Squad
 * card in Home's right column (online friends first: Join a friend's room, open the panel), and the
 * phone's squad strip over the soldier's stage. Each is a one-line mount in the shell's screens
 * (social.md lists them); all of them hide when the API can't be reached (offline training).
 */
import { useContext, useEffect, useSyncExternalStore } from 'react';
import { ControllerContext } from '../shell/context';
import { Icon } from '../ui/Icon';
import { Avatar } from './FriendsPanel';
import { mountSocialSprite } from './icons';
import { HOME_POLL_MS, badgeCount, onlineFriends, socialOf, statusText, useSel, type SocialController } from './social';
import './social.css';

const never = () => () => {};

/**
 * The shell's SocialController while friends make sense (a signed-in, online player), else null:
 * no app shell (the debug client, a screen test on its own) or offline training.
 */
export function useSocial(): SocialController | null {
  const ctl = useContext(ControllerContext);
  // a whole shell controller (screen tests pass partial stand-ins: no friends there)
  const social = ctl && ctl.store && typeof ctl.api?.onSignIn === 'function' ? socialOf(ctl) : null;
  useEffect(() => {
    if (social) mountSocialSprite();
  }, [social]);
  const isOnline = () => {
    const p = social?.shell.store.getState().profile;
    return !!p && !p.offline;
  };
  const online = useSyncExternalStore(social ? social.shell.store.subscribe : never, isOnline, isOnline);
  return online ? social : null;
}

/** What the badge counts: requests waiting for you, and invites you haven't seen. */
export function useBadge(social: SocialController | null): number {
  const count = () => (social ? badgeCount(social.store.getState()) : 0);
  return useSyncExternalStore(social ? social.store.subscribe : never, count, count);
}

/** The top bar's Friends button: opens the panel; the badge is what waits for you. */
export function FriendsButton({ phone = false }: { phone?: boolean }) {
  const social = useSocial();
  const badge = useBadge(social);
  if (!social) return null;
  return (
    <button
      type="button"
      className={`btn btn--ghost btn--icon btn--sm sx-fbtn m-p8${phone ? ' sx-fbtn--phone' : ''}`}
      aria-label={badge ? `Friends, ${badge} waiting` : 'Friends'}
      onClick={() => social.openPanel('friends')}
    >
      <Icon name="sx-friends" />
      {badge > 0 && <span className="sx-badge sx-badge--float">{badge}</span>}
    </button>
  );
}

/** Home's Squad card (desktop, the right column): who's on, Join, and the way into the panel. */
export function SquadCard() {
  const social = useSocial();
  if (!social) return null;
  return <SquadCardBody social={social} />;
}

function SquadCardBody({ social }: { social: SocialController }) {
  useEffect(() => social.watch(HOME_POLL_MS), [social]);
  const list = useSel(social.store, (s) => s.list);
  const party = useSel(social.store, (s) => s.party);
  const on = onlineFriends(list);
  const requests = list?.incoming.length ?? 0;
  const shown = on.slice(0, 4);
  return (
    <section className="sx-squad m-p3" aria-label="Squad: friends online">
      <header className="sx-squad__head">
        <span className="label label--volt">Squad</span>
        <span className="sx-squad__count">· {list ? `${on.length} online` : '…'}</span>
        <span className="menu-top__spacer"></span>
        <button type="button" className="btn btn--ghost btn--icon btn--sm sx-squad__add" aria-label="Add a friend" onClick={() => social.openPanel('friends')}>
          <Icon name="users-plus" />
        </button>
      </header>
      {shown.length > 0 ? (
        <div className="sx-squad__strip">
          {shown.map((f) => (
            <Avatar key={f.id} name={f.nickname} status={f.status} ring={f.status === 'in_room'} />
          ))}
          {on.length > shown.length && <span className="avatar avatar--open sx-av">+{on.length - shown.length}</span>}
        </div>
      ) : (
        <p className="sx-squad__empty">{list && list.friends.length === 0 ? 'Add friends by name or code, and see when they play.' : 'No friends online right now.'}</p>
      )}
      {on.slice(0, 2).map((f) => (
        <div key={f.id} className="sx-squad__row">
          <span className="sx-row__who">
            <b>{f.nickname}</b>
            <span className={`sx-row__line sx-tone--${f.status === 'in_room' ? 'volt' : 'ok'}`}>{statusText(f)}</span>
          </span>
          {f.status === 'in_room' && f.room && (
            <button type="button" className="btn btn--volt btn--sm sx-act" onClick={() => social.join(f)}>
              Join
            </button>
          )}
        </div>
      ))}
      {party && party.members.length > 1 && (
        <div className="sx-party">
          <span className="label">Party · {party.members.length}</span>
          <span className="sx-party__names">{party.members.map((m) => m.nickname).join(' · ')}</span>
          <button type="button" className="btn btn--ghost btn--sm sx-act" onClick={() => void social.leaveParty()}>
            Leave
          </button>
        </div>
      )}
      <button type="button" className="btn btn--paper btn--sm btn--block sx-squad__open m-p8" onClick={() => social.openPanel('friends')}>
        <Icon name="sx-friends" />
        {requests ? `Friends · ${requests} ${requests === 1 ? 'request' : 'requests'}` : 'Friends'}
      </button>
    </section>
  );
}

/** The phone's squad strip (P1): online friends' faces and a Friends button, top of the stage. */
export function PhoneSquad() {
  const social = useSocial();
  if (!social) return null;
  return <PhoneSquadBody social={social} />;
}

function PhoneSquadBody({ social }: { social: SocialController }) {
  useEffect(() => social.watch(HOME_POLL_MS), [social]);
  const list = useSel(social.store, (s) => s.list);
  const on = onlineFriends(list);
  const first = on.find((f) => f.status === 'in_room' && f.room) ?? null;
  return (
    <section className="sx-psquad" aria-label="Squad: friends online">
      <span className="sx-psquad__head">
        <span className="label label--volt">Squad</span>
        <span className="sx-squad__count">· {list ? `${on.length} on` : '…'}</span>
      </span>
      {on.length > 0 && (
        <span className="sx-psquad__strip">
          {on.slice(0, 3).map((f) => (
            <Avatar key={f.id} name={f.nickname} status={f.status} ring={f.status === 'in_room'} />
          ))}
          {on.length > 3 && <span className="avatar avatar--open sx-av">+{on.length - 3}</span>}
        </span>
      )}
      {first && (
        <button type="button" className="btn btn--volt btn--sm sx-psquad__join" onClick={() => social.join(first)}>
          Join {first.nickname}
        </button>
      )}
    </section>
  );
}
