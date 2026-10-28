/**
 * What the game sounds like: sim events and drawn frames in, engine calls out. It runs on the
 * render side (main.ts calls it once per drawn frame, and with each batch of events the renderer
 * already gets), never inside the 60 Hz sim.
 *
 * Events give the moments (a shot, a hit, a blast, a dash, a pickup). The frames give what the
 * events don't carry: footsteps and landings, the jetpack, reloads, swaps, swings, wind-ups, the
 * riot shield going up, fire, grenades bouncing, mines arming, projectiles in flight, smoke and gas
 * hissing, and the local player's flashbang deafness, gas cough and low fuel.
 */
import { HitZone, NO_WEAPON, pickups, weaponSkinOf, weapons, type CosmeticLoadout, type MapDef } from '@military-forge/content';
import { DamageSource, type SimEvent } from '@military-forge/sim';
import type { Frame, GrenadeView, PlayerView } from '../view';
import type { PlayOptions, Voice } from './engine';
import { GRENADE, PROJECTILE, blastSound, flightLoop, launcherOf, skinnedWeaponSounds, weaponSounds, type WeaponSounds } from './families';
import { distanceGain } from './engine';
import type { SoundId } from './sounds';

/** The engine as the director uses it (tests pass a recorder). */
export interface Sink {
  readonly now: number;
  listener: { x: number; y: number } | null;
  play(id: SoundId, o?: PlayOptions): Voice | null;
  loop(key: string, id: SoundId, o?: PlayOptions): void;
  stopLoop(key: string, fade?: number): void;
  loopKeys(): string[];
  duck(depth: number, hold?: number): void;
  /** your own gun dips under a close incoming threat */
  duckOwn(depth?: number, hold?: number): void;
  muffle(amount: number, seconds: number): void;
  readonly soft: boolean;
}

/** An off-screen sound from the server (docs/05 §9): gunfire or a blast, coarse position. */
export interface FarSound {
  type: 'sound';
  kind: 'shot' | 'explosion';
  source: number;
  x: number;
  y: number;
}

export type AudioEvent = SimEvent | FarSound;

/** What a frame needs besides the Frame. */
export interface FrameExtras {
  /** the jetpack's tank size (tuning.fuelMax), for the low-fuel warning */
  fuelMax: number;
  /** the fire button is held (the empty click) */
  fireHeld: boolean;
  /** the map being played (acoustics: walls between you and a sound, open or under cover) */
  map?: MapDef;
  /**
   * The game holds still (training's pause, LocalMode.paused): the loops (jet, burn, held fire, hiss)
   * go quiet and nothing new starts; on resume the frames that follow bring back what still runs.
   */
  paused?: boolean;
}

interface PlayerMemo {
  frame: number;
  alive: boolean;
  x: number;
  y: number;
  grounded: boolean;
  /** the fastest fall since leaving the ground, m/s (positive down) */
  fall: number;
  /** the jetpack sound is on (it rides over a feathered jet key's short gaps) */
  jetting: boolean;
  /** when the jet was last seen firing / last went quiet (s) */
  jetSeen: number;
  jetQuiet: number;
  /** how much of the time the jet fires (feathering): the loop's level */
  jetDuty: number;
  active: number;
  def: number;
  dual: boolean;
  reloading: boolean;
  reloadVoices: Voice[];
  reloadAt: number;
  meleeTicks: number;
  windup: boolean;
  windupVoice: Voice | null;
  shield: PlayerView['shield'];
  burning: boolean;
  stride: number;
  lastDash: number;
  chain: number;
  jetDisabled: number;
}

interface GrenadeMemo {
  frame: number;
  type: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  state: number;
  bounceAt: number;
}

const STRIDE = 1.15;
/** the jet key off this long (s) before the jetpack sound stops */
const JET_GRACE = 0.15;
const CROUCH_STRIDE = 0.8;
/** a fall faster than this lands audibly (m/s); faster than HARD, a hard landing */
const LAND = 3.5;
const HARD = 13;
/** the fuel fraction under which the jetpack beeps */
const LOW_FUEL = 0.2;
/** enemies this close (m) are directional cues: their steps and jets lifted in the mix */
const CUE_RANGE = 18;
/** a shot from within this far (m), or one that passes this close to you, is an incoming threat */
const THREAT_RANGE = 12;
/** a projectile fired online by us shows up from the server within this long (s) */
const OWN_LAUNCH_WINDOW = 1.5;

const pickupKind = new Map(pickups.map((p) => [p.index, p.kind]));

export class AudioDirector {
  private localId = -1;
  private frameNo = 0;
  /** the map event's warning second last counted (eventCountdown) */
  private lastCount = '';
  private readonly players = new Map<number, PlayerMemo>();
  private readonly grenades = new Map<number, GrenadeMemo>();
  private readonly clouds = new Set<number>();
  /** where each player was last drawn (events place sounds there) */
  private readonly pos = new Map<number, { x: number; y: number }>();
  /** a shooter's last shot sound (a shotgun's pellets arrive as several shots in one tick) */
  private readonly lastShot = new Map<number, number>();
  private readonly lastThrow = new Map<number, number>();
  /** fire held as a loop (beam, flamethrower): until when, per shooter */
  private readonly fireLoops = new Map<number, { until: number; ws: WeaponSounds }>();
  /** projectile ids announced by a local 'launch' event (local mode): no second sound when they appear */
  private readonly launchedIds = new Set<number>();
  /** our own launches online (predicted): [projectile type, time], matched when the server's appear */
  private ownLaunches: [number, number][] = [];
  /** victims our last hit on was to the head (a headshot kill) */
  private readonly headOn = new Set<number>();
  private lowFuelAt = -Infinity;
  private fireWasHeld = false;
  private coughAt = -Infinity;
  private blindPeak = 0;

  /**
   * A player's look (the room's: the ROSTER's, the local player's own), so a weapon skin's own sounds play for
   * everyone who hears that gun (docs/17 V11). Null: every gun sounds as its base.
   */
  lookOf: ((id: number, isLocal: boolean) => CosmeticLoadout | null) | null = null;

  constructor(private readonly sink: Sink) {}

  /** The sounds `player`'s weapon `weapon` makes: its skin's, if the player's look wears one that swaps them. */
  soundsFor(player: number, weapon: number): WeaponSounds | null {
    const def = weapons[weapon];
    const skin = def && this.lookOf ? weaponSkinOf(this.lookOf(player, player === this.localId), def.id) : null;
    return skin?.sounds ? skinnedWeaponSounds(weapon, skin.id, skin.sounds) : weaponSounds(weapon);
  }

  /** Forget everything (a new mode, a new map). */
  reset(): void {
    for (const key of this.sink.loopKeys()) this.sink.stopLoop(key, 0.1);
    this.players.clear();
    this.grenades.clear();
    this.clouds.clear();
    this.pos.clear();
    this.fireLoops.clear();
    this.launchedIds.clear();
    this.ownLaunches = [];
    this.headOn.clear();
    this.sink.listener = null;
  }

  // ================================================================ events

  onEvents(events: readonly AudioEvent[], localId: number): void {
    this.localId = localId;
    for (const e of events) this.event(e);
  }

  private at(id: number): { x?: number; y?: number } {
    if (id === this.localId) return {};
    const p = this.pos.get(id);
    return p ? { x: p.x, y: p.y + 1 } : {};
  }

  private event(e: AudioEvent): void {
    const s = this.sink;
    const me = this.localId;
    switch (e.type) {
      case 'shot':
        this.shot(e);
        break;
      case 'ricochet':
        s.play('ricochet', { x: e.x, y: e.y });
        if (e.hit === 1) s.play('impact.wall', { x: e.ex, y: e.ey });
        break;
      case 'hit':
        this.hit(e);
        break;
      case 'death':
        if (e.victim === me) {
          s.play('death.self');
          s.play('voice.death', { gain: 0.9, priority: 20 });
          this.stopPlayerLoops(me);
        } else {
          s.play('voice.death', this.at(e.victim));
          if (e.killer === me) s.play(this.headOn.has(e.victim) ? 'kill.head' : 'kill.confirm');
        }
        this.headOn.delete(e.victim);
        break;
      case 'spawn':
        s.play('spawn', e.player === me ? {} : { ...this.at(e.player), gain: 0.6 });
        break;
      case 'throw': {
        const last = this.lastThrow.get(e.owner) ?? -Infinity;
        // our own throw comes predicted first, then the server's copy: one sound
        if (s.now - last > 0.6) s.play('grenade.throw', { ...this.at(e.owner), priority: e.owner === me ? 15 : 0 });
        this.lastThrow.set(e.owner, s.now);
        break;
      }
      case 'launch': {
        this.launchedIds.add(e.grenade);
        const def = weapons[e.weapon];
        const type = def?.projectile ? def.projectile.index + PROJECTILE.rocket : -1;
        if (e.owner === me && type >= 0) this.ownLaunches.push([type, s.now]);
        const ws = this.soundsFor(e.owner, e.weapon);
        if (ws) this.fire(e.owner, ws, this.pos.get(e.owner));
        break;
      }
      case 'explosion': {
        const b = blastSound(e.grenade);
        if (!b) break;
        s.play(b.id, { x: e.x, y: e.y, gain: Math.min(1.2, 0.6 + e.radius / 8) });
        if (b.big > 0) {
          const l = s.listener;
          const d = l ? Math.hypot(e.x - l.x, e.y - l.y) : 0;
          s.duck(b.big * distanceGain(d, 60), 0.12 + b.big * 0.2);
          // right on top of you: the world goes dull and the ears ring (not when softened)
          if (l && d < 15) s.duckOwn(0.5, 0.4);
          if (l && d < 7 && b.big >= 0.5 && b.id !== 'flash.bang') {
            const close = 1 - d / 7;
            s.muffle(0.55 * close, 1.2 + close);
            if (!s.soft) s.play('blast.ring', { gain: close });
          }
        }
        break;
      }
      case 'dash': {
        const m = this.players.get(e.player);
        const chained = m && s.now - m.lastDash < 0.55;
        if (m) {
          m.chain = chained ? m.chain + 1 : 0;
          m.lastDash = s.now;
        }
        const chain = m?.chain ?? 0;
        const o = e.player === me ? { priority: 15 } : { x: e.x, y: e.y + 1 };
        s.play(chained ? 'dash.chain' : 'dash', { ...o, rate: 1 + Math.min(4, chain) * 0.09 });
        break;
      }
      case 'pickup': {
        const kind = pickupKind.get(e.item);
        const id: SoundId = kind === 'shield' ? 'pickup.shield' : kind === 'grenades' ? 'pickup.grenades' : 'pickup.weapon';
        s.play(id, e.player === me ? { priority: 10 } : { x: e.x, y: e.y });
        break;
      }
      case 'shieldBreak':
        s.play('shield.break', e.owner === me ? { priority: 20 } : { x: e.x, y: e.y });
        s.duck(e.owner === me ? 0.45 : 0.2, 0.15);
        break;
      case 'mapEvent':
        s.play(e.phase === 0 ? 'event.warn' : e.phase === 1 ? 'event.start' : 'event.end');
        break;
      case 'sound':
        // gunfire or a blast outside the view: muffled, from its side
        s.play(e.kind === 'shot' ? 'distant.gun' : 'distant.boom', { x: e.x, y: e.y, far: 12 });
        break;
      default:
        break;
    }
  }

  private shot(e: Extract<SimEvent, { type: 'shot' }>): void {
    const s = this.sink;
    const me = this.localId;
    const own = e.shooter === me;
    const ws = this.soundsFor(e.shooter, e.weapon);
    if (ws && ws.family !== 'melee') {
      const last = this.lastShot.get(e.shooter) ?? -Infinity;
      if (s.now - last > 0.025 || ws.fireLoop) this.fire(e.shooter, ws, own ? undefined : { x: e.ox, y: e.oy - 1 });
      this.lastShot.set(e.shooter, s.now);
    }
    // where it landed
    if (e.hit === 1) s.play('impact.wall', { x: e.ex, y: e.ey, gain: own ? 0.8 : 1 });
    else if (e.hit === 2 && e.target !== me) s.play('impact.body', { x: e.ex, y: e.ey });
    else if (e.hit === 3) s.play('shield.hit', e.target === me ? { priority: 20 } : { x: e.ex, y: e.ey });
    // a near miss: the crack of a bullet passing; a close shooter: an incoming threat, so your own
    // gun dips a little and it reads
    const l = s.listener;
    if (!own && l) {
      const d = segmentDistance(l.x, l.y, e.ox, e.oy, e.ex, e.ey);
      const fromShooter = Math.hypot(l.x - e.ox, l.y - e.oy);
      if (e.target !== me && ws?.fire && ws.family !== 'rocket' && ws.family !== 'popper' && d < 1.6 && fromShooter > 3) {
        s.play('whiz', { x: l.x + Math.sign(e.ox - l.x) * 3, y: l.y + Math.sign(e.oy - l.y) * 1.5, gain: 1 - d / 2, priority: 20 });
        s.duckOwn(0.3, 0.2);
      } else if (fromShooter < THREAT_RANGE || d < 3) s.duckOwn(0.2, 0.15);
    }
  }

  /** A weapon going off: a shot sound (and its bolt or pump after), or its held loop kept alive. */
  private fire(shooter: number, ws: WeaponSounds, where: { x: number; y: number } | undefined): void {
    const s = this.sink;
    const own = shooter === this.localId;
    const o: PlayOptions = own ? { priority: 15, own: true } : where ? { x: where.x, y: where.y + 1 } : {};
    if (!own && !where) return;
    if (ws.fireLoop) {
      const held = this.fireLoops.get(shooter);
      if (!held) s.play(ws.fireLoop.start, o);
      this.fireLoops.set(shooter, { until: s.now + 0.22, ws });
      s.loop(`fire:${shooter}`, ws.fireLoop.loop, o);
      return;
    }
    if (!ws.fire) return;
    s.play(ws.fire, { ...o, rate: ws.rate, gain: ws.gain });
    if (ws.cycle) s.play(ws.cycle.id, { ...o, delay: ws.cycle.after, gain: 0.55 });
    // the spent case lands a moment later (a shotgun's when it's pumped); close by only (its range)
    if (ws.brass && Math.random() < 0.3) {
      const after = (ws.cycle?.after ?? 0) + 0.3 + Math.random() * 0.25;
      s.play(ws.brass, { ...o, ...(own ? { pan: Math.random() * 0.6 - 0.1 } : {}), delay: after });
    }
  }

  private hit(e: Extract<SimEvent, { type: 'hit' }>): void {
    const s = this.sink;
    const me = this.localId;
    if (e.target === me) {
      // where it came from: panned toward the attacker
      const a = e.attacker !== me ? this.pos.get(e.attacker) : undefined;
      const l = s.listener;
      const pan = a && l ? Math.max(-1, Math.min(1, (a.x - l.x) / 8)) * 0.8 : 0;
      const burn = e.source === weaponIndex('dragon') && e.damage < 8;
      if (!burn) {
        s.play('hit.taken', { pan, gain: Math.min(1, 0.55 + e.damage / 60), priority: 10 });
        s.duckOwn(0.4, 0.25);
      }
      if ((!burn && e.damage >= 16 && Math.random() < 0.55) || (burn && Math.random() < 0.08)) {
        s.play('voice.hurt', { pan: pan * 0.3 });
      }
      return;
    }
    if (e.source === DamageSource.Melee) s.play('melee.hit', { ...this.at(e.target), priority: e.attacker === me ? 15 : 0 });
    if (e.attacker === me) {
      const head = e.zone === HitZone.Head;
      if (head) this.headOn.add(e.target);
      else this.headOn.delete(e.target);
      s.play(head ? 'hit.head' : 'hit.marker');
    } else if (e.damage >= 24 && Math.random() < 0.45) s.play('voice.hurt', { ...this.at(e.target), gain: 0.7 });
  }

  // ================================================================ frames

  onFrame(f: Frame, dt: number, extras: FrameExtras): void {
    const s = this.sink;
    if (extras.paused) {
      // the memos stay as they are (a jet held at the pause sounds again on resume, with no new start)
      for (const key of s.loopKeys()) s.stopLoop(key, 0.1);
      return;
    }
    this.localId = f.localId;
    this.frameNo++;
    const me = f.players.find((p) => p.id === f.localId) ?? null;
    s.listener = me ? { x: me.x, y: me.y + 1 } : null;
    for (const p of f.players) this.pos.set(p.id, { x: p.x, y: p.y });
    for (const p of f.players) this.player(p, dt);
    if (me) this.local(me, extras);
    this.projectiles(f.grenades);
    this.hiss(f);
    this.eventCountdown(f);
    this.expire();
  }

  /**
   * The map event's warning counts down its last three seconds on the war-tone drum (ui.count), in
   * step with the HUD's countdown digit (hud/eventTemplate.ts); the siren (event.warn) opens the
   * warning and event.start lands on the impact, both from the sim's mapEvent events.
   */
  private eventCountdown(f: Frame): void {
    const e = f.mapEvent;
    const n = e && e.phase === 'warning' ? Math.max(1, Math.ceil(e.secondsLeft - 1e-9)) : 0;
    const key = e ? `${e.id}:${e.occurrence}:${n}` : '';
    if (key === this.lastCount) return;
    this.lastCount = key;
    if (n >= 1 && n <= 3) this.sink.play('ui.count', { priority: 70 });
  }

  private player(p: PlayerView, dt: number): void {
    const s = this.sink;
    const own = p.id === this.localId;
    let m = this.players.get(p.id);
    const fresh = !m || m.frame !== this.frameNo - 1;
    const w = p.weapons[p.active];
    const def = w?.def ?? NO_WEAPON;
    if (!m || fresh) {
      if (m) this.stopPlayerLoops(p.id);
      m = {
        frame: this.frameNo,
        alive: p.alive,
        x: p.x,
        y: p.y,
        grounded: p.grounded,
        fall: 0,
        jetting: false,
        jetSeen: -Infinity,
        jetQuiet: -Infinity,
        jetDuty: 0,
        active: p.active,
        def,
        dual: p.dual,
        reloading: (w?.reloadTicks ?? 0) > 0,
        reloadVoices: [],
        reloadAt: 0,
        meleeTicks: p.meleeTicks ?? 0,
        windup: false,
        windupVoice: null,
        shield: p.shield,
        burning: false,
        stride: 0,
        lastDash: m?.lastDash ?? -Infinity,
        chain: 0,
        jetDisabled: p.jetDisabledTicks ?? 0,
      };
      this.players.set(p.id, m);
    }
    m.frame = this.frameNo;
    const where: PlayOptions = own ? { own: true } : { x: p.x, y: p.y + 1 };
    // an enemy close by is a directional cue: their steps and jets lifted a little in the mix
    const l = s.listener;
    const cue = !own && l !== null && Math.hypot(p.x - l.x, p.y + 1 - l.y) < CUE_RANGE ? 1.3 : 1;
    const cuePriority = cue > 1 ? 12 : 0;
    const key = (k: string) => `${k}:${p.id}`;

    if (!p.alive) {
      if (m.alive) this.stopPlayerLoops(p.id);
      Object.assign(m, { alive: false, x: p.x, y: p.y, jetting: false, jetDuty: 0, windup: false, burning: false, reloading: false });
      return;
    }
    const spawned = !m.alive;
    m.alive = true;
    const dx = p.x - m.x;
    const vy = dt > 0 ? (p.y - m.y) / dt : 0;
    m.x = p.x;
    m.y = p.y;

    // ---- feet: steps while walking, a landing after a fall
    if (p.grounded && !spawned) {
      if (!m.grounded && m.fall > LAND && !fresh) {
        const hard = m.fall > HARD;
        s.play(hard ? 'land.hard' : 'land', { ...where, gain: Math.min(1, 0.35 + (m.fall - LAND) / 10) });
        m.stride = 0;
      } else if (Math.abs(dx) > 0.002 && Math.abs(dx) < 1.5) {
        m.stride += Math.abs(dx);
        const stride = p.crouched ? CROUCH_STRIDE : STRIDE;
        if (m.stride >= stride) {
          m.stride -= stride;
          s.play('step', { ...where, gain: (p.crouched ? 0.5 : 1) * (own ? 0.8 : cue), priority: cuePriority });
        }
      }
      m.fall = 0;
    } else if (!p.grounded) m.fall = Math.max(m.fall, -vy);
    m.grounded = p.grounded;

    // ---- the jetpack: feathering the key (bots do, players too) keeps one sound going, quieter
    const now = s.now;
    m.jetDuty += ((p.jetting ? 1 : 0) - m.jetDuty) * Math.min(1, dt * 6);
    if (p.jetting) {
      if (!m.jetting && now - m.jetQuiet > 0.3) s.play('jet.start', { ...where, priority: cuePriority });
      m.jetting = true;
      m.jetSeen = now;
    } else if (m.jetting && now - m.jetSeen > JET_GRACE) {
      m.jetting = false;
      m.jetQuiet = now;
      s.stopLoop(key('jet'), 0.12);
      s.play('jet.stop', { ...where, gain: 0.5 + 0.5 * m.jetDuty });
    }
    if (m.jetting) s.loop(key('jet'), 'jet.loop', { ...where, gain: (own ? 1 : 0.85 * cue) * (0.45 + 0.55 * m.jetDuty), priority: cuePriority });

    // ---- the gun in hand: draw, reload, wind-up, swing
    const ws = def !== NO_WEAPON ? this.soundsFor(p.id, def) : null;
    if (!spawned && (p.active !== m.active || def !== m.def || p.dual !== m.dual) && ws) {
      this.cancelReload(m);
      this.stopWindup(p.id, m, null);
      s.play(ws.draw, { ...where, gain: 0.9 });
    }
    m.active = p.active;
    m.def = def;
    m.dual = p.dual;

    const reloading = (w?.reloadTicks ?? 0) > 0;
    if (reloading && !m.reloading && ws && w) this.startReload(p, m, ws, w.mag, where);
    else if (!reloading && m.reloading) {
      // finished, or cut short (a swap, a death): what hasn't played yet doesn't
      const T = weapons[m.def]?.reload ?? 1;
      if (s.now - m.reloadAt < T * 0.85) this.cancelReload(m);
      m.reloadVoices = [];
    }
    m.reloading = reloading;

    const windup = !!p.windup;
    if (windup && !m.windup && ws?.windup) {
      m.windupVoice = s.play(ws.windup.start, where);
      if (ws.windup.loop) s.loop(key('spin'), ws.windup.loop, { ...where, delay: 0.45 });
    } else if (!windup && m.windup) this.stopWindup(p.id, m, ws, where);
    else if (windup && ws?.windup?.loop) s.loop(key('spin'), ws.windup.loop, where);
    m.windup = windup;

    // a swing counts up from 1 (sim meleeTicks); a new one starts from 0, or restarts lower
    const melee = p.meleeTicks ?? 0;
    if (melee > 0 && (m.meleeTicks === 0 || melee < m.meleeTicks)) s.play('melee.swing', { ...where, priority: own ? 15 : 0 });
    m.meleeTicks = melee;

    // ---- the riot shield going up
    if (p.shield === 'raising' && m.shield !== 'raising') s.play('shield.raise', where);
    m.shield = p.shield;

    // ---- on fire
    if (p.burning) s.loop(key('burn'), 'burn.loop', where);
    else if (m.burning) s.stopLoop(key('burn'), 0.3);
    m.burning = !!p.burning;

    // ---- held fire (beam, flames) follows the shooter
    const held = this.fireLoops.get(p.id);
    if (held?.ws.fireLoop) s.loop(key('fire'), held.ws.fireLoop.loop, where);
  }

  /** The local player's own cues: low fuel, an EMP'd jetpack, the empty click, deafness, the cough. */
  private local(me: PlayerView, x: FrameExtras): void {
    const s = this.sink;
    const now = s.now;
    if (!me.alive) {
      this.fireWasHeld = x.fireHeld;
      return;
    }
    // low fuel: beeps while jetting on the last fifth of the tank
    if (me.jetting && x.fuelMax > 0 && me.fuel / x.fuelMax < LOW_FUEL && now - this.lowFuelAt > 0.6) {
      s.play('jet.lowfuel');
      this.lowFuelAt = now;
    }
    const m = this.players.get(me.id);
    const emp = me.jetDisabledTicks ?? 0;
    if (m) {
      if (emp > 0 && m.jetDisabled === 0) s.play('jet.sputter');
      m.jetDisabled = emp;
    }
    // the dry click: the trigger pulled on an empty gun that isn't reloading
    const w = me.weapons[me.active];
    const ws = w && w.def !== NO_WEAPON ? this.soundsFor(me.id, w.def) : null;
    if (x.fireHeld && !this.fireWasHeld && w && ws && ws.family !== 'melee' && w.mag === 0 && w.reloadTicks === 0) {
      s.play(ws.empty);
    }
    this.fireWasHeld = x.fireHeld;
    // a flashbang: the world muffled and (unless softened) the ears ringing
    const blind = me.blind ?? 0;
    if (blind > this.blindPeak + 0.25 && blind > 0.35) {
      const secs = Math.max(1, (me.blindTicks ?? 120) / 60);
      s.muffle(blind, secs);
      if (!s.soft) s.play('flash.ring', { gain: blind });
    }
    this.blindPeak = blind;
    // gas: a cough now and then
    if ((me.gasTicks ?? 0) > 0 && now - this.coughAt > 1.3) {
      s.play('voice.cough');
      this.coughAt = now + Math.random() * 0.6;
    }
  }

  private startReload(p: PlayerView, m: PlayerMemo, ws: WeaponSounds, mag: number, where: PlayOptions): void {
    const s = this.sink;
    const def = weapons[m.def];
    const T = def?.reload ?? 1;
    m.reloadAt = s.now;
    const voices: Voice[] = [];
    const add = (id: SoundId, at: number) => {
      const v = s.play(id, { ...where, delay: at, priority: p.id === this.localId ? 10 : 0 });
      if (v) voices.push(v);
    };
    if (ws.perRound && def) {
      // remote players show no magazine: assume a few shells
      const missing = p.id === this.localId ? def.mag - mag : 3;
      const n = Math.max(1, Math.min(6, missing));
      for (let i = 0; i < n; i++) add(ws.perRound.id, 0.08 + ((T * 0.8) / n) * i);
      add(ws.perRound.end, T * 0.9);
    } else for (const step of ws.reload) add(step.id, T * step.at);
    m.reloadVoices = voices;
  }

  private cancelReload(m: PlayerMemo): void {
    const now = this.sink.now;
    for (const v of m.reloadVoices) if (v.startedAt > now) v.stop(0.01);
    m.reloadVoices = [];
  }

  private stopWindup(id: number, m: PlayerMemo, ws: WeaponSounds | null, where: PlayOptions = {}): void {
    const s = this.sink;
    m.windupVoice?.stop(0.08);
    m.windupVoice = null;
    if (s.loopKeys().includes(`spin:${id}`)) {
      s.stopLoop(`spin:${id}`, 0.1);
      if (ws?.windup?.stop) s.play(ws.windup.stop, where);
    }
    m.windup = false;
  }

  private stopPlayerLoops(id: number): void {
    const s = this.sink;
    for (const k of ['jet', 'burn', 'fire', 'spin']) s.stopLoop(`${k}:${id}`, 0.1);
    this.fireLoops.delete(id);
    const m = this.players.get(id);
    if (m) {
      this.cancelReload(m);
      m.windupVoice?.stop(0.05);
      m.windupVoice = null;
    }
  }

  // ---- grenades and projectiles: bounces, mines, launches seen online, flight loops

  private projectiles(list: readonly GrenadeView[]): void {
    const s = this.sink;
    const now = s.now;
    this.ownLaunches = this.ownLaunches.filter(([, t]) => now - t < OWN_LAUNCH_WINDOW);
    for (const g of list) {
      if (g.id === undefined) continue;
      const type = g.type ?? GRENADE.frag;
      let m = this.grenades.get(g.id);
      if (m && m.type !== type) {
        s.stopLoop(`proj:${g.id}`, 0.05);
        m = undefined;
      }
      const vx = g.vx ?? 0;
      const vy = g.vy ?? 0;
      if (!m) {
        m = { frame: this.frameNo, type, x: g.x, y: g.y, vx, vy, state: g.state ?? 0, bounceAt: -Infinity };
        this.grenades.set(g.id, m);
        if (type >= PROJECTILE.rocket) this.seenLaunch(g.id, type, g.x, g.y);
      } else {
        // a bounce: the velocity turned sharply between two looks
        const dv = Math.hypot(vx - m.vx, vy - m.vy);
        const speed = Math.hypot(m.vx, m.vy);
        if (dv > 4 && speed > 2 && now - m.bounceAt > 0.1 && (type < PROJECTILE.rocket || type === PROJECTILE.shell) && !(type === GRENADE.mine && (g.state ?? 0) > 0)) {
          s.play('grenade.bounce', { x: g.x, y: g.y, gain: Math.min(1, dv / 12), rate: type === PROJECTILE.shell ? 0.85 : 1 });
          m.bounceAt = now;
        }
        const state = g.state ?? 0;
        if (type === GRENADE.mine && state !== m.state) {
          if (state === 1) s.play('mine.arm', { x: g.x, y: g.y });
          else if (state === 2) s.play('mine.armed', { x: g.x, y: g.y });
          else if (state === 3) s.play('mine.trigger', { x: g.x, y: g.y });
        }
        if (type === PROJECTILE.blade && state === 1 && m.state === 0) s.play('blade.ricochet', { x: g.x, y: g.y });
        m.state = state;
        m.x = g.x;
        m.y = g.y;
        m.vx = vx;
        m.vy = vy;
      }
      m.frame = this.frameNo;
      const fly = flightLoop(type);
      if (fly) s.loop(`proj:${g.id}`, fly, { x: g.x, y: g.y });
    }
    for (const [id, m] of this.grenades)
      if (m.frame !== this.frameNo) {
        this.grenades.delete(id);
        s.stopLoop(`proj:${id}`, 0.05);
      }
  }

  /** A projectile appeared: unless a launch event already sounded it, find who fired it. */
  private seenLaunch(id: number, type: number, x: number, y: number): void {
    if (this.launchedIds.delete(id)) return;
    const own = this.ownLaunches.findIndex(([t]) => t === type);
    if (own >= 0) {
      this.ownLaunches.splice(own, 1);
      return;
    }
    const launcher = launcherOf(type);
    let best: { id: number; d: number; def: number } | null = null;
    for (const [pid, m] of this.players) {
      if (pid === this.localId || !m.alive || weapons[m.def]?.id !== launcher) continue;
      const d = Math.hypot(m.x - x, m.y + 1 - y);
      if (d < 4 && (!best || d < best.d)) best = { id: pid, d, def: m.def };
    }
    const ws = best ? this.soundsFor(best.id, best.def) : null;
    if (best && ws) this.fire(best.id, ws, { x, y: y - 1 });
  }

  /** Smoke and gas clouds hiss while young. */
  private hiss(f: Frame): void {
    const s = this.sink;
    const seen = new Set<number>();
    for (const c of f.clouds ?? []) {
      const level = Math.max(0, 1 - c.age / 8) * Math.min(1, c.density * 1.5);
      if (level < 0.05) continue;
      seen.add(c.id);
      s.loop(`cloud:${c.id}`, c.type === GRENADE.gas ? 'gas.hiss' : 'smoke.hiss', { x: c.x, y: c.y, gain: level });
    }
    for (const id of this.clouds) if (!seen.has(id)) s.stopLoop(`cloud:${id}`, 0.6);
    this.clouds.clear();
    for (const id of seen) this.clouds.add(id);
  }

  /** Held fire that stopped, and loops whose players went out of sight. */
  private expire(): void {
    const s = this.sink;
    for (const [id, held] of this.fireLoops)
      if (s.now > held.until) {
        this.fireLoops.delete(id);
        s.stopLoop(`fire:${id}`, 0.1);
        if (held.ws.fireLoop) s.play(held.ws.fireLoop.stop, id === this.localId ? {} : this.at(id));
      }
    for (const [id, m] of this.players)
      if (m.frame !== this.frameNo) {
        this.stopPlayerLoops(id);
        this.players.delete(id);
        this.pos.delete(id);
      }
  }
}

/** Distance from (px, py) to the segment (ax, ay)–(bx, by). */
export function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

const weaponIndex = (id: string): number => weapons.find((w) => w.id === id)?.index ?? -1;
