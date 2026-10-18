/**
 * 4 · Room lobby (the kit's data-screen="lobby"): the invite (code, Copy link, WhatsApp, QR), the
 * players and the match settings (the host edits, guests read). The lobby is the room's warm-up:
 * "Warm up" folds it into a strip at the top so the player can move and shoot behind it.
 */
import { maps } from '@military-forge/content';
import { ROOM_SETTING_LIMITS } from '@military-forge/protocol';
import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { Ping, Screen, blurAfter } from '../../ui/Screen';
import { useCtl } from '../context';
import { roomLink } from '../controller';
import { playerName } from '../matchView';
import type { LobbyPlayer, LobbyView } from '../onlineView';
import { encodeQr, qrSvgPath } from '../qr';
import type { Bindings } from '../controls';
import { TipsCard } from './Tips';

/** Players a room takes (the game server's default maxHumans: MATCH_STATE doesn't carry it). */
export const ROOM_SLOTS = 8;

/** The kit's time-limit choices, minutes (0 = none). */
export const TIME_CHOICES = [1, 2, 3, 5, 8, 10, 15, 20, 0] as const;
export const KILL_STEP = 5;

/** The kit's line and thumbnail for each map (maps without one show their name on a plain tile). */
export const MAP_CARDS: Readonly<Record<string, { blurb: string; thumb: string }>> = {
  'movement-test': { blurb: 'Learn the jetpack', thumb: 'map-thumb--test' },
  'lunar-outpost': { blurb: 'Low gravity', thumb: 'map-thumb--lunar' },
  'storm-front': { blurb: 'Wind and EMP storms', thumb: 'map-thumb--storm' },
  'flux-lab': { blurb: 'Pads and gravity pockets', thumb: 'map-thumb--flux' },
};

/** The maps a lobby lists (the dev test map stays out unless the room is on it). */
export function lobbyMaps(current: string): string[] {
  return Object.keys(maps).filter((id) => id !== 'mechanics-test' || id === current);
}

export function minutesLabel(seconds: number): string {
  return seconds === 0 ? 'No time limit' : `${Math.round(seconds / 60)} min`;
}

export function killsLabel(kills: number): string {
  return kills === 0 ? 'No kill limit' : `${kills} kills`;
}

/**
 * A host setting as the host sees it: their last choice at once, until the room's answer (a round
 * trip away) says the same, or 3 s pass (the server didn't take it). Quick clicks add up.
 */
export function useRoomSetting(server: number): [number, (value: number) => void] {
  const [local, setLocal] = useState<number | null>(null);
  useEffect(() => {
    if (local !== null && local === server) setLocal(null);
  }, [server, local]);
  useEffect(() => {
    if (local === null) return undefined;
    const t = window.setTimeout(() => setLocal(null), 3000);
    return () => window.clearTimeout(t);
  }, [local]);
  return [local ?? server, setLocal];
}

function initial(name: string): string {
  return ([...name.trim()][0] ?? '?').toUpperCase();
}

function PlayerRow({ p, hostView }: { p: LobbyPlayer; hostView: boolean }) {
  const you = p.you ? (hostView ? ' is-you' : ' is-you-guest') : '';
  return (
    <li className={`player-row${you}`}>
      {p.isBot ? (
        <span className="avatar avatar--bot">
          <Icon name="chip" />
        </span>
      ) : (
        <span className="avatar">{initial(p.name)}</span>
      )}
      <span className="player-row__name">
        <span>{playerName(p.name, p.isBot)}</span>
        {p.host && (
          <span className="badge badge--host">
            <Icon name="star" />
            Host
          </span>
        )}
        {p.isBot && (
          <span className="badge badge--bot">
            <Icon name="chip" />
            Bot
          </span>
        )}
        {p.you && <span className="badge badge--you">You</span>}
      </span>
      {p.isBot ? <span className="ping muted">no ping</span> : <Ping ms={p.pingMs} />}
      {p.ready || p.isBot ? (
        <span className="ready">
          <Icon name="check-circle" />
          Ready
        </span>
      ) : (
        <span className="ready ready--no">
          <Icon name="circle" />
          Not ready
        </span>
      )}
      <span className="player-row__act"></span>
    </li>
  );
}

function MapThumb({ id, className = '' }: { id: string; className?: string }) {
  return <span className={`map-thumb ${MAP_CARDS[id]?.thumb ?? ''} ${className}`.trim()} aria-hidden="true"></span>;
}

/** The lobby folded away for warm-up: the code, who's ready, Ready, and the way back. */
function LobbyStrip({ lobby, onOpen }: { lobby: LobbyView; onOpen: () => void }) {
  const ctl = useCtl();
  const people = lobby.players.filter((p) => !p.isBot);
  const ready = people.filter((p) => p.ready).length;
  return (
    <Screen name="lobby" kind="game" states={[lobby.isHost ? 'host' : 'guest', lobby.ready ? 'ready' : 'not-ready']} label="Room lobby (folded)">
      <div className="mf-lobby-strip hud-plate" role="region" aria-label="Room">
        <span className="badge badge--soon">Warm-up</span>
        <span>
          Room <span className="roomcode-inline num">{lobby.code}</span>
        </span>
        <span className="status status--ok">
          <Icon name="check-circle" />
          {ready} of {people.length} ready
        </span>
        {lobby.ready ? (
          <button className="btn btn--secondary lobby__ready-on" aria-pressed="true" onClick={blurAfter(() => ctl.host.online?.setReady(false))}>
            <Icon name="check-circle" />
            You're ready
          </button>
        ) : (
          <button className="btn btn--primary" onClick={blurAfter(() => ctl.host.online?.setReady(true))}>
            <Icon name="circle" />
            Ready
          </button>
        )}
        <button className="btn btn--ghost" onClick={blurAfter(onOpen)}>
          <Icon name="users" />
          Lobby
        </button>
      </div>
    </Screen>
  );
}

/** `tips`: the player's bindings while the first-run controls card is due (it shows once the lobby folds). */
export function Lobby({ lobby, tips = null, doubleTapDash = true }: { lobby: LobbyView; tips?: Bindings | null; doubleTapDash?: boolean }) {
  const ctl = useCtl();
  const online = ctl.host.online;
  const [folded, setFolded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [timeLimit, showTime] = useRoomSetting(lobby.timeLimit);
  const [kills, showKills] = useRoomSetting(lobby.killLimit);
  const link = roomLink(lobby.code);
  const qr = useMemo(() => qrSvgPath(encodeQr(link), 1), [link]);
  if (folded)
    return (
      <>
        <LobbyStrip lobby={lobby} onOpen={() => setFolded(false)} />
        {tips && <TipsCard bindings={tips} doubleTapDash={doubleTapDash} />}
      </>
    );

  const host = lobby.isHost;
  const me = lobby.players.find((p) => p.you);
  // bots never ready up (the match doesn't wait for them): "ready" counts the people
  const people = lobby.players.filter((p) => !p.isBot);
  const readyCount = people.filter((p) => p.ready).length;
  const enough = lobby.players.length >= lobby.minPlayers;
  const open = Math.max(0, ROOM_SLOTS - lobby.players.length);
  const limits = ROOM_SETTING_LIMITS;
  const times = TIME_CHOICES.filter((m) => m === 0 || (m * 60 >= limits.timeLimit.min && m * 60 <= limits.timeLimit.max));
  const setKills = (k: number) => {
    showKills(k);
    online?.setMatchSettings({ killLimit: k });
  };
  const setTime = (seconds: number) => {
    showTime(seconds);
    online?.setMatchSettings({ timeLimit: seconds });
  };
  const shownLink = link.replace(/^https?:\/\//, '');

  const copy = async () => {
    if (await ctl.copyLink(lobby.code, true)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    }
  };

  return (
    <Screen name="lobby" kind="menu" states={[host ? 'host' : 'guest', lobby.ready ? 'ready' : 'not-ready', copied ? 'copied' : 'link-idle']} label="Room lobby">
      <header className="topbar">
        <button className="btn btn--ghost" onClick={blurAfter(() => ctl.leave())}>
          <Icon name="door-out" />
          Leave room
        </button>
        <span className="topbar__title">Room</span>
        <span className="badge badge--soon">Warm-up</span>
        <button className="btn btn--ghost" onClick={blurAfter(() => setFolded(true))} title="Fold the lobby away and move around while you wait">
          <Icon name="target" />
          Warm up
        </button>
        <div className="topbar__spacer"></div>
        {me && !me.isBot && <Ping ms={me.pingMs} label="Room" />}
        <button className="btn btn--secondary btn--icon" aria-label="Settings" onClick={blurAfter(() => ctl.openSettings())}>
          <Icon name="gear" />
        </button>
      </header>

      <div className="screen-body lobby">
        <section className="panel invite ticks" aria-labelledby="inv-title">
          <p className="eyebrow" id="inv-title">
            Invite friends
          </p>
          <div className="roomcode" aria-label={`Room code: ${[...lobby.code].join(' ')}`}>
            {[...lobby.code].map((ch, i) => (
              <span key={i} data-bind={`room.code.${i}`}>
                {ch}
              </span>
            ))}
          </div>
          {copied ? (
            <button className="btn btn--primary btn--xl btn--block invite__copy invite__copy--done" onClick={blurAfter(() => void copy())}>
              <Icon name="check" size="lg" />
              Link copied. Paste it in your chat
            </button>
          ) : (
            <button className="btn btn--primary btn--xl btn--block invite__copy" onClick={blurAfter(() => void copy())}>
              <Icon name="link" size="lg" />
              Copy link
            </button>
          )}
          <p className="invite__link">
            <Icon name="link" size="sm" />
            <span data-bind="room.link">{shownLink}</span>
          </p>
          <button className="btn btn--whatsapp btn--xl btn--block" onClick={blurAfter(() => ctl.shareOnWhatsApp(lobby.code))}>
            <Icon name="chat-send" size="lg" />
            Share on WhatsApp
          </button>
          <div className="invite__qr">
            <div className="qr" role="img" aria-label="QR code for the room link">
              <svg viewBox={qr.viewBox} shapeRendering="crispEdges" aria-hidden="true">
                <path fill="var(--c-qr-ink)" d={qr.path} />
              </svg>
            </div>
            <div className="invite__qrtext">
              <p className="h3">Friend next to you?</p>
              <p className="muted">They scan this with their phone camera and land in this room.</p>
              <button className="btn btn--ghost invite__more" onClick={blurAfter(() => void ctl.shareLink(lobby.code))}>
                <Icon name="share" />
                More ways to share
              </button>
            </div>
          </div>
        </section>

        <section className="panel players" aria-labelledby="pl-title">
          <div className="panel__head">
            <h2 className="h3" id="pl-title">
              Players
            </h2>
            <span className="players__count num" data-bind="room.playerCount">
              {lobby.players.length} / {ROOM_SLOTS}
            </span>
            <span className="topbar__spacer"></span>
            <span className={readyCount === people.length ? 'status status--ok' : 'status status--info'}>
              <Icon name={readyCount === people.length ? 'check-circle' : 'circle'} />
              <span data-bind="room.readyCount">
                {readyCount} of {people.length} ready
              </span>
            </span>
          </div>
          <ol className="player-list">
            {lobby.players.map((p) => (
              <PlayerRow key={p.id} p={p} hostView={host} />
            ))}
            {Array.from({ length: open }, (_, i) => (
              <li key={`open${i}`} className="player-row player-row--open">
                <span className="avatar avatar--open">
                  <Icon name="user" />
                </span>
                <span className="muted">{i === 0 ? 'Open slot: share the link' : 'Open slot'}</span>
              </li>
            ))}
          </ol>
          {!enough && (
            <div className="players__foot">
              <span className="status status--info">
                <Icon name="info" />
                Waiting for at least {lobby.minPlayers} players
              </span>
            </div>
          )}
        </section>

        <section className="panel msettings" aria-labelledby="ms-title">
          <div className="panel__head">
            <h2 className="h3" id="ms-title">
              Match settings
            </h2>
            <span className="topbar__spacer"></span>
            {!host && (
              <span className="status status--info">
                <Icon name="lock" />
                The host picks the settings
              </span>
            )}
          </div>
          <div className="panel__body msettings__body">
            <div className="mrow">
              <span className="mrow__label">Mode</span>
              <span className="mrow__value">
                <b>Deathmatch</b>
                <span className="small muted">Every soldier for themselves</span>
              </span>
            </div>

            {host ? (
              <>
                <div className="mrow mrow--stack">
                  <span className="mrow__label" id="tl-label">
                    Time limit
                  </span>
                  <div className="seg" role="radiogroup" aria-labelledby="tl-label">
                    {times.map((m) => (
                      <button
                        key={m}
                        className="seg__opt"
                        role="radio"
                        aria-checked={timeLimit === m * 60}
                        disabled={m === 0 && kills === 0}
                        title={m === 0 && kills === 0 ? 'Set a kill limit first: a match needs one or the other' : undefined}
                        onClick={blurAfter(() => setTime(m * 60))}
                      >
                        {m === 0 ? 'None' : m}
                      </button>
                    ))}
                  </div>
                  <span className="small muted">Minutes</span>
                </div>
                <div className="mrow mrow--stack">
                  <span className="mrow__label" id="kl-label">
                    Kill limit
                  </span>
                  <div className="mrow__inline">
                    <div className="stepper" role="group" aria-labelledby="kl-label">
                      <button aria-label="Fewer kills" disabled={kills !== 0 && kills <= limits.killLimit.min} onClick={blurAfter(() => setKills(kills === 0 ? limits.killLimit.min : Math.max(limits.killLimit.min, kills - KILL_STEP)))}>
                        −
                      </button>
                      <output className="num" data-bind="room.killLimit">
                        {kills === 0 ? '–' : kills}
                      </output>
                      <button aria-label="More kills" disabled={kills >= limits.killLimit.max} onClick={blurAfter(() => setKills(kills === 0 ? limits.killLimit.min : Math.min(limits.killLimit.max, kills + KILL_STEP)))}>
                        +
                      </button>
                    </div>
                    <span className="small muted">
                      {limits.killLimit.min} to {limits.killLimit.max}
                    </span>
                    <button
                      className="seg__opt"
                      aria-pressed={kills === 0}
                      disabled={kills !== 0 && timeLimit === 0}
                      title={kills !== 0 && timeLimit === 0 ? 'Set a time limit first: a match needs one or the other' : undefined}
                      onClick={blurAfter(() => setKills(kills === 0 ? 10 : 0))}
                    >
                      No limit
                    </button>
                  </div>
                </div>
                <div className="mrow mrow--stack">
                  <span className="mrow__label" id="map-label">
                    Map
                  </span>
                  <div className="maps" role="radiogroup" aria-labelledby="map-label">
                    {lobbyMaps(lobby.mapId).map((id) => (
                      <button key={id} className="map-card" role="radio" aria-checked={id === lobby.mapId} disabled={id !== lobby.mapId} title={id === lobby.mapId ? undefined : 'Rooms play one map for now: picking another comes with map rotation'}>
                        <MapThumb id={id} />
                        <span>
                          <b>{maps[id]!.name}</b>
                          {MAP_CARDS[id] && <span className="small muted">{MAP_CARDS[id].blurb}</span>}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="mrow">
                  <span className="mrow__label">Time limit</span>
                  <span className="mrow__value">
                    <b data-bind="room.timeLimit">{minutesLabel(lobby.timeLimit)}</b>
                  </span>
                </div>
                <div className="mrow">
                  <span className="mrow__label">Kill limit</span>
                  <span className="mrow__value">
                    <b data-bind="room.killLimit">{killsLabel(kills)}</b>
                  </span>
                </div>
                <div className="mrow mrow--stack">
                  <span className="mrow__label">Map</span>
                  <div className="map-ro">
                    <MapThumb id={lobby.mapId} />
                    <span>
                      <b className="h3" data-bind="room.map">
                        {lobby.mapName}
                      </b>
                      {MAP_CARDS[lobby.mapId] && <span className="muted">{MAP_CARDS[lobby.mapId]!.blurb}</span>}
                    </span>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>
      </div>

      <footer className="lobby__bar">
        <p className="warmup">
          <Icon name="info" />
          <span>
            <b>Warm-up:</b> move and shoot freely, nothing counts until the match starts. Everyone ready starts it.
          </span>
        </p>
        <span className="topbar__spacer"></span>
        {lobby.ready ? (
          <button className="btn btn--secondary btn--xl lobby__ready-on" aria-pressed="true" onClick={blurAfter(() => online?.setReady(false))}>
            <Icon name="check-circle" />
            You're ready
          </button>
        ) : (
          <button className="btn btn--secondary btn--xl" onClick={blurAfter(() => online?.setReady(true))}>
            <Icon name="circle" />
            Ready
          </button>
        )}
        {host && (
          <button className="btn btn--primary btn--xl" disabled={!enough} title={enough ? 'Start the countdown now' : `Needs ${lobby.minPlayers} players`} onClick={blurAfter(() => online?.startMatch())}>
            <Icon name="play" />
            Start now
          </button>
        )}
      </footer>
    </Screen>
  );
}
