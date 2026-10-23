/**
 * The in-match HUD (docs/11): round two's "In-match HUD" on the desktop
 * (docs/design/military-forge-ui-v2.html) and, while the touch controls are up, the first kit's
 * "14 · Phone HUD". Plain DOM driven once per frame, in three parts:
 *   - template.ts: the kit's markup, values bound by attribute (bind.ts) and shown by state token
 *     (state.ts: data-active-state on the root, data-state on what comes and goes);
 *   - the kit's stylesheet (ui/kit.css) and hud.css (how the app hosts it, and the HUD's motion);
 *   - this file and model.ts: the values and tokens (hudFrame, pure) and the parts that come and
 *     go (kill feed, banners, damage arcs, the belt, the scoreboard).
 * An element is written only when its value changes, so a 60 fps frame costs a few dozen string
 * compares. Bars are one CSS number each; short-lived effects are CSS animations started once.
 *
 * Motion (docs/design/ui-motion-spec.md §4.1): calm, and only when something happens. Values
 * written every frame (fuel, --throw, the reticle, the dash ring refilling, the equip ring) are
 * raw; discrete changes get the patterns: rolls (P4) on counts and clocks, stamps (P7), edge
 * banners (P9) that leave accelerating (Linger), the HP bar's ease (P10) on a hit only.
 */
import { avatarElement } from '../presentation/domAvatar';
import { DamageSource, MatchPhase, type SimEvent } from '@military-forge/sim';
import { DRAGON, GAS, HitZone, POWER_WEAPONS, defaultTuning, weapons, type Tuning } from '@military-forge/content';
import type { MatchView } from '../shell/matchView';
import { formatClock, playerName } from '../shell/matchView';
import { capText, iconHref, weaponIcon } from '../ui/icons';
import { drawButtonCap } from '../gamepad/caps';
import { pingQuality } from '../ui/ping';
import { logicalRect } from '../ui/landscape';
import { PHONE_TAGS, WorldTags } from './worldTags';
import { moveIndicator, reduced, rollText, stagger, token } from '../ui/motion';
import type { Frame, NetStats, PlayerView } from '../view';
import { weaponUnderfoot } from '../weaponItems';
import { Binder } from './bind';
import {
  conditions,
  crateCompare,
  damageArc as arcLook,
  dashHint,
  dashStatus,
  eventArrow,
  eventEffect,
  eventEndLine,
  eventFx,
  eventLook,
  eventMomentOf,
  EventTimeline,
  feedFromEvents,
  fireWords,
  fuelView,
  grenadeBelt,
  healthView,
  isBlastSource,
  isBurnTick,
  itemCard,
  leaderLine,
  pickupIcon,
  pickupNear,
  pickupPrompt,
  screenAngle,
  shieldStatus,
  streakWords,
  tunedSummary,
  weaponCards,
  weaponFamily,
  type ArcKind,
  type EventMoment,
  type FeedEntry,
  type HudPlayer,
  type ScoreRow,
} from './model';
import { StateTokens } from './state';
import { HUD_VARS, hudTemplate } from './template';
import { feedTouchHud } from '../touch';
import './hud.css';
import './premium.css';

export type BannerKind = 'info' | 'event' | 'success' | 'warning' | 'danger';

export interface BannerOptions {
  /** how long it stays, ms (default 3200) */
  durationMs?: number;
  /** a smaller second line */
  detail?: string;
}

export interface HudInput {
  frame: Frame;
  tuning: Tuning;
  /** the match clock and score (null: no match) */
  match: MatchView | null;
  /** the camera's zoom level, 1 = closest */
  zoom?: number;
  /** world → screen (CSS px), for the damage arcs around the player */
  toScreen(x: number, y: number): { x: number; y: number };
  /** where the reticle goes (the pointer, or the touch aim), CSS px; null hides it */
  pointer: { x: number; y: number } | null;
  /** the net plate: ping and loss (Settings → Network → Net graph, or N) */
  showNet: boolean;
  /** Settings → Graphics → Show FPS, and the frames per second now */
  showFps: boolean;
  fps: number;
  /** Reduce flashes: the HUD stays readable over the dark-out instead of whiting out with the world */
  reduceFlashes: boolean;
  /** the white-out on screen now (fx), 0..1 */
  flash: number;
  /** the Tab scoreboard's rows (asked for only while it is open) */
  scoreRows(): ScoreRow[] | null;
  /** the owner changed gameplay numbers on this server (the admin page): a small tag */
  adminTuned?: boolean;
  /** what "Tuned by host" compares with: the room's tuning before the host's edits (default: the shipped defaults) */
  tuningBase?: Tuning;
  /** while a grenade throw is aimed (held past a tap): the strength it would go with, 0..7; −1 otherwise */
  throwAim?: number;
  /** when the last quick throw (a tap) was let go, ms (performance.now) */
  quickThrowAt?: number;
  /** Settings → Graphics → Blood: the HUD's blood decals with the low-health and heavy-hit cues */
  blood?: boolean;
}

/** Keycap text for the actions the HUD names, from Settings → Controls. */
export type HudKeys = Partial<Record<'dash' | 'grenade' | 'cycleGrenade' | 'shield' | 'swap' | 'reload' | 'scoreboard' | 'interact' | 'fire', string>>;

/** How the local player last died, for the respawn card. */
export interface DeathInfo {
  label: string;
  killer: string;
  /** what did it (sprite href), '' for none */
  icon: string;
}

/** What hudFrame needs besides the input: the HUD's own memory. */
export interface HudMemory {
  /** seconds since the local player was last hurt */
  sinceHitS: number;
  death: DeathInfo | null;
  keys: HudKeys;
  /** the touch controls are playing (a phone): prompts say what to tap, not which key */
  touch?: boolean;
  /** the net plate's detail (title), refreshed four times a second */
  netDetail: string;
  /** the health bar's ghost: where health was before the last hits (0..1) */
  hpGhost: number;
  /** a shot of ours just landed (the reticle's marker), and how: in the head, off a shield, a blast */
  hitMarker: boolean;
  headshot?: boolean;
  ricochet?: boolean;
  launchMark?: boolean;
  killMarker: boolean;
  boardOpen: boolean;
  /** we were just hurt (blood decals), and by a heavy hit or a blast (the stagger vignette) */
  hurt?: boolean;
  heavyHit?: boolean;
  /** the HP bar eases to its new value (P10) for a moment after a hit; raw otherwise (regen) */
  hpEase?: boolean;
  /** the blast that may have launched us, "Kemi's Thumper", while it can still be why we fly; null otherwise */
  launchedBy?: string | null;
  /** the last dash's direction (sim 'dash' event), while its hint shows; null otherwise */
  dashDir?: number | null;
  /** the draw under way (swap or dual toggle): its whole length, ticks */
  swapTotal?: number;
  /** a quick throw (a tap) was just let go: its stamp */
  quickThrow?: boolean;
  /** the map event's moment (warning, impact, active, all-clear: EventTimeline); absent, read from the frame (no impact or all-clear) */
  event?: EventMoment | null;
  /** a draw just ended: the gun now in hand lands (its name and class stamp, the art settles) */
  drawn?: boolean;
  /** a moment after a draw: the cue under the held gun keeps saying which key swaps back */
  swapHint?: boolean;
  /** our last kill, to confirm (who, our streak, a headshot); `n` counts them so a new one restamps */
  kill?: { victim: string; streak: number; headshot: boolean; n: number } | null;
}

export interface HudFrame {
  values: Record<string, string>;
  tokens: string[];
}

const FEED_LINES = 6;
const PHONE_FEED_LINES = 2;
/** the desktop's kill-feed rows leave after 5 s (motion spec §4.1), the phone's fade at 6 */
const FEED_MS = 5000;
const PHONE_FEED_MS = 6000;
const HIT_MARKER_MS = 180;
const KILL_MARKER_MS = 450;
/** a damage arc: in over --m-instant, held, out over 600 ms (hud.css mf-arc) */
const ARC_MS = 1300;
/** what leaves with an exit keeps showing this long (--m-fast and a frame) */
const LEAVE_MS = 170;
const HURT_MS = 450;
const HEAVY_MS = 500;
const HP_EASE_MS = 300;
const LAUNCH_MS = 2500;
const DASH_HINT_MS = 600;
const QUICK_MS = 450;
/** the gun now in hand lands (stamps) this long after its draw ends */
const DRAWN_MS = 450;
/** the draw cue keeps naming the swap-back key this long after the draw */
const SWAP_HINT_MS = 1200;
/** a kill's confirmation stays up this long */
const KILL_CONFIRM_MS = 1500;
const SHIELD_WORDS = {
  up: { state: 'Up', covers: 'Front covered', action: 'sling to dash' },
  raising: { state: 'Raising', covers: 'Coming up', action: 'sling to dash' },
  slung: { state: 'Slung', covers: 'Back covered', action: 'raise it' },
} as const;
const BANNER_LOOK: Record<BannerKind, { color: string; icon: string }> = {
  info: { color: 'var(--c-volt)', icon: 'info' },
  event: { color: 'var(--c-ev-gravity)', icon: 'bolt' },
  success: { color: 'var(--c-ok)', icon: 'ok' },
  warning: { color: 'var(--c-warn)', icon: 'warn' },
  danger: { color: 'var(--c-hp)', icon: 'bad' },
};
/** map events that bend a grenade's arc while they run (the throw meter's warning) */
const ARC_EVENTS = new Set(['lowGravity', 'gravitySurge', 'flip', 'gust']);

const fixed = (v: number, digits = 3) => (Math.round(v * 10 ** digits) / 10 ** digits).toString();
const href = (name: string | null) => (name ? iconHref(name) : '');

/** Ping quality the kit's way: green up to 100 ms, amber to 200, red beyond; 4…1 signal bars. */
export function pingLook(ms: number): { cls: string; bars: number; sig: string; tone: 'ok' | 'warn' | 'bad' } {
  if (ms <= 50) return { cls: 'ping--good', bars: 4, sig: 'sig sig--ok', tone: 'ok' };
  if (ms <= 100) return { cls: 'ping--good', bars: 3, sig: 'sig sig--warn', tone: 'ok' };
  if (ms <= 200) return { cls: 'ping--mid', bars: 2, sig: 'sig sig--bad', tone: 'warn' };
  return { cls: 'ping--bad', bars: 1, sig: 'sig sig--bad', tone: 'bad' };
}

let tunedFor: Tuning | null = null;
let tunedBase: Tuning | null = null;
let tunedText = '';
/** tunedSummary, once per tuning object (the mode hands the same one every frame) */
function tunedOnce(t: Tuning, base: Tuning): string {
  if (t !== tunedFor || base !== tunedBase) {
    tunedFor = t;
    tunedBase = base;
    tunedText = tunedSummary(t, base);
  }
  return tunedText;
}

/**
 * Every value and state token of one frame: pure, so tests can check it without a DOM. Values are
 * text, attributes (sprite hrefs, classes) and the bars' numbers (v.*, 0..1); tokens are the kit's
 * state names (low-hp, reloading, shield-up…) plus the app's own (match, net, belt…).
 */
export function hudFrame(input: HudInput, mem: HudMemory): HudFrame {
  const { frame, tuning: t } = input;
  const v: Record<string, string> = {};
  const tokens: string[] = [];
  const on = (token: string, when: boolean | undefined) => {
    if (when) tokens.push(token);
  };

  for (const [k, text] of Object.entries(mem.keys) as [keyof HudKeys, string][]) v[`bind.${k}.0`] = text;

  // match clock and score, and what the room's host tuned
  const m = input.match;
  const playing = !!m && m.phase === MatchPhase.InProgress;
  on('match', playing);
  v['match.mode'] = 'Deathmatch';
  v['match.timeLeft'] = m && playing ? formatClock(m.untimed ? m.secondsElapsed : m.secondsLeft) : '';
  v['match.limit'] = m ? (m.killLimit > 0 ? `First to ${m.killLimit}` : m.untimed ? 'No time limit' : 'No kill limit') : '';
  v['match.myScore'] = String(m?.myScore ?? 0);
  v['match.leaderShort'] = m?.leaderName || 'Leader';
  v['match.leaderScore'] = String(m?.leaderScore ?? 0);
  const tuned = tunedOnce(t, input.tuningBase ?? defaultTuning);
  on('tuned', tuned !== '');
  v['match.tunedSummary'] = tuned;

  // the map event (docs/02 §20.7) as a sequence: the warning with its countdown, the impact as it
  // starts, the strip while it runs, the all-clear after (EventTimeline); its screen treatment by kind
  const e = frame.mapEvent ?? null;
  on('event', !!e);
  on('event-active', e?.phase === 'active');
  on('event-warning', e?.phase === 'warning');
  const moment = mem.event !== undefined ? mem.event : eventMomentOf(e);
  const stage = moment?.stage ?? null;
  on('ev-shown', !!stage);
  on('ev-warning', stage === 'warning');
  on('ev-impact', stage === 'impact');
  on('ev-active', stage === 'active');
  on('ev-end', stage === 'end');
  // the treatment's own token while it runs (hud.css: the low-gravity float, the EMP flicker)
  if (moment && (stage === 'impact' || stage === 'active')) tokens.push(`ev-fx-${eventFx(moment.kind)}`);
  if (moment) {
    const look = eventLook(moment.kind);
    const arrow = eventArrow(moment.kind);
    const warning = stage === 'warning';
    const running = stage === 'impact' || stage === 'active';
    const seconds = String(moment.seconds);
    v['event.color'] = look.color;
    v['event.icon'] = iconHref(look.icon);
    v['event.arrow'] = arrow ? iconHref(arrow) : '';
    v['event.name'] = moment.name;
    v['event.description'] = moment.description;
    v['event.effect'] = eventEffect(moment.description);
    v['event.over'] = `${moment.name} over`;
    v['event.endLine'] = eventEndLine(moment.kind);
    v['event.fx'] = eventFx(moment.kind);
    v['event.stage'] = stage!;
    v['event.startsIn'] = warning ? seconds : '';
    v['event.count'] = warning ? seconds : '';
    // the digit stamps each second: its class alternates, so the stamp's animation starts again
    v['event.countClass'] = `display num mf-evw__digit mf-evw__digit--${moment.seconds % 2 ? 'a' : 'b'}`;
    v['event.timeLeft'] = running ? seconds : '';
    v['v.event'] = running ? fixed(moment.progress, 2) : '0';
    v['v.evWarn'] = warning ? fixed(moment.progress, 3) : '0';
  } else {
    v['v.event'] = '0';
    v['v.evWarn'] = '0';
  }

  // the net plate and the frame counter
  const net = frame.net;
  on('net', input.showNet && !!net);
  if (net) {
    const ping = Math.round(net.rttMs);
    const look = pingLook(ping);
    v['net.sig'] = look.sig;
    v['net.tone'] = look.tone;
    v['net.phoneClass'] = `phud-ping num ${look.cls}`;
    v['net.ping'] = `${ping} ms`;
    const loss = net.prediction?.snapshotLossPct ?? 0;
    const jitter = net.prediction ? `±${Math.round(net.prediction.rttJitterMs)}` : '';
    const via = net.transport === 'wt' ? 'WT' : net.transport === 'ws' ? 'WS' : net.transport === 'lan' ? 'LAN' : '';
    v['net.loss'] = `${loss.toFixed(1)}%`;
    // the readout the owner reports from (19 Oct 2026): jitter and the transport next to ping and loss
    v['net.jitter'] = jitter;
    v['net.via'] = via;
    v['net.viaTitle'] = via === 'WT' ? 'WebTransport (UDP)' : via === 'WS' ? 'WebSocket (TCP)' : via === 'LAN' ? 'Local room: straight to the host over your Wi-Fi' : '';
    // phones: one compact line after the ping
    v['net.short'] = [jitter, `${loss < 10 ? loss.toFixed(1) : Math.round(loss)}%`, via].filter(Boolean).join(' · ');
    v['net.detail'] = mem.netDetail;
  }
  on('fps', input.showFps && input.fps > 0);
  on('admin', input.adminTuned === true);
  v['fps.value'] = String(Math.round(input.fps));

  on('board', mem.boardOpen);
  on('blood-on', !!input.blood);

  const me = (frame.players.find((p) => p.id === frame.localId) ?? null) as HudPlayer | null;
  if (!me) {
    for (const k of ['v.hp', 'v.hpGhost', 'v.fuel', 'v.fuelDelay', 'v.shield', 'v.dash', 'v.dashCost', 'v.reload', 'v.respawn', 'v.equip', 'v.throw']) v[k] = '0';
    v['v.equipMs'] = '400ms';
    return { values: v, tokens };
  }
  on('alive', me.alive);
  on('spectating', !me.alive);
  on('hurt', me.alive && mem.hurt);
  on('heavy-hit', me.alive && mem.heavyHit);

  // health, with the ghost of recent damage and the regen delay; it eases only on a hit (P10)
  const hv = healthView(me.hp, t, mem.sinceHitS);
  v['player.hp'] = String(hv.hp);
  v['v.hp'] = fixed(hv.fill);
  v['v.hpGhost'] = fixed(Math.max(hv.fill, mem.hpGhost));
  on('low-hp', me.alive && hv.low);
  on('hp-ease', mem.hpEase);
  v['player.hpCue'] = hv.regenIn > 0 ? ` · regen starts in ${Math.ceil(hv.regenIn)} s` : hv.regenerating ? ' · regenerating' : '';

  // jet fuel and its regen delay; the jetpack's conditions
  const c = conditions(me);
  const fv = fuelView(me, t);
  v['player.fuel'] = String(Math.round(fv.fill * 100));
  v['v.fuel'] = fixed(fv.fill);
  v['v.fuelDelay'] = fixed(fv.delayLeft);
  // what the next dash costs, on the fuel bar (the fluid dash: no cooldown, it eats fuel)
  v['v.dashCost'] = fixed(t.fuelMax > 0 ? Math.max(0, Math.min(1, t.dashFuelCost / t.fuelMax)) : 0);
  on('emp', c.emp);
  v['player.empCause'] = c.empSeconds > 0 ? 'EMP grenade' : 'EMP field';
  v['player.jetDisabled'] = c.empSeconds > 0 ? `${c.empSeconds.toFixed(1)} s` : '';
  on('gas', c.inGas);
  v['player.gasCue'] = GAS_CUE;
  on('burning', me.alive && !!me.burning);
  v['player.burnCue'] = BURN_CUE;
  on('flash-reduced', input.reduceFlashes && c.blind > 0.05);
  const flying = me.alive && !me.grounded && Math.hypot(me.vx, me.vy) > t.launchSpeedX;
  on('launched', flying && !!mem.launchedBy);
  v['hit.by'] = mem.launchedBy ?? '';

  // the riot shield (up blocks the dash: the kit's shield-up)
  const sh = shieldStatus(me);
  on('shield', sh.state !== 'none');
  on('shield-up', sh.state === 'up' || sh.state === 'raising');
  if (sh.state !== 'none') {
    const words = SHIELD_WORDS[sh.state];
    v['player.shield.state'] = words.state;
    v['player.shield.covers'] = words.covers;
    v['player.shield.action'] = words.action;
    v['player.shield.hp'] = String(sh.hp);
    v['player.shield.max'] = String(Math.round(sh.hp / Math.max(1e-6, sh.fill)) || 0);
  }
  v['v.shield'] = fixed(sh.fill);

  // dash: no cooldown, the fuel (docs/02 §21). The desktop shows it on the fuel bar (v.dashCost
  // above) and dims the dash plate when the fuel buys none; the pip counts the dashes in the tank;
  // the last dash's direction shows on the rose for a moment. (--dash still feeds the phone's ring.)
  const d = dashStatus(me, t);
  on('dash-ready', d.state === 'ready');
  on('dash-cooldown', d.state === 'spent');
  on('air-used', d.state === 'spent');
  v['dash.left'] = d.left < 0 ? '∞' : `×${d.left}`;
  v['v.dash'] = fixed(1 - d.fill);
  const hint = mem.dashDir === null || mem.dashDir === undefined ? null : dashHint(mem.dashDir);
  on('dash-hint', me.alive && !!hint);
  if (hint) {
    v['dash.hintDir'] = hint.words;
    v['dash.hintRotate'] = `rotate(${hint.rose} 50 50)`;
    v['dash.hintArrow'] = `${hint.arrow}deg`;
  } else Object.assign(v, { 'dash.hintDir': '', 'dash.hintRotate': 'rotate(0 50 50)', 'dash.hintArrow': '0deg' });

  // weapons: the one in hand (the big slot; both while dual-wielding) and the one on your back
  const cards = weaponCards(me);
  const held = cards.find((w) => w.slot === me.active) ?? cards[0];
  const other = cards.find((w) => w !== held);
  const swap = Math.max(0, me.swapTicks ?? 0);
  on('weapon', !!held);
  on('switching', !!held && swap > 0);
  v['v.equip'] = swap > 0 && (mem.swapTotal ?? 0) > 0 ? fixed(1 - Math.min(1, swap / mem.swapTotal!), 2) : '0';
  v['player.slot.0.equipLeft'] = swap > 0 ? `${(swap / 60).toFixed(1)} s` : '';
  // the draw's length for its motion (the ghosts' slide, hud.css), the gun's real equip time
  v['v.equipMs'] = `${Math.round(Math.max(250, Math.min(600, ((mem.swapTotal ?? 0) / 60) * 1000)))}ms`;
  on('drawn', !!held && swap === 0 && !!mem.drawn);
  on('swap-hint', !!held && !me.dual && (swap > 0 || !!mem.swapHint));
  if (held) {
    const def = weapons[held.def];
    const hand = me.dual ? cards : [held];
    const reload = hand.find((w) => w.reload >= 0);
    const icon = href(weaponIcon(def?.id));
    const empty = !held.melee && !reload && hand.every((w) => w.mag === 0);
    on('gun', !held.melee);
    on('melee', held.melee);
    on('melee-only', held.melee && cards.every((w) => w.melee));
    on('weapon-icon', icon !== '');
    on('reloading', !!reload);
    on('empty', empty);
    on('low-ammo', !empty && !reload && hand.some((w) => w.lowAmmo));
    on('windup', !!me.windup && !held.melee);
    v['player.slot.0.windup'] = def?.charge ? 'Charging' : 'Spinning up';
    // the phone's keys (round one)
    v['weapon.0.icon'] = icon;
    v['weapon.0.mag'] = held.melee ? '—' : String(held.mag);
    v['weapon.0.tail'] = held.melee ? '' : `/${def?.mag ?? 0} · ${held.reserve}`;
    // round two's held slot
    const second = me.dual ? cards.find((w) => w !== held) : undefined;
    v['player.slot.0.idx'] = String(held.slot + 1);
    v['player.slot.0.name'] = second && second.name !== held.name ? `${held.name} & ${second.name}` : held.name;
    v['player.slot.0.family'] = weaponFamily(def);
    v['player.slot.0.fire'] = held.melee ? 'Melee' : fireWords(def);
    v['player.slot.0.icon'] = icon;
    v['player.dual.icon'] = second ? href(weaponIcon(weapons[second.def]?.id)) : icon;
    v['player.slot.0.mag'] = String(held.mag);
    v['player.slot.0.magSize'] = String(def?.mag ?? 0);
    v['player.slot.0.reserve'] = me.dual ? cards.map((w) => w.reserve).join(' · ') : String(held.reserve);
    v['player.slot.0.magL'] = String(cards[0]?.mag ?? 0);
    v['player.slot.0.magR'] = String(cards[1]?.mag ?? 0);
    v['v.reload'] = reload ? fixed(reload.reload) : '0';
  } else v['v.reload'] = '0';
  on('dual', me.dual);
  const slung = !me.dual && held ? other : undefined;
  on('slung', !me.dual && !!held);
  on('slung-item', !!slung);
  on('slung-empty', !me.dual && !!held && !slung);
  on('slung-gun', !!slung && !slung.melee);
  if (slung) {
    v['player.slot.1.icon'] = href(weaponIcon(weapons[slung.def]?.id));
    v['player.slot.1.name'] = slung.name;
    v['player.slot.1.mag'] = String(slung.mag);
    v['player.slot.1.reserve'] = String(slung.reserve);
  } else if (held) v['player.slot.1.name'] = '';
  v['weapon.zoom'] = `${input.zoom ?? 1}×`;

  // the grenade belt's head (its items are drawn by the Hud when they change), the throw meter
  const belt = grenadeBelt(me).filter((g) => g.present);
  const selected = belt.find((g) => g.selected) ?? belt[0];
  on('belt', belt.length > 0);
  on('belt-many', belt.filter((g) => g.count > 0).length > 1);
  v['grenades.selected'] = selected?.name ?? '';
  v['grenades.count'] = String(selected?.count ?? 0);
  v['grenades.max'] = String(selected?.max ?? 0);
  v['grenades.icon'] = iconHref(`g-${selected?.id ?? 'frag'}`);
  const aim = input.throwAim ?? -1;
  const aiming = me.alive && aim >= 0;
  const strength = aiming ? 0.7 + (0.3 * Math.min(7, aim)) / 7 : 0;
  on('aiming', aiming);
  v['v.throw'] = fixed(strength, 3);
  v['grenades.throwPercent'] = aiming ? `${Math.round(strength * 100)}%` : '';
  on('arc-warning', aiming && e?.phase === 'active' && ARC_EVENTS.has(e.kind));
  v['grenades.arcCause'] = e && ARC_EVENTS.has(e.kind) ? e.name : '';
  on('quick-throw', me.alive && mem.quickThrow);

  // the item underfoot or close by: a weapon crate you stand on gets the quick compare; the rest,
  // pickupPrompt's line ("Riot Shield: walk over to take")
  const item = pickupNear(me, frame.pickups);
  const prompt = pickupPrompt(me, frame.pickups, mem.touch ? null : mem.keys.interact || 'E');
  const under = me.alive ? weaponUnderfoot(frame.pickups, me) : null;
  const crate = under && !under.held ? under : null;
  on('pickup', !!prompt);
  on('pickup-crate', !!crate);
  on('pickup-item', !!prompt && !crate);
  for (const k of ['pickup.item.title', 'pickup.item.line', 'pickup.item.tone', 'pickup.weapon.power']) v[k] = '';
  if (prompt) {
    v['pickup.text'] = prompt;
    v['pickup.icon'] = item ? pickupIcon(item) : crate ? href(weaponIcon(crate.weapon.id)) : '';
    // the item card: what it is and what it does for you (a grenade pair on your belt, the shield's HP)
    if (item && !crate) {
      const card = itemCard(item, me, mem.touch ? null : mem.keys.interact || 'E');
      v['pickup.item.title'] = card.title;
      v['pickup.item.line'] = card.line;
      v['pickup.item.tone'] = card.tone;
    }
  }
  if (crate) {
    const inHand = held ? weapons[held.def] : undefined;
    on('pickup-swaps', !!inHand);
    on('pickup-cmp', !!inHand && inHand.fireMode !== 'melee');
    v['pickup.verb'] = inHand ? 'Swap' : 'Take';
    v['pickup.weapon.name'] = crate.weapon.name;
    v['pickup.weapon.family'] = weaponFamily(crate.weapon);
    v['pickup.weapon.fire'] = fireWords(crate.weapon);
    v['pickup.weapon.magWords'] = crate.weapon.fireMode === 'melee' ? 'No ammo' : `${crate.weapon.mag}-round mag`;
    v['pickup.weapon.power'] = POWER_WEAPONS.has(crate.weapon.id) ? 'power' : '';
    v['pickup.weapon.icon'] = href(weaponIcon(crate.weapon.id));
    v['pickup.held.name'] = inHand?.name ?? '';
    v['pickup.held.icon'] = href(weaponIcon(inHand?.id));
    if (inHand && inHand.fireMode !== 'melee') {
      for (const r of crateCompare(inHand, crate.weapon)) {
        v[`pickup.held.stats.${r.key}`] = r.held;
        v[`pickup.weapon.stats.${r.key}`] = r.floor;
        v[`pickup.bar.${r.key}.a`] = fixed(r.a, 2);
        v[`pickup.bar.${r.key}.b`] = fixed(r.b, 2);
        v[`pickup.delta.${r.key}.class`] = `cmp__d cmp__d--${r.dir}`;
        v[`pickup.delta.${r.key}.icon`] = r.dir === 'up' ? iconHref('chev-up') : r.dir === 'down' ? iconHref('chev-down') : '';
        v[`pickup.delta.${r.key}.text`] = r.delta;
      }
    }
  }

  // dead: who did it, and the respawn
  if (!me.alive) {
    const total = t.respawnDelay * 60;
    const death = mem.death ?? { label: 'Taken out', killer: '', icon: '' };
    on('death-weapon', death.icon !== '');
    v['death.label'] = death.label;
    v['death.killer'] = death.killer;
    v['death.icon'] = death.icon;
    const waiting = me.respawnTicks > 0;
    v['death.lead'] = waiting ? 'Respawn in' : 'Respawning…';
    const left = Math.ceil(me.respawnTicks / 60);
    v['player.respawnIn'] = waiting ? String(left) : '';
    // the digit stamps each second (its class alternates, so the animation starts again)
    v['death.numClass'] = `num mf-num--${left % 2 ? 'a' : 'b'}`;
    v['death.unit'] = waiting ? 's' : '';
    v['v.respawn'] = total > 0 ? fixed(1 - Math.min(1, me.respawnTicks / total)) : '1';
  } else v['v.respawn'] = '0';

  // our kill, confirmed: who, a headshot, the streak in words ("3 down")
  const kc = me.alive ? (mem.kill ?? null) : null;
  on('kill-confirm', !!kc);
  on('kill-head', !!kc?.headshot);
  v['kill.victim'] = kc?.victim ?? '';
  v['kill.class'] = `display mf-kc__name mf-kc__name--${(kc?.n ?? 0) % 2 ? 'a' : 'b'}`;
  v['kill.streak'] = kc ? streakWords(kc.streak) : '';
  // the spectator bar's visuals are in place for when spectating lands (netcode); nothing drives them yet
  v['spectate.name'] = '';

  // the reticle and its markers
  on('reticle', !!input.pointer && me.alive);
  on('hit', mem.hitMarker);
  on('headshot', mem.hitMarker && mem.headshot);
  on('ricochet', mem.hitMarker && mem.ricochet);
  on('launch-mark', mem.hitMarker && mem.launchMark);
  on('kill', mem.killMarker);
  return { values: v, tokens };
}

/** The gas and burn cues: how much they hurt (content). */
const GAS_CUE = `${GAS.cloud.dpsEdge}–${GAS.cloud.dpsCore} HP a second, get out`;
const BURN_CUE = DRAGON.projectile?.burn ? `${DRAGON.projectile.burn.dps} HP a second until it burns out` : 'it burns out';

/**
 * Tokens that leave with an exit instead of vanishing (the edge banners' accelerate-out, P9): when a
 * group's main token goes off, it and the members it had stay on LEAVE_MS longer with `<main>-leaving`
 * added, so hud.css can play the exit before the element hides. Coming back cancels the exit.
 */
export class Linger {
  private last = new Set<string>();
  private readonly leaving = new Map<string, { until: number; tokens: string[] }>();

  constructor(
    private readonly groups: readonly { main: string; members: readonly string[] }[],
    private readonly ms = LEAVE_MS,
  ) {}

  apply(tokens: readonly string[], now: number): string[] {
    const set = new Set(tokens);
    const out = [...tokens];
    for (const g of this.groups) {
      if (set.has(g.main)) {
        this.leaving.delete(g.main);
        continue;
      }
      let l = this.leaving.get(g.main);
      if (!l && this.last.has(g.main)) {
        l = { until: now + this.ms, tokens: [g.main, ...g.members.filter((t) => this.last.has(t))] };
        this.leaving.set(g.main, l);
      }
      if (!l) continue;
      if (now < l.until) out.push(...l.tokens, `${g.main}-leaving`);
      else this.leaving.delete(g.main);
    }
    this.last = set;
    return out;
  }
}

/** "Kemi's Thumper", "your own frag": what a blast that hit us was, for the Launched cue. */
export function blastName(attacker: string | null, source: number): string {
  const what = source === DamageSource.Grenade ? 'frag' : source === DamageSource.Mine ? 'mine' : (weapons[source]?.name ?? 'blast');
  return attacker === null ? `your own ${what}` : `${attacker}'s ${what}`;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: Element): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  parent?.appendChild(e);
  return e;
}

const SVG = 'http://www.w3.org/2000/svg';

/** <svg class="ic …"><use href="…"/></svg>, labelled when it says something on its own. */
function svgIcon(className: string, ref: string, label?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', className);
  if (label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
  } else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', ref);
  svg.appendChild(use);
  return svg;
}

const BADGE_WORDS: Record<NonNullable<FeedEntry['badge']>, [icon: string, label: string]> = {
  headshot: ['b-headshot', 'headshot'],
  ricochet: ['b-ricochet', 'ricochet off a shield'],
  blast: ['b-blast', 'blast'],
  fall: ['b-fall', 'fall'],
  suicide: ['b-self', 'own goal'],
};

/** One kill-feed line in the first kit's markup (.kf): the phone's, until the phone HUD is ported. */
export function feedLine(entry: FeedEntry): HTMLLIElement {
  const li = el('li', entry.mine ? 'kf kf--me hud-plate' : 'kf hud-plate');
  const name = (text: string, bot: boolean) => {
    el('span', 'kf__name', li).textContent = playerName(text, bot);
    if (bot) el('span', 'badge badge--bot', li).textContent = 'Bot';
  };
  const what = () => {
    if (entry.icon) li.appendChild(svgIcon(entry.icon.startsWith('#icon-wpn-') ? 'ic ic--wpn' : 'ic', entry.icon, entry.how));
    else el('span', 'kf__how', li).textContent = entry.how;
  };
  const badge = () => {
    if (!entry.badge || entry.badge === 'fall') return;
    const [icon, label] = BADGE_WORDS[entry.badge];
    li.appendChild(svgIcon('ic kf__badge', iconHref(icon), label));
  };
  if (entry.fell) {
    li.appendChild(svgIcon('ic kf__badge kf__badge--fall', iconHref('b-fall'), 'fall'));
    name(entry.victim, entry.victimBot);
    el('span', 'kf__how', li).textContent = 'fell';
  } else if (entry.suicide) {
    what();
    name(entry.victim, entry.victimBot);
    badge();
  } else {
    name(entry.killer, entry.killerBot);
    what();
    name(entry.victim, entry.victimBot);
    badge();
  }
  return li;
}

/**
 * One kill-feed row in round two's markup (the kit's .kf plate): names, what did it (a weapon's
 * glyph, a grenade's, or words) and its badge. It slides in from the right edge (P9) and its badge
 * stamps (P7); Hud.addFeed sends it off after FEED_MS.
 */
export function feedRow(entry: FeedEntry): HTMLLIElement {
  const li = el('li', `kf plate m-p9 m-p9--right${entry.mine ? ' kf--me' : ''}`);
  const name = (text: string, bot: boolean) => {
    el('span', 'kf__name', li).textContent = playerName(text, bot);
    if (bot) el('span', 'tag tag--bot', li).textContent = 'Bot';
  };
  const what = () => {
    if (entry.icon.startsWith('#icon-wpn-')) li.appendChild(svgIcon('ic--kf', entry.icon, entry.how));
    else if (entry.icon) li.appendChild(svgIcon(entry.icon.startsWith('#icon-g-') ? 'ic ic--fill kf__g' : 'ic kf__g', entry.icon, entry.how));
    else el('span', 'kf__how', li).textContent = entry.how;
  };
  const badge = () => {
    if (!entry.badge || entry.badge === 'fall') return;
    const [icon, label] = BADGE_WORDS[entry.badge];
    li.appendChild(svgIcon(`ic kf__badge kf__badge--${entry.badge === 'suicide' ? 'self' : entry.badge} m-p7`, iconHref(icon), label));
  };
  if (entry.fell) {
    li.appendChild(svgIcon('ic kf__g', iconHref('b-fall'), 'fell'));
    name(entry.victim, entry.victimBot);
  } else if (entry.suicide) {
    what();
    name(entry.victim, entry.victimBot);
    badge();
  } else {
    name(entry.killer, entry.killerBot);
    what();
    name(entry.victim, entry.victimBot);
    badge();
  }
  return li;
}

/** The kit's damage arc: a 30° slice of the r=400 ring at the top, scaled into the HUD's 800-unit box. */
const ARC_D = 'M -103.5 -386.4 A 400 400 0 0 1 103.5 -386.4';

interface Belt {
  set: string;
  state: string;
  items: Map<string, { li: HTMLElement; count: HTMLElement }>;
}

export class Hud {
  readonly root: HTMLElement;
  private readonly binder: Binder;
  private readonly states: StateTokens;
  private readonly linger = new Linger([
    { main: 'ev-warning', members: [] },
    { main: 'ev-active', members: [] },
    { main: 'ev-end', members: [] },
    { main: 'kill-confirm', members: ['kill-head'] },
    { main: 'drawn', members: [] },
    { main: 'pickup-crate', members: ['pickup-swaps', 'pickup-cmp'] },
    { main: 'pickup-item', members: [] },
  ]);
  private readonly banners: HTMLElement;
  private readonly feeds: { list: HTMLElement; max: number; row: (e: FeedEntry) => HTMLLIElement; ms: number }[];
  /** the desktop's damage arcs (round two) and the phone's (round one) */
  private readonly arcs: SVGSVGElement;
  private readonly phoneArcs: SVGSVGElement;
  /** tags over the items on the map (worldTags.ts) */
  private readonly worldTags: WorldTags;
  private readonly reticles: HTMLElement[];
  private readonly markers: HTMLElement[];
  private readonly beltList: HTMLElement;
  private readonly beltSel: HTMLElement;
  private readonly board: HTMLElement;
  private readonly slots: { held: HTMLElement; slung: HTMLElement };
  private names: ReadonlyMap<number, string> = new Map();
  /** the roster's bots (every one, not only those the snapshot shows: it leaves out who's out of view) */
  private rosterBots: ReadonlySet<number> = new Set();
  private feedKey = 0;
  private lastHitAt = -Infinity;
  private hitMarkerUntil = 0;
  private killMarkerUntil = 0;
  private hitHow = { head: false, rico: false, blast: false };
  private pulseMarker = false;
  private hurtUntil = 0;
  private heavyUntil = 0;
  private hpEaseUntil = 0;
  private launched: { by: string; until: number } | null = null;
  private dash: { dir: number; until: number } | null = null;
  private swapTotal = 0;
  private lastSwap = 0;
  private drawnUntil = 0;
  private swapHintUntil = 0;
  /** the map event's sequence (warning → impact → active → all-clear) */
  private readonly events = new EventTimeline();
  /** our kills since we last died, and the last one to confirm */
  private streak = 0;
  private kill: { victim: string; streak: number; headshot: boolean; n: number; until: number } | null = null;
  private kills = 0;
  /** the world tags on the phone screen (the nearest few, smaller) */
  private readonly phoneTags: WorldTags;
  private lastActive = -1;
  private death: DeathInfo | null = null;
  private keys: HudKeys = {};
  private keyCodes: Partial<Record<keyof HudKeys, string | undefined>> = {};
  private netDetail = '';
  private netAt = 0;
  private ghost = { value: 1, heldUntil: 0, lastHp: 1, at: 0 };
  private me: PlayerView | null = null;
  private others: readonly PlayerView[] = [];
  private scoreboardOpen = false;
  private scoreboardAt = 0;
  private boardKey = '';
  private boardCells: HTMLElement[][] = [];
  private boardClock: HTMLElement | null = null;
  private boardLead: HTMLElement | null = null;
  private scoreboardCodes: readonly string[] = ['Tab'];
  private blocked = false;
  private visible: boolean | null = null;
  private opacity = '';
  private belt: Belt = { set: '', state: '', items: new Map() };
  private reticleAt = '';
  private arcsAt = '';
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.scoreboardCodes.includes(e.code) || e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    this.setScoreboard(e.type === 'keydown' && !this.blocked);
  };
  private readonly onBlur = () => this.setScoreboard(false);

  constructor(parent: HTMLElement = document.body) {
    this.root = el('div', 'mf mf-hud');
    this.root.id = 'hud';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = hudTemplate();
    this.root.setAttribute('data-bind-var', HUD_VARS);
    parent.appendChild(this.root);
    this.binder = new Binder(this.root);
    // the tokens on #hud (hud.css) and on each screen, inside its kit's wrapper (the kits' scoped state rules)
    this.states = new StateTokens(this.root, [...this.root.querySelectorAll<HTMLElement>('.mf-hud-fit > .screen')]);
    const one = <T extends Element>(sel: string) => this.root.querySelector<T>(sel)!;
    const desk = '.mf-hud-desktop';
    this.banners = one<HTMLElement>('.mf-hud-banners');
    this.feeds = [
      { list: one<HTMLElement>(`${desk} .killfeed`), max: FEED_LINES, row: feedRow, ms: FEED_MS },
      { list: one<HTMLElement>('.phud-feed'), max: PHONE_FEED_LINES, row: feedLine, ms: PHONE_FEED_MS },
    ];
    this.arcs = one<SVGSVGElement>(`${desk} .dmg`);
    this.phoneArcs = one<SVGSVGElement>('.mf-hud-phone .dmg-arcs');
    this.worldTags = new WorldTags(one<HTMLElement>(`${desk} .mf-world`));
    this.phoneTags = new WorldTags(one<HTMLElement>('.mf-hud-phone .mf-world'), PHONE_TAGS);
    this.reticles = [one<HTMLElement>(`${desk} .reticle`), one<HTMLElement>('.mf-hud-phone .reticle')];
    this.markers = [...this.root.querySelectorAll<HTMLElement>(`${desk} .mf-mk`)];
    this.beltList = one<HTMLElement>(`${desk} .belt__list`);
    this.beltSel = one<HTMLElement>(`${desk} .mf-belt__sel`);
    this.board = one<HTMLElement>(`${desk} .sb`);
    this.slots = { held: one<HTMLElement>(`${desk} .slot--held`), slung: one<HTMLElement>(`${desk} .slot--slung`) };
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
  }

  /** The keys that hold the scoreboard open (Settings → Controls). */
  setScoreboardKeys(codes: readonly string[]): void {
    this.scoreboardCodes = codes;
  }

  /** Keycaps next to actions, from the player's bindings: { dash: 'ShiftLeft', grenade: 'KeyG', … } (codes). */
  setKeys(codes: Partial<Record<keyof HudKeys, string | undefined>>, layout?: ReadonlyMap<string, string> | null): void {
    const keys: HudKeys = {};
    for (const [k, code] of Object.entries(codes) as [keyof HudKeys, string | undefined][]) keys[k] = code ? capText(code, layout) : '';
    this.keys = keys;
    this.keyCodes = codes;
    for (const cap of this.root.querySelectorAll<HTMLElement>('kbd[data-bind]')) {
      const action = cap.getAttribute('data-bind')?.split('.')[1] as keyof HudKeys;
      drawButtonCap(cap, codes[action], keys[action] ?? '');
    }
  }

  /** Menus over the game: no scoreboard on Tab. */
  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (blocked) this.setScoreboard(false);
  }

  setVisible(on: boolean): void {
    if (on !== this.visible) {
      this.visible = on;
      this.root.style.display = on ? '' : 'none';
    }
    if (!on) this.setScoreboard(false);
  }

  /** The roster: names by player id, and which of them are bots (their Bot badge, no "[BOT]" tag). */
  setNames(names: ReadonlyMap<number, string>, bots: ReadonlySet<number> = new Set()): void {
    this.names = names;
    this.rosterBots = bots;
  }

  /** Sim events (local mode's, or the server's plus our own predicted shots): feed, arcs, markers, cues. */
  onEvents(events: readonly SimEvent[], localId: number): void {
    const now = performance.now();
    const how = { hit: false, head: false, rico: false, blast: false };
    for (const e of events) {
      if (e.type === 'hit' && e.target === localId) {
        this.lastHitAt = now;
        this.hpEaseUntil = now + HP_EASE_MS;
        const burn = isBurnTick(e.source, e.damage) || e.source === DamageSource.Gas;
        if (e.damage > 0) this.hurtUntil = now + HURT_MS;
        if (!burn) {
          const look = arcLook(e.source, e.damage);
          if (look.kind !== 'bullet') this.heavyUntil = now + HEAVY_MS;
          if (e.attacker !== localId) {
            const shot = events.find((event): event is Extract<SimEvent, { type: 'shot' }> => event.type === 'shot' && event.shooter === e.attacker && event.target === localId && event.hit === 2);
            this.damageArc(e.attacker, look.kind, look.amount, shot ? { x: shot.ox, y: shot.oy } : undefined);
          }
        }
        if (isBlastSource(e.source)) {
          const by = e.attacker === localId || e.attacker < 0 ? null : playerName(this.names.get(e.attacker) ?? `Player ${e.attacker + 1}`, this.isBot(e.attacker));
          this.launched = { by: blastName(by, e.source), until: now + LAUNCH_MS };
        }
      }
      if (e.type === 'hit' && e.attacker === localId && e.target !== localId) {
        how.hit = true;
        if (e.zone === HitZone.Head) how.head = true;
        if (isBlastSource(e.source)) how.blast = true;
      }
      if (e.type === 'ricochet' && e.shooter === localId && e.hit === 2 && e.target !== localId) how.rico = true;
      if (e.type === 'death' && e.killer === localId && e.victim !== localId) this.killMarkerUntil = now + KILL_MARKER_MS;
      if (e.type === 'dash' && e.player === localId) this.dash = { dir: e.dir, until: now + DASH_HINT_MS };
    }
    if (how.hit) {
      this.hitMarkerUntil = now + HIT_MARKER_MS;
      this.hitHow = { head: how.head, rico: how.rico, blast: how.blast };
      this.pulseMarker = true;
    }
    const bots = new Set(this.rosterBots);
    for (const p of this.others) if (p.isBot) bots.add(p.id);
    for (const entry of feedFromEvents(events, localId, this.names, () => ++this.feedKey, bots)) {
      this.addFeed(entry);
      if (entry.mine === 'killer') {
        this.streak += 1;
        this.kills += 1;
        this.kill = { victim: playerName(entry.victim, entry.victimBot), streak: this.streak, headshot: entry.headshot, n: this.kills, until: now + KILL_CONFIRM_MS };
      } else if (entry.mine === 'victim') {
        this.streak = 0;
        this.kill = null;
      }
      if (entry.mine === 'victim') {
        this.death = entry.fell
          ? { label: 'You fell', killer: '', icon: '' }
          : entry.suicide
            ? { label: 'Taken out by', killer: 'yourself', icon: entry.icon }
            : { label: 'Taken out by', killer: playerName(entry.killer, entry.killerBot), icon: entry.icon };
      }
    }
  }

  update(input: HudInput): void {
    const { frame } = input;
    const now = performance.now();
    this.me = frame.players.find((p) => p.id === frame.localId) ?? null;
    this.others = frame.players;
    if (input.showNet && now - this.netAt > 250) {
      this.netAt = now;
      this.netDetail = netGraph(frame.net);
    }
    const hpFill = this.me ? Math.max(0, Math.min(1, this.me.hp / input.tuning.healthMax)) : 1;
    const swap = Math.max(0, this.me?.swapTicks ?? 0);
    if (swap > this.lastSwap) this.swapTotal = swap;
    // a draw just ended: the gun lands, and the cue says which key swaps back a moment longer
    if (this.lastSwap > 0 && swap === 0) {
      this.drawnUntil = now + DRAWN_MS;
      this.swapHintUntil = now + SWAP_HINT_MS;
    }
    this.lastSwap = swap;
    if (this.kill && now >= this.kill.until) this.kill = null;
    const hitting = now < this.hitMarkerUntil;
    const { values, tokens } = hudFrame(input, {
      sinceHitS: (now - this.lastHitAt) / 1000,
      death: this.death,
      keys: this.keys,
      touch: typeof document !== 'undefined' && document.documentElement.hasAttribute('data-touch-controls') && document.documentElement.dataset.input !== 'pad',
      netDetail: this.netDetail,
      hpGhost: this.ghostAt(hpFill, now),
      hitMarker: hitting,
      headshot: hitting && this.hitHow.head,
      ricochet: hitting && this.hitHow.rico,
      launchMark: hitting && this.hitHow.blast,
      killMarker: now < this.killMarkerUntil,
      boardOpen: this.scoreboardOpen,
      hurt: now < this.hurtUntil,
      heavyHit: now < this.heavyUntil,
      hpEase: now < this.hpEaseUntil,
      launchedBy: this.launched && now < this.launched.until ? this.launched.by : null,
      dashDir: this.dash && now < this.dash.until ? this.dash.dir : null,
      swapTotal: this.swapTotal,
      quickThrow: now - (input.quickThrowAt ?? -Infinity) < QUICK_MS,
      event: this.events.update(frame.mapEvent, now),
      drawn: now < this.drawnUntil,
      swapHint: now < this.swapHintUntil,
      kill: this.kill,
    });
    this.binder.update(values);
    this.states.set(this.linger.apply(tokens, now));
    if (this.me?.alive) this.death = null;
    this.crossSlots(swap);
    if (this.pulseMarker) {
      this.pulseMarker = false;
      this.pulse();
    }
    this.drawBelt();
    feedTouchHud(values, tokens); // the phone's thumb dials wear these too (touch/skin.ts)
    this.place(input);
    // the world tags of the screen that shows (the desktop's, or the phone's while the touch controls are up)
    const phone = typeof document !== 'undefined' && document.documentElement.hasAttribute('data-touch-controls');
    const tags = { on: phone ? this.phoneTags : this.worldTags, off: phone ? this.worldTags : this.phoneTags };
    tags.off.update(undefined, null, input.toScreen, 1, '', true);
    tags.on.update(frame.pickups, this.me, input.toScreen, Number(getComputedStyleValue(phone ? '--phone-fit' : '--hud-fit')) || 1, this.keys.interact ?? '', !this.me?.alive, this.keyCodes.interact);
    // the white-out takes the HUD with the world; Reduce flashes keeps it readable over the dark-out
    const opacity = input.reduceFlashes ? '' : fixed(1 - Math.min(1, input.flash), 2);
    if (opacity !== this.opacity) {
      this.opacity = opacity;
      this.root.style.opacity = opacity === '1' ? '' : opacity;
    }
    if (this.scoreboardOpen && now - this.scoreboardAt > 250) {
      const fresh = this.scoreboardAt === 0;
      this.scoreboardAt = now;
      this.drawScoreboard(input.scoreRows(), input.match, fresh);
    }
  }

  // ---- banners (announcements; the map event has its own under the clock) ----

  showBanner(text: string, kind: BannerKind = 'info', options: BannerOptions = {}): void {
    const look = BANNER_LOOK[kind];
    const b = el('div', 'plate mf-hud-banner m-p9');
    b.style.setProperty('--ev', look.color);
    const ms = options.durationMs ?? 3200;
    b.setAttribute('role', 'status');
    el('span', 'mf-hud-banner__ic', b).appendChild(svgIcon('ic', iconHref(look.icon)));
    const body = el('div', 'mf-hud-banner__text', b);
    el('b', 'mf-hud-banner__title', body).textContent = text;
    if (options.detail) el('span', 'mf-hud-banner__desc', body).textContent = options.detail;
    this.banners.appendChild(b);
    // at most three: the oldest goes
    while (this.banners.children.length > 3) this.banners.firstElementChild?.remove();
    window.setTimeout(() => leave(b), ms);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.worldTags.dispose();
    this.phoneTags.dispose();
    this.root.remove();
  }

  // ---- internals ----

  private isBot(id: number): boolean {
    return this.rosterBots.has(id) || this.others.some((p) => p.id === id && p.isBot);
  }

  /** The health bar's ghost: holds where health was for 300 ms after a hit (motion spec §4.1), then slides down. */
  private ghostAt(hp: number, now: number): number {
    const g = this.ghost;
    const dt = Math.min(0.1, (now - g.at) / 1000);
    g.at = now;
    if (hp < g.lastHp) g.heldUntil = now + 300;
    g.lastHp = hp;
    if (hp >= g.value) g.value = hp;
    else if (now > g.heldUntil) g.value = Math.max(hp, g.value - 0.6 * dt);
    return g.value;
  }

  private setScoreboard(open: boolean): void {
    if (open === this.scoreboardOpen) return;
    this.scoreboardOpen = open;
    this.scoreboardAt = 0;
  }

  /**
   * The reticle at the pointer and the damage arcs around the player, in the HUD's design pixels.
   * They move by transform (anchored at the HUD's top left: hud.css), so following the pointer stays
   * on the compositor, no layout per frame.
   */
  private place(input: HudInput): void {
    const fit = (name: string) => Number(getComputedStyleValue(name)) || 1;
    const p = input.pointer;
    const key = p ? `${Math.round(p.x)},${Math.round(p.y)}` : '';
    if (key !== this.reticleAt && p) {
      this.reticleAt = key;
      const hud = fit('--hud-fit');
      const phone = fit('--phone-fit');
      this.reticles.forEach((r, i) => {
        const f = i === 0 ? hud : phone;
        r.style.transform = `translate(${(p.x / f).toFixed(1)}px, ${(p.y / f).toFixed(1)}px)`;
      });
    }
    if (this.me) {
      const s = input.toScreen(this.me.x, this.me.y + 0.9);
      const at = `${Math.round(s.x)},${Math.round(s.y)}`;
      if (at !== this.arcsAt) {
        this.arcsAt = at;
        const hud = fit('--hud-fit');
        const phone = fit('--phone-fit');
        this.arcs.style.transform = `translate(${(s.x / hud).toFixed(1)}px, ${(s.y / hud).toFixed(1)}px)`;
        this.phoneArcs.style.transform = `translate(${(s.x / phone).toFixed(1)}px, ${(s.y / phone).toFixed(1)}px)`;
      }
    }
  }

  private addFeed(entry: FeedEntry): void {
    for (const feed of this.feeds) {
      const li = feed.row(entry);
      li.style.setProperty('--feed-ms', `${feed.ms}ms`);
      feed.list.prepend(li);
      while (feed.list.children.length > feed.max) feed.list.lastElementChild?.remove();
      window.setTimeout(() => leave(li), feed.ms);
    }
  }

  /**
   * A damage arc and close pointer toward the incoming shot (or attacker when the shot isn't in
   * this event batch). An unseen source gets a ring. Older indicators dim as new hits arrive.
   */
  private damageArc(attacker: number, kind: ArcKind, amount: number, origin?: { x: number; y: number }): void {
    const me = this.me;
    const from = attacker >= 0 ? this.others.find((p) => p.id === attacker) : undefined;
    const source = origin ?? from;
    const angle = me && source ? (screenAngle(me, source) * 180) / Math.PI + 90 : null;
    // round two (desktop)
    for (const old of this.arcs.querySelectorAll('.dmg__arc, .dmg__pointer')) old.classList.add('dmg__arc--old');
    const arc = document.createElementNS(SVG, angle === null ? 'circle' : 'path');
    if (angle === null) arc.setAttribute('r', '400');
    else arc.setAttribute('d', ARC_D);
    arc.setAttribute('transform', 'scale(.7)');
    arc.setAttribute('class', `dmg__arc dmg__arc--${kind}`);
    (arc as SVGElement).style.setProperty('--amt', fixed(amount, 2));
    (arc as SVGElement).style.setProperty('--rot', `${(angle ?? 0).toFixed(1)}deg`);
    this.arcs.appendChild(arc);
    if (angle !== null) {
      const pointer = document.createElementNS(SVG, 'path');
      pointer.setAttribute('d', 'M 0 -148 L -15 -114 L 0 -121 L 15 -114 Z');
      pointer.setAttribute('transform', `rotate(${angle.toFixed(1)})`);
      pointer.setAttribute('class', `dmg__pointer dmg__pointer--${kind}`);
      (pointer as SVGElement).style.setProperty('--amt', fixed(amount, 2));
      this.arcs.appendChild(pointer);
      window.setTimeout(() => pointer.remove(), ARC_MS);
    }
    while (this.arcs.children.length > 8) this.arcs.firstElementChild?.remove();
    window.setTimeout(() => arc.remove(), ARC_MS);
    // round one (phone)
    for (const old of this.phoneArcs.querySelectorAll('.dmg-arc, .dmg-pointer')) old.classList.add('dmg-arc--old');
    let p: SVGElement;
    if (angle !== null) {
      p = document.createElementNS(SVG, 'path');
      p.setAttribute('d', 'M -51.3 -141 A 150 150 0 0 1 51.3 -141');
      p.setAttribute('transform', `rotate(${angle.toFixed(1)})`);
    } else {
      p = document.createElementNS(SVG, 'circle');
      p.setAttribute('r', '150');
    }
    p.setAttribute('class', 'dmg-arc');
    this.phoneArcs.appendChild(p);
    if (angle !== null) {
      const pointer = document.createElementNS(SVG, 'path');
      pointer.setAttribute('d', 'M 0 -104 L -12 -76 L 0 -82 L 12 -76 Z');
      pointer.setAttribute('transform', `rotate(${angle.toFixed(1)})`);
      pointer.setAttribute('class', `dmg-pointer dmg-pointer--${kind}`);
      this.phoneArcs.appendChild(pointer);
      window.setTimeout(() => pointer.remove(), ARC_MS);
    }
    while (this.phoneArcs.children.length > 8) this.phoneArcs.firstElementChild?.remove();
    window.setTimeout(() => p.remove(), ARC_MS);
  }

  /** A hit marker: scale 1.3 → 1 in --m-instant, then it fades (motion spec §4.1); each hit restarts it. */
  private pulse(): void {
    if (reduced()) return;
    const shown = this.markers.find((m) => !m.hasAttribute('hidden'));
    if (!shown || typeof shown.animate !== 'function') return;
    for (const a of shown.getAnimations()) a.cancel();
    shown.animate([{ scale: '1.3', opacity: 1 }, { scale: '1', opacity: 1, offset: 0.5 }, { scale: '1', opacity: 0 }], { duration: HIT_MARKER_MS, easing: 'ease-out' });
  }

  /**
   * A swap: the two slot cards trade places (motion spec §4.1) over the gun's real equip time
   * (0.25–0.6 s) on --ease-travel. The held card grows into its place from where the slung card was
   * (one uniform scale, anchored at the slung card's corner, so nothing is stretched); the slung card
   * slides back from the held card's side and fades in. The equip bar and ring fill at the same pace
   * from the sim; the incoming gun's art and its ghosts (hud.css) ride inside the held card.
   */
  private crossSlots(swap: number): void {
    const me = this.me;
    const active = me && me.alive && !me.dual ? me.active : -1;
    const changed = this.lastActive >= 0 && active >= 0 && active !== this.lastActive;
    this.lastActive = active;
    if (!changed || swap <= 0 || reduced()) return;
    const { held, slung } = this.slots;
    if (held.hasAttribute('hidden') || slung.hasAttribute('hidden') || typeof held.animate !== 'function') return;
    const zoom = Number(getComputedStyleValue('--hud-fit')) || 1;
    const a = logicalRect(held);
    const b = logicalRect(slung);
    if (a.width === 0 || b.width === 0) return;
    const duration = Math.max(250, Math.min(600, (swap / 60) * 1000));
    const easing = token('--ease-travel', 'cubic-bezier(0.7, 0, 0.16, 1)');
    for (const card of [held, slung]) for (const old of card.getAnimations()) if (!('animationName' in old)) old.cancel(); // ours, not the CSS stamps
    // the held card, from the slung card's box: same bottom-left corner, scaled to its height
    const k = Math.max(0.3, Math.min(1, b.height / a.height));
    const dx = (b.left - a.left) / zoom;
    const dy = (b.top + b.height - (a.top + a.height)) / zoom;
    held.animate([{ transformOrigin: '0 100%', transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${k.toFixed(3)})`, opacity: 0.35 }, { transformOrigin: '0 100%', transform: 'none', opacity: 1 }], { duration, easing });
    // the slung card, sliding back from where the held one was
    const sx = (a.left - b.left) / zoom;
    slung.animate([{ transform: `translateX(${(sx * 0.5).toFixed(1)}px)`, opacity: 0 }], { duration, easing }); // to its own place and opacity
  }

  /**
   * The belt: its items are built when the types carried change; counts roll (P4) and the selection
   * slides (P5) when they change, nothing otherwise.
   */
  private drawBelt(): void {
    const me = this.me as HudPlayer | null;
    const belt = me ? grenadeBelt(me).filter((g) => g.present) : [];
    const set = belt.map((g) => g.id).join(' ');
    const b = this.belt;
    if (set !== b.set) {
      b.set = set;
      b.state = '';
      b.items.clear();
      const items = belt.map((g) => {
        const li = el('li', 'belt__item');
        li.appendChild(svgIcon('ic ic--fill ic--lg', iconHref(`g-${g.id}`)));
        const count = el('b', 'belt__count num', li);
        b.items.set(g.id, { li, count });
        return li;
      });
      this.beltList.replaceChildren(...items);
    }
    const state = belt.map((g) => `${g.count}:${g.selected ? 1 : 0}`).join(' ');
    if (state === b.state) return;
    const first = b.state === '';
    b.state = state;
    for (const g of belt) {
      const item = b.items.get(g.id)!;
      item.li.classList.toggle('is-selected', g.selected);
      item.li.classList.toggle('is-empty', g.count === 0);
      item.li.setAttribute('aria-label', `${g.name}, ${g.count} of ${g.max}${g.selected ? ', selected' : ''}`);
      rollText(item.count, String(g.count));
      if (g.selected) {
        moveIndicator(this.beltSel, item.li.offsetLeft, item.li.offsetWidth);
        // the first placement is where it starts, not a move
        if (first) this.beltSel.style.transition = 'none';
      }
    }
  }

  /**
   * The Tab scoreboard (the kit's .sb): built when it opens (the panel focus-pulls in at --m-fast,
   * the rows rise 20 ms apart), then its cells are rewritten in place four times a second; a new
   * order or player rebuilds the rows without the entrance.
   */
  private drawScoreboard(rows: ScoreRow[] | null, match: MatchView | null, fresh: boolean): void {
    const list = rows ?? [];
    const key = list.map((r) => `${r.key}:${r.bot ? 1 : 0}:${r.you ? 1 : 0}:${r.host ? 1 : 0}:${r.left ? 1 : 0}:${r.name}`).join('|');
    const clock = match?.phase === MatchPhase.InProgress ? formatClock(match.untimed ? match.secondsElapsed : match.secondsLeft) : '';
    if (fresh || key !== this.boardKey) {
      const head = el('header', 'sb__head');
      el('h1', 'display', head).textContent = 'Scoreboard';
      const limit = match ? (match.killLimit > 0 ? `first to ${match.killLimit}` : 'no kill limit') : '';
      el('span', 'sb__meta', head).textContent = ['Deathmatch', match?.mapName ?? '', limit].filter(Boolean).join(' · ');
      this.boardClock = el('b', 'sb__clock num', head);
      // who leads and where you stand (rewritten below with the scores)
      this.boardLead = el('p', 'sb__lead');
      const table = el('table', 'sb__table');
      const tr = el('tr', '', el('thead', '', table));
      for (const text of ['#', 'Player', 'Score', 'Kills', 'Deaths', 'Ping']) {
        const th = el('th', '', tr);
        th.scope = 'col';
        th.textContent = text;
      }
      const body = el('tbody', '', table);
      const lead = list.length > 1 && list[0]!.score > list[1]!.score;
      this.boardCells = list.map((r, i) => {
        const row = el('tr', [fresh ? 'm-p3 m-p3--tight' : '', r.you ? 'is-you' : ''].filter(Boolean).join(' '), body);
        if (r.id !== undefined && !r.left) row.dataset.pid = String(r.id); // voice chat's talking ring (voice/voice.css)
        if (fresh) stagger(row, i);
        const rank = el('td', 'sb__rank num', row);
        const who = el('td', 'sb__name', row);
        // their soldier's portrait when the lobby cached it (presentation/domAvatar.ts), else the initial
        who.appendChild(avatarElement(document, r.left ? -1 : (r.id ?? -1), r.name, r.bot));
        el('b', '', who).textContent = playerName(r.name, r.bot);
        if (i === 0 && lead) {
          const crown = el('span', 'stamp stamp--volt sb__crown', who);
          crown.append(svgIcon('ic ic--sm', iconHref('crown')), 'Lead');
        }
        if (r.you) el('span', 'tag tag--you', who).textContent = 'You';
        if (r.host) el('span', 'tag tag--host', who).textContent = 'Host';
        if (r.bot) el('span', 'tag tag--bot', who).textContent = 'Bot';
        if (r.left) el('span', 'tag tag--ghost', who).textContent = 'Left';
        return [rank, el('td', 'num sb__k', row), el('td', 'num', row), el('td', 'num', row), el('td', 'num sb__ping', row)];
      });
      if (!list.length) {
        const empty = el('td', 'sb__ping', el('tr', '', body));
        empty.colSpan = 6;
        empty.textContent = 'Scores show while a match runs.';
      }
      const foot = el('footer', 'sb__foot');
      foot.append('Hold ');
      drawButtonCap(el('kbd', 'kbd', foot), this.keyCodes.scoreboard, this.keys.scoreboard || 'Tab');
      foot.append(' to keep this open · ranked by score: kills minus self-kills · bots show no ping');
      this.board.replaceChildren(head, this.boardLead, table, foot);
      this.boardKey = key;
    }
    if (this.boardClock && this.boardClock.textContent !== clock) this.boardClock.textContent = clock;
    const lead = leaderLine(list, match?.killLimit ?? 0, (r) => playerName(r.name, r.bot));
    if (this.boardLead && this.boardLead.textContent !== lead) {
      this.boardLead.textContent = lead;
      this.boardLead.hidden = !lead;
    }
    list.forEach((r, i) => {
      const cells = this.boardCells[i];
      if (!cells) return;
      const text = [String(i + 1), String(r.score), String(r.kills), String(r.deaths), r.ping >= 0 ? `${r.ping} ms` : '·'];
      cells.forEach((c, j) => {
        if (c.textContent !== text[j]) c.textContent = text[j]!;
      });
      // the ping in the kit's bands (green to 100 ms, amber to 200, red beyond)
      const ping = cells[5]!;
      const band = r.ping >= 0 ? pingQuality(r.ping).cls : '';
      if (ping.dataset.band !== band) {
        ping.classList.remove('ping--good', 'ping--mid', 'ping--bad');
        if (band) ping.classList.add(band);
        ping.dataset.band = band;
      }
    });
  }
}

/** An edge banner or feed row leaves: accelerating out (P9's .is-leaving), then it's gone. */
function leave(node: HTMLElement): void {
  if (!node.isConnected) return;
  node.classList.add('is-leaving');
  window.setTimeout(() => node.remove(), reduced() ? 0 : LEAVE_MS);
}

/** A CSS variable on <html> (fit.ts writes the HUD's zoom there). */
function getComputedStyleValue(name: string): string {
  return document.documentElement.style.getPropertyValue(name);
}

/** The net plate's detail (its title, and the two-player script's numbers): the full net graph. */
export function netGraph(n: NetStats | undefined): string {
  if (!n) return 'local match · no network';
  const p = n.prediction;
  const lines = [
    `ping ${n.rttMs.toFixed(0)} ms${p ? ` ±${p.rttJitterMs.toFixed(0)}` : ''} · loss ${p ? p.snapshotLossPct.toFixed(1) : '0.0'}% · ${n.snapshotsPerSec.toFixed(0)} snap/s${n.transport ? ` · ${n.transport === 'wt' ? 'WebTransport' : n.transport === 'ws' ? 'WebSocket' : 'local room'}` : ''}`,
    `↓ ${n.kbInPerSec.toFixed(1)} KB/s · ↑ ${n.kbOutPerSec.toFixed(1)} KB/s · interp ${n.interpDelayMs} ms`,
  ];
  if (p) lines.push(`buffer ${Number.isNaN(p.inputBufferHealth) ? '–' : p.inputBufferHealth} · ×${p.timeScale.toFixed(3)} · corrections ${p.correctionsPerMin.toFixed(1)}/min`);
  lines.push(n.status);
  if (p?.suggestLowBandwidth) lines.push('heavy packet loss: try Low-bandwidth mode (Settings)');
  return lines.join('\n');
}
