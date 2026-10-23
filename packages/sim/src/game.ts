/**
 * The authoritative simulation of one room (docs/06 §5.3). The same class runs headless on the
 * game server, in the browser for local play/prediction, and in golden-replay tests.
 */
import { NO_WEAPON, createTuning, getMap, mapTiers, tierIndexAt, weapons, type DummySpawn, type MapDef, type Tuning } from '@military-forge/content';
import { IdAllocator } from '@military-forge/shared';
import { botInput } from './bots';
import { CloudState, stepClouds } from './clouds';
import { stepRegen, stepWeapons } from './combat';
import { MAX_CLOUDS, MAX_GRENADES, MAX_PICKUPS, MAX_PLAYERS, ticks } from './constants';
import { DamageSource, type SimEvent } from './events';
import { GrenadeState, forgetOwner, stepGrenade, stepStatus } from './grenades';
import { stepBurn } from './projectiles';
import { copyInput, type Input } from './input';
import { MapMechanics, createBodyEnv } from './mechanics';
import { depenetrate, quantizeMovement, stepMovement } from './movement';
import { PickupState, createSpawners, dropCarried, resetPickups, stepPickups, type SpawnerState } from './pickups';
import { PlayerState, allies, giveLoadout, keepGuns, respawnGuns } from './player';
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
  /**
   * The test armory (with pickups on): a rack of one of every gun near the spawns, each back 2 s
   * after it's taken (pickups.ts). A server flag; the playtest turns it on.
   */
  armory?: boolean;
}

/** Team spawns: how much a teammate nearby counts, against an enemy far away (metres per metre). */
const TEAM_SPAWN_PULL = 0.35;

/** Seconds within which a hazard death is credited to the last attacker (docs/03 §8). */
const ENVIRONMENT_CREDIT_TICKS = ticks(5);

/** Scratch for the player being moved (the sim is single-threaded). */
const bodyEnv = createBodyEnv();

export class Game {
  map: MapDef;
  world: CollisionWorld;
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
  spawners: SpawnerState[];
  /** smoke and gas clouds (clouds.ts) */
  readonly clouds: CloudState[] = Array.from({ length: MAX_CLOUDS }, (_, i) => new CloudState(i));
  /** events produced by the most recent step() */
  readonly events: SimEvent[] = [];
  /** lag compensation for hitscan (server only; null = test targets where they are now) */
  rewind: TargetRewind | null = null;
  /** the map's rules, zones and events (docs/02 §20); null when it has none */
  mech: MapMechanics | null;
  /** set by Match.step outside the warm-up and the match: bots keep their aim, press nothing */
  inputsFrozen = false;
  /**
   * Extra ticks of their own for players catching up (the server: a client's inputs arrived late, the
   * player stood held while they were missing; room.ts): after this tick's step, each player runs
   * these inputs in order, as its own simulation would have (stepPlayer), at this tick's time. Emptied
   * by each step.
   */
  readonly catchUp: Input[][] = [];
  /** called before each catch-up tick of a player (its `k`th): the server sets that input's view for lag compensation */
  beforeCatchUp: ((p: PlayerState, k: number) => void) | null = null;
  private readonly ids = new IdAllocator(MAX_PLAYERS);

  constructor(options: GameOptions = {}) {
    this.map = options.map ?? getMap(options.mapId ?? 'movement-test');
    this.world = new CollisionWorld(this.map);
    this.mech = MapMechanics.compile(this.map);
    this.tuning = createTuning(options.tuning);
    this.seed = (options.seed ?? 1) >>> 0;
    this.pickupsEnabled = options.pickups ?? false;
    this.spawners = this.pickupsEnabled ? createSpawners(this.map, this.world, options.armory ?? false) : [];
    resetPickups(this);
    if (options.dummies) for (const d of this.map.dummies) this.addDummy(d);
  }

  /** Change the arena between matches while keeping player IDs and room sessions intact. */
  changeMap(mapId: string, armory = false): void {
    if (this.map.id === mapId) return;
    this.map = getMap(mapId);
    this.world = new CollisionWorld(this.map);
    this.mech = MapMechanics.compile(this.map);
    this.spawners = this.pickupsEnabled ? createSpawners(this.map, this.world, armory) : [];
    for (const grenade of this.grenades) grenade.alive = false;
    for (const cloud of this.clouds) cloud.alive = false;
    this.events.length = 0;
    for (const player of this.players) if (player) player.alive = false;
    for (const player of this.players) if (player) this.respawn(player);
    resetPickups(this);
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
      g.weapon = -1;
      g.hits = 0;
      return g;
    }
    return null;
  }

  /**
   * Team modes: the safest spawn, away from enemies and near teammates. Each spawn scores its distance
   * to the nearest living enemy, less TEAM_SPAWN_PULL of its distance to the nearest living teammate;
   * the highest wins (ties: lowest index). With no enemy alive, the one nearest a teammate. On a map
   * with tiers, only the least crowded tier's spawns count, as in a free-for-all.
   */
  private teamSpawn(p: PlayerState, fewest: number): { x: number; y: number } | null {
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < this.map.spawns.length; i++) {
      const s = this.map.spawns[i]!;
      if (fewest >= 0 && this.spawnTier[i] !== fewest) continue;
      let enemy = Infinity;
      let mate = Infinity;
      for (const q of this.players) {
        if (!q || q === p || !q.alive) continue;
        const dx = q.x - s.x;
        const dy = q.y - s.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (allies(p, q)) mate = Math.min(mate, d);
        else enemy = Math.min(enemy, d);
      }
      const score = (enemy === Infinity ? 1000 : enemy) - (mate === Infinity ? 0 : TEAM_SPAWN_PULL * mate);
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  /**
   * Spawn point farthest from other living players (ties: lowest index); in team modes teamSpawn. On a
   * map with tiers, only spawns on the tiers with the fewest living players count, so a match spreads
   * across its stacked battle zones instead of piling onto one. Dummies use their home. Public for
   * match start (match.ts).
   */
  respawn(p: PlayerState): void {
    let sx = p.homeX;
    let sy = p.homeY;
    const team = p.team >= 0 && (!p.isBot || p.brain) ? this.teamSpawn(p, this.leastCrowdedTier(p)) : null;
    if (team) {
      sx = team.x;
      sy = team.y;
    } else if (!p.isBot || p.brain) {
      const fewest = this.leastCrowdedTier(p);
      let bestScore = -1;
      for (let i = 0; i < this.map.spawns.length; i++) {
        const s = this.map.spawns[i]!;
        if (fewest >= 0 && this.spawnTier[i] !== fewest) continue;
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
    giveLoadout(p, weapons, respawnGuns(p));
    depenetrate(this.world, p, this.tuning);
    this.events.push({ type: 'spawn', player: p.id });
  }

  /** each spawn's tier (MapDef.tiers), or empty on a map without tiers */
  private spawnTierCache: Int8Array | null = null;
  private spawnTierMap: MapDef | null = null;
  private get spawnTier(): Int8Array {
    if (!this.spawnTierCache || this.spawnTierMap !== this.map) {
      this.spawnTierCache = Int8Array.from(this.map.spawns, (s) => tierIndexAt(this.map, s.y));
      this.spawnTierMap = this.map;
    }
    return this.spawnTierCache;
  }
  private readonly tierCount = new Int32Array(16);

  /**
   * The tier (with a spawn on it) holding the fewest living players other than `p`, lowest first on
   * a tie; −1 on a map without tiers (the plain farthest-spawn rule, unchanged).
   */
  private leastCrowdedTier(p: PlayerState): number {
    const tiers = mapTiers(this.map);
    if (!tiers) return -1;
    const n = Math.min(tiers.length, this.tierCount.length);
    const count = this.tierCount;
    count.fill(0);
    for (const q of this.players) {
      if (!q || q === p || !q.alive) continue;
      count[Math.min(n - 1, tierIndexAt(this.map, q.y))]!++;
    }
    const spawnTier = this.spawnTier;
    let best = -1;
    for (let i = 0; i < spawnTier.length; i++) {
      const t = Math.min(n - 1, spawnTier[i]!);
      if (best < 0 || count[t]! < count[best]! || (count[t] === count[best] && t < best)) best = t;
    }
    return best;
  }

  /**
   * Sets the weapons a player respawns with and equips them now, with full ammo (dev give-weapon
   * and replays; map spawners and pickups come with the full arsenal). It forgets the guns kept
   * from the last death: a chosen loadout wins.
   */
  setLoadout(p: PlayerState, loadout: readonly [number, number]): void {
    p.loadout = [loadout[0], loadout[1]];
    p.keptGuns = [NO_WEAPON, NO_WEAPON];
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

  /**
   * Whether `attacker` may hurt `target` (team modes): friendly fire off, teammates don't hurt each
   * other (bullets, blasts, flames, gas, swings); your own grenade still hurts you.
   */
  canHurt(attacker: number, target: PlayerState): boolean {
    if (this.tuning.friendlyFire >= 1 || attacker === target.id) return true;
    const by = this.players[attacker];
    return !by || !allies(by, target);
  }

  damage(target: PlayerState, amount: number, attacker: number, source: number, zone: number): void {
    if (!target.alive || amount <= 0 || !this.canHurt(attacker, target)) return;
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
    keepGuns(victim); // a person respawns with the guns they died holding, crate and armory picks included
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
   * the last one (docs/05 §13). Bots and dummies generate their own.
   */
  step(inputs: ReadonlyArray<Readonly<Input> | undefined>): void {
    // bots decide first, on what the last tick showed (its events are still here)
    for (const p of this.players) {
      if (!p?.brain || !p.alive) continue;
      p.brain.think(this, p, p.input);
      if (this.inputsFrozen) {
        p.input.buttons = 0;
        p.input.weaponSelect = 0;
      }
    }
    this.events.length = 0;
    const t = this.tuning;
    const mech = this.mech;
    // the map event schedule for this tick (and its warning/start/end events)
    if (mech) mech.beginTick(this.seed, this.tick, this.events);

    for (const p of this.players) {
      if (!p) continue;
      if (p.isBot) {
        if (p.alive && !p.brain) botInput(this, p, p.input);
      } else {
        const input = inputs[p.id];
        if (input) copyInput(p.input, input);
      }
    }

    for (const p of this.players) {
      if (!p?.alive || p.held) continue;
      const x0 = p.x;
      const y0 = p.y;
      if (stepMovement(this.world, p, t, mech ? mech.bodyEnv(p, t, bodyEnv) : null)) this.events.push({ type: 'dash', player: p.id, x: x0, y: y0, dir: p.dashDir, chain: p.dashChain });
    }
    // the shield key and carry modes, before anyone fires: every shot this tick meets the same shields
    for (const p of this.players) if (p?.alive && !p.held) stepShield(p);
    for (const p of this.players) if (p?.alive && !p.held) stepWeapons(this, p);
    for (const g of this.grenades) if (g.alive) stepGrenade(this, g);
    stepClouds(this);
    for (const p of this.players) if (p?.alive && !p.held) stepBurn(this, p);

    // hazards: falling out of the map (KILL zone below the bounds)
    for (const p of this.players) {
      if (!p?.alive || p.y > this.map.bounds.minY + 0.5) continue;
      const credited = p.lastAttacker >= 0 && this.tick - p.lastAttackTick <= ENVIRONMENT_CREDIT_TICKS;
      this.kill(p, credited ? p.lastAttacker : p.id, DamageSource.World);
    }
    stepPickups(this);

    for (const p of this.players) {
      if (!p || p.held) continue;
      if (p.alive) {
        stepRegen(this, p);
        stepStatus(p);
        quantizeMovement(p);
      } else if (--p.respawnTicks <= 0) {
        this.respawn(p);
      }
      p.prevButtons = p.input.buttons;
    }
    for (const p of this.players) {
      const extra = p ? this.catchUp[p.id] : undefined;
      if (!p || !extra?.length) continue;
      for (let k = 0; k < extra.length; k++) {
        this.beforeCatchUp?.(p, k);
        this.stepPlayer(p, extra[k]!);
      }
      extra.length = 0;
    }
    this.tick++;
  }

  /**
   * One tick of one player's own simulation (the server catching a late client up, Game.catchUp):
   * its input, movement, shield, weapons, burning, the kill line, regen and status, as step() does
   * for everyone. Its shots and throws land in this tick (scored and sent with it); grenades, clouds
   * and pickups move with everyone's next step.
   */
  private stepPlayer(p: PlayerState, input: Readonly<Input>): void {
    copyInput(p.input, input);
    if (this.inputsFrozen) {
      p.input.buttons = 0;
      p.input.weaponSelect = 0;
    }
    if (p.alive) {
      const x0 = p.x;
      const y0 = p.y;
      const mech = this.mech;
      if (stepMovement(this.world, p, this.tuning, mech ? mech.bodyEnv(p, this.tuning, bodyEnv) : null)) this.events.push({ type: 'dash', player: p.id, x: x0, y: y0, dir: p.dashDir, chain: p.dashChain });
      stepShield(p);
      stepWeapons(this, p);
      stepBurn(this, p);
      if (p.alive && p.y <= this.map.bounds.minY + 0.5) {
        const credited = p.lastAttacker >= 0 && this.tick - p.lastAttackTick <= ENVIRONMENT_CREDIT_TICKS;
        this.kill(p, credited ? p.lastAttacker : p.id, DamageSource.World);
      }
    }
    if (p.alive) {
      stepRegen(this, p);
      stepStatus(p);
      quantizeMovement(p);
    } else if (--p.respawnTicks <= 0) {
      this.respawn(p);
    }
    p.prevButtons = p.input.buttons;
  }
}
