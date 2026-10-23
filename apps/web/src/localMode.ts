/**
 * Local mode: the shared sim runs in the browser with bots (packages/bots, `?bots=`) or the map's
 * dummy targets. Fixed 60 Hz steps, input sampled once per tick, render interpolated between ticks
 * (docs/02 §3). With match rules it plays a deathmatch through the Match lifecycle (results, Play
 * again); without, it's a sandbox. Any registered map (?map=), including the map-mechanics demos
 * (docs/02 §20).
 */
import { addBots, botSpecs } from '@military-forge/bots';
import { DEFAULT_LOADOUT, getMap, weapons, NO_WEAPON, type MapDef, type Tuning } from '@military-forge/content';
import {
  DT,
  Game,
  Match,
  ReplayRecorder,
  SmokeSight,
  blindIntensity,
  createInput,
  type Input,
  type MatchCommandKind,
  type MatchRules,
  type PlayerState,
  type ReplayFile,
  type SimEvent,
} from '@military-forge/sim';
import type { Camera } from './camera';
import { cloudView, fullBelt, statusView } from './grenadeViews';
import type { InputSampler } from './input';
import type { LocalBots } from './localBots';
import { mapEventView } from './mapEvent';
import { LocalLoadoutStore, ownedOnly, starterInventory } from './locker/loadouts';
import { botLooks, lookBook } from './looks/book';
import { ThrowPreview } from './throwPreview';
import type { Renderer } from './render';
import { mobilityView, shieldView, type CloudView, type Frame, type PlayerView } from './view';

const MAX_CATCHUP = 5;
const SEED = 1234;

export class LocalMode {
  readonly map: MapDef;
  game: Game;
  me: PlayerState;
  /** the throw arc while a grenade throw is aimed (both views draw it) */
  private readonly throwPreview = new ThrowPreview();
  match: Match | null = null;
  private acc = 0;
  private readonly prev = new Map<number, { x: number; y: number }>();
  private readonly input: Input = createInput();
  private readonly inputs: (Input | undefined)[] = [];
  private recorder: ReplayRecorder | null = null;
  /** who smoke hides from us: the same rule as the server's AOI, so offline play looks like online */
  private readonly sight = new SmokeSight();
  /** the most blinded we were over this frame's ticks (a flashbang inside a hitch still shows) */
  private peakBlind = 0;
  lastReplay: ReplayFile | null = null;
  /** dev give-weapon: the local player's [slot 1, slot 2] weapons, kept across resets and recorded in replays */
  loadout: [number, number] = [DEFAULT_LOADOUT[0], DEFAULT_LOADOUT[1]];
  /** the test armory (a rack of one of every gun near the spawns): on in local play, off with ?armory=0 */
  private readonly armory = typeof location === 'undefined' || new URLSearchParams(location.search).get('armory') !== '0';
  /** dev: `?grenades` gives the local player every grenade type (until map pickups hand them out); in replays too */
  private readonly grenadeLoadout: number[] | null = typeof location !== 'undefined' && new URLSearchParams(location.search).has('grenades') ? fullBelt() : null;

  constructor(
    private readonly sampler: InputSampler,
    private readonly camera: Camera,
    private readonly renderer: Renderer,
    private readonly name: string,
    private readonly matchRules: Partial<MatchRules> | null = null,
    /** ?map= (docs/02 §20 demo maps: lunar-outpost, storm-front, flux-lab, mechanics-test) */
    mapId = 'movement-test',
    /** ?bots= / ?botlevel= (localBots.ts); null = the map's dummies */
    private readonly bots: LocalBots | null = null,
  ) {
    this.map = getMap(mapId);
    this.game = new Game({ map: this.map, seed: SEED, dummies: !bots, pickups: true, armory: this.armory });
    this.me = this.game.addPlayer(name);
    this.reset();
  }

  /** Fresh world (keeps the current live tuning). Recordings start from here so they replay exactly. */
  reset(): void {
    const tuning = { ...this.game.tuning };
    this.game = new Game({ map: this.map, seed: SEED, dummies: !this.bots, pickups: true, armory: this.armory, tuning });
    this.me = this.game.addPlayer(this.name);
    // bots join after the human, as replays put them back (botReplaySetup)
    if (this.bots) addBots(this.game, this.bots.count, this.bots.level);
    // loadout before the Match: its countdown respawns everyone through Game.respawn → giveLoadout(p.loadout)
    this.game.setLoadout(this.me, this.loadout);
    if (this.grenadeLoadout) this.game.setGrenadeLoadout(this.me, this.grenadeLoadout);
    this.match = this.matchRules ? new Match(this.game, this.matchRules) : null;
    this.match?.setReady(this.me.id); // straight into the countdown (docs/01 §2: instant in)
    this.prev.clear();
    this.acc = 0;
    const names = new Map<number, string>();
    const bots = new Set<number>();
    for (const p of this.game.players) {
      if (!p) continue;
      names.set(p.id, p === this.me ? 'You' : p.name);
      if (p.isBot) bots.add(p.id);
    }
    this.renderer.setNames(names, bots);
    // v19: the bots wear the seeded looks a room would give them (the local player: the saved look)
    const players = this.game.players.filter((p): p is PlayerState => p !== null);
    lookBook.setRoster(this.me.id, players.map((p) => ({ id: p.id, name: p.name, isBot: p.isBot })));
    const mine = new LocalLoadoutStore().peek();
    lookBook.replace([...botLooks(SEED, players.filter((p) => p.isBot)), ...(mine ? [[this.me.id, ownedOnly(mine, starterInventory)] as const] : [])]);
  }

  tuning(): Tuning {
    return this.game.tuning;
  }

  /** A new tuning for this match, from now on (a new object, so the HUD sees the change: "Tuned by host"). */
  setTuning(t: Tuning): void {
    this.game.tuning = { ...t };
  }

  zoomMax(): number {
    const ws = this.me.weapons.filter((w) => w.def !== NO_WEAPON).map((w) => weapons[w.def]!.zoomMax);
    return this.me.dual ? Math.min(...ws) : (weapons[this.me.weapons[this.me.active]!.def]?.zoomMax ?? 1);
  }

  get localId(): number {
    return this.me.id;
  }

  playAgain(): void {
    this.command('rematch');
  }

  backToLobby(): void {
    this.command('lobby');
  }

  ready(): void {
    this.command('ready');
  }

  private command(kind: MatchCommandKind): void {
    if (!this.match) return;
    if (kind === 'rematch') this.match.voteRematch(this.me.id);
    else if (kind === 'lobby') this.match.returnToLobby();
    else this.match.setReady(this.me.id, kind === 'ready');
    this.recorder?.command(kind);
  }

  respawn(): void {
    this.me.spawn(this.me.x, this.me.y + 0.3, this.game.tuning);
  }

  /**
   * Dev give-weapon: equips [slot 1, slot 2] now (full ammo) and on every respawn. Replays only
   * record the loadout they start with, so a change mid-recording restarts the recording from a
   * fresh world with the new loadout; the downloaded replay then reproduces what was played.
   */
  setLoadout(loadout: [number, number]): void {
    this.loadout = [loadout[0], loadout[1]];
    if (this.recorder) {
      this.recorder = null;
      this.toggleRecording(); // reset() equips this.loadout
      return;
    }
    this.game.setLoadout(this.me, this.loadout);
  }

  toggleRecording(): boolean {
    if (this.recorder) {
      this.lastReplay = this.recorder.toFile();
      this.recorder = null;
      return false;
    }
    this.reset();
    this.recorder = new ReplayRecorder(
      {
        map: this.map.id,
        seed: SEED,
        dummies: !this.bots,
        pickups: true,
        ...(this.armory ? { armory: true } : {}),
        tuning: { ...this.game.tuning },
        loadouts: [[...this.loadout]],
        ...(this.grenadeLoadout ? { grenadeLoadouts: [this.grenadeLoadout.slice()] } : {}),
        ...(this.matchRules ? { match: this.matchRules } : {}),
        ...(this.bots ? { bots: botSpecs(this.game) } : {}),
      },
      `playtest-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
    );
    if (this.match) this.recorder.command('ready');
    return true;
  }

  /**
   * Gunfire as the server would send it to us through smoke (docs/05 §9): no tracer from a shooter
   * smoke hides, tracers stop where they go into smoke, and one into a player it hides goes on as a
   * miss. Offline play looks like online.
   */
  private smokeEvents(events: readonly SimEvent[]): readonly SimEvent[] {
    this.sight.gather(this.game);
    if (this.sight.count === 0) return events;
    const me = this.me.id;
    return events.flatMap((e): SimEvent[] => {
      if (e.type !== 'shot' || e.shooter === me) return [e];
      if (e.shooter >= 0 && this.sight.hides(me, e.shooter)) return [];
      let shot = e;
      if ((e.hit === 2 || e.hit === 3) && e.target >= 0 && this.sight.hides(me, e.target)) {
        const missed = this.sight.missed;
        this.sight.carryOn(e.ox, e.oy, e.ex, e.ey, e.weapon);
        shot = { ...e, ex: missed.x, ey: missed.y, hit: missed.hit === 1 ? 1 : 0, target: -1, zone: 0 };
      }
      const t = this.sight.tracerCut(me, shot.ox, shot.oy, shot.ex, shot.ey);
      if (t < 1) shot = { ...shot, ex: shot.ox + (shot.ex - shot.ox) * t, ey: shot.oy + (shot.ey - shot.oy) * t, hit: 0, target: -1, zone: 0 };
      return [shot];
    });
  }

  update(dt: number): Frame {
    const t = this.game.tuning;
    this.acc += Math.min(dt, 0.25);
    let steps = 0;
    while (this.acc >= DT && steps < MAX_CATCHUP) {
      for (const p of this.game.players) {
        if (!p) continue;
        const prev = this.prev.get(p.id);
        if (prev) {
          prev.x = p.x;
          prev.y = p.y;
        } else this.prev.set(p.id, { x: p.x, y: p.y });
      }
      this.sampler.sample(this.camera, this.me.shoulderX(t), this.me.shoulderY(t), this.input);
      this.inputs[this.me.id] = this.input;
      if (this.match) this.match.step(this.inputs);
      else this.game.step(this.inputs);
      this.recorder?.record(this.input);
      this.renderer.onEvents(this.smokeEvents(this.game.events), this.me.id);
      if (this.me.alive) this.peakBlind = Math.max(this.peakBlind, blindIntensity(this.me));
      this.acc -= DT;
      steps++;
    }
    if (steps === MAX_CATCHUP && this.acc > DT) this.acc = 0; // spiral-of-death guard
    const alpha = this.acc / DT;

    const players: PlayerView[] = [];
    this.sight.gather(this.game);
    for (const p of this.game.players) {
      if (!p) continue;
      if (this.sight.hides(this.me.id, p.id)) continue; // inside or behind smoke: not drawn (the server wouldn't send it)
      const prev = this.prev.get(p.id);
      let x = p.x;
      let y = p.y;
      if (prev && Math.abs(prev.x - p.x) + Math.abs(prev.y - p.y) < 3) {
        x = prev.x + (p.x - prev.x) * alpha;
        y = prev.y + (p.y - prev.y) * alpha;
      }
      players.push({
        id: p.id,
        name: p.name,
        isBot: p.isBot,
        isLocal: p === this.me,
        alive: p.alive,
        x,
        y,
        vx: p.vx,
        vy: p.vy,
        grounded: p.grounded,
        crouched: p.crouched,
        jetting: p.jetting,
        aim: p.aim,
        hp: p.hp,
        fuel: p.fuel,
        fuelRegenDelay: p.fuelRegenDelay,
        frags: p.frags,
        ...statusView(p, p === this.me ? this.peakBlind : 0),
        active: p.active,
        dual: p.dual,
        weapons: p.weapons.map((w) => ({ def: w.def, mag: w.mag, reserve: w.reserve, reloadTicks: w.reloadTicks })),
        meleeTicks: p.meleeTicks,
        dashing: p.dashTicks > 0,
        shield: shieldView(p),
        shieldHp: p.shieldHp,
        ...(p === this.me ? mobilityView(this.game, p) : {}),
        respawnTicks: p.respawnTicks,
        kills: p.kills,
        deaths: p.deaths,
      });
    }
    this.peakBlind = 0;
    const clouds: CloudView[] = [];
    for (const c of this.game.clouds) {
      const view = c.alive ? cloudView(c.id, c.type, c.x, c.y, c.age) : null;
      if (view) clouds.push(view);
    }
    return {
      tick: this.game.tick,
      localId: this.me.id,
      players,
      // grenades in smoke we can't see into stay hidden too (ours always show), as the server does
      grenades: this.game.grenades
        .filter((g) => g.alive && (g.owner === this.me.id || !this.sight.pointHidden(this.me.id, g.x, g.y)))
        .map((g) => ({ x: g.x, y: g.y, fuse: g.fuse, type: g.type, state: g.state, id: g.id, vx: g.vx, vy: g.vy })),
      clouds,
      mapEvent: mapEventView(this.game),
      pickups: this.game.pickups.filter((k) => k.alive).map((k) => ({ id: k.id, def: k.def, x: k.x, y: k.y })),
      throwArc: this.throwPreview.update(this.game, this.me, this.sampler.throwAim),
      matchSeed: (this.game.seed + (this.match?.number ?? 0)) >>> 0,
      ...(this.recorder ? { recording: this.recorder.length } : {}),
    };
  }
}
