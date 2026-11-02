/**
 * M3 · Phone lobby (the kit's data-screen="m-lobby"), two columns about 40/60 (UX-23). Left: a compact
 * share card (the room code as its headline, Share link through the phone's own share sheet, the QR
 * behind Show QR, Invite friends, the room's listing), and under it the Lobby feed's latest line. Right:
 * the roster with who's ready, the map and rules line (it opens a bottom sheet: the host edits, guests
 * read), and the one action pinned to the bottom across the column: Start now for the host, Ready for a
 * guest (UX-21). A local room keeps its own share poster (its QR is the way in). "Warm up" folds the
 * lobby to a strip so the player can move and shoot behind it. Same actions and words as the desktop
 * Lobby; a spectator (v20) gets Join next round (or Stay watching) in Ready's place, and no warm-up.
 *
 * Motion: the room code focus-pulls in (P1), the cards are there on the first frame and the roster's
 * rows rise in turn (P3; UX-98); a player joining rises in, the counts roll (P4), a ready tick stamps
 * (P7); Share is P8, then the share sheet, then a "Shared" stamp.
 */
import { maps } from '@military-forge/content';
import type { LobbyEntry } from '@military-forge/shared';
import { ROOM_SETTING_LIMITS } from '@military-forge/protocol';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../ui/Icon';
import { blurAfter } from '../../../ui/Screen';
import { useCtl } from '../../context';
import { roomLink } from '../../controller';
import type { Bindings } from '../../controls';
import { playerName } from '../../matchView';
import { READY_WORDS, isReady, readyCount, readyLine, type LobbyPlayer, type LobbyView } from '../../onlineView';
import { encodeQr, qrSvgPath } from '../../qr';
import { MapPoster } from '../../posters';
import { KILL_STEP, ROOM_SLOTS, TIME_CHOICES, killsLabel, lobbyMaps, minutesLabel, useLeaveConfirm, useRoomSetting, useSpectating } from '../Lobby';
import { leaveCost } from '../Pause';
import { PhoneScreen, rise } from './layout';
import { LobbyInvite } from '../../../social/SocialLayer';
import { Roll, ShareChip, Sheet, shareRoom, useShareChip, type ShareOutcome } from './parts';
import { PhoneTips } from './PhoneTips';
import { PlayerAvatar } from '../../../presentation/PlayerAvatar';
import { AddFriendButton, RowActions } from '../../../social/AddFriend';
import { TeamRoster } from '../../../teams/TeamRoster';
import { BOT_LEVELS, BOT_LEVEL_NAMES, botFillChoices, botsLine, type BotLevel } from '../../roomBots';
import { LobbyRadio } from '../../../voice/Radio';
import { PlayerMore, roomTarget } from '../../../social/ReportSheet';
import { RoomListing } from '../../../rooms/RoomListing';
import { useFeed } from '../../../feed/LobbyFeed';
import { useFeedSel, type FeedController } from '../../../feed/feed';

function Row({ p, i, friendly = false }: { p: LobbyPlayer; i: number; friendly?: boolean }) {
  // a bot is always ready; the host starts the match, so is too (UX-21)
  const ready = isReady(p);
  return (
    <li className={`pm-row m-p3${p.you ? ' is-you' : ''}`} style={rise(i)}>
      {/* the player's soldier as their avatar (presentation/, owner 23 Oct) */}
      <PlayerAvatar id={p.id} name={p.name} bot={p.isBot} />
      <b className="pm-row__name">{playerName(p.name, p.isBot)}</b>
      {p.host && (
        <span className="tag tag--host">
          <Icon name="crown" />
          Host
        </span>
      )}
      {p.isBot && <span className="tag tag--bot">Bot</span>}
      <span className="menu-top__spacer"></span>
      {/* the people in the room with you (audit 2 P-06); Report / Block sit in the same slot */}
      {friendly && !p.you && !p.isBot && (
        <RowActions>
          <AddFriendButton name={p.name} compact />
        </RowActions>
      )}
      {/* keyed by the state, so a player readying up stamps in (P7) */}
      <span key={ready ? 'ready' : 'wait'} className={`prow__ready${ready ? ' is-ready m-p7' : ''}`}>
        <Icon name={ready ? 'check' : 'clock'} size="sm" />
        {ready ? READY_WORDS.ready : READY_WORDS.notReady}
      </span>
      {/* report, block, mute, the host's remove (audit-2 L-01, L-02, L-11) */}
      <PlayerMore target={roomTarget(p, 'lobby')} />
    </li>
  );
}

/**
 * A local room's half of the share poster (the Pen board's S1, 24 Oct): ONE QR, the room link, which a
 * friend's phone camera opens straight into the room (the link finds the local room through the relay),
 * with the code beside it for Join. The QR swap (no internet at all) is the host's fallback link under
 * it; with no internet there's no code, so it's the way in.
 */
function PhoneLocalShare({ lobby, qr }: { lobby: LobbyView; qr: { viewBox: string; path: string } }) {
  const ctl = useCtl();
  const swap = (
    <button type="button" className={lobby.code ? 'pm-lan__swap m-p8' : 'btn btn--ink btn--block m-p8 pm-lan__add'} onClick={blurAfter(() => ctl.openOverlay('lan-add'))}>
      <Icon name="qr" size={lobby.code ? 'sm' : undefined} />
      {lobby.code ? (
        <span>
          <span className="pm-more">No internet? </span>Swap QR codes
        </span>
      ) : (
        <span>
          Add<span className="pm-more"> a player</span> by QR
        </span>
      )}
    </button>
  );
  if (!lobby.code) {
    return (
      <>
        <div className="paper pm-lan__how">
          <span className="label">
            <Icon name="wifi" size="sm" />
            Local room · no internet
          </span>
          <b className="display pm-lan__how-t">Friends join by QR</b>
        </div>
        {lobby.isHost ? swap : null}
        <span className="pm-lan__hint">{lobby.isHost ? 'One QR swap per friend.' : 'The host adds each friend with a QR swap.'}</span>
      </>
    );
  }
  return (
    <>
      <div className="paper pm-lan__scan">
        <span className="qr pm-lan__qr" role="img" aria-label={`QR code for room ${lobby.code}: a phone's camera opens it straight into the room`}>
          <svg viewBox={qr.viewBox} shapeRendering="crispEdges" aria-hidden="true">
            <path fill="var(--c-qr-dark)" d={qr.path} />
          </svg>
        </span>
        <span className="pm-lan__scan-t">
          <span className="label">
            <Icon name="wifi" size="sm" />
            Scan to join
          </span>
          <b className="display pm-lan__how-code num">{lobby.code}</b>
          <span className="pm-lan__scan-line">Same Wi-Fi: phone camera at the code, or type it in Join.</span>
        </span>
      </div>
      {lobby.isHost && swap}
    </>
  );
}

/** The lobby folded away for warm-up: the code, who's ready, the one action, and the way back (top centre, clear of the dials). */
function PhoneLobbyStrip({ lobby, onOpen }: { lobby: LobbyView; onOpen: () => void }) {
  const ctl = useCtl();
  const { ready, people } = readyCount(lobby.players);
  const enough = lobby.players.length >= lobby.minPlayers;
  return (
    <PhoneScreen name="m-lobby" kind="game" label="Room lobby (folded)" states={['folded', lobby.ready ? 'ready' : 'not-ready']}>
      <div className="pm-strip plate m-p9" role="region" aria-label={`Room ${lobby.code}, warming up`}>
        <span className="pm-strip__ready">
          <Roll value={ready} />/<Roll value={people} /> ready
        </span>
        {lobby.isHost ? (
          <button type="button" className="btn btn--sm btn--icon btn--volt m-p8" aria-label={READY_WORDS.start} disabled={!enough} onClick={blurAfter(() => ctl.host.online?.startMatch())}>
            <Icon name="play" />
          </button>
        ) : (
          <button type="button" className={`btn btn--sm btn--icon m-p8 ${lobby.ready ? 'btn--ghost' : 'btn--volt'}`} aria-label={lobby.ready ? `${READY_WORDS.youReady}: tap for ${READY_WORDS.notReady.toLowerCase()}` : READY_WORDS.ready} onClick={blurAfter(() => ctl.host.online?.setReady(!lobby.ready))}>
            <Icon name={lobby.ready ? 'check' : 'clock'} />
          </button>
        )}
        <LobbyRadio players={lobby.players} phone />
        <button type="button" className="btn btn--ghost btn--sm btn--icon m-p8" aria-label="Open the lobby" onClick={blurAfter(onOpen)}>
          <Icon name="users-plus" />
        </button>
      </div>
    </PhoneScreen>
  );
}

/** The match rules: the host sets the time and kill limits (the room answers), guests read them. */
function RulesSheet({ lobby, open, onClose }: { lobby: LobbyView; open: boolean; onClose: () => void }) {
  const ctl = useCtl();
  const online = ctl.host.online;
  const [timeLimit, showTime] = useRoomSetting(lobby.timeLimit);
  const [kills, showKills] = useRoomSetting(lobby.killLimit);
  const [bots, showBots] = useRoomSetting(lobby.bots);
  const [botLevel, showBotLevel] = useRoomSetting<BotLevel>(lobby.botLevel);
  const [mapId, showMap] = useRoomSetting(lobby.mapId);
  const limits = ROOM_SETTING_LIMITS;
  const times = TIME_CHOICES.filter((m) => m === 0 || (m * 60 >= limits.timeLimit.min && m * 60 <= limits.timeLimit.max));
  const host = lobby.isHost;
  const setKills = (k: number) => {
    showKills(k);
    online?.setMatchSettings({ killLimit: k });
  };
  const setTime = (seconds: number) => {
    showTime(seconds);
    online?.setMatchSettings({ timeLimit: seconds });
  };
  return (
    <Sheet open={open} onClose={onClose} label="Match rules">
      <div className="pm-sheet__head">
        <b className="display">Match rules</b>
        <span className="menu-top__spacer"></span>
        {!host && <span className="tag tag--ghost">The host sets these</span>}
        <button type="button" className="btn btn--ghost btn--sm btn--icon m-p8" aria-label="Close" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      <div className="pm-sheet__row">
        <span className="label">Mode</span>
        <div className="seg pm-seg" role="radiogroup" aria-label="Mode">
          {[0, 2, 3, 4].map((t) => (
            <button type="button" key={t} role="radio" aria-checked={(lobby.teams ?? 0) === t} className="seg__opt m-p8" disabled={!host} onClick={() => online?.setMatchSettings({ teams: t })}>
              {t === 0 ? 'Free-for-all' : `${t} teams`}
            </button>
          ))}
        </div>
      </div>
      <div className="pm-sheet__row">
        <span className="label">Map</span>
        {/* each map by its poster (a frame from the game) and its name */}
        <div className="pm-maps" role="radiogroup" aria-label="Map">
          {lobbyMaps(lobby.mapId).map((id) => (
            <button type="button" key={id} role="radio" aria-checked={mapId === id} className="pm-map m-p8" disabled={!host} onClick={() => {
              showMap(id);
              online?.setMatchSettings({ mapId: id });
            }}>
              <MapPoster id={id} kind="card" sizes="150px" />
              <span className="pm-map__name">{maps[id]?.name ?? id}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="pm-sheet__row">
        <span className="label">Time limit</span>
        <div className="seg pm-seg" role="radiogroup" aria-label="Time limit">
          {times.map((m) => {
            const on = timeLimit === m * 60;
            return (
              // no time limit and no kill limit together: a match has to end somehow (ROOM_SETTING_LIMITS)
              <button type="button" key={m} role="radio" aria-checked={on} className="seg__opt m-p8" disabled={!host || (m === 0 && kills === 0)} onClick={() => setTime(m * 60)}>
                {m === 0 ? '∞' : `${m}m`}
              </button>
            );
          })}
        </div>
      </div>
      <div className="pm-sheet__row">
        <span className="label">Kill limit</span>
        <div className="stepper pm-stepper">
          <button type="button" className="btn btn--ink btn--sm btn--icon m-p8" aria-label="Fewer kills" disabled={!host || (kills !== 0 && kills <= limits.killLimit.min)} onClick={() => setKills(kills === 0 ? limits.killLimit.min : Math.max(limits.killLimit.min, kills - KILL_STEP))}>
            <Icon name="minus" />
          </button>
          <span className="stepper__val">
            <Roll value={kills === 0 ? '∞' : kills} />
          </span>
          <button type="button" className="btn btn--ink btn--sm btn--icon m-p8" aria-label="More kills" disabled={!host || kills >= limits.killLimit.max} onClick={() => setKills(kills === 0 ? limits.killLimit.min : Math.min(limits.killLimit.max, kills + KILL_STEP))}>
            <Icon name="plus" />
          </button>
          {host && (
            <button type="button" className="btn btn--ghost btn--sm m-p8" disabled={kills === 0 || timeLimit === 0} onClick={() => setKills(0)}>
              No limit
            </button>
          )}
        </div>
      </div>
      {/* the room's bots (desktop UI agent, v17): live, mid-match too */}
      <div className="pm-sheet__row">
        <span className="label">Bots</span>
        <div className="seg pm-seg" role="radiogroup" aria-label="Bots">
          {botFillChoices(bots).map((n) => (
            <button type="button" key={n} role="radio" aria-checked={bots === n} className="seg__opt m-p8" disabled={!host} onClick={() => (showBots(n), online?.setMatchSettings({ bots: n }))}>
              {n === 0 ? 'Off' : n}
            </button>
          ))}
        </div>
      </div>
      <div className="pm-sheet__row">
        <span className="label">Bot level</span>
        <div className="seg pm-seg" role="radiogroup" aria-label="Bot level">
          {BOT_LEVELS.map((l) => (
            <button type="button" key={l} role="radio" aria-checked={botLevel === l} className="seg__opt m-p8" disabled={!host || bots === 0} onClick={() => (showBotLevel(l), online?.setMatchSettings({ botLevel: l }))}>
              {BOT_LEVEL_NAMES[l]}
            </button>
          ))}
        </div>
      </div>
      <p className="pm-sheet__note">
        {minutesLabel(timeLimit)} · {killsLabel(kills)} · {botsLine(bots, botLevel)}
        {lobby.rules ? ' · Custom rules' : ''}
      </p>
    </Sheet>
  );
}


/**
 * The share card (UX-23): the room code as its headline, Share link (volt) through the phone's share
 * sheet, the QR behind Show QR (for a friend next to you), then Invite friends and the room's listing.
 */
function PhoneShareCard({ lobby, qr, onShared }: { lobby: LobbyView; qr: { viewBox: string; path: string }; onShared: (outcome: ShareOutcome) => void }) {
  const [showQr, setShowQr] = useState(false);
  const shownLink = roomLink(lobby.code).replace(/^https?:\/\//, '');
  return (
    <section className="ticket pm-sharecard" aria-label="Invite friends">
      {showQr ? (
        <div className="pm-sharecard__qr" id="pm-room-qr">
          <span className="qr" role="img" aria-label="QR code for the room link">
            <svg viewBox={qr.viewBox} shapeRendering="crispEdges" aria-hidden="true">
              <path fill="var(--c-qr-dark)" d={qr.path} />
            </svg>
          </span>
          <span className="pm-sharecard__qr-t">
            <span className="label">
              <Icon name="globe" size="sm" />
              Scan to join
            </span>
            <b className="display num">{lobby.code}</b>
            <span className="pm-sharecard__link" data-bind="lobby.links.internet">
              {shownLink}
            </span>
          </span>
        </div>
      ) : (
        <div className="pm-sharecard__head">
          <span className="label">Room code</span>
          <b className="display pm-sharecard__code num" aria-label={`Room code ${[...lobby.code].join(' ')}`}>
            {lobby.code}
          </b>
        </div>
      )}
      <div className="pm-sharecard__acts">
        <button type="button" className="btn btn--volt pm-sharecard__share m-p8" onClick={blurAfter(() => void shareRoom(lobby.code).then(onShared))}>
          <Icon name="share" />
          Share link
        </button>
        {/* the QR waits behind its toggle: the code and the link are what most friends need */}
        <button type="button" className="btn btn--paper btn--icon pm-sharecard__qrbtn m-p8" aria-pressed={showQr} aria-controls="pm-room-qr" aria-label={showQr ? 'Hide QR' : 'Show QR'} title={showQr ? 'Hide QR' : 'Show QR'} onClick={blurAfter(() => setShowQr(!showQr))}>
          <Icon name={showQr ? 'close' : 'qr'} />
        </button>
      </div>
      {/* friends (social/): invite them straight to this room */}
      <LobbyInvite phone />
      {/* who finds the room in Rooms, Post to Lobby, WhatsApp (rooms/): a chip that opens a sheet */}
      <RoomListing code={lobby.code} phone />
    </section>
  );
}

/** One line of the Lobby feed, short, for the lobby's peek. */
export function peekLine(e: LobbyEntry): string {
  switch (e.kind) {
    case 'chat':
      return `${e.from.name}: ${e.text}`;
    case 'room_posted':
      return `${e.hostName} opened a room`;
    case 'match_result':
      return e.winnerName ? `${e.winnerName} won on ${maps[e.map]?.name ?? e.map}` : `A bot took ${maps[e.map]?.name ?? e.map}`;
    case 'welcome':
      return `${e.name} joined · say welcome`;
    case 'level_up':
      return `${e.name} reached level ${e.level}`;
  }
}

/**
 * The Lobby feed under the share card (UX-23: the left column's space, not a third column): its latest
 * line and the dot for something new; a tap opens the feed's own sheet with Quick chat.
 */
function FeedPeek() {
  const feed = useFeed();
  return feed ? <FeedPeekBody feed={feed} /> : null;
}

function FeedPeekBody({ feed }: { feed: FeedController }) {
  useEffect(() => {
    if (feed.store.getState().status === 'idle') void feed.load();
  }, [feed]);
  const last = useFeedSel(feed, (s) => s.entries.filter((e) => e.kind !== 'chat' || (!s.hideChat && !s.muted[e.from.id])).at(-1) ?? null);
  const status = useFeedSel(feed, (s) => s.status);
  const unread = useFeedSel(feed, (s) => s.unread && !s.hideChat);
  const line = last ? peekLine(last) : status === 'ready' ? 'Nothing yet today · say hi with Quick chat' : 'Everyone playing right now';
  return (
    <button type="button" className="card card--print pm-feed m-p8" aria-label={`Lobby: public chat. ${line}`} onClick={() => feed.open()}>
      <Icon name="chat" />
      <span className="pm-feed__t">
        <b>
          Lobby
          {unread && <span className="lf-dot" aria-hidden="true"></span>}
        </b>
        <span className="pm-feed__line">{line}</span>
      </span>
      <Icon name="chev-right" size="sm" />
    </button>
  );
}

/**
 * The phone roster's order: the host, you, the other people, then the bots. The list shows about three
 * rows above the action, and a guest's own row (where Not ready shows) fell below them.
 */
export function phoneOrder(players: readonly LobbyPlayer[]): LobbyPlayer[] {
  const rank = (p: LobbyPlayer) => (p.host ? 0 : p.you ? 1 : p.isBot ? 3 : 2);
  return [...players].sort((a, b) => rank(a) - rank(b));
}

/** A guest's one action (UX-21): Ready, which becomes a "You're ready" stamp with Not ready beside it. */
function PhoneGuestReady({ ready, padFirst }: { ready: boolean; padFirst: boolean }) {
  const online = useCtl().host.online;
  if (ready)
    return (
      <>
        <span className="stamp stamp--ok pm-ready m-p7" role="status">
          <Icon name="check" />
          {READY_WORDS.youReady}
        </span>
        <button type="button" className="btn btn--ghost btn--sm pm-unready m-p8" data-pad-first={padFirst || undefined} onClick={blurAfter(() => online?.setReady(false))}>
          {READY_WORDS.notReady}
        </button>
      </>
    );
  return (
    <button type="button" className="btn btn--volt m-p8" data-pad-first={padFirst || undefined} onClick={blurAfter(() => online?.setReady(true))}>
      <Icon name="check" />
      {READY_WORDS.ready}
    </button>
  );
}

/**
 * `tips`: set while the first-run controls card is due (it shows once the lobby folds): the touch tips,
 * not the desktop's keys. The props match the desktop Lobby's; the bindings and `doubleTapDash` are the keyboard's.
 */
export function PhoneLobby({ lobby, tips = null }: { lobby: LobbyView; tips?: Bindings | null; doubleTapDash?: boolean }) {
  const ctl = useCtl();
  const online = ctl.host.online;
  const { spectating, queued } = useSpectating();
  const [folded, setFolded] = useState(false);
  const [rules, setRules] = useState(false);
  const leaving = useLeaveConfirm();
  const [chip, showChip] = useShareChip();
  const link = roomLink(lobby.code);
  const qr = useMemo(() => qrSvgPath(encodeQr(link), 1), [link]);
  if (folded)
    return (
      <>
        <PhoneLobbyStrip lobby={lobby} onOpen={() => setFolded(false)} />
        {tips && <PhoneTips />}
      </>
    );

  const host = lobby.isHost;
  const count = readyCount(lobby.players);
  const enough = lobby.players.length >= lobby.minPlayers;
  const allReady = enough && count.ready === count.people;
  const me = lobby.players.find((p) => p.you);

  return (
    <PhoneScreen name="m-lobby" label="Room lobby" word="ROOM" states={[host ? 'host' : 'guest', lobby.ready ? 'ready' : 'not-ready', chip ? 'shared' : 'link-idle', ...(spectating ? ['watching'] : [])]}>
      <div className="pm">
        <header className="pm-top">
          {/* asks once, as the in-match menu does (audit 2, N-04) */}
          <button type="button" className="btn btn--ghost btn--icon btn--sm m-p8" aria-label="Leave the room" data-pad-leave onClick={leaving.ask}>
            <Icon name="back" />
          </button>
          <b className="display pm-h">Room</b>
          {lobby.code !== '' && (
            <span className="stamp stamp--paper pm-code m-p1" data-bind="room.code" aria-label={`Room code ${[...lobby.code].join(' ')}`}>
              {lobby.code}
            </span>
          )}
          <span className="menu-top__spacer"></span>
          {lobby.local && me && me.pingMs >= 0 && (
            <span className="net-pill pm-pill" title="Your round trip to the host, over the Wi-Fi">
              <span className={me.pingMs <= 100 ? 'dot' : me.pingMs <= 200 ? 'dot dot--warn' : 'dot dot--bad'}></span>
              <span>LAN</span>
              <span className="num">{Math.round(me.pingMs)} ms</span>
            </span>
          )}
          {/* voice (voice/Radio.tsx): the room's one radio, here in the lobby */}
          <LobbyRadio players={lobby.players} phone />
          {!spectating && (
            <button type="button" className="tag tag--ok pm-warm m-p8" title="Fold the lobby away and move around while you wait" onClick={blurAfter(() => setFolded(true))}>
              <Icon name="play" />
              Warm up
            </button>
          )}
        </header>

        <div className="pm-lobby">
          <div className="pm-lobby__side">
            {lobby.local ? (
              // a local room: its QR is the way in (the link finds the room through the relay), so it shows at once
              <section className={`poster halftone-ink pm-share pm-share--local${lobby.code ? ' pm-share--scan' : ''}`} aria-label="Invite friends">
                <b className="display pm-share__t">Rally your squad</b>
                {lobby.code !== '' && (
                  <button type="button" className="btn btn--ink btn--block pm-share__btn m-p8" onClick={blurAfter(() => void shareRoom(lobby.code).then(showChip))}>
                    <Icon name="share" />
                    <span>
                      Share<span className="pm-more"> room</span> link
                    </span>
                  </button>
                )}
                <PhoneLocalShare lobby={lobby} qr={qr} />
                <span className="hazard" aria-hidden="true"></span>
              </section>
            ) : (
              <PhoneShareCard lobby={lobby} qr={qr} onShared={showChip} />
            )}
            <ShareChip outcome={chip} />
            {!lobby.local && <FeedPeek />}
          </div>

          <section className="card card--print pm-roster" aria-labelledby="pm-roster-t">
            <div className="pm-roster__h">
              <b className="display" id="pm-roster-t">
                Roster <Roll value={lobby.players.length} />/{ROOM_SLOTS}
              </b>
              <span className={`status ${allReady ? 'status--ok' : 'status--busy'}`} data-bind="room.readyCount">
                <Icon name={allReady ? 'ok' : 'clock'} size="sm" />
                <span>
                  <Roll value={count.ready} />
                  {readyLine(lobby.players).slice(String(count.ready).length)}
                </span>
              </span>
            </div>
            {/* team modes (teams/, v21): grouped by team; the host taps a player, then Move here */}
            {(lobby.teams ?? 0) > 0 ? (
              <TeamRoster players={lobby.players} teams={lobby.teams ?? 0} host={lobby.isHost} onMove={(id, t) => online?.setTeam(id, t)} phone />
            ) : (
            <ol>
              {phoneOrder(lobby.players).map((p, i) => (
                <Row key={p.id} p={p} i={i + 1} friendly={!lobby.local} />
              ))}
            </ol>
            )}
            {/* the map and rules line, then the one action across the column: one footer, pinned to the bottom (thumb zone) */}
            <div className="pm-roster__foot">
              <div className="pm-mission">
                <button type="button" className="pm-rules m-p8" aria-haspopup="dialog" onClick={() => setRules(true)}>
                  <MapPoster id={lobby.mapId} kind="card" sizes="56px" className="pm-mission__art" />
                  <b data-bind="lobby.map.name">{lobby.mapName}</b>
                  <span className="pm-rules__limits">
                    {minutesLabel(lobby.timeLimit)} · {killsLabel(lobby.killLimit)}
                  </span>
                  <Icon name={host ? 'edit' : 'chev-right'} size="sm" />
                </button>
              </div>
              {/* a spectator: watching, and the way to a slot instead of Ready and Start */}
              {spectating ? (
                <div className="pm-bar">
                  <span className={`status ${queued ? 'status--ok' : 'status--busy'}`} role="status">
                    <Icon name={queued ? 'clock' : 'eye'} size="sm" />
                    {queued ? 'In line' : "You're watching"} · you'll play when a slot opens
                  </span>
                  {queued ? (
                    <button type="button" className="btn btn--ghost btn--sm m-p8" onClick={blurAfter(() => online?.play(false))}>
                      <Icon name="eye" />
                      Stay watching
                    </button>
                  ) : (
                    <button type="button" className="btn btn--volt btn--sm m-p8" onClick={blurAfter(() => online?.play('next'))}>
                      <Icon name="play" />
                      Join next round
                    </button>
                  )}
                </div>
              ) : (
                <div className="pm-bar pm-bar--go">
                  {host ? (
                    <button type="button" className={`btn btn--volt m-p8${allReady ? ' mf-glow' : ''}`} data-pad-first disabled={!enough} title={enough ? 'Start the countdown now' : `Needs ${lobby.minPlayers} players`} onClick={blurAfter(() => online?.startMatch())}>
                      <Icon name="play" />
                      {READY_WORDS.start}
                    </button>
                  ) : (
                    <PhoneGuestReady ready={lobby.ready} padFirst />
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      <RulesSheet lobby={lobby} open={rules} onClose={() => setRules(false)} />
      <Sheet open={leaving.asking} onClose={leaving.stay} label="Leave the room?">
        <div className="pm-sheet__head">
          <span className="pm-sheet__icon" aria-hidden="true">
            <Icon name="door-out" />
          </span>
          <b className="display">Leave the room?</b>
        </div>
        <p className="pm-sheet__note">{leaveCost(null, true)}</p>
        <div className="pm-bar">
          <button type="button" className="btn btn--danger btn--sm m-p8" data-pad-leave onClick={blurAfter(() => ctl.leave())}>
            <Icon name="door-out" />
            Leave room
          </button>
          <button type="button" className="btn btn--paper btn--sm m-p8" autoFocus data-pad-back onClick={blurAfter(leaving.stay)}>
            Stay
          </button>
        </div>
      </Sheet>
    </PhoneScreen>
  );
}
