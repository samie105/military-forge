/**
 * M3 · Phone lobby (the kit's data-screen="m-lobby"): the room code; the loudest thing on screen, the
 * share poster (Share room link through the phone's own share sheet, and the link's QR for a friend
 * next to you); the roster with who's ready (bots too); the map; Ready and, for the host, Start. The
 * match rules open in a bottom sheet (the host edits, guests read). "Warm up" folds the lobby to a
 * strip so the player can move and shoot behind it. Same actions as the desktop Lobby; a spectator
 * (v20) gets Join next round (or Stay watching) in Ready's place, and no warm-up.
 *
 * Motion: the room code focus-pulls in (P1), the share poster arrives first and the roster's rows
 * after it (P3); a player joining rises in, the counts roll (P4), a ready tick stamps (P7); Share is
 * P8, then the share sheet, then a "Shared" stamp.
 */
import { maps } from '@military-forge/content';
import { ROOM_SETTING_LIMITS } from '@military-forge/protocol';
import { useMemo, useState } from 'react';
import { Icon } from '../../../ui/Icon';
import { blurAfter } from '../../../ui/Screen';
import { useCtl } from '../../context';
import { roomLink } from '../../controller';
import type { Bindings } from '../../controls';
import { playerName } from '../../matchView';
import type { LobbyPlayer, LobbyView } from '../../onlineView';
import { encodeQr, qrSvgPath } from '../../qr';
import { KILL_STEP, ROOM_SLOTS, TIME_CHOICES, killsLabel, lobbyMaps, minutesLabel, useRoomSetting, useSpectating } from '../Lobby';
import { PhoneScreen, rise } from './layout';
import { LobbyInvite } from '../../../social/SocialLayer';
import { Roll, ShareChip, Sheet, shareRoom, useShareChip } from './parts';
import { PhoneTips } from './PhoneTips';
import { PlayerAvatar } from '../../../presentation/PlayerAvatar';
import { TeamRoster } from '../../../teams/TeamRoster';
import { BOT_LEVELS, BOT_LEVEL_NAMES, botFillChoices, botsLine, type BotLevel } from '../../roomBots';
import { LobbyRadio } from '../../../voice/Radio';

function Row({ p, i }: { p: LobbyPlayer; i: number }) {
  const ready = p.ready || p.isBot;
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
      {/* keyed by the state, so a player readying up stamps in (P7) */}
      <span key={ready ? 'ready' : 'wait'} className={`prow__ready${ready ? ' is-ready m-p7' : ''}`}>
        <Icon name={ready ? 'check' : 'clock'} size="sm" />
        {ready ? 'Ready' : 'Wait'}
      </span>
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

/** The lobby folded away for warm-up: the code, who's ready, Ready, and the way back (top centre, clear of the dials). */
function PhoneLobbyStrip({ lobby, onOpen }: { lobby: LobbyView; onOpen: () => void }) {
  const ctl = useCtl();
  const people = lobby.players.filter((p) => !p.isBot);
  const ready = people.filter((p) => p.ready).length;
  return (
    <PhoneScreen name="m-lobby" kind="game" label="Room lobby (folded)" states={['folded', lobby.ready ? 'ready' : 'not-ready']}>
      <div className="pm-strip plate m-p9" role="region" aria-label={`Room ${lobby.code}, warming up`}>
        <span className="pm-strip__ready">
          <Roll value={ready} />/<Roll value={people.length} /> ready
        </span>
        <button type="button" className={`btn btn--sm btn--icon m-p8 ${lobby.ready ? 'btn--ghost' : 'btn--volt'}`} aria-pressed={lobby.ready} aria-label={lobby.ready ? 'Ready (tap to wait)' : 'Ready up'} onClick={blurAfter(() => ctl.host.online?.setReady(!lobby.ready))}>
          <Icon name={lobby.ready ? 'check' : 'clock'} />
        </button>
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
        <div className="seg pm-seg" role="radiogroup" aria-label="Map">
          {lobbyMaps(lobby.mapId).map((id) => (
            <button type="button" key={id} role="radio" aria-checked={mapId === id} className="seg__opt m-p8" disabled={!host} onClick={() => {
              showMap(id);
              online?.setMatchSettings({ mapId: id });
            }}>
              {maps[id]?.name ?? id}
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
      </p>
    </Sheet>
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
  const people = lobby.players.filter((p) => !p.isBot);
  const readyCount = people.filter((p) => p.ready).length;
  const enough = lobby.players.length >= lobby.minPlayers;
  const shownLink = link.replace(/^https?:\/\//, '');
  const me = lobby.players.find((p) => p.you);

  return (
    <PhoneScreen name="m-lobby" label="Room lobby" word="ROOM" states={[host ? 'host' : 'guest', lobby.ready ? 'ready' : 'not-ready', chip ? 'shared' : 'link-idle', ...(spectating ? ['watching'] : [])]}>
      <div className="pm">
        <header className="pm-top">
          <button type="button" className="btn btn--ghost btn--icon btn--sm m-p8" aria-label="Leave the room" onClick={blurAfter(() => ctl.leave())}>
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
          <section className={`poster halftone-ink pm-share m-p3${lobby.local ? ' pm-share--local' : ''}${lobby.local && lobby.code ? ' pm-share--scan' : ''}`} style={rise(0)} aria-label="Invite friends">
            <b className="display pm-share__t">Rally your squad</b>
            {lobby.code !== '' && (
              <button
                type="button"
                className="btn btn--ink btn--block pm-share__btn m-p8"
                onClick={blurAfter(() => {
                  void shareRoom(lobby.code).then(showChip);
                })}
              >
                <Icon name="share" />
                <span>
                  Share<span className="pm-more"> room</span> link
                </span>
              </button>
            )}
            {lobby.local ? (
              <PhoneLocalShare lobby={lobby} qr={qr} />
            ) : (
              <div className="pm-qrs">
                <div className="ticket pm-qr pm-qr--wide">
                  <span className="qr" role="img" aria-label="QR code for the room link">
                    <svg viewBox={qr.viewBox} shapeRendering="crispEdges" aria-hidden="true">
                      <path fill="var(--c-qr-dark)" d={qr.path} />
                    </svg>
                  </span>
                  <span>
                    <span className="label">
                      <Icon name="globe" size="sm" />
                      Scan to join
                    </span>
                    <b data-bind="lobby.links.internet">{shownLink}</b>
                  </span>
                </div>
              </div>
            )}
            {/* friends (social/): invite them straight to this room */}
            {!lobby.local && <LobbyInvite phone />}
            <ShareChip outcome={chip} />
            <span className="hazard" aria-hidden="true"></span>
          </section>

          <section className="card card--print pm-roster m-p3" style={rise(1)} aria-labelledby="pm-roster-t">
            <div className="pm-roster__h">
              <b className="display" id="pm-roster-t">
                Roster <Roll value={lobby.players.length} />/{ROOM_SLOTS}
              </b>
              <span className={`status ${readyCount === people.length ? 'status--ok' : 'status--busy'}`}>
                <Icon name={readyCount === people.length ? 'ok' : 'clock'} size="sm" />
                <Roll value={readyCount} /> ready
              </span>
            </div>
            {/* team modes (teams/, v21): grouped by team; the host taps a player, then Move here */}
            {(lobby.teams ?? 0) > 0 ? (
              <TeamRoster players={lobby.players} teams={lobby.teams ?? 0} host={lobby.isHost} onMove={(id, t) => online?.setTeam(id, t)} phone />
            ) : (
            <ol>
              {lobby.players.map((p, i) => (
                <Row key={p.id} p={p} i={i + 2} />
              ))}
            </ol>
            )}
            {/* the match rules and Ready/Start: one footer, so at large text both stay in view (phone.css) */}
            <div className="pm-roster__foot">
              <div className="pm-mission">
                <span>
                  <Icon name="map" size="sm" />
                  <b data-bind="lobby.map.name">{lobby.mapName}</b>
                </span>
                <button type="button" className="pm-rules m-p8" onClick={() => setRules(true)}>
                  <Icon name="clock" size="sm" />
                  {minutesLabel(lobby.timeLimit)} · {killsLabel(lobby.killLimit)}
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
                <div className="pm-bar">
                  <button type="button" className={`btn btn--sm m-p8 ${lobby.ready ? 'btn--ghost is-ready' : 'btn--ghost'}`} aria-pressed={lobby.ready} onClick={blurAfter(() => online?.setReady(!lobby.ready))}>
                    <Icon name={lobby.ready ? 'check' : 'clock'} />
                    Ready
                  </button>
                  {host && (
                    <button type="button" className="btn btn--paper btn--sm m-p8" disabled={!enough} title={enough ? 'Start the countdown now' : `Needs ${lobby.minPlayers} players`} onClick={blurAfter(() => online?.startMatch())}>
                      <Icon name="play" />
                      Start
                    </button>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
      <RulesSheet lobby={lobby} open={rules} onClose={() => setRules(false)} />
    </PhoneScreen>
  );
}
