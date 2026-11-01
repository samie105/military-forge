/**
 * Rooms (Home's Rooms tab, #/rooms; 1 Nov 2026, the owner: "a session where people can enter like the
 * room and all post it, or find anyone online"): the open rooms you may join, and who's on.
 *
 * The list (GET /rooms, ranked by the API: friends first, then lobbies, then the most people with a
 * seat free, then the newest) has a pinned first row that is always there, Play now's "Bots ready ·
 * join any time", so it is never empty. Each row: mode and map, the host (a friend badge), people and
 * bots apart, the phase, seats left, the host's tag and language, "Friend inside", and Join (Watch when
 * full). Filters: mode, friends, language, and Show full. A room taken meanwhile falls back to Play now.
 *
 * Online now (desktop: the right column; phone: its own tab): the counts (people only), Looking for a
 * match, recent players on (only those who chose it), friends on, and the two privacy switches.
 *
 * Every state says what's true: loading, a failed refresh (the last list stays, marked), offline,
 * under 18 or suspended, nothing open, nothing matching the filters. Keyboard, controller (the pinned
 * Play now is where a pad lands) and screen readers (one label per row) all work; motion is the kit's.
 */
import { LANG_LABELS, LFG_MODES, LFG_MODE_LABELS, type LfgMode, type RoomLang, type RoomRow } from '@military-forge/shared';
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { Icon } from '../ui/Icon';
import { Cap } from '../ui/Kbd';
import { Screen, Switch } from '../ui/Screen';
import { useCtl } from '../shell/context';
import { Backdrop, Hint, Hints, NetPill, OFFLINE_LINE, SUSPENDED_LINE } from '../shell/screens/frame';
import { PhoneScreen, rise } from '../shell/screens/phone/layout';
import { useSocial } from '../social/Squad';
import { Avatar } from '../social/FriendsPanel';
import { onlineFriends, statusText, useSel, type SocialController } from '../social/social';
import type { OnlinePlayer } from './api';
import { inviteOnceInRoom, roomsApi, useLooking, useOnlineNow, useRoomList, type OnlineData, type Polled } from './data';
import { DEFAULT_FILTERS, countsLine, filterRooms, langLine, langsIn, mapLine, modeLine, peopleLine, phaseLine, rowLabel, seatsLine, tagLine, type ModeFilter, type RoomFilters } from './format';
import './rooms.css';

const PHASE_ICON: Record<NonNullable<RoomRow['phase']>, string> = { lobby: 'play', starting: 'play', playing: 'clock', results: 'trophy' };
const phaseIcon = (p: RoomRow['phase']) => (p ? PHASE_ICON[p] : PHASE_ICON.lobby);

const MODE_FILTERS: readonly { id: ModeFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ffa', label: 'Deathmatch' },
  { id: 'teams', label: 'Teams' },
];

/** Why online rooms aren't open to this player, or null when they are. */
export function closedLine(profile: { offline: boolean; minor?: boolean; suspended?: { until: string | null } } | null): string | null {
  if (!profile) return 'Pick a name first: rooms are online.';
  if (profile.suspended) return SUSPENDED_LINE;
  if (profile.offline) return OFFLINE_LINE;
  if (profile.minor) return 'Online rooms are for players 18 and over. Training with bots is open to everyone.';
  return null;
}

export function RoomsScreen({ phone = false }: { phone?: boolean }) {
  const ctl = useCtl();
  const profile = useStore(ctl.store, (s) => s.profile);
  const closed = closedLine(profile);
  const api = useMemo(() => roomsApi(ctl.api), [ctl.api]);
  const list = useRoomList(api, closed === null);
  const online = useOnlineNow(api, closed === null);
  const [tab, setTab] = useState<'rooms' | 'online'>('rooms');
  const social = useSocial();

  const body = closed ? (
    <ClosedState line={closed} phone={phone} />
  ) : phone ? (
    tab === 'rooms' ? (
      <RoomList list={list} phone />
    ) : (
      <OnlinePanel online={online} social={social} phone />
    )
  ) : (
    <>
      <RoomList list={list} />
      <OnlinePanel online={online} social={social} />
    </>
  );

  if (phone)
    return (
      <PhoneScreen name="m-rooms" label="Rooms" word="ROOMS" dialog states={[closed ? 'closed' : list.status]}>
        <div className="pm rm rm--phone">
          <header className="pm-top">
            <button type="button" className="btn btn--ghost btn--icon btn--sm m-p8 pm-back" aria-label="Back to home" onClick={() => ctl.closeOverlay()}>
              <Icon name="back" />
            </button>
            <span className="pm-titles">
              <span className="pm-eyebrow">{online.data ? countsLine(online.data.now.counts) : 'Open rooms'}</span>
              <b className="display pm-h">Rooms</b>
            </span>
            <span className="menu-top__spacer"></span>
            {!closed && (
              <div className="seg rm-tabs" role="radiogroup" aria-label="Show">
                <button type="button" role="radio" className="seg__opt" aria-checked={tab === 'rooms'} onClick={() => setTab('rooms')}>
                  <Icon name="map" />
                  Rooms
                </button>
                <button type="button" role="radio" className="seg__opt" aria-checked={tab === 'online'} onClick={() => setTab('online')}>
                  <Icon name="users-plus" />
                  Online
                </button>
              </div>
            )}
          </header>
          <div className="rm-body">{body}</div>
        </div>
      </PhoneScreen>
    );

  return (
    <Screen name="rooms" kind="menu" label="Rooms" dialog states={[closed ? 'closed' : list.status]}>
      <Backdrop word="ROOMS" />
      <div className="menu">
        <header className="menu-top">
          <button className="btn btn--ghost btn--icon btn--sm m-p8" type="button" aria-label="Back to home" onClick={() => ctl.closeOverlay()}>
            <Icon name="back" />
          </button>
          <span className="label">Home</span>
          <h1 className="menu-top__title">Rooms</h1>
          {online.data && !closed && (
            <span className="tag tag--ghost rm-count" role="status">
              <span className="dot" aria-hidden="true"></span>
              {countsLine(online.data.now.counts)}
            </span>
          )}
          <span className="menu-top__spacer"></span>
          <NetPill offline={!!profile?.offline} />
        </header>
        <div className="menu-body rm">{body}</div>
        <Hints>
          <Hint keys={<Cap>Enter</Cap>} pad="Pad0">
            Join
          </Hint>
          <Hint keys={<Cap>Tab</Cap>}>Next</Hint>
          <Hint keys={<Cap>Esc</Cap>} pad="Pad1">
            Back
          </Hint>
        </Hints>
      </div>
    </Screen>
  );
}

export function ClosedState({ line, phone }: { line: string; phone: boolean }) {
  const ctl = useCtl();
  return (
    <div className={`rm-closed card card--print${phone ? ' rm-closed--phone' : ''}`} role="status">
      <Icon name="unplug" size="lg" />
      <p>{line}</p>
      <button type="button" className="btn btn--volt btn--sm m-p8" data-pad-first onClick={() => ctl.go({ to: 'training' })}>
        <Icon name="target" />
        Training
      </button>
    </div>
  );
}

/** The list: the filters, the pinned Play now row, the rooms. */
export function RoomList({ list, phone = false, initialFilters = DEFAULT_FILTERS }: { list: Polled<RoomRow[]>; phone?: boolean; initialFilters?: RoomFilters }) {
  const ctl = useCtl();
  const [filters, setFilters] = useState<RoomFilters>(initialFilters);
  const [busy, setBusy] = useState<string | null>(null);
  const rows = list.data ?? [];
  const shown = filterRooms(rows, filters);
  const langs = langsIn(rows);
  const hiddenFull = rows.filter((r) => r.seats <= 0).length;
  const set = (change: Partial<RoomFilters>) => setFilters((f) => ({ ...f, ...change }));
  const join = async (code: string) => {
    setBusy(code);
    await ctl.joinListed(code);
    setBusy(null);
  };
  const filtered = filters.mode !== 'all' || filters.friends || filters.lang !== null;

  return (
    <section className={`rm-list-wrap${phone ? ' rm-list-wrap--phone' : ''}`} aria-labelledby="rm-list-t">
      <div className="rm-bar">
        <h2 id="rm-list-t" className={phone ? 'vh' : 'display rm-h'}>
          Open rooms
        </h2>
        <div className="seg rm-seg" role="radiogroup" aria-label="Mode">
          {MODE_FILTERS.map((m) => (
            <button key={m.id} type="button" role="radio" className="seg__opt" aria-checked={filters.mode === m.id} onClick={() => set({ mode: m.id })}>
              {m.label}
            </button>
          ))}
        </div>
        <button type="button" className={`btn btn--sm m-p8 rm-chip${filters.friends ? ' is-on' : ''}`} aria-pressed={filters.friends} onClick={() => set({ friends: !filters.friends })}>
          <Icon name="users-plus" />
          Friends
        </button>
        {langs.length > 0 && (
          <label className="rm-lang">
            <span className="vh">Language</span>
            <select value={filters.lang ?? ''} onChange={(e) => set({ lang: (e.target.value || null) as RoomLang | null })}>
              <option value="">Any language</option>
              {langs.map((l) => (
                <option key={l} value={l}>
                  {LANG_LABELS[l]}
                </option>
              ))}
            </select>
          </label>
        )}
        <span className="rm-bar__end">
          <Switch on={filters.showFull} onChange={(v) => set({ showFull: v })} label="Show full" showState={false} />
        </span>
      </div>

      <div className="rm-status" role="status" aria-live="polite">
        {list.status === 'loading' && (
          <span className="status status--busy">
            <span className="spinner" aria-hidden="true"></span>
            Finding rooms…
          </span>
        )}
        {list.error && (
          <span className="status status--bad">
            <Icon name="bad" size="sm" />
            {list.data ? `${list.error}: showing the last list` : list.error}
            <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={() => void list.reload()}>
              <Icon name="refresh" />
              Try again
            </button>
          </span>
        )}
        {list.status === 'ready' && !list.error && (
          <span className="rm-status__n">
            {shown.length === 0 ? (rows.length === 0 ? 'No open rooms right now' : 'No rooms match these filters') : `${shown.length} ${shown.length === 1 ? 'room' : 'rooms'} open`}
            {!filters.showFull && hiddenFull > 0 ? ` · ${hiddenFull} full hidden` : ''}
          </span>
        )}
      </div>

      <ul className="rm-list" aria-label="Open rooms" aria-busy={list.status === 'loading'}>
        {/* never empty: Play now is always there, its bots ready */}
        <li className="rm-row rm-row--pinned m-p3" style={rise(0)} aria-label="Bots ready, join any time. Play now">
          <span className="rm-row__icon" aria-hidden="true">
            <Icon name="bot" />
          </span>
          <span className="rm-row__main">
            <b className="rm-row__title">Bots ready · join any time</b>
            <span className="rm-row__sub">Play now: a fight at once, others on Play now may join</span>
          </span>
          <button type="button" className="btn btn--volt btn--sm m-p8 rm-row__act" data-pad-first onClick={() => ctl.playNow()}>
            <Icon name="play" />
            Play now
          </button>
        </li>
        {list.status === 'loading' && !list.data && [0, 1, 2].map((i) => <li key={i} className="rm-row rm-row--ghost" aria-hidden="true"></li>)}
        {shown.map((r, i) => (
          <RoomRowItem key={r.code} r={r} i={i + 1} busy={busy === r.code} disabled={busy !== null} onJoin={() => void join(r.code)} onWatch={() => ctl.watch(r.code)} phone={phone} />
        ))}
      </ul>
      {list.status === 'ready' && shown.length === 0 && (
        <p className="rm-empty">
          {rows.length === 0 ? (
            <>
              Nobody has opened a room to everyone yet. <b>Play now</b> makes one others can join, or <b>Create room</b> and set it to Public in its lobby.
            </>
          ) : (
            <>
              {filtered ? 'Nothing matches. ' : 'Every open room is full. '}
              <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={() => setFilters(filtered ? DEFAULT_FILTERS : { ...filters, showFull: true })}>
                {filtered ? 'Clear filters' : 'Show full rooms'}
              </button>
            </>
          )}
        </p>
      )}
    </section>
  );
}

function RoomRowItem({ r, i, busy, disabled, onJoin, onWatch, phone }: { r: RoomRow; i: number; busy: boolean; disabled: boolean; onJoin: () => void; onWatch: () => void; phone: boolean }) {
  const full = r.seats <= 0;
  const mode = modeLine(r.teams) ?? 'New room';
  const map = mapLine(r.map);
  const tag = tagLine(r.tag);
  const lang = langLine(r.lang);
  return (
    <li className={`rm-row m-p3${full ? ' rm-row--full' : ''}${r.friendInside || r.host.friend ? ' rm-row--friend' : ''}`} style={rise(Math.min(i, 10)) as CSSProperties} aria-label={rowLabel(r)}>
      <span className="rm-row__main">
        <b className="rm-row__title">
          {mode}
          {map && <span className="rm-row__map"> · {map}</span>}
        </b>
        <span className="rm-row__sub">
          <Icon name="crown" size="sm" />
          <span className="rm-row__host">{r.host.name}</span>
          {r.host.friend && <span className="tag tag--ok rm-tag">Friend</span>}
          {r.quick && <span className="tag tag--ghost rm-tag">Open</span>}
          {r.visibility === 'friends' && <span className="tag tag--ghost rm-tag">Friends</span>}
        </span>
      </span>
      <span className="rm-row__who">
        <span className="rm-row__people">
          <Icon name="user" size="sm" />
          {peopleLine(r.people, r.bots)}
        </span>
        <span className={`rm-row__phase rm-phase--${r.phase ?? 'lobby'}`}>
          <Icon name={phaseIcon(r.phase)} size="sm" />
          {phaseLine(r)}
        </span>
      </span>
      {!phone && (
        <span className="rm-row__tags">
          {r.friendInside && (
            <span className="tag tag--you rm-tag">
              <Icon name="users-plus" />
              Friend inside
            </span>
          )}
          {tag && <span className="tag tag--paper rm-tag">{tag}</span>}
          {lang && (
            <span className="tag tag--ghost rm-tag" lang={r.lang ?? undefined}>
              <Icon name="globe" />
              {lang}
            </span>
          )}
        </span>
      )}
      <span className="rm-row__end">
        <span className={`rm-row__seats${full ? ' is-full' : ''}`}>{seatsLine(r.seats)}</span>
        {phone && r.friendInside && <span className="tag tag--you rm-tag">Friend inside</span>}
        {full ? (
          <button type="button" className="btn btn--ghost btn--sm m-p8 rm-row__act" disabled={disabled} onClick={onWatch} aria-label={`Watch ${r.host.name}'s room`}>
            <Icon name="eye" />
            Watch
          </button>
        ) : (
          <button type="button" className="btn btn--volt btn--sm m-p8 rm-row__act" disabled={disabled} onClick={onJoin} aria-label={`Join ${r.host.name}'s room`}>
            <Icon name="door-out" />
            {busy ? 'Joining…' : 'Join'}
          </button>
        )}
      </span>
    </li>
  );
}

/** Online now: the counts, Looking for a match, recent players and friends on, the privacy switches. */
export function OnlinePanel({ online, social, phone = false }: { online: Polled<OnlineData>; social: SocialController | null; phone?: boolean }) {
  const ctl = useCtl();
  const api = useMemo(() => roomsApi(ctl.api), [ctl.api]);
  const looking = useLooking(api, online, (line) => ctl.notify(line));
  const data = online.data;
  const settings = data?.now.settings ?? null;
  const [privacy, setPrivacy] = useState<{ appearOffline: boolean; showToRecent: boolean } | null>(null);
  const shownPrivacy = privacy ?? settings;
  useEffect(() => setPrivacy(null), [settings?.appearOffline, settings?.showToRecent]);
  const setSetting = async (change: Partial<{ appearOffline: boolean; showToRecent: boolean }>) => {
    if (!shownPrivacy) return;
    const before = privacy;
    setPrivacy({ ...shownPrivacy, ...change });
    try {
      setPrivacy(await api.setOnlineSettings(change));
      void online.reload();
    } catch {
      setPrivacy(before);
      ctl.notify("Can't reach the server: try again");
    }
  };
  const inviteNew = (p: OnlinePlayer) => {
    if (!social) return;
    // no room yet: make one, then the invite goes once its lobby is up
    inviteOnceInRoom(ctl.store, (who) => social.invite(who), [{ id: p.id, nickname: p.nickname }]);
    ctl.go({ to: 'create' });
    ctl.notify(`Making a room for you and ${p.nickname}`);
  };
  const minutes = looking.until ? Math.max(1, Math.ceil((Date.parse(looking.until) - Date.now()) / 60_000)) : null;

  return (
    <aside className={`rm-online${phone ? ' rm-online--phone' : ''}`} aria-labelledby="rm-online-t">
      <header className="rm-online__head">
        <span className="label label--volt" id="rm-online-t">
          Online now
        </span>
        <b className="display rm-online__count" aria-live="polite">
          {data ? countsLine(data.now.counts) : online.status === 'error' ? '–' : '…'}
        </b>
        {data && data.now.counts.online >= 5 && <span className="rm-online__note">People only, never bots</span>}
      </header>
      {online.error && (
        <p className="status status--bad rm-online__err">
          <Icon name="bad" size="sm" />
          {online.error}
          <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={() => void online.reload()}>
            Try again
          </button>
        </p>
      )}

      <section className="rm-lfg card" aria-labelledby="rm-lfg-t">
        <div className="rm-lfg__top">
          <span className="rm-lfg__words">
            <b id="rm-lfg-t">Looking for a match</b>
            <span className="rm-lfg__sub">{looking.on ? (minutes ? `Others can see you and invite you · ${minutes} min left` : 'Turning on…') : 'Lists you for 15 minutes so others can invite you'}</span>
          </span>
          <Switch on={looking.on} onChange={(v) => void looking.set(v, looking.mode)} label="Looking for a match" />
        </div>
        <div className="seg rm-seg" role="radiogroup" aria-label="Mode you want">
          {LFG_MODES.map((m: LfgMode) => (
            <button key={m} type="button" role="radio" className="seg__opt" aria-checked={looking.mode === m} onClick={() => void (looking.on ? looking.set(true, m) : looking.set(false, m))}>
              {LFG_MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </section>

      <PeopleList
        title="Looking now"
        empty={data ? 'Nobody else is looking right now.' : null}
        players={data?.looking ?? []}
        line={(p) => `Level ${p.level} · ${LFG_MODE_LABELS[p.mode ?? 'any']}${p.where ? ` · in a ${p.where}` : ''}`}
        act={(p) =>
          p.room ? (
            <button type="button" className="btn btn--volt btn--sm sx-act" onClick={() => void ctl.joinListed(p.room!)}>
              Join
            </button>
          ) : social ? (
            <button type="button" className="btn btn--paper btn--sm sx-act" onClick={() => inviteNew(p)} aria-label={`Make a room and invite ${p.nickname}`}>
              Invite
            </button>
          ) : null
        }
      />

      {social && <FriendsOn social={social} />}

      <PeopleList
        title="Played with lately"
        empty={data ? 'Nobody you played with this week is showing as on.' : null}
        players={data?.recent ?? []}
        line={(p) => `Level ${p.level} · ${p.where === 'match' ? 'In a match' : p.where === 'lobby' ? 'In a lobby' : 'On the menus'}`}
        act={(p) =>
          p.room ? (
            <button type="button" className="btn btn--volt btn--sm sx-act" onClick={() => void ctl.joinListed(p.room!)}>
              Join
            </button>
          ) : null
        }
      />

      <section className="rm-privacy" aria-label="Your privacy">
        <span className="label">Your privacy</span>
        <div className="rm-privacy__row">
          <span className="rm-privacy__words">
            <b>Appear offline</b>
            <span>Friends see you offline. You leave every list here.</span>
          </span>
          {shownPrivacy && <Switch on={shownPrivacy.appearOffline} onChange={(v) => void setSetting({ appearOffline: v })} label="Appear offline" />}
        </div>
        <div className="rm-privacy__row">
          <span className="rm-privacy__words">
            <b>Show me to people I played with</b>
            <span>For 7 days after a match. Off: only friends see you.</span>
          </span>
          {shownPrivacy && <Switch on={shownPrivacy.showToRecent} onChange={(v) => void setSetting({ showToRecent: v })} label="Show me to people I played with" />}
        </div>
      </section>
    </aside>
  );
}

function PeopleList({ title, empty, players, line, act }: { title: string; empty: string | null; players: readonly OnlinePlayer[]; line: (p: OnlinePlayer) => string; act: (p: OnlinePlayer) => ReactNode }) {
  return (
    <section className="rm-people" aria-label={title}>
      <span className="label">
        {title} · {players.length}
      </span>
      {players.length === 0 && empty && <p className="rm-people__empty">{empty}</p>}
      {players.length > 0 && (
        <ul className="rm-people__list">
          {players.map((p) => (
            <li key={p.id} className="sx-row rm-person">
              <Avatar name={p.nickname} look={p.look} status={p.where ? 'in_room' : 'online'} ring={p.where !== null} />
              <span className="sx-row__who">
                <b>
                  {p.nickname}
                  {p.friend && <span className="tag tag--ok rm-tag">Friend</span>}
                </b>
                <span className="sx-row__line">{line(p)}</span>
              </span>
              {act(p)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FriendsOn({ social }: { social: SocialController }) {
  useEffect(() => social.watch(30_000), [social]);
  const list = useSel(social.store, (s) => s.list);
  const on = onlineFriends(list);
  return (
    <section className="rm-people" aria-label="Friends online">
      <span className="label">Friends online · {list ? on.length : '…'}</span>
      {list && on.length === 0 && <p className="rm-people__empty">{list.friends.length === 0 ? 'Add friends from Friends on Home to see them here.' : 'No friends on right now.'}</p>}
      {on.length > 0 && (
        <ul className="rm-people__list">
          {on.slice(0, 6).map((f) => (
            <li key={f.id} className="sx-row rm-person">
              <Avatar name={f.nickname} look={f.look} status={f.status} ring={f.status === 'in_room'} />
              <span className="sx-row__who">
                <b>{f.nickname}</b>
                <span className={`sx-row__line sx-tone--${f.status === 'in_room' ? 'volt' : 'ok'}`}>{statusText(f)}</span>
              </span>
              {f.status === 'in_room' && f.room && (
                <button type="button" className="btn btn--volt btn--sm sx-act" onClick={() => social.join(f)}>
                  Join
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

