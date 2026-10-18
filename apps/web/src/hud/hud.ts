/**
 * The in-match HUD (docs/11): the owner's design kit's "7 · In-match HUD" and, while the touch
 * controls are up, its "14 · Phone HUD". Plain DOM driven once per frame, in three parts:
 *   - template.ts: the kit's markup, values bound by attribute (bind.ts) and shown by state token
 *     (state.ts: data-active-state on the root, data-state on what comes and goes);
 *   - the kit's stylesheet (ui/kit.css) and hud.css (how the app hosts it);
 *   - this file and model.ts: the values and tokens (hudFrame, pure) and the parts that come and
 *     go (kill feed, banners, damage arcs, the belt, the scoreboard).
 * An element is written only when its value changes, so a 60 fps frame costs a few dozen string
 * compares. Bars are one CSS number each; short-lived effects are CSS animations started once.
 */
import { GAS, weapons, type Tuning } from '@military-forge/content';
import { MatchPhase, type SimEvent } from '@military-forge/sim';
import type { MatchView } from '../shell/matchView';
import { formatClock, playerName } from '../shell/matchView';
import { capText, iconHref, weaponIcon } from '../ui/icons';
import type { Frame, NetStats, PlayerView } from '../view';
import { Binder } from './bind';
import { conditions, dashStatus, eventLook, feedFromEvents, fuelView, grenadeBelt, healthView, pickupIcon, pickupNear, pickupPrompt, screenAngle, shieldStatus, weaponCards, type FeedEntry, type HudPlayer, type ScoreRow } from './model';
import { StateTokens } from './state';
import { HUD_VARS, hudTemplate } from './template';
import { touchGrenade } from './touchSkin';
import './hud.css';

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
}

/** Keycap text for the actions the HUD names, from Settings → Controls. */
export type HudKeys = Partial<Record<'dash' | 'grenade' | 'cycleGrenade' | 'shield' | 'swap' | 'reload' | 'scoreboard', string>>;

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
  /** the net plate's detail (title), refreshed four times a second */
  netDetail: string;
  /** the health bar's ghost: where health was before the last hits (0..1) */
  hpGhost: number;
  hitMarker: boolean;
  killMarker: boolean;
  boardOpen: boolean;
}

export interface HudFrame {
  values: Record<string, string>;
  tokens: string[];
}

const FEED_LINES = 6;
const PHONE_FEED_LINES = 2;
const FEED_MS = 6000;
const HIT_MARKER_MS = 180;
const KILL_MARKER_MS = 450;
const ARC_MS = 1300;
const SHIELD_WORDS = {
  up: { state: 'Up', covers: 'Front covered', action: 'sling it to dash' },
  raising: { state: 'Raising', covers: 'Coming up', action: 'sling it to dash' },
  slung: { state: 'Slung', covers: 'Back covered', action: 'raise it' },
} as const;
const BANNER_LOOK: Record<BannerKind, { color: string; icon: string }> = {
  info: { color: 'var(--c-volt)', icon: 'info' },
  event: { color: 'var(--c-ev-gravity)', icon: 'bolt' },
  success: { color: 'var(--c-ok)', icon: 'ok' },
  warning: { color: 'var(--c-warn)', icon: 'warn' },
  danger: { color: 'var(--c-hp)', icon: 'bad' },
};

const fixed = (v: number, digits = 3) => (Math.round(v * 10 ** digits) / 10 ** digits).toString();
const href = (name: string | null) => (name ? iconHref(name) : '');

/** Ping quality the kit's way: green up to 100 ms, amber to 200, red beyond; 4…1 signal bars. */
export function pingLook(ms: number): { cls: string; bars: number } {
  if (ms <= 50) return { cls: 'ping--good', bars: 4 };
  if (ms <= 100) return { cls: 'ping--good', bars: 3 };
  if (ms <= 200) return { cls: 'ping--mid', bars: 2 };
  return { cls: 'ping--bad', bars: 1 };
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

  // match clock and score
  const m = input.match;
  const playing = !!m && m.phase === MatchPhase.InProgress;
  on('match', playing);
  v['match.mode'] = 'Deathmatch';
  v['match.timeLeft'] = m && playing ? formatClock(m.untimed ? m.secondsElapsed : m.secondsLeft) : '';
  v['match.limit'] = m ? (m.killLimit > 0 ? `First to ${m.killLimit}` : m.untimed ? 'No time limit' : 'No kill limit') : '';
  v['match.myScore'] = String(m?.myScore ?? 0);
  v['match.leaderLabel'] = m?.leaderName ? `Leader · ${m.leaderName}` : 'Leader';
  v['match.leaderShort'] = m?.leaderName || 'Leader';
  v['match.leaderScore'] = String(m?.leaderScore ?? 0);

  // the map event (docs/02 §20.7) under the clock
  const e = frame.mapEvent ?? null;
  on('event', !!e);
  on('event-active', e?.phase === 'active');
  if (e) {
    const look = eventLook(e.kind);
    const warning = e.phase === 'warning';
    const seconds = Math.max(1, Math.ceil(e.secondsLeft - 1e-9));
    v['event.class'] = warning ? 'event-banner event-banner--warn' : 'event-banner';
    v['event.color'] = look.color;
    v['event.icon'] = iconHref(warning ? 'warn' : look.icon);
    v['event.name'] = e.name;
    v['event.time'] = warning ? `in ${seconds} s` : `${seconds} s`;
    v['event.description'] = e.description;
    v['v.event'] = warning ? '0' : fixed(1 - e.progress, 2);
  } else v['v.event'] = '0';

  // the net plate and the frame counter
  const net = frame.net;
  on('net', input.showNet && !!net);
  if (net) {
    const ping = Math.round(net.rttMs);
    const look = pingLook(ping);
    v['net.class'] = `ping ${look.cls}`;
    v['net.phoneClass'] = `phud-ping num ${look.cls}`;
    v['net.bars'] = String(look.bars);
    v['net.ping'] = `${ping} ms`;
    v['net.loss'] = `${(net.prediction?.snapshotLossPct ?? 0).toFixed(1)}%`;
    v['net.detail'] = mem.netDetail;
  }
  on('fps', input.showFps && input.fps > 0);
  on('admin', input.adminTuned === true);
  v['fps.value'] = String(Math.round(input.fps));

  on('board', mem.boardOpen);

  const me = (frame.players.find((p) => p.id === frame.localId) ?? null) as HudPlayer | null;
  if (!me) {
    for (const k of ['v.hp', 'v.hpGhost', 'v.fuel', 'v.fuelDelay', 'v.shield', 'v.dash', 'v.reload', 'v.respawn']) v[k] = '0';
    return { values: v, tokens };
  }
  on('alive', me.alive);
  on('spectating', !me.alive);

  // health, with the ghost of recent damage and the regen delay
  const hv = healthView(me.hp, t, mem.sinceHitS);
  v['player.hp'] = String(hv.hp);
  v['v.hp'] = fixed(hv.fill);
  v['v.hpGhost'] = fixed(Math.max(hv.fill, mem.hpGhost));
  on('low-hp', me.alive && hv.low);
  v['player.hpCue'] = hv.regenIn > 0 ? ` · regen starts in ${Math.ceil(hv.regenIn)} s` : hv.regenerating ? ' · regenerating' : '';

  // jet fuel and its regen delay; the jetpack's conditions
  const c = conditions(me);
  const fv = fuelView(me, t);
  v['player.fuel'] = String(Math.round(fv.fill * 100));
  v['v.fuel'] = fixed(fv.fill);
  v['v.fuelDelay'] = fixed(fv.delayLeft);
  on('emp', c.emp);
  v['player.empCause'] = c.empSeconds > 0 ? 'EMP grenade' : 'EMP field';
  v['player.jetDisabled'] = c.empSeconds > 0 ? `${c.empSeconds.toFixed(1)} s` : '';
  on('gas', c.inGas);
  v['player.gasCue'] = `${GAS.cloud.dpsEdge}–${GAS.cloud.dpsCore} HP a second, get out`;
  on('flash-reduced', input.reduceFlashes && c.blind > 0.05);

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

  // dash: the ring refills (1 = ready), the seconds in the middle, the air dash's pip
  const d = dashStatus(me, t);
  on('dash-cooldown', d.state === 'cooldown');
  v['player.dashCooldown'] = d.state === 'cooldown' ? d.seconds.toFixed(1) : '';
  v['v.dash'] = fixed(1 - d.fill);
  v['player.airClass'] = d.state === 'spent' || (me.airDashUsed && !me.grounded) ? 'hud-dash__air is-used' : 'hud-dash__air';

  // weapons: the one in hand (the big slot) and the other
  const cards = weaponCards(me);
  const active = cards.find((w) => w.slot === me.active) ?? cards[0];
  const other = cards.find((w) => w !== active);
  on('weapon', !!active);
  if (active) {
    const reloading = active.reload >= 0;
    const icon = href(weaponIcon(weapons[active.def]?.id));
    on('gun', !active.melee);
    on('weapon-icon', icon !== '');
    on('reloading', reloading);
    on('low-ammo', active.lowAmmo && !reloading);
    v['weapon.0.slot'] = String(active.slot + 1);
    v['weapon.0.name'] = active.name;
    v['weapon.0.icon'] = icon;
    v['weapon.0.mag'] = active.melee ? '—' : String(active.mag);
    v['weapon.0.magSize'] = String(weapons[active.def]?.mag ?? 0);
    v['weapon.0.reserve'] = String(active.reserve);
    v['weapon.0.tail'] = active.melee ? '' : `/${weapons[active.def]?.mag ?? 0} · ${active.reserve}`;
    v['v.reload'] = reloading ? fixed(active.reload) : '0';
  } else v['v.reload'] = '0';
  on('dual', me.dual);
  on('second-weapon', !!other);
  if (other) {
    const icon = href(weaponIcon(weapons[other.def]?.id));
    on('second-icon', icon !== '');
    v['weapon.1.slot'] = String(other.slot + 1);
    v['weapon.1.name'] = other.name;
    v['weapon.1.icon'] = icon;
    v['weapon.1.ammo'] = other.melee ? 'melee' : `${other.mag} / ${other.reserve}`;
  }
  v['weapon.zoom'] = `${input.zoom ?? 1}×`;

  // the grenade belt's head (its items are drawn by the Hud when they change)
  const belt = grenadeBelt(me).filter((g) => g.present);
  const selected = belt.find((g) => g.selected) ?? belt[0];
  on('belt', belt.length > 0);
  on('belt-many', belt.filter((g) => g.count > 0).length > 1);
  v['belt.selected'] = selected?.name ?? '';
  v['belt.count'] = String(selected?.count ?? 0);

  // the item underfoot or close by: pickupPrompt's whole line ("[E] take Widow (swaps your Hammer .44)"
  // for a weapon crate, "Riot Shield: walk over to take" for the rest)
  const item = pickupNear(me, frame.pickups);
  const prompt = pickupPrompt(me, frame.pickups);
  on('pickup', !!prompt);
  if (prompt) {
    v['pickup.name'] = item?.name ?? '';
    v['pickup.text'] = prompt;
    v['pickup.icon'] = item ? pickupIcon(item) : '';
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
    v['player.respawnIn'] = waiting ? String(Math.ceil(me.respawnTicks / 60)) : '';
    v['death.unit'] = waiting ? 's' : '';
    v['v.respawn'] = total > 0 ? fixed(1 - Math.min(1, me.respawnTicks / total)) : '1';
  } else v['v.respawn'] = '0';

  // the reticle and its markers
  on('reticle', !!input.pointer && me.alive);
  on('hit-marker', mem.hitMarker);
  on('kill-marker', mem.killMarker);
  return { values: v, tokens };
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

/** One kill-feed line in the kit's markup (.kf): names, what did it, and its badge. */
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

export class Hud {
  readonly root: HTMLElement;
  private readonly binder: Binder;
  private readonly states: StateTokens;
  private readonly banners: HTMLElement;
  private readonly feeds: { list: HTMLElement; max: number }[];
  private readonly arcs: SVGSVGElement[];
  private readonly reticles: HTMLElement[];
  private readonly beltList: HTMLElement;
  private readonly board: HTMLElement;
  private names: ReadonlyMap<number, string> = new Map();
  /** the touch controls' grenade button, once they're up */
  private touchNade: HTMLElement | null = null;
  /** the roster's bots (every one, not only those the snapshot shows: it leaves out who's out of view) */
  private rosterBots: ReadonlySet<number> = new Set();
  private feedKey = 0;
  private lastHitAt = -Infinity;
  private hitMarkerUntil = 0;
  private killMarkerUntil = 0;
  private death: DeathInfo | null = null;
  private keys: HudKeys = {};
  private netDetail = '';
  private netAt = 0;
  private ghost = { value: 1, heldUntil: 0, lastHp: 1, at: 0 };
  private me: PlayerView | null = null;
  private others: readonly PlayerView[] = [];
  private scoreboardOpen = false;
  private scoreboardAt = 0;
  private scoreboardCodes: readonly string[] = ['Tab'];
  private blocked = false;
  private visible: boolean | null = null;
  private opacity = '';
  private beltKey = '';
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
    const all = <T extends Element>(sel: string) => [...this.root.querySelectorAll<T>(sel)];
    this.banners = this.root.querySelector<HTMLElement>('.mf-hud-banners')!;
    this.feeds = [
      { list: this.root.querySelector<HTMLElement>('.killfeed')!, max: FEED_LINES },
      { list: this.root.querySelector<HTMLElement>('.phud-feed')!, max: PHONE_FEED_LINES },
    ];
    this.arcs = all<SVGSVGElement>('.dmg-arcs');
    this.reticles = all<HTMLElement>('.reticle');
    this.beltList = this.root.querySelector<HTMLElement>('.belt__list')!;
    this.board = this.root.querySelector<HTMLElement>('.scoreboard')!;
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

  /** Sim events (local mode's, or the server's plus our own predicted shots): feed, arcs, markers. */
  onEvents(events: readonly SimEvent[], localId: number): void {
    const now = performance.now();
    for (const e of events) {
      if (e.type === 'hit' && e.target === localId) {
        this.lastHitAt = now;
        if (e.attacker !== localId) this.damageArc(e.attacker);
      }
      if (e.type === 'hit' && e.attacker === localId && e.target !== localId) this.hitMarkerUntil = now + HIT_MARKER_MS;
      if (e.type === 'death' && e.killer === localId && e.victim !== localId) this.killMarkerUntil = now + KILL_MARKER_MS;
    }
    const bots = new Set(this.rosterBots);
    for (const p of this.others) if (p.isBot) bots.add(p.id);
    for (const entry of feedFromEvents(events, localId, this.names, () => ++this.feedKey, bots)) {
      this.addFeed(entry);
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
    const { values, tokens } = hudFrame(input, {
      sinceHitS: (now - this.lastHitAt) / 1000,
      death: this.death,
      keys: this.keys,
      netDetail: this.netDetail,
      hpGhost: this.ghostAt(hpFill, now),
      hitMarker: now < this.hitMarkerUntil,
      killMarker: now < this.killMarkerUntil,
      boardOpen: this.scoreboardOpen,
    });
    this.binder.update(values);
    this.states.set(tokens);
    if (this.me?.alive) this.death = null;
    this.drawBelt();
    this.dressTouchGrenade();
    this.place(input);
    // the white-out takes the HUD with the world; Reduce flashes keeps it readable over the dark-out
    const opacity = input.reduceFlashes ? '' : fixed(1 - Math.min(1, input.flash), 2);
    if (opacity !== this.opacity) {
      this.opacity = opacity;
      this.root.style.opacity = opacity === '1' ? '' : opacity;
    }
    if (this.scoreboardOpen && now - this.scoreboardAt > 250) {
      this.scoreboardAt = now;
      this.drawScoreboard(input.scoreRows(), input.match);
    }
  }

  // ---- banners (announcements; the map event has its own under the clock) ----

  showBanner(text: string, kind: BannerKind = 'info', options: BannerOptions = {}): void {
    const look = BANNER_LOOK[kind];
    const b = el('div', 'event-banner mf-hud-banner');
    b.style.setProperty('--ev', look.color);
    const ms = options.durationMs ?? 3200;
    b.style.setProperty('--banner-ms', `${ms}ms`);
    b.setAttribute('role', 'status');
    el('span', 'event-banner__icon', b).appendChild(svgIcon('ic ic--lg', iconHref(look.icon)));
    const body = el('div', 'event-banner__text', b);
    el('b', 'event-banner__title', el('p', '', body)).textContent = text;
    if (options.detail) el('p', 'event-banner__desc', body).textContent = options.detail;
    this.banners.appendChild(b);
    // at most three: the oldest goes
    while (this.banners.children.length > 3) this.banners.firstElementChild?.remove();
    window.setTimeout(() => b.remove(), ms + 400);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.root.remove();
  }

  // ---- internals ----

  /** The health bar's ghost: holds where health was for half a second after a hit, then slides down. */
  private ghostAt(hp: number, now: number): number {
    const g = this.ghost;
    const dt = Math.min(0.1, (now - g.at) / 1000);
    g.at = now;
    if (hp < g.lastHp) g.heldUntil = now + 500;
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
        this.arcs.forEach((a, i) => {
          const f = i === 0 ? hud : phone;
          a.style.transform = `translate(${(s.x / f).toFixed(1)}px, ${(s.y / f).toFixed(1)}px)`;
        });
      }
    }
  }

  private addFeed(entry: FeedEntry): void {
    for (const feed of this.feeds) {
      const li = feedLine(entry);
      li.style.setProperty('--feed-ms', `${FEED_MS}ms`);
      feed.list.prepend(li);
      while (feed.list.children.length > feed.max) feed.list.lastElementChild?.remove();
      window.setTimeout(() => li.remove(), FEED_MS + 300);
    }
  }

  private damageArc(attacker: number): void {
    const me = this.me;
    const from = attacker >= 0 ? this.others.find((p) => p.id === attacker) : undefined;
    for (const svg of this.arcs) {
      for (const old of svg.querySelectorAll('.dmg-arc')) old.classList.add('dmg-arc--old');
      let arc: SVGElement;
      if (me && from) {
        // the arc points up at rest; screen angles are 0 = right, clockwise
        arc = document.createElementNS(SVG, 'path');
        arc.setAttribute('d', 'M -51.3 -141 A 150 150 0 0 1 51.3 -141');
        arc.setAttribute('transform', `rotate(${((screenAngle(me, from) * 180) / Math.PI + 90).toFixed(1)})`);
      } else {
        // unseen attacker: a ring, no direction
        arc = document.createElementNS(SVG, 'circle');
        arc.setAttribute('r', '150');
      }
      arc.setAttribute('class', 'dmg-arc');
      svg.appendChild(arc);
      while (svg.children.length > 4) svg.firstElementChild?.remove();
      window.setTimeout(() => arc.remove(), ARC_MS);
    }
  }

  /** The touch grenade button (touch controls up): the selected type's icon and its count (touchSkin.ts). */
  private dressTouchGrenade(): void {
    if (!document.documentElement.hasAttribute('data-touch-controls')) return;
    if (!this.touchNade?.isConnected) this.touchNade = document.querySelector<HTMLElement>('.mf-touch .mf-ctl-grenade');
    const btn = this.touchNade;
    if (!btn) return;
    const me = this.me as HudPlayer | null;
    const g = touchGrenade(me ? grenadeBelt(me).filter((s) => s.present) : []);
    const count = String(g.count);
    if (btn.dataset.grenade !== g.id) btn.dataset.grenade = g.id;
    if (btn.dataset.count !== count) btn.dataset.count = count;
  }

  /** The belt's items, redrawn only when a count or the selection changes. */
  private drawBelt(): void {
    const me = this.me as HudPlayer | null;
    const belt = me ? grenadeBelt(me).filter((g) => g.present) : [];
    const key = belt.map((g) => `${g.id}:${g.count}:${g.selected ? 1 : 0}`).join(' ');
    if (key === this.beltKey) return;
    this.beltKey = key;
    const items = belt.map((g) => {
      const li = el('li', `belt__item${g.selected ? ' is-selected' : ''}${g.count === 0 ? ' is-empty' : ''}`);
      li.setAttribute('aria-label', `${g.name}, ${g.count} of ${g.max}${g.selected ? ', selected' : ''}`);
      li.appendChild(svgIcon('ic ic--lg', iconHref(`g-${g.id}`)));
      const pips = el('span', 'pips', li);
      pips.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < g.max; i++) el('i', i < g.count ? 'on' : '', pips);
      return li;
    });
    this.beltList.replaceChildren(...items);
  }

  private drawScoreboard(rows: ScoreRow[] | null, match: MatchView | null): void {
    const head = el('div', 'scoreboard__head');
    const title = el('div', '', head);
    const limit = match ? (match.killLimit > 0 ? `first to ${match.killLimit}` : 'no kill limit') : '';
    el('p', 'eyebrow', title).textContent = ['Deathmatch', limit, match?.mapName ?? ''].filter(Boolean).join(' · ');
    el('h2', 'display h2', title).textContent = 'Scoreboard';
    el('span', 'topbar__spacer', head);
    if (match?.phase === MatchPhase.InProgress) {
      const clock = el('div', 'scoreboard__clock', head);
      clock.appendChild(svgIcon('ic', iconHref('clock')));
      el('b', 'num', clock).textContent = formatClock(match.untimed ? match.secondsElapsed : match.secondsLeft);
      el('span', 'muted', clock).textContent = match.untimed ? 'played' : 'left';
    }

    const table = el('table', 'table');
    const tr = el('tr', '', el('thead', '', table));
    for (const [text, cls] of [
      ['#', 't-rank'],
      ['Player', ''],
      ['Kills', 't-num'],
      ['Deaths', 't-num'],
      ['Score', 't-num'],
      ['Ping', 't-num'],
    ] as const) {
      const th = el('th', cls, tr);
      th.scope = 'col';
      th.textContent = text;
    }
    const body = el('tbody', '', table);
    (rows ?? []).forEach((r, i) => {
      const row = el('tr', [r.you ? 'is-you' : '', r.bot ? 'is-bot' : ''].filter(Boolean).join(' '), body);
      el('td', 't-rank', row).textContent = String(i + 1);
      const who = el('span', 't-player', el('td', '', row));
      if (r.bot) el('span', 'avatar avatar--sm avatar--bot', who).appendChild(svgIcon('ic ic--sm', iconHref('bot')));
      else el('span', 'avatar avatar--sm', who).textContent = ([...r.name.trim()][0] ?? '?').toUpperCase();
      who.append(playerName(r.name, r.bot));
      if (r.host) {
        const b = el('span', 'badge badge--host', who);
        b.append(svgIcon('ic', iconHref('star')), 'Host');
      }
      if (r.you) el('span', 'badge badge--you', who).textContent = 'You';
      if (r.bot) {
        const b = el('span', 'badge badge--bot', who);
        b.append(svgIcon('ic', iconHref('bot')), 'Bot');
      }
      if (r.left) el('span', 'badge badge--bot', who).textContent = 'Left';
      el('td', 't-num', row).textContent = String(r.kills);
      el('td', 't-num', row).textContent = String(r.deaths);
      el('td', 't-num t-score', row).textContent = String(r.score);
      const ping = el('td', 't-num', row);
      if (r.ping >= 0) el('span', `ping ${pingLook(r.ping).cls}`, ping).textContent = String(r.ping);
      else {
        ping.classList.add('muted');
        ping.textContent = '–';
      }
    });
    if (!rows?.length) {
      const empty = el('td', 'muted', el('tr', '', body));
      empty.colSpan = 6;
      empty.textContent = 'Scores show while a match runs.';
    }

    const foot = el('div', 'scoreboard__foot');
    const hold = el('span', 'keys', foot);
    el('span', 'muted', hold).textContent = 'Hold';
    el('kbd', 'kbd', hold).textContent = this.keys.scoreboard || 'Tab';
    el('span', 'muted', foot).textContent = 'Score = kills minus self-kills. Ping in ms.';
    this.board.replaceChildren(head, table, foot);
  }
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
    `ping ${n.rttMs.toFixed(0)} ms${p ? ` ±${p.rttJitterMs.toFixed(0)}` : ''} · loss ${p ? p.snapshotLossPct.toFixed(1) : '0.0'}% · ${n.snapshotsPerSec.toFixed(0)} snap/s`,
    `↓ ${n.kbInPerSec.toFixed(1)} KB/s · ↑ ${n.kbOutPerSec.toFixed(1)} KB/s · interp ${n.interpDelayMs} ms`,
  ];
  if (p) lines.push(`buffer ${Number.isNaN(p.inputBufferHealth) ? '–' : p.inputBufferHealth} · ×${p.timeScale.toFixed(3)} · corrections ${p.correctionsPerMin.toFixed(1)}/min`);
  lines.push(n.status);
  if (p?.suggestLowBandwidth) lines.push('heavy packet loss: try Low-bandwidth mode (Settings)');
  return lines.join('\n');
}
