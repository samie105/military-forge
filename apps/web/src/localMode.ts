/**
 * Local mode: the shared sim runs in the browser with the map's dummy targets. Fixed 60 Hz steps,
 * input sampled once per tick, render interpolated between ticks (docs/02 §3). With match rules it
 * plays a deathmatch through the Match lifecycle (results, Play again); without, it's a sandbox.
 * Any registered map (?map=), including the map-mechanics demos (docs/02 §20).
 */
import { DEFAULT_LOADOUT, getMap, weapons, NO_WEAPON, type MapDef, type Tuning } from '@military-forge/content';
import {
  DT,
  Game,
  Match,
  ReplayRecorder,
  createInput,
  type Input,
  type MatchCommandKind,
  type MatchRules,
  type PlayerState,
  type ReplayFile,
} from '@military-forge/sim';
import type { Camera } from './camera';
import type { InputSampler } from './input';
import { mapEventView } from './mapEvent';
import type { Renderer } from './render';
import { shieldView, type Frame, type PlayerView } from './view';

const MAX_CATCHUP = 5;
const SEED = 1234;

export class LocalMode {
  readonly map: MapDef;
  game: Game;
  me: PlayerState;
  match: Match | null = null;
  private acc = 0;
  private readonly prev = new Map<number, { x: number; y: number }>();
  private readonly input: Input = createInput();
  private readonly inputs: (Input | undefined)[] = [];
  private recorder: ReplayRecorder | null = null;
  lastReplay: ReplayFile | null = null;
  /** dev give-weapon: the local player's [slot 1, slot 2] weapons, kept across resets and recorded in replays */
  loadout: [number, number] = [DEFAULT_LOADOUT[0], DEFAULT_LOADOUT[1]];

  constructor(
    private readonly sampler: InputSampler,
    private readonly camera: Camera,
    private readonly renderer: Renderer,
    private readonly name: string,
    private readonly matchRules: Partial<MatchRules> | null = null,
    /** ?map= (docs/02 §20 demo maps: lunar-outpost, storm-front, flux-lab, mechanics-test) */
    mapId = 'movement-test',
  ) {
    this.map = getMap(mapId);
    this.game = new Game({ map: this.map, seed: SEED, dummies: true, pickups: true });
    this.me = this.game.addPlayer(name);
    this.reset();
  }

  /** Fresh world (keeps the current live tuning). Recordings start from here so they replay exactly. */
  reset(): void {
    const tuning = { ...this.game.tuning };
    this.game = new Game({ map: this.map, seed: SEED, dummies: true, pickups: true, tuning });
    this.me = this.game.addPlayer(this.name);
    // loadout before the Match: its countdown respawns everyone through Game.respawn → giveLoadout(p.loadout)
    this.game.setLoadout(this.me, this.loadout);
    this.match = this.matchRules ? new Match(this.game, this.matchRules) : null;
    this.match?.setReady(this.me.id); // straight into the countdown (docs/01 §2: instant in)
    this.prev.clear();
    this.acc = 0;
    const names = new Map<number, string>();
    for (const p of this.game.players) if (p) names.set(p.id, p === this.me ? 'You' : p.name);
    this.renderer.setNames(names);
  }

  tuning(): Tuning {
    return this.game.tuning;
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
        dummies: true,
        pickups: true,
        tuning: { ...this.game.tuning },
        loadouts: [[...this.loadout]],
        ...(this.matchRules ? { match: this.matchRules } : {}),
      },
      `playtest-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`,
    );
    if (this.match) this.recorder.command('ready');
    return true;
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
      this.renderer.onEvents(this.game.events, this.me.id);
      this.acc -= DT;
      steps++;
    }
    if (steps === MAX_CATCHUP && this.acc > DT) this.acc = 0; // spiral-of-death guard
    const alpha = this.acc / DT;

    const players: PlayerView[] = [];
    for (const p of this.game.players) {
      if (!p) continue;
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
        active: p.active,
        dual: p.dual,
        weapons: p.weapons.map((w) => ({ def: w.def, mag: w.mag, reserve: w.reserve, reloadTicks: w.reloadTicks })),
        meleeTicks: p.meleeTicks,
        dashing: p.dashTicks > 0,
        shield: shieldView(p),
        shieldHp: p.shieldHp,
        respawnTicks: p.respawnTicks,
        kills: p.kills,
        deaths: p.deaths,
      });
    }
    return {
      tick: this.game.tick,
      localId: this.me.id,
      players,
      grenades: this.game.grenades.filter((g) => g.alive).map((g) => ({ x: g.x, y: g.y, fuse: g.fuse })),
      mapEvent: mapEventView(this.game),
      pickups: this.game.pickups.filter((k) => k.alive).map((k) => ({ id: k.id, def: k.def, x: k.x, y: k.y })),
      ...(this.recorder ? { recording: this.recorder.length } : {}),
    };
  }
}
