/**
 * The production HUD (docs/11): plain DOM, driven once per frame. Three parts, so a new look is
 * cheap to drop in:
 *   - template.ts: the markup, values bound by data-bind attributes named as in the UI brief;
 *   - hud.css: the look, every colour, size and layer a token on `.hud`, bars driven by one number;
 *   - this file + model.ts: the values (hudValues, pure) and the parts that come and go (kill feed,
 *     banners, damage arcs, kill confirmations, the scoreboard).
 * Every element is written only when its value changes (bind.ts), so a 60 fps frame costs a few
 * dozen string compares. Short-lived effects are CSS animations started once.
 */
import { type Tuning } from '@military-forge/content';
import { MatchPhase, type SimEvent } from '@military-forge/sim';
import type { MapEventBanner } from '../shell/mapEventBanner';
import type { MatchView } from '../shell/matchView';
import { formatClock } from '../shell/matchView';
import type { Frame, NetStats, PlayerView } from '../view';
import { Binder } from './bind';
import { conditions, dashStatus, feedFromEvents, fuelView, grenadeBelt, healthView, pickupPrompt, screenAngle, shieldStatus, weaponCards, type FeedEntry, type HudPlayer, type ScoreRow } from './model';
import { hudTemplate } from './template';
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
  /** the match clock and score (null: no match, e.g. warm-up) */
  match: MatchView | null;
  /** the map event to announce (the shell's store: setMapEvent), null when none */
  mapEvent?: MapEventBanner | null;
  /** the camera's zoom level, 1 = closest */
  zoom?: number;
  /** world → screen, for the damage arcs around the player */
  toScreen(x: number, y: number): { x: number; y: number };
  showNet: boolean;
  /** the Tab scoreboard's rows (asked for only while it is open) */
  scoreRows(): ScoreRow[] | null;
}

/** Key glyphs shown next to actions (Settings → Controls), e.g. { dash: 'Shift', grenade: 'G' }. */
export type HudGlyphs = Partial<Record<'dash' | 'grenade' | 'cycle' | 'shield', string>>;

/** What hudValues needs besides the input: the HUD's own memory. */
export interface HudMemory {
  /** seconds since the local player was last hurt */
  sinceHitS: number;
  /** "Kemi got you · Hammer .44", for the death card */
  killedBy: string;
  glyphs: HudGlyphs;
  /** the net graph's text (refreshed 4 times a second) */
  netText: string;
}

const FEED_LINES = 5;
const FEED_MS = 6000;
const STREAK_MS = 4000;
const SHIELD_LABEL = { none: '', up: 'up · front', slung: 'slung · back', raising: 'raising…' } as const;

/**
 * Every value the template binds, from one frame: pure, so tests can check it without a DOM.
 * Keys follow the UI brief's data names; bars are 0..1 numbers, states are words for CSS.
 */
export function hudValues(input: HudInput, mem: HudMemory): Record<string, string> {
  const { frame, tuning: t } = input;
  const v: Record<string, string> = {};

  const m = input.match;
  const playing = !!m && m.phase === MatchPhase.InProgress;
  v['match.on'] = playing ? '1' : '';
  v['match.timeLeft'] = m && playing ? formatClock(m.untimed ? m.secondsElapsed : m.secondsLeft) : '';
  v['match.score'] = m && playing ? `You ${m.myScore} · Leader ${m.leaderScore}${m.killLimit > 0 ? ` / ${m.killLimit}` : ''}` : '';

  const e = input.mapEvent ?? null;
  v['event.title'] = e?.title ?? '';
  v['event.phase'] = e?.phase ?? '';
  v['event.color'] = e?.color ?? 'transparent';
  v['event.in'] = e?.phase === 'warning' ? ` in ${e.seconds}` : '';
  v['event.line'] = e?.line ?? '';
  v['event.left'] = e?.phase === 'active' ? ` · ${e.seconds} s` : '';

  v['net.on'] = input.showNet ? '1' : '';
  v['net.text'] = mem.netText;
  for (const k of ['dash', 'grenade', 'cycle', 'shield'] as const) v[`keys.${k}`] = mem.glyphs[k] ?? '';

  const me = (frame.players.find((p) => p.id === frame.localId) ?? null) as HudPlayer | null;
  if (!me) return { ...v, ...EMPTY_PLAYER };

  const hv = healthView(me.hp, t, mem.sinceHitS);
  v['player.hp'] = String(hv.hp);
  v['player.hpFill'] = hv.fill.toFixed(3);
  v['player.hpState'] = `${hv.low ? 'low' : ''}${hv.regenerating ? ' regen' : ''}`.trim();
  v['player.regen'] = hv.regenIn > 0 ? `regen in ${Math.ceil(hv.regenIn)} s` : hv.regenerating ? 'regenerating' : '';

  const sh = shieldStatus(me);
  v['player.shield.hp'] = sh.state === 'none' ? '' : String(sh.hp);
  v['player.shield.state'] = sh.state;
  v['player.shield.fill'] = sh.fill.toFixed(3);
  v['player.shield.label'] = SHIELD_LABEL[sh.state];

  const c = conditions(me);
  const fv = fuelView(me, t);
  v['player.fuel'] = fv.fill.toFixed(3);
  v['player.fuelDelayAt'] = fv.fill.toFixed(3);
  v['player.fuelDelay'] = fv.delay.toFixed(3);
  v['player.ignite'] = fv.ignite.toFixed(3);
  v['player.fuelState'] = c.emp ? 'emp' : fv.empty ? 'empty' : fv.delay > 0 ? 'waiting' : '';
  v['player.fuelNote'] = c.emp ? 'offline' : fv.empty ? 'empty' : '';

  const d = dashStatus(me, t);
  v['player.dashCooldown'] = d.fill.toFixed(3);
  v['player.dashState'] = c.emp ? 'blocked' : d.state;
  v['player.dashNote'] = c.emp ? 'offline' : d.state === 'cooldown' ? `${d.seconds.toFixed(1)} s` : d.state === 'spent' ? 'air dash used' : 'ready';

  v['player.jetDisabled'] = c.emp ? `EMP · jetpack offline${c.empSeconds > 0 ? ` ${Math.ceil(c.empSeconds)} s` : ''}` : '';
  v['player.blind'] = c.blind.toFixed(2);
  v['player.blindNote'] = c.blind > 0.05 ? 'Blinded' : '';
  v['player.inGas'] = c.inGas ? 'Toxic gas' : '';

  const cards = weaponCards(me);
  for (let i = 0; i < 2; i++) {
    const w = cards[i];
    const reloading = !!w && w.reload >= 0;
    v[`weapons.${i}.name`] = w?.name ?? '';
    v[`weapons.${i}.mag`] = w ? (w.melee ? '—' : String(w.mag)) : '';
    v[`weapons.${i}.reserve`] = w ? (w.melee ? 'melee' : `/ ${w.reserve}`) : '';
    v[`weapons.${i}.note`] = w ? (reloading ? 'Reloading' : w.speed !== 1 ? `Heavy ×${w.speed.toFixed(2)}` : '') : '';
    v[`weapons.${i}.reload`] = reloading ? w.reload.toFixed(3) : '0';
    v[`weapons.${i}.state`] = w ? `${w.active ? 'active' : ''}${reloading ? ' reloading' : ''}${w.lowAmmo && !reloading ? ' low' : ''}`.trim() : '';
  }
  v['weapons.zoom'] = `${input.zoom ?? 1}×`;
  v['weapons.dual'] = me.dual ? '1' : '';

  const belt = grenadeBelt(me);
  belt.forEach((g, i) => {
    v[`grenades.${i}.present`] = g.present ? '1' : '';
    v[`grenades.${i}.count`] = String(g.count);
    v[`grenades.${i}.name`] = g.name;
    v[`grenades.${i}.state`] = `${g.selected ? 'selected' : ''}${g.count === 0 ? ' empty' : ''}`.trim();
  });
  v['grenades.cycle'] = belt.filter((g) => g.present).length > 1 ? '1' : '';
  v['grenades.state'] = belt.every((g) => !g.present || g.count === 0) ? 'empty' : '';

  v['pickup.prompt'] = pickupPrompt(me, frame.pickups);

  const s = input.toScreen(me.x, me.y + 0.9);
  v['arcs.x'] = s.x.toFixed(0);
  v['arcs.y'] = s.y.toFixed(0);

  v['death.on'] = me.alive ? '' : '1';
  v['death.by'] = me.alive ? '' : mem.killedBy || 'Eliminated';
  v['death.timer'] = me.alive ? '' : me.respawnTicks > 0 ? `Back in ${(me.respawnTicks / 60).toFixed(1)} s` : 'Respawning…';
  v['vignette'] = me.alive && hv.low ? (0.35 + 0.65 * (1 - hv.fill / 0.35)).toFixed(2) : '0';
  return v;
}

/** Bound values with no player to show (spectating before the first snapshot). */
const EMPTY_PLAYER: Readonly<Record<string, string>> = {
  'player.hp': '',
  'player.hpFill': '0',
  'player.hpState': '',
  'player.regen': '',
  'player.shield.hp': '',
  'player.shield.state': 'none',
  'player.shield.fill': '0',
  'player.shield.label': '',
  'player.fuel': '0',
  'player.fuelDelayAt': '0',
  'player.fuelDelay': '0',
  'player.ignite': '0',
  'player.fuelState': '',
  'player.fuelNote': '',
  'player.dashCooldown': '0',
  'player.dashState': '',
  'player.dashNote': '',
  'player.jetDisabled': '',
  'player.blind': '0',
  'player.blindNote': '',
  'player.inGas': '',
  'weapons.0.name': '',
  'weapons.1.name': '',
  'weapons.zoom': '',
  'weapons.dual': '',
  'grenades.cycle': '',
  'grenades.state': 'empty',
  'pickup.prompt': '',
  'death.on': '',
  vignette: '0',
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  parent?.appendChild(e);
  return e;
}

export class Hud {
  readonly root: HTMLElement;
  private readonly binder: Binder;
  private readonly banners: HTMLElement;
  private readonly feed: HTMLElement;
  private readonly arcs: HTMLElement;
  private readonly confirm: HTMLElement;
  private readonly board: HTMLElement;
  private readonly visible: { last: string | null };
  private names: ReadonlyMap<number, string> = new Map();
  private feedKey = 0;
  private lastHitAt = -Infinity;
  private killedBy = '';
  private glyphs: HudGlyphs = {};
  private netText = '';
  private streak = { count: 0, at: -Infinity };
  private me: PlayerView | null = null;
  private others: readonly PlayerView[] = [];
  private scoreboardOpen = false;
  private scoreboardAt = 0;
  private netAt = 0;
  private scoreboardCodes: readonly string[] = ['Tab'];
  private blocked = false;
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.scoreboardCodes.includes(e.code) || e.repeat) return;
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    this.setScoreboard(e.type === 'keydown' && !this.blocked);
  };
  private readonly onBlur = () => this.setScoreboard(false);

  constructor(parent: HTMLElement = document.body) {
    this.root = el('div', 'hud');
    this.root.id = 'hud';
    this.root.setAttribute('aria-hidden', 'true');
    this.root.innerHTML = hudTemplate();
    parent.appendChild(this.root);
    this.binder = new Binder(this.root);
    const part = (cls: string) => this.root.querySelector<HTMLElement>(`.${cls}`)!;
    this.banners = part('hud-banners');
    this.feed = part('hud-feed');
    this.arcs = part('hud-arcs');
    this.confirm = part('hud-confirm');
    this.board = part('hud-board');
    this.visible = { last: null };

    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
  }

  /** The keys that hold the scoreboard open (Settings → Controls). */
  setScoreboardKeys(codes: readonly string[]): void {
    this.scoreboardCodes = codes;
  }

  /** The key glyphs shown next to dash, grenades and the shield (Settings → Controls). */
  setGlyphs(glyphs: HudGlyphs): void {
    this.glyphs = glyphs;
  }

  /** Menus over the game: no scoreboard on Tab. */
  setBlocked(blocked: boolean): void {
    this.blocked = blocked;
    if (blocked) this.setScoreboard(false);
  }

  setVisible(on: boolean): void {
    const v = on ? '' : 'none';
    if (v !== this.visible.last) {
      this.visible.last = v;
      this.root.style.display = v;
    }
    if (!on) this.setScoreboard(false);
  }

  setNames(names: ReadonlyMap<number, string>): void {
    this.names = names;
  }

  /** Sim events (local mode's, or the server's plus our own predicted shots): feed, arcs, confirmations. */
  onEvents(events: readonly SimEvent[], localId: number): void {
    const now = performance.now();
    for (const e of events) {
      if (e.type === 'hit' && e.target === localId && e.attacker !== localId) {
        this.lastHitAt = now;
        this.damageArc(e.attacker);
      } else if (e.type === 'hit' && e.target === localId) this.lastHitAt = now;
    }
    for (const entry of feedFromEvents(events, localId, this.names, () => ++this.feedKey)) {
      this.addFeed(entry);
      if (entry.mine === 'killer') this.confirmKill(entry, now);
      if (entry.mine === 'victim') this.killedBy = entry.suicide ? (entry.how === 'fell' ? 'You fell' : 'You took yourself out') : `${entry.killer} got you · ${entry.how}`;
    }
  }

  update(input: HudInput): void {
    const { frame } = input;
    this.me = frame.players.find((p) => p.id === frame.localId) ?? null;
    this.others = frame.players;
    const now = performance.now();
    if (input.showNet && now - this.netAt > 250) {
      this.netAt = now;
      this.netText = netGraph(frame.net);
    }
    this.binder.update(hudValues(input, { sinceHitS: (now - this.lastHitAt) / 1000, killedBy: this.killedBy, glyphs: this.glyphs, netText: this.netText }));

    if (this.scoreboardOpen && now - this.scoreboardAt > 250) {
      this.scoreboardAt = now;
      this.drawScoreboard(input.scoreRows());
    }
  }

  // ---- banners (announcements; the map event has its own, bound from the shell's store) ----

  showBanner(text: string, kind: BannerKind = 'info', options: BannerOptions = {}): void {
    const b = el('div', 'hud-banner');
    b.dataset.state = kind;
    el('b', '', b).textContent = text;
    if (options.detail) el('small', '', b).textContent = options.detail;
    this.banners.appendChild(b);
    // at most three on screen: the oldest goes
    while (this.banners.children.length > 3) this.banners.firstElementChild?.remove();
    const ms = options.durationMs ?? 3200;
    b.style.setProperty('--hud-banner-ms', `${ms}ms`);
    window.setTimeout(() => b.remove(), ms + 400);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.root.remove();
  }

  // ---- internals ----

  private setScoreboard(open: boolean): void {
    if (open === this.scoreboardOpen) return;
    this.scoreboardOpen = open;
    this.board.dataset.state = open ? 'open' : '';
    this.scoreboardAt = 0;
  }

  private addFeed(entry: FeedEntry): void {
    const li = el('li', 'hud-feed-line');
    if (entry.mine) li.dataset.state = entry.mine;
    if (entry.suicide) {
      el('span', 'hud-feed-victim', li).textContent = entry.victim;
      el('span', 'hud-feed-how', li).textContent = entry.how === 'fell' ? 'fell' : `✝ ${entry.how}`;
    } else {
      el('span', 'hud-feed-killer', li).textContent = entry.killer;
      el('span', 'hud-feed-how', li).textContent = `${entry.headshot ? '◎ ' : ''}${entry.how}`;
      el('span', 'hud-feed-victim', li).textContent = entry.victim;
    }
    li.style.setProperty('--hud-feed-ms', `${FEED_MS}ms`);
    this.feed.prepend(li);
    while (this.feed.children.length > FEED_LINES) this.feed.lastElementChild?.remove();
    window.setTimeout(() => li.remove(), FEED_MS + 300);
  }

  private confirmKill(entry: FeedEntry, now: number): void {
    this.streak = now - this.streak.at < STREAK_MS ? { count: this.streak.count + 1, at: now } : { count: 1, at: now };
    const c = el('div', 'hud-confirm-line');
    el('b', '', c).textContent = entry.headshot ? 'Headshot' : 'Eliminated';
    el('span', '', c).textContent = entry.victim;
    if (this.streak.count > 1) el('em', '', c).textContent = `×${this.streak.count}`;
    this.confirm.replaceChildren(c);
    window.setTimeout(() => c.remove(), 1600);
  }

  private damageArc(attacker: number): void {
    const me = this.me;
    const from = attacker >= 0 ? this.others.find((p) => p.id === attacker) : undefined;
    const arc = el('div', 'hud-arc');
    if (me && from) arc.style.setProperty('--hud-arc-angle', `${screenAngle(me, from)}rad`);
    else arc.dataset.state = 'around'; // unseen attacker: a ring, no direction
    this.arcs.appendChild(arc);
    while (this.arcs.children.length > 4) this.arcs.firstElementChild?.remove();
    window.setTimeout(() => arc.remove(), 1300);
  }

  private drawScoreboard(rows: ScoreRow[] | null): void {
    const table = el('table', 'hud-board-table');
    const head = el('tr', '', el('thead', '', table));
    for (const h of ['#', 'Player', 'Score', 'K', 'D', 'A', 'Ping']) el('th', h === 'Player' ? 'hud-board-name' : '', head).textContent = h;
    const body = el('tbody', '', table);
    (rows ?? []).forEach((r, i) => {
      const tr = el('tr', '', body);
      if (r.you || r.left) tr.dataset.state = r.you ? 'you' : 'left';
      el('td', '', tr).textContent = String(i + 1);
      const name = el('td', 'hud-board-name', tr);
      name.textContent = r.name;
      if (r.host) el('span', 'hud-tag', name).textContent = 'HOST';
      if (r.bot) el('span', 'hud-tag', name).textContent = 'BOT';
      if (r.left) el('span', 'hud-tag', name).textContent = 'LEFT';
      for (const v of [r.score, r.kills, r.deaths, r.assists]) el('td', '', tr).textContent = String(v);
      el('td', 'hud-board-ping', tr).textContent = r.ping >= 0 ? `${r.ping}` : r.bot ? 'bot' : '–';
    });
    if (!rows?.length) el('td', 'hud-board-empty', el('tr', '', body)).textContent = 'Scores appear when a match runs';
    const title = el('div', 'hud-board-title');
    title.textContent = 'Scoreboard';
    this.board.replaceChildren(title, table);
  }
}

/** The net graph's text (N), from the frame's net stats; local mode shows that it is local. */
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
