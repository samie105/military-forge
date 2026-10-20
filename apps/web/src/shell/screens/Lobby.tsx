/**
 * 4 · Room lobby (round two's data-screen="lobby"): sharing first and loudest (Share, the room link
 * with its QR, Copy link and WhatsApp), the roster and the mission (the host edits, guests read).
 * The lobby is the room's warm-up: "Warm up" folds it into a strip so the player can move and shoot
 * behind it. Motion (ui-motion-spec.md §4.1): the room code focus-pulls in, the share card arrives
 * first and the rows rise in turn (P3); joins rise in and leaves fall out, the counts roll (P4), a
 * ready tick stamps (P7), Copy link swaps its label for 1.6 s, and the host's Start button glows when
 * everyone is ready.
 *
 * The kit's Same-Wi-Fi link, host tools (add or remove bots, kick), bot count and level, time of day
 * and a map choice aren't in the room protocol yet: their places stay empty (the PR lists them).
 */
import { maps, type MapEventKind } from '@military-forge/content';
import { ROOM_SETTING_LIMITS } from '@military-forge/protocol';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Icon } from '../../ui/Icon';
import { Screen, blurAfter } from '../../ui/Screen';
import { eventLook } from '../../hud/model';
import { useCtl } from '../context';
import { roomLink } from '../controller';
import { playerName } from '../matchView';
import type { LobbyPlayer, LobbyView } from '../onlineView';
import { encodeQr, qrSvgPath } from '../qr';
import type { Bindings } from '../controls';
import { Backdrop, RollNum, remember } from './frame';
import { BotSettings, botsLine, type BotLevel } from '../roomBots';
import { TipsCard } from './Tips';

/** Players a room takes (the game server's default maxHumans: MATCH_STATE doesn't carry it). */
export const ROOM_SLOTS = 8;

/** The kit's time-limit choices, minutes (0 = none). */
export const TIME_CHOICES = [1, 2, 3, 5, 8, 10, 15, 20, 0] as const;
export const KILL_STEP = 5;

/**
 * The kit's words and thumbnail for each map: a short line (`blurb`), where it is (`place`) and a
 * tagline; `thumb` is round one's thumbnail class (the phone lobby), `art` round two's.
 */
export const MAP_CARDS: Readonly<Record<string, { blurb: string; thumb: string; place?: string; tagline?: string; art?: 'market' | 'lunar' | 'storm' | 'flux' }>> = {
  'street-market': { blurb: 'Rooftops and minibuses', thumb: '', place: 'Lagos, Nigeria', tagline: 'Billboards, minibuses and rooftop fights', art: 'market' },
  'movement-test': { blurb: 'Learn the jetpack', thumb: 'map-thumb--test', place: 'Training range', tagline: 'Ledges and gaps to learn the jetpack on' },
  'lunar-outpost': { blurb: 'Low gravity', thumb: 'map-thumb--lunar', place: 'The Moon', tagline: 'Low gravity, with Earth in the sky', art: 'lunar' },
  'storm-front': { blurb: 'Wind and EMP storms', thumb: 'map-thumb--storm', place: 'A cold port', tagline: 'Rain, cranes and a storm that never stops', art: 'storm' },
  'flux-lab': { blurb: 'Pads and gravity pockets', thumb: 'map-thumb--flux', place: 'Research hall', tagline: 'A lab hall where gravity misbehaves', art: 'flux' },
};

/** A map event's chip class, by kind (the kit's chip--gravity, --emp, --fog, --squall). */
export function eventChip(kind: MapEventKind): string {
  if (kind === 'emp') return 'chip--emp';
  if (kind === 'fog') return 'chip--fog';
  if (kind === 'gust') return 'chip--squall';
  return 'chip--gravity';
}

const EVENT_WORDS: Readonly<Record<MapEventKind, string>> = { gravitySurge: 'Gravity surge', lowGravity: 'Low gravity', emp: 'EMP storm', fog: 'Fog', gust: 'Squall', flip: 'Gravity flip', custom: 'Map event' };

/** What can happen on a map (its event defs), for its card: name and kind, at most two. */
export function mapEvents(id: string): { name: string; kind: MapEventKind }[] {
  const defs = maps[id]?.events?.defs ?? [];
  return defs.slice(0, 2).map((d) => ({ name: d.name ? d.name.charAt(0) + d.name.slice(1).toLowerCase() : EVENT_WORDS[d.kind], kind: d.kind }));
}

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
export function useRoomSetting<T extends number | string>(server: T): [T, (value: T) => void] {
  const [local, setLocal] = useState<T | null>(null);
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

/** A list's items plus those that just left, kept `ms` longer (flagged) so they can animate out. */
export function useWithLeavers<T>(items: readonly T[], key: (t: T) => string | number, ms = 170): { item: T; leaving: boolean }[] {
  const gone = useRef(new Map<string | number, { item: T; until: number }>());
  const last = useRef<readonly T[]>(items);
  const [, tick] = useState(0);
  const now = performance.now();
  const keys = new Set(items.map(key));
  for (const old of last.current) {
    const k = key(old);
    if (!keys.has(k) && !gone.current.has(k)) gone.current.set(k, { item: old, until: now + ms });
  }
  for (const k of keys) gone.current.delete(k);
  last.current = items;
  useEffect(() => {
    if (gone.current.size === 0) return undefined;
    const t = window.setTimeout(() => {
      const at = performance.now();
      for (const [k, g] of gone.current) if (g.until <= at) gone.current.delete(k);
      tick((n) => n + 1);
    }, ms);
    return () => window.clearTimeout(t);
  });
  return [...items.map((item) => ({ item, leaving: false })), ...[...gone.current.values()].map((g) => ({ item: g.item, leaving: true }))];
}

function pingLook(ms: number): { cls: string; sig: string } {
  if (ms <= 100) return { cls: 'prow__ping', sig: ms <= 50 ? 'sig sig--ok' : 'sig sig--warn' };
  return ms <= 200 ? { cls: 'prow__ping prow__ping--warn', sig: 'sig sig--bad' } : { cls: 'prow__ping prow__ping--warn', sig: 'sig sig--bad' };
}

function PlayerRow({ p, hostView, leaving, i }: { p: LobbyPlayer; hostView: boolean; leaving: boolean; i: number }) {
  const you = p.you ? (hostView ? ' is-you' : ' is-you-guest') : '';
  const ping = pingLook(p.pingMs);
  return (
    <li className={`prow${you} ${leaving ? 'm-leave' : 'm-p3 m-p3--tight'}`} style={{ '--i': i } as CSSProperties}>
      {p.isBot ? (
        <span className="avatar avatar--bot">
          <Icon name="bot" />
        </span>
      ) : (
        <span className="avatar">{initial(p.name)}</span>
      )}
      <b className="prow__name">{playerName(p.name, p.isBot)}</b>
      {p.host && (
        <span className="tag tag--host">
          <Icon name="crown" />
          Host
        </span>
      )}
      {p.isBot && <span className="tag tag--bot">Bot</span>}
      {p.you && <span className="tag tag--you">You</span>}
      <span className="prow__fill"></span>
      {p.isBot ? (
        <span className="prow__ping">
          <Icon name="bot" size="sm" />
          No ping
        </span>
      ) : p.pingMs >= 0 ? (
        <span className={ping.cls}>
          <span className={ping.sig} aria-hidden="true">
            <i></i>
            <i></i>
            <i></i>
            <i></i>
          </span>
          <span className="num">{Math.round(p.pingMs)} ms</span>
        </span>
      ) : (
        <span className="prow__ping">–</span>
      )}
      {p.ready || p.isBot ? (
        <span className="prow__ready is-ready m-p7" key="ready">
          <Icon name="check" size="sm" />
          Ready
        </span>
      ) : (
        <span className="prow__ready" key="not-ready">
          <Icon name="clock" size="sm" />
          Not ready
        </span>
      )}
    </li>
  );
}

/** A map's card (the kit's .mapcard): its drawn thumbnail, name, place, tagline and what can happen there. */
function MapCard({ id, picked }: { id: string; picked: boolean }) {
  const card = MAP_CARDS[id];
  const art = card?.art;
  return (
    <button
      type="button"
      className={picked ? 'mapcard is-picked m-p8' : 'mapcard m-p8'}
      role="radio"
      aria-checked={picked}
      disabled={!picked}
      title={picked ? undefined : 'Rooms play one map for now: picking another comes with map rotation'}
      data-map={id}
    >
      <div className={`thumb thumb--${art ?? 'storm'}`} aria-hidden="true">
        {art === 'lunar' && (
          <>
            <i className="thumb__earth"></i>
            <i className="thumb__ground"></i>
          </>
        )}
        {art === 'storm' && (
          <>
            <i className="thumb__rain"></i>
            <Icon name="ev-lightning" className="thumb__glyph" />
          </>
        )}
        {art === 'flux' && (
          <>
            <i className="thumb__blocks"></i>
            <Icon name="ev-gravity" className="thumb__glyph" />
          </>
        )}
        {art === 'market' && <Icon name="map" className="thumb__glyph" />}
        {!art && <Icon name="target" className="thumb__glyph" />}
      </div>
      <span className="mapcard__body">
        <b className="display mapcard__name">{maps[id]?.name ?? id}</b>
        {card?.place && (
          <span className="mapcard__place">
            <Icon name="map" size="sm" />
            {card.place}
          </span>
        )}
        {card?.tagline && <span className="mapcard__tag">{card.tagline}</span>}
        <span className="mapcard__events">
          {mapEvents(id).map((e) => (
            <span key={e.name} className={`chip ${eventChip(e.kind)}`}>
              <Icon name={eventLook(e.kind).icon} />
              {e.name}
            </span>
          ))}
        </span>
      </span>
      {picked && <span className="stamp stamp--volt mapcard__stamp m-p7">Picked</span>}
    </button>
  );
}

/** The lobby folded away for warm-up: the code, who's ready, Ready, and the way back. */
function LobbyStrip({ lobby, onOpen }: { lobby: LobbyView; onOpen: () => void }) {
  const ctl = useCtl();
  const people = lobby.players.filter((p) => !p.isBot);
  const ready = people.filter((p) => p.ready).length;
  return (
    <Screen name="lobby" kind="game" states={[lobby.isHost ? 'host' : 'guest', lobby.ready ? 'ready' : 'not-ready']} label="Room lobby (folded)">
      <div className="mf-lobby-strip plate m-p9" role="region" aria-label="Room">
        <span className="tag tag--ok">
          <Icon name="play" />
          Warm-up
        </span>
        <span>
          Room <span className="num mf-lobby-strip__code">{lobby.code}</span>
        </span>
        <span className="status status--ok">
          <Icon name="ok" />
          <RollNum value={ready} /> of <RollNum value={people.length} /> ready
        </span>
        {lobby.ready ? (
          <button className="btn btn--paper m-p8" type="button" aria-pressed="true" onClick={blurAfter(() => ctl.host.online?.setReady(false))}>
            <Icon name="check" />
            You're ready
          </button>
        ) : (
          <button className="btn btn--volt m-p8" type="button" onClick={blurAfter(() => ctl.host.online?.setReady(true))}>
            <Icon name="clock" />
            Ready
          </button>
        )}
        <button className="btn btn--ghost m-p8" type="button" onClick={blurAfter(onOpen)}>
          <Icon name="users-plus" />
          Lobby
        </button>
      </div>
    </Screen>
  );
}

/** How long Copy link says "Copied" (motion spec §4.1: 1.6 s, then back). */
const COPIED_MS = 1600;

/** `tips`: the player's bindings while the first-run controls card is due (it shows once the lobby folds). */
export function Lobby({ lobby, tips = null, doubleTapDash = true }: { lobby: LobbyView; tips?: Bindings | null; doubleTapDash?: boolean }) {
  const ctl = useCtl();
  const online = ctl.host.online;
  const [folded, setFolded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [timeLimit, showTime] = useRoomSetting(lobby.timeLimit);
  const [kills, showKills] = useRoomSetting(lobby.killLimit);
  const [bots, showBots] = useRoomSetting(lobby.bots);
  const [botLevel, showBotLevel] = useRoomSetting<BotLevel>(lobby.botLevel);
  const link = roomLink(lobby.code);
  const qr = useMemo(() => qrSvgPath(encodeQr(link), 1), [link]);
  const rows = useWithLeavers(lobby.players, (p) => p.id);
  // the lobby goes as the countdown begins: the picked map card grows into the map intro (P2)
  useLayoutEffect(() => () => remember('map', document.querySelector('[data-screen="lobby"] .mapcard.is-picked')), []);
  if (folded)
    return (
      <>
        <LobbyStrip lobby={lobby} onOpen={() => setFolded(false)} />
        {tips && <TipsCard bindings={tips} doubleTapDash={doubleTapDash} />}
      </>
    );

  const host = lobby.isHost;
  const me = lobby.players.find((p) => p.you);
  const hostName = lobby.players.find((p) => p.host)?.name ?? 'The host';
  // bots never ready up (the match doesn't wait for them): "ready" counts the people
  const people = lobby.players.filter((p) => !p.isBot);
  const readyCount = people.filter((p) => p.ready).length;
  const enough = lobby.players.length >= lobby.minPlayers;
  const allReady = enough && readyCount === people.length;
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
      window.setTimeout(() => setCopied(false), COPIED_MS);
    }
  };
  const row = (i: number) => ({ '--i': i }) as CSSProperties;

  return (
    <Screen name="lobby" kind="menu" states={[host ? 'host' : 'guest', lobby.ready ? 'ready' : 'not-ready', copied ? 'copied' : 'link-idle']} label="Room lobby">
      <Backdrop word="ROOM" />
      <div className="menu">
        <header className="menu-top lobby__top">
          <button className="btn btn--ghost btn--sm m-p8" type="button" onClick={blurAfter(() => ctl.leave())}>
            <Icon name="door-out" />
            Leave
          </button>
          <h1 className="menu-top__title">Room</h1>
          <span className="stamp stamp--paper lobby__code m-p1" aria-label={`Room code: ${[...lobby.code].join(' ')}`}>
            {[...lobby.code].map((ch, i) => (
              <span key={i} data-bind={`room.code.${i}`}>
                {ch}
              </span>
            ))}
          </span>
          <span className="tag tag--ok">
            <Icon name="play" />
            Warm-up live
          </span>
          <button className="btn btn--ghost btn--sm m-p8" type="button" onClick={blurAfter(() => setFolded(true))} title="Fold the lobby away and move around while you wait">
            <Icon name="target" />
            Warm up
          </button>
          <span className="menu-top__spacer"></span>
          {me && !me.isBot && me.pingMs >= 0 && (
            <span className="net-pill" title="Your round trip to the room">
              <span className={me.pingMs <= 100 ? 'dot' : me.pingMs <= 200 ? 'dot dot--warn' : 'dot dot--bad'}></span>
              <span>Room</span>
              <span className="num">{Math.round(me.pingMs)} ms</span>
            </span>
          )}
          <button className="btn btn--ghost btn--icon btn--sm m-p8" type="button" aria-label="Settings" onClick={blurAfter(() => ctl.openSettings())}>
            <Icon name="gear" />
          </button>
        </header>

        <div className="menu-body lobby">
          {/* A · share: the loudest thing on the screen, and the first to arrive */}
          <section className="poster halftone-ink lobby__share m-p3" style={row(0)} aria-labelledby="share-title">
            <span className="btn__sticker" style={{ right: 24, top: -16 }}>
              <span data-bind="room.slotsLeft">{open}</span> {open === 1 ? 'slot' : 'slots'} left
            </span>
            <span className="serial">Call in your squad</span>
            <h2 id="share-title" className="display lobby__share-title">
              Rally your
              <br />
              squad
            </h2>
            <button className="btn btn--ink btn--xl btn--block lobby__share-btn m-p8" type="button" onClick={blurAfter(() => void ctl.shareLink(lobby.code))}>
              <Icon name="share" />
              <span className="btn__stack">
                Share room link
                <span className="btn__sub">Your share sheet, or the link copied</span>
              </span>
            </button>
            <div className="ticket linkt">
              <span className="qr linkt__qr" role="img" aria-label="QR code for the room link">
                <svg viewBox={qr.viewBox} shapeRendering="crispEdges" aria-hidden="true">
                  <path fill="var(--c-qr-dark)" d={qr.path} />
                </svg>
              </span>
              <div className="linkt__body">
                <span className="label">
                  <Icon name="globe" size="sm" />
                  Room link
                </span>
                <b className="linkt__url" data-bind="room.link">
                  {shownLink}
                </b>
                <span className="linkt__sub">A friend next to you can scan the code</span>
                <span className="mf-linkt__acts">
                  {copied ? (
                    <button className="btn btn--paper btn--sm linkt__done m-p8 mf-swap-in" type="button" key="copied" onClick={blurAfter(() => void copy())}>
                      <Icon name="check" />
                      Copied ✓
                    </button>
                  ) : (
                    <button className="btn btn--paper btn--sm m-p8 mf-swap-in" type="button" key="copy" onClick={blurAfter(() => void copy())}>
                      <Icon name="copy" />
                      Copy link
                    </button>
                  )}
                  <button className="btn btn--paper btn--sm m-p8" type="button" onClick={blurAfter(() => ctl.shareOnWhatsApp(lobby.code))}>
                    <Icon name="chat" />
                    WhatsApp
                  </button>
                </span>
              </div>
            </div>
            <span className="hazard" aria-hidden="true"></span>
          </section>

          {/* B · the roster */}
          <section className="card card--print lobby__squad m-p3" style={row(1)} aria-labelledby="squad-title">
            <div className="lobby__head">
              <h2 id="squad-title" className="display">
                Roster <RollNum value={lobby.players.length} />
                <span className="lobby__of">/{ROOM_SLOTS}</span>
              </h2>
              <span className={allReady ? 'status status--ok' : 'status status--busy'}>
                <Icon name={allReady ? 'ok' : 'clock'} size="sm" />
                <span data-bind="room.readyCount">
                  <RollNum value={readyCount} /> of {people.length} ready
                </span>
              </span>
            </div>
            <ol className="prows">
              {rows.map(({ item: p, leaving }, i) => (
                <PlayerRow key={p.id} p={p} hostView={host} leaving={leaving} i={i} />
              ))}
              {Array.from({ length: open }, (_, i) => (
                <li key={`open${i}`} className="prow prow--open">
                  <span className="avatar avatar--open">
                    <Icon name="plus" />
                  </span>
                  <span className="prow__name">{i === 0 ? 'Open slot · share the link' : 'Open slot'}</span>
                </li>
              ))}
            </ol>
            {!enough ? (
              <p className="lobby__note">
                <Icon name="info" size="sm" />
                Waiting for at least {lobby.minPlayers} players{bots > 0 ? ": bots fill in when the match starts" : " (bots are off)"}.
              </p>
            ) : (
              !host && (
                <p className="lobby__note">
                  <Icon name="eye" size="sm" />
                  {playerName(hostName, false)} is the host and picks the mission.
                </p>
              )
            )}
          </section>

          {/* C · the mission */}
          <section className="card card--print lobby__set m-p3" style={row(2)} aria-labelledby="set-title">
            <div className="lobby__head">
              <h2 id="set-title" className="display">
                Mission
              </h2>
              {host ? (
                <span className="tag tag--host">
                  <Icon name="crown" />
                  You pick
                </span>
              ) : (
                <span className="tag tag--ghost">
                  <Icon name="lock" />
                  The host picks the settings
                </span>
              )}
            </div>
            <div className="lobby__limits">
              <span>
                <Icon name="target" size="sm" />
                <b>Deathmatch</b>
              </span>
              <span>
                <Icon name="clock" size="sm" />
                <b data-bind="room.timeLimit">{minutesLabel(timeLimit)}</b>
              </span>
              <span>
                <Icon name="skull" size="sm" />
                <b data-bind="room.killLimit">{killsLabel(kills)}</b>
              </span>
              <span>
                <Icon name="bot" size="sm" />
                <b data-bind="room.bots">{botsLine(bots, botLevel)}</b>
              </span>
            </div>
            {host && (
              <div className="lobby__opts">
                <span className="label" id="tl-label">
                  Time limit
                </span>
                <div className="seg" role="radiogroup" aria-labelledby="tl-label">
                  {times.map((m) => (
                    <button
                      key={m}
                      type="button"
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
                <span className="label" id="kl-label">
                  Kill limit
                </span>
                <div className="lobby__bots">
                  <div className="stepper" role="group" aria-labelledby="kl-label">
                    <button type="button" className="btn btn--ink btn--icon btn--sm m-p8" aria-label="Fewer kills" disabled={kills !== 0 && kills <= limits.killLimit.min} onClick={blurAfter(() => setKills(kills === 0 ? limits.killLimit.min : Math.max(limits.killLimit.min, kills - KILL_STEP)))}>
                      <Icon name="minus" />
                    </button>
                    <output className="stepper__val num" data-bind="room.killLimit">
                      {kills === 0 ? '–' : <RollNum value={kills} />}
                    </output>
                    <button type="button" className="btn btn--ink btn--icon btn--sm m-p8" aria-label="More kills" disabled={kills >= limits.killLimit.max} onClick={blurAfter(() => setKills(kills === 0 ? limits.killLimit.min : Math.min(limits.killLimit.max, kills + KILL_STEP)))}>
                      <Icon name="plus" />
                    </button>
                  </div>
                  <button
                    type="button"
                    className="seg__opt mf-seg-solo"
                    aria-pressed={kills === 0}
                    disabled={kills !== 0 && timeLimit === 0}
                    title={kills !== 0 && timeLimit === 0 ? 'Set a time limit first: a match needs one or the other' : undefined}
                    onClick={blurAfter(() => setKills(kills === 0 ? 10 : 0))}
                  >
                    No limit
                  </button>
                </div>
                <BotSettings
                  id="lobby"
                  bots={bots}
                  level={botLevel}
                  onBots={(n) => {
                    showBots(n);
                    online?.setMatchSettings({ bots: n });
                  }}
                  onLevel={(l) => {
                    showBotLevel(l);
                    online?.setMatchSettings({ botLevel: l });
                  }}
                />
              </div>
            )}
            <span className="label">Map</span>
            <div className="maps" role="radiogroup" aria-label="Map" data-bind="room.map">
              {lobbyMaps(lobby.mapId).map((id) => (
                <MapCard key={id} id={id} picked={id === lobby.mapId} />
              ))}
            </div>
          </section>
        </div>

        <footer className="lobby__bar">
          <p className="lobby__warm">
            <span className="dot"></span>
            Warm-up: move and shoot freely. Nothing counts until the match starts.
          </p>
          <span className="menu-top__spacer"></span>
          {lobby.ready ? (
            <button className="btn btn--ghost btn--xl m-p8" type="button" role="switch" aria-checked="true" onClick={blurAfter(() => online?.setReady(false))}>
              <Icon name="check" />
              You're ready
            </button>
          ) : (
            <button
              className="btn btn--ghost btn--xl m-p8"
              type="button"
              role="switch"
              aria-checked="false"
              onClick={(e) => {
                remember('start', e.currentTarget);
                blurAfter(() => online?.setReady(true))(e);
              }}
            >
              <Icon name="check" />
              Ready
            </button>
          )}
          {host ? (
            <button
              className={allReady ? 'btn btn--paper btn--xl m-p8 mf-glow' : 'btn btn--paper btn--xl m-p8'}
              type="button"
              disabled={!enough}
              title={enough ? 'Start the countdown now' : `Needs ${lobby.minPlayers} players`}
              onClick={(e) => {
                remember('start', e.currentTarget);
                blurAfter(() => online?.startMatch())(e);
              }}
            >
              <Icon name="play" />
              <span className="btn__stack">
                Start now
                <span className="btn__sub">
                  {readyCount} of {people.length} ready
                </span>
              </span>
            </button>
          ) : (
            <p className="lobby__wait">
              <span className="spinner"></span>
              Waiting for {playerName(hostName, false)} to start, or everyone ready
            </p>
          )}
        </footer>
      </div>
    </Screen>
  );
}
