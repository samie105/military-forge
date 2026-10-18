/**
 * The authoritative simulation of one room (docs/06 §5.3). The same class runs headless on the
 * game server, in the browser for local play/prediction, and in golden-replay tests.
 */
import { createTuning, getMap, weapons, type DummySpawn, type MapDef, type Tuning } from '@military-forge/content';
import { IdAllocator } from '@military-forge/shared';
import { botInput } from './bots';
import { CloudState, stepClouds } from './clouds';
import { stepRegen, stepWeapons } from './combat';
import { MAX_CLOUDS, MAX_GRENADES, MAX_PICKUPS, MAX_PLAYERS, ticks } from './constants';
import { DamageSource, type SimEvent } from './events';
import { GrenadeState, forgetOwner, stepGrenade, stepStatus } from './grenades';
import { copyInput, type Input } from './input';
import { MapMechanics, createBodyEnv } from './mechanics';
import { depenetrate, quantizeMovement, stepMovement } from './movement';
import { PickupState, createSpawners, dropCarried, resetPickups, stepPickups, type SpawnerState } from './pickups';
import { PlayerState, giveLoadout } from './player';
import type { TargetRewind } from './rewind';
import { stepShield } from './shield';
import { CollisionWorld } from './world';

export interface GameOptions {
  mapId?: string;
  map?: MapDef;
  seed?: number;
  tuning?: Partial<Tuning>;
  /** spawn the map's dummy targets */
  dummies?: boolean;
  /**
   * run the map's pickup spawners and drop carried items on death (pickups.ts). Off by default:
   * the client's prediction world takes pickups from the server, and replays recorded before
   * pickups existed must play as they did.
   */
  pickups?: boolean;
}

/** Seconds within which a hazard death is credited to the last attacker (docs/03 §8). */
const ENVIRONMENT_CREDIT_TICKS = ticks(5);

/** Scratch for the player being moved (the sim is single-threaded). */
const bodyEnv = createBodyEnv();

export class Game {
  readonly map: MapDef;
  readonly world: CollisionWorld;
  tuning: Tuning;
  readonly seed: number;
  tick = 0;
  readonly players: (PlayerState | null)[] = new Array<PlayerState | null>(MAX_PLAYERS).fill(null);
  readonly grenades: GrenadeState[] = Array.from({ length: MAX_GRENADES }, (_, i) => new GrenadeState(i));
  /** pickups on/off for this game (GameOptions.pickups) */
  readonly pickupsEnabled: boolean;
  /** items lying on the map (alive ones) */
  readonly pickups: PickupState[] = Array.from({ length: MAX_PICKUPS }, (_, i) => new PickupState(i));
  /** the map's spawners; empty with pickups off */
  readonly spawners: SpawnerState[];
  /** smoke and gas clouds (clouds.ts) */
  readonly clouds: CloudState[] = Array.from({ length: MAX_CLOUDS }, (_, i) => new CloudState(i));
  /** events produced by the most recent step() */
  readonly events: SimEvent[] = [];
  /** lag compensation for hitscan (server only; null = test targets where they are now) */
  rewind: TargetRewind | null = null;
  /** the map's rules, zones and events (docs/02 §20); null when it has none */
  readonly mech: MapMechanics | null;
  private readonly ids = new IdAllocator(MAX_PLAYERS);

  constructor(options: GameOptions = {}) {
    this.map = options.map ?? getMap(options.mapId ?? 'movement-test');
    this.world = new CollisionWorld(this.map);
    this.mech = MapMechanics.compile(this.map);
    this.tuning = createTuning(options.tuning);
    this.seed = (options.seed ?? 1) >>> 0;
    this.pickupsEnabled = options.pickups ?? false;
    this.spawners = this.pickupsEnabled ? createSpawners(this.map) : [];
    resetPickups(this);
    if (options.dummies) for (const d of this.map.dummies) this.addDummy(d);
  }

  addPlayer(name: string): PlayerState {
    const id = this.ids.allocate();
    if (id < 0) throw new Error('room full');
    const p = new PlayerState(id);
    p.name = name;
    this.players[id] = p;
    this.respawn(p);
    return p;
  }

  addDummy(spawn: DummySpawn): PlayerState {
    const p = this.addPlayer(spawn.name);
    p.isBot = true;
    p.script = spawn.script;
    p.homeX = spawn.x;
    p.homeY = spawn.y;
    this.respawn(p);
    return p;
  }

  removePlayer(id: number): void {
    const p = this.players[id];
    if (!p) return;
    // a leaving carrier lets go of its shield as a death would: it stays on the floor for others
    if (p.alive) dropCarried(this, p);
    // its mines go and its grenades and clouds become nobody's: the next player given this id doesn't inherit them
    forgetOwner(this, id);
    this.players[id] = null;
    this.ids.free(id);
  }

  playerCount(includeBots = true): number {
    let n = 0;
    for (const p of this.players) if (p && (includeBots || !p.isBot)) n++;
    return n;
  }

  /** A free grenade slot, reset to a frag (callers set the rest). */
  allocGrenade(): GrenadeState | null {
    for (const g of this.grenades) {
      if (g.alive) continue;
      g.type = 0;
      g.state = 0;
      g.hp = 0;
      g.born = this.tick;
      return g;
    }
    return null;
  }

  /** Spawn point farthest from other living players (ties: lowest index). Dummies use their home. Public for match start (match.ts). */
  respawn(p: PlayerState): void {
    let sx = p.homeX;
    let sy = p.homeY;
    if (!p.isBot) {
      let bestScore = -1;
      for (const s of this.map.spawns) {
        let nearest = Infinity;
        for (const q of this.players) {
          if (!q || q === p || !q.alive) continue;
          const dx = q.x - s.x;
          const dy = q.y - s.y;
          nearest = Math.min(nearest, dx * dx + dy * dy);
        }
        if (nearest > bestScore) {
          bestScore = nearest;
          sx = s.x;
          sy = s.y;
        }
      }
    }
    p.spawn(sx, sy, this.tuning);
    giveLoadout(p, weapons, p.loadout);
    depenetrate(this.world, p, this.tuning);
    this.events.push({ type: 'spawn', player: p.id });
  }

  /**
   * Sets the weapons a player respawns with and equips them now, with full ammo (dev give-weapon
   * and replays; map spawners and pickups come with the full arsenal).
   */
  setLoadout(p: PlayerState, loadout: readonly [number, number]): void {
    p.loadout = [loadout[0], loadout[1]];
    giveLoadout(p, weapons, p.loadout);
    p.active = 0;
    p.dual = false;
    p.swapTicks = 0;
    p.meleeTicks = 0;
  }

  /**
   * Sets the grenades a player respawns with, by type (packages/content grenades), and fills the
   * belt now (dev give-grenades and replays; map pickups give pairs through addGrenades).
   */
  setGrenadeLoadout(p: PlayerState, counts: readonly number[]): void {
    p.grenadeLoadout = counts.slice();
    p.refillGrenades();
  }

  damage(target: PlayerState, amount: number, attacker: number, source: number, zone: number): void {
    if (!target.alive || amount <= 0) return;
    target.hp -= amount;
    target.regenDelay = ticks(this.tuning.healthRegenDelay);
    if (attacker !== target.id) {
      target.lastAttacker = attacker;
      target.lastAttackTick = this.tick;
    }
    this.events.push({ type: 'hit', attacker, target: target.id, damage: amount, zone, source });
    if (target.hp <= 0) this.kill(target, attacker, source);
  }

  private kill(victim: PlayerState, killer: number, source: number): void {
    victim.hp = 0;
    victim.alive = false;
    victim.jetting = false;
    dropCarried(this, victim);
    victim.respawnTicks = ticks(this.tuning.respawnDelay);
    victim.deaths++;
    const k = this.players[killer];
    if (killer === victim.id) victim.kills--; // suicide: −1 (docs/03 §8)
    else if (k) k.kills++;
    this.events.push({ type: 'death', victim: victim.id, killer, source });
  }

  /**
   * Advances one tick. `inputs[id]` is that player's input for this tick; a missing entry repeats
   * the last one (docs/05 §13). Dummies generate their own.
   */
  step(inputs: ReadonlyArray<Readonly<Input> | undefined>): void {
    this.events.length = 0;
    const t = this.tuning;
    const mech = this.mech;
    // the map event schedule for this tick (and its warning/start/end events)
    if (mech) mech.beginTick(this.seed, this.tick, this.events);

    for (const p of this.players) {
      if (!p) continue;
      if (p.isBot) {
        if (p.alive) botInput(this, p, p.input);
      } else {
        const input = inputs[p.id];
        if (input) copyInput(p.input, input);
      }
    }

    for (const p of this.players) {
      if (!p?.alive) continue;
      const x0 = p.x;
      const y0 = p.y;
      if (stepMovement(this.world, p, t, mech ? mech.bodyEnv(p, t, bodyEnv) : null)) this.events.push({ type: 'dash', player: p.id, x: x0, y: y0, dir: p.dashDir });
    }
    // the shield key and carry modes, before anyone fires: every shot this tick meets the same shields
    for (const p of this.players) if (p?.alive) stepShield(p);
    for (const p of this.players) if (p?.alive) stepWeapons(this, p);
    for (const g of this.grenades) if (g.alive) stepGrenade(this, g);
    stepClouds(this);

    // hazards: falling out of the map (KILL zone below the bounds)
    for (const p of this.players) {
      if (!p?.alive || p.y > this.map.bounds.minY + 0.5) continue;
      const credited = p.lastAttacker >= 0 && this.tick - p.lastAttackTick <= ENVIRONMENT_CREDIT_TICKS;
      this.kill(p, credited ? p.lastAttacker : p.id, DamageSource.World);
    }
    stepPickups(this);

    for (const p of this.players) {
      if (!p) continue;
      if (p.alive) {
        stepRegen(this, p);
        stepStatus(p);
        quantizeMovement(p);
      } else if (--p.respawnTicks <= 0) {
        this.respawn(p);
      }
      p.prevButtons = p.input.buttons;
    }
    this.tick++;
  }
}
