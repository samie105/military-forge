/**
 * The authoritative simulation of one room (docs/06 §5.3). The same class runs headless on the
 * game server, in the browser for local play/prediction, and in golden-replay tests.
 */
import { FRAG, createTuning, getMap, weapons, type DummySpawn, type MapDef, type Tuning } from '@military-forge/content';
import { IdAllocator } from '@military-forge/shared';
import { botInput } from './bots';
import { stepRegen, stepWeapons } from './combat';
import { MAX_GRENADES, MAX_PLAYERS, ticks } from './constants';
import { DamageSource, type SimEvent } from './events';
import { GrenadeState, stepGrenade } from './grenades';
import { copyInput, type Input } from './input';
import { MapMechanics, createBodyEnv } from './mechanics';
import { depenetrate, quantizeMovement, stepMovement } from './movement';
import { PlayerState, giveLoadout } from './player';
import type { TargetRewind } from './rewind';
import { CollisionWorld } from './world';

export interface GameOptions {
  mapId?: string;
  map?: MapDef;
  seed?: number;
  tuning?: Partial<Tuning>;
  /** spawn the map's dummy targets */
  dummies?: boolean;
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
    if (!this.players[id]) return;
    this.players[id] = null;
    this.ids.free(id);
  }

  playerCount(includeBots = true): number {
    let n = 0;
    for (const p of this.players) if (p && (includeBots || !p.isBot)) n++;
    return n;
  }

  allocGrenade(): GrenadeState | null {
    for (const g of this.grenades) if (!g.alive) return g;
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
    for (const p of this.players) if (p?.alive) stepWeapons(this, p);
    for (const g of this.grenades) if (g.alive) stepGrenade(this, g, FRAG);

    // hazards: falling out of the map (KILL zone below the bounds)
    for (const p of this.players) {
      if (!p?.alive || p.y > this.map.bounds.minY + 0.5) continue;
      const credited = p.lastAttacker >= 0 && this.tick - p.lastAttackTick <= ENVIRONMENT_CREDIT_TICKS;
      this.kill(p, credited ? p.lastAttacker : p.id, DamageSource.World);
    }

    for (const p of this.players) {
      if (!p) continue;
      if (p.alive) {
        stepRegen(this, p);
        quantizeMovement(p);
      } else if (--p.respawnTicks <= 0) {
        this.respawn(p);
      }
      p.prevButtons = p.input.buttons;
    }
    this.tick++;
  }
}
