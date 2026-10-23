/**
 * The friends panel (board "SOCIAL · friends, invites, voice", S2/P2): a Frost-glass drawer from the
 * right on desktop (1920×1080 design px) and a sheet on phones (812×375). Your friend code, Add a
 * friend (exact name or code), and three tabs: Friends (requests on top, then In a match / Online /
 * Offline), Requests (to you and sent), Blocked. Each friend row: Join their room, and a menu with
 * Remove and Block (each asked once more). Esc or the scrim closes it.
 */
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { usePhoneLayout } from '../shell/screens/phone/layout';
import { Icon } from '../ui/Icon';
import type { Friend, FriendsList, Person } from './api';
import { IncomingInvites, InviteButton } from './Invites';
import { statusText, useSel, type FriendsTab, type SocialController } from './social';

const initial = (name: string) => ([...name.trim()][0] ?? '?').toUpperCase();

export function Avatar({ name, status, ring }: { name: string; status?: Friend['status'] | undefined; ring?: boolean | undefined }) {
  return (
    <span className={`avatar sx-av${ring ? ' sx-av--ring' : ''}`} aria-hidden="true">
      {initial(name)}
      {status && <i className={`sx-dot sx-dot--${status}`}></i>}
    </span>
  );
}

/** The panel, when open (SocialLayer mounts it). */
export function FriendsPanel({ social }: { social: SocialController }) {
  const open = useSel(social.store, (s) => s.panel.open);
  const phone = usePhoneLayout();
  // keep it fresh while it shows
  useEffect(() => (open ? social.watch(30_000) : undefined), [open, social]);
  if (!open) return null;
  return <PanelBody social={social} phone={phone} />;
}

function PanelBody({ social, phone }: { social: SocialController; phone: boolean }) {
  const list = useSel(social.store, (s) => s.list);
  const error = useSel(social.store, (s) => s.error);
  const tab = useSel(social.store, (s) => s.panel.tab);
  const drawer = useRef<HTMLElement>(null);

  // Esc closes the panel (and only the panel: the shell's menu toggle doesn't see it)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      social.closePanel();
    };
    window.addEventListener('keydown', onKey, true);
    drawer.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey, true);
  }, [social]);

  const online = list?.friends.filter((f) => f.status !== 'offline').length ?? 0;
  const requests = list?.incoming.length ?? 0;
  return (
    <div className={`mf-fit ${phone ? 'mf-fit--phone ' : ''}mf-fit--modal kit-v2 mf-social`}>
      <section className={`screen screen--game sx-screen${phone ? ' screen--phone sx-screen--phone' : ''}`} data-screen="friends" aria-label="Friends">
        <button type="button" className="sx-scrim" aria-label="Close friends" onClick={() => social.closePanel()}></button>
        <aside ref={drawer} className="sx-drawer m-p9 m-p9--right" role="dialog" aria-modal="true" aria-labelledby="sx-title" tabIndex={-1}>
          <header className="sx-drawer__head">
            <h2 id="sx-title" className="display sx-drawer__title">
              Friends
            </h2>
            {list && !phone && (
              <span className="tag sx-tag sx-tag--ok">
                <span className="sx-live" aria-hidden="true"></span>
                {online} online
              </span>
            )}
            <span className="menu-top__spacer"></span>
            {phone && (
              <button type="button" className="sx-codechip" disabled={!list} aria-label={`Your friend code ${list?.code ?? ''}: copy it`} onClick={() => void social.copyCode()}>
                <span className="num">{list?.code ?? '····-····'}</span>
                <Icon name="copy" size="sm" />
              </button>
            )}
            <button type="button" className="btn btn--ghost btn--icon btn--sm sx-close" aria-label="Close" onClick={() => social.closePanel()}>
              <Icon name="close" />
            </button>
          </header>

          {!phone && <CodeCard social={social} list={list} />}
          <AddFriend social={social} phone={phone} />

          <div className="sx-tabs" role="tablist" aria-label="Friends lists">
            <Tab social={social} tab="friends" on={tab === 'friends'}>
              Friends{list ? ` · ${list.friends.length}` : ''}
            </Tab>
            <Tab social={social} tab="requests" on={tab === 'requests'} badge={requests}>
              Requests
            </Tab>
            <Tab social={social} tab="blocked" on={tab === 'blocked'}>
              Blocked
            </Tab>
          </div>

          <div className="sx-list" role="tabpanel">
            {error && (
              <p className="status status--warn sx-note">
                <Icon name="warn" size="sm" />
                {error}
              </p>
            )}
            {!list && !error && <p className="status status--busy sx-note">Loading your friends…</p>}
            {list && tab === 'friends' && <FriendsTabView social={social} list={list} />}
            {list && tab === 'requests' && <RequestsTabView social={social} list={list} />}
            {list && tab === 'blocked' && <BlockedTabView social={social} list={list} />}
            {phone && (
              <p className="sx-privacy sx-privacy--inlist">
                <Icon name="lock" size="sm" />
                Only friends see your status and your room.
              </p>
            )}
          </div>

          <p className="sx-privacy">
            <Icon name="lock" size="sm" />
            Friends see your status and your room. Nobody else does.
          </p>
        </aside>
      </section>
    </div>
  );
}

function Tab({ social, tab, on, badge, children }: { social: SocialController; tab: FriendsTab; on: boolean; badge?: number; children: ReactNode }) {
  return (
    <button type="button" role="tab" className="tab sx-tab" aria-selected={on} onClick={() => social.setTab(tab)}>
      {children}
      {!!badge && <span className="sx-badge">{badge}</span>}
    </button>
  );
}

function CodeCard({ social, list }: { social: SocialController; list: FriendsList | null }) {
  return (
    <div className="sx-code">
      <span className="sx-code__text">
        <span className="label sx-code__label">Your friend code</span>
        <b className="sx-code__code num" data-bind="social.code">
          {list?.code ?? '····-····'}
        </b>
        <span className="sx-code__sub">Friends add you with it. Only friends see you online.</span>
      </span>
      <button type="button" className="btn btn--ink btn--sm sx-code__copy" disabled={!list} onClick={() => void social.copyCode()}>
        <Icon name="copy" />
        Copy
      </button>
    </div>
  );
}

function AddFriend({ social, phone }: { social: SocialController; phone: boolean }) {
  const adding = useSel(social.store, (s) => s.adding);
  const added = useSel(social.store, (s) => s.added);
  const [text, setText] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const outcome = await social.add(text);
    if (outcome?.tone === 'ok') setText('');
  };
  return (
    <form className="sx-add" onSubmit={(e) => void submit(e)}>
      <label className="sx-add__field">
        <span className="vh">Add a friend by exact name or friend code</span>
        <input
          className="sx-add__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Exact name or friend code"
          maxLength={32}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="send"
        />
      </label>
      <button type="submit" className="btn btn--volt btn--sm sx-add__send" disabled={adding || !text.trim()}>
        <Icon name="users-plus" />
        {phone ? '' : adding ? 'Sending' : 'Send'}
        {phone && <span className="vh">Send request</span>}
      </button>
      {added && (
        <p className={`status ${added.tone === 'ok' ? 'status--ok' : 'status--warn'} sx-add__out`} role="status">
          <Icon name={added.tone === 'ok' ? 'ok' : 'warn'} size="sm" />
          {added.message}
        </p>
      )}
    </form>
  );
}

function Section({ title, tone, count }: { title: string; tone: 'volt' | 'ok' | 'muted'; count: number }) {
  return (
    <h3 className={`sx-sec sx-sec--${tone}`}>
      {title} · {count}
    </h3>
  );
}

function FriendsTabView({ social, list }: { social: SocialController; list: FriendsList }) {
  const groups: [string, 'volt' | 'ok' | 'muted', Friend[]][] = [
    ['In a match', 'volt', list.friends.filter((f) => f.status === 'in_room')],
    ['Online', 'ok', list.friends.filter((f) => f.status === 'online')],
    ['Offline', 'muted', list.friends.filter((f) => f.status === 'offline')],
  ];
  return (
    <>
      <IncomingInvites social={social} />
      {list.incoming.length > 0 && (
        <>
          <Section title="Requests" tone="volt" count={list.incoming.length} />
          {list.incoming.slice(0, 3).map((p) => (
            <IncomingRow key={p.id} social={social} person={p} />
          ))}
          {list.incoming.length > 3 && (
            <button type="button" className="btn btn--ghost btn--sm sx-more" onClick={() => social.setTab('requests')}>
              All {list.incoming.length} requests
            </button>
          )}
        </>
      )}
      {list.friends.length === 0 && (
        <div className="sx-empty">
          <Icon name="sx-friends" size="lg" />
          <p>
            <b>No friends yet.</b> Send someone your code, or add them by their exact name.
          </p>
        </div>
      )}
      {groups.map(
        ([title, tone, friends]) =>
          friends.length > 0 && (
            <div key={title} className="sx-group">
              <Section title={title} tone={tone} count={friends.length} />
              {friends.map((f) => (
                <FriendRow key={f.id} social={social} friend={f} />
              ))}
            </div>
          ),
      )}
    </>
  );
}

function RequestsTabView({ social, list }: { social: SocialController; list: FriendsList }) {
  return (
    <>
      <Section title="To you" tone="volt" count={list.incoming.length} />
      {list.incoming.length === 0 && <p className="sx-note">No requests waiting.</p>}
      {list.incoming.map((p) => (
        <IncomingRow key={p.id} social={social} person={p} />
      ))}
      <Section title="Sent" tone="muted" count={list.outgoing.length} />
      {list.outgoing.length === 0 && <p className="sx-note">Nothing sent. Requests wait until the other player answers.</p>}
      {list.outgoing.map((p) => (
        <PersonRow key={p.id} social={social} person={p} line="Waiting for an answer">
          <button type="button" className="btn btn--ghost btn--sm sx-act" onClick={() => void social.cancel(p)}>
            Cancel
          </button>
        </PersonRow>
      ))}
    </>
  );
}

function BlockedTabView({ social, list }: { social: SocialController; list: FriendsList }) {
  return (
    <>
      <p className="sx-note">Blocked players can't see you online, and nothing they send reaches you. They aren't told.</p>
      {list.blocked.length === 0 && <p className="sx-note">Nobody blocked.</p>}
      {list.blocked.map((p) => (
        <PersonRow key={p.id} social={social} person={p} line="Blocked">
          <button type="button" className="btn btn--ghost btn--sm sx-act" onClick={() => void social.unblock(p)}>
            Unblock
          </button>
        </PersonRow>
      ))}
    </>
  );
}

function PersonRow({ social, person, line, children }: { social: SocialController; person: Person; line: string; children: ReactNode }) {
  const busy = useSel(social.store, (s) => !!s.busy[person.id]);
  return (
    <div className="sx-row" aria-busy={busy}>
      <Avatar name={person.nickname} />
      <span className="sx-row__who">
        <b>{person.nickname}</b>
        <span className="sx-row__line">{line}</span>
      </span>
      {children}
    </div>
  );
}

function IncomingRow({ social, person }: { social: SocialController; person: Person }) {
  const busy = useSel(social.store, (s) => !!s.busy[person.id]);
  return (
    <div className="sx-row sx-row--req" aria-busy={busy}>
      <Avatar name={person.nickname} />
      <span className="sx-row__who">
        <b>{person.nickname}</b>
        <span className="sx-row__line sx-tone--volt">Wants to be friends</span>
      </span>
      <button type="button" className="btn btn--volt btn--sm sx-act" disabled={busy} onClick={() => void social.accept(person)}>
        <Icon name="check" />
        Accept
      </button>
      <button type="button" className="btn btn--ghost btn--sm sx-act" disabled={busy} onClick={() => void social.decline(person)} aria-label={`Decline ${person.nickname}`}>
        Decline
      </button>
    </div>
  );
}

/** A friend: their status, Join (when in a room you aren't in), and the ⋯ menu (Remove, Block). */
export function FriendRow({ social, friend, extra }: { social: SocialController; friend: Friend; extra?: ReactNode }) {
  const busy = useSel(social.store, (s) => !!s.busy[friend.id]);
  const myRoom = useSel(social.shell.store, (s) => (s.screen.name === 'room' ? s.screen.code : null));
  const [menu, setMenu] = useState<'closed' | 'open' | 'remove' | 'block'>('closed');
  const tone = friend.status === 'in_room' ? 'volt' : friend.status === 'online' ? 'ok' : 'muted';
  // in a room yourself, Invite comes first (Join would leave it)
  const joinable = friend.status === 'in_room' && !!friend.room && friend.room !== myRoom && !myRoom;
  if (menu === 'remove' || menu === 'block') {
    const block = menu === 'block';
    return (
      <div className="sx-row sx-row--confirm" role="alertdialog" aria-label={block ? `Block ${friend.nickname}?` : `Remove ${friend.nickname}?`}>
        <span className="sx-row__who">
          <b>{block ? `Block ${friend.nickname}?` : `Remove ${friend.nickname}?`}</b>
          <span className="sx-row__line">{block ? "They won't be told, and can't see you or reach you." : "They won't be told. Add them again any time."}</span>
        </span>
        <button
          type="button"
          className={`btn btn--sm sx-act ${block ? 'btn--danger' : 'btn--paper'}`}
          onClick={() => {
            setMenu('closed');
            void (block ? social.block(friend) : social.remove(friend));
          }}
        >
          {block ? 'Block' : 'Remove'}
        </button>
        <button type="button" className="btn btn--ghost btn--sm sx-act" autoFocus onClick={() => setMenu('closed')}>
          Keep
        </button>
      </div>
    );
  }
  return (
    <div className={`sx-row sx-row--${friend.status}`} aria-busy={busy}>
      <Avatar name={friend.nickname} status={friend.status} ring={friend.status === 'in_room'} />
      <span className="sx-row__who">
        <b>{friend.nickname}</b>
        <span className={`sx-row__line sx-tone--${tone}`}>{friend.room && friend.room === myRoom ? 'In your room' : statusText(friend)}</span>
      </span>
      {extra ?? <InviteButton social={social} friend={friend} />}
      {joinable && (
        <button type="button" className="btn btn--volt btn--sm sx-act" onClick={() => social.join(friend)}>
          <Icon name="arrow-right" />
          Join
        </button>
      )}
      <span className="sx-menu">
        <button type="button" className="btn btn--ghost btn--sm btn--icon sx-act" aria-label={`More for ${friend.nickname}`} aria-expanded={menu === 'open'} onClick={() => setMenu(menu === 'open' ? 'closed' : 'open')}>
          <Icon name="sx-dots" />
        </button>
        {menu === 'open' && (
          <span className="sx-menu__pop" role="menu">
            <button type="button" role="menuitem" className="sx-menu__item" onClick={() => setMenu('remove')}>
              <Icon name="user-x" size="sm" />
              Remove friend
            </button>
            <button type="button" role="menuitem" className="sx-menu__item sx-menu__item--bad" onClick={() => setMenu('block')}>
              <Icon name="sx-ban" size="sm" />
              Block
            </button>
          </span>
        )}
      </span>
    </div>
  );
}
