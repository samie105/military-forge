/**
 * A bot's brain (docs/08 §9): the sim calls `think` once per tick, first thing in Game.step.
 *
 * - **10 Hz decisions** (staggered by player id, so 1/6 of the bots think each tick): a look
 *   around, then the behaviour tree: get out of gas, wait out a flashbang's white, fall back to
 *   regenerate when hurt, fight what it sees (pick a spot at the gun's range with a line of fire,
 *   throw a frag now and then), grab a shield worth having, hunt what it heard or lost sight of, or
 *   roam.
 * - **Every tick:** the navigator (or a gravity-pocket escape) moves it, the aim tracks a target
 *   it can still see (smoke or a flashbang can take it away between looks), the gunner works the
 *   trigger (only with a line of fire), the shield goes up for a fight and on the back otherwise,
 *   and a dash dodges a hit. All of it is an ordinary Input.
 * - **Arsenal B (v10):** it sees what a client is sent (Perception: smoke, the full white, SOUNDs);
 *   a flashbang's fade spoils its aim; gas it has seen costs extra on every path and it walks out of
 *   a cloud it's in; an EMP grenade's dead jetpack closes the jet links. It throws frags only.
 *
 * Randomness comes from the bot's own seeded generator, never the sim's spread hashes.
 */
import { BREACHER, BUZZ, FRAG, HAMMER, K47, NO_WEAPON, WIDOW, pickups as pickupDefs, weapons } from '@military-forge/content';
import { DEG2RAD, angleToU16, hash4, simAtan2, wrapAngle, Xoshiro128 } from '@military-forge/shared';
import {
  Btn,
  DamageSource,
  SegFlag,
  createBodyEnv,
  createRayHit,
  dashBlocked,
  type BodyEnv,
  type Brain,
  type Game,
  type Input,
  type MapMechanics,
  type PlayerState,
} from '@military-forge/sim';
import { Aim } from './aim';
import { Action, Condition, Selector, Sequence, Status, type BtNode } from './bt';
import { solveThrow, type Throw } from './grenadier';
import { Gunner, type Trigger } from './gunner';
import type { BotLevel } from './levels';
import type { MotorGoal } from './motor';
import { navGraphFor } from './nav/cache';
import { LinkKind, type NavGraph, type NavLink } from './nav/graph';
import { Navigator } from './nav/navigator';
import { Perception, type Contact } from './perception';

/** decisions every this many ticks (10 Hz) */
export const THINK_EVERY = 6;
/** salt for the bots' seeds: keeps them apart from every other seeded draw */
const SEED_SALT = 0xb075;
/** eye/shoulder height for lines of fire from a node (m) */
const EYE = 1.08;

/** Loadouts a bot can roll (slot 0, slot 1). */
export const BOT_LOADOUTS: readonly (readonly [number, number])[] = [
  [HAMMER.index, BUZZ.index],
  [HAMMER.index, K47.index],
  [BUZZ.index, BREACHER.index],
  [HAMMER.index, WIDOW.index],
  [K47.index, BREACHER.index],
];

export type BotMode = 'roam' | 'hunt' | 'fight' | 'grab' | 'retreat' | 'escape' | 'blind';

/** a shield on the ground is worth a detour when it beats the bot's own by this much HP */
const SHIELD_GAIN = 40;
/** items further than this aren't worth a detour (m) */
const ITEM_REACH = 40;
/** going into a node in gas it has seen costs this many seconds, up to 3× at the cloud's centre */
const GAS_COST = 4;
/** a gas cloud counts this much bigger (m) for paths and for "in it" */
const GAS_MARGIN = 0.5;
/** a way out of gas ends at least this far (m) past a cloud's edge */
const GAS_CLEAR = 1.2;

const ray = createRayHit();

export class BotBrain implements Brain {
  readonly graph: NavGraph;
  readonly nav: Navigator;
  readonly rng: Xoshiro128;
  readonly perception = new Perception();
  readonly aim: Aim;
  readonly gunner: Gunner;
  /** the loadout it rolled (Game.setLoadout gives it on every respawn) */
  readonly loadout: readonly [number, number];
  /** what the tree chose at the last think, and the branch it ran (tests, debug view) */
  mode: BotMode = 'roam';
  readonly trace: string[] = [];
  /** the player it's fighting or hunting (−1: none) */
  target = -1;

  private readonly tree: BtNode<BotBrain>;
  private readonly env = createBodyEnv();
  private readonly probeEnv = createBodyEnv();
  private readonly mech: MapMechanics | null;
  /** per-node "blocked by a map event" cache for the current tick */
  private readonly blockTick: Int32Array;
  private readonly blockValue: Uint8Array;
  /** per-node and per-link gas cost caches for the current tick */
  private readonly gasTick: Int32Array;
  private readonly gasValue: Float64Array;
  private readonly gasLinkTick: Int32Array;
  private readonly gasLinkValue: Float64Array;
  private readonly bodyMid: number;
  /** the tick of the last think: a gap means the bot died and came back */
  private lastTick = -2;
  private now = 0;
  /** replans toward the same goal after a failed link, before picking another */
  private retries = 0;
  /** flying out of a gravity pocket toward this x (NaN: not escaping) */
  private escapeX = NaN;
  private escaped = false;
  private readonly escapeGoal: MotorGoal = { x: 0, y: 0, jet: false, early: false };
  /** walking straight out of gas toward this x when no path out was found (NaN: not) */
  private walkOutX = NaN;
  /** the node it's leaving gas for (−1: none), and the cloud it's in (inGas) */
  private exitNode = -1;
  private readonly cloud = { x: 0, y: 0, r: 0 };
  /** what it's hunting: a contact's last known place, or a SOUND's (target −1) */
  private huntX = 0;
  private huntY = 0;
  private huntTick = -1;
  // fighting
  private repositionAt = 0;
  private strafeSide = 1;
  private hopTicks = 0;
  private nextHop = 0;
  private retreating = false;
  private coverAt = 0;
  private planned: Throw | null = null;
  private throwExpires = 0;
  private nextGrenade = 0;
  /** dash this tick with these direction buttons (0: no dodge) */
  private dodge = 0;
  /** the shield key can be pressed again from this tick (no flapping) */
  private shieldAt = 0;
  /** the item slot it's going for (−1: none) */
  private item = -1;
  private readonly hands = { buttons: 0, weaponSelect: 0 };
  private readonly trig: Trigger = { target: null, dist: 0, onTarget: false, fighting: false };
  // set for the duration of a think, for the tree's actions
  private game!: Game;
  private self!: PlayerState;

  constructor(
    game: Game,
    readonly level: BotLevel,
    /** this bot's number in the game (0 = first bot added): part of its seed */
    readonly serial: number,
  ) {
    this.graph = navGraphFor(game);
    this.nav = new Navigator(this.graph);
    this.nav.maxFuel = level.jetSkill * game.tuning.fuelMax;
    this.rng = new Xoshiro128(hash4(game.seed, SEED_SALT, serial, 0));
    this.loadout = BOT_LOADOUTS[this.rng.int(BOT_LOADOUTS.length)]!;
    this.aim = new Aim(level, this.rng);
    this.gunner = new Gunner(level, this.rng);
    this.perception.viewScale = level.view;
    this.mech = game.mech;
    this.blockTick = new Int32Array(this.graph.nodes.length).fill(-1);
    this.blockValue = new Uint8Array(this.graph.nodes.length);
    this.gasTick = new Int32Array(this.graph.nodes.length).fill(-1);
    this.gasValue = new Float64Array(this.graph.nodes.length);
    this.gasLinkTick = new Int32Array(this.graph.links.length).fill(-1);
    this.gasLinkValue = new Float64Array(this.graph.links.length);
    this.bodyMid = game.tuning.standHeight / 2;
    if (this.mech) this.nav.blocked = this.nodeBlocked;
    this.nav.penalty = this.linkGas;
    this.tree = new Selector<BotBrain>('root', [
      new Sequence('gas', [new Condition('in gas', (b) => b.inGas()), new Action('leave the gas', (b) => b.leaveGas())]),
      new Sequence('blind', [new Condition('whited out', (b) => b.perception.blind >= 1), new Action('wait it out', (b) => b.waitOut())]),
      new Sequence('retreat', [new Condition('hurt', (b) => b.hurt()), new Action('fall back', (b) => b.fallBack())]),
      new Sequence('fight', [new Condition('enemy in sight', (b) => b.spot()), new Action('engage', (b) => b.engage())]),
      new Sequence('grab', [new Condition('item worth it', (b) => b.wantItem()), new Action('grab', (b) => b.grab())]),
      new Sequence('hunt', [new Condition('enemy known', (b) => b.lead()), new Action('hunt', (b) => b.hunt())]),
      new Action('roam', (b) => b.roam()),
    ]);
  }

  think(game: Game, self: PlayerState, out: Input): void {
    const tick = game.tick;
    if (tick !== this.lastTick + 1) this.respawned();
    this.lastTick = tick;
    this.now = tick;
    this.game = game;
    this.self = self;
    const env = game.mech ? game.mech.bodyEnv(self, game.tuning, this.env) : null;
    // the jetpack is down: an EMP field or storm, or an EMP grenade's lockout
    this.nav.jetBlocked = (env !== null && env.jetDisabled) || self.jetDisabledTicks > 0;
    this.nav.hurry = this.mode === 'escape';

    this.perception.hear(game, self);
    this.aim.impair = this.perception.blind;
    this.maybeDodge(game, self, env);

    if ((tick + self.id) % THINK_EVERY === 0 && !game.inputsFrozen) {
      this.perception.look(game, self);
      // caught in a hazard a map event switched on (a gravity pocket): fly out the side, level
      // (straight down is a one-way catwalk it can't drop through while the pocket lifts it)
      this.escapeX = env !== null && env.gravityMul < 0 ? this.pocketExit(self) : NaN;
      this.walkOutX = NaN;
      this.trace.length = 0;
      if (Number.isNaN(this.escapeX)) {
        if (this.escaped) {
          this.escaped = false;
          if (this.nav.goal >= 0) this.nav.plan(self, this.nav.goal);
        }
        this.tree.tick(this, this.trace);
      } else {
        this.escaped = true;
        this.mode = 'escape';
        this.trace.push('escape');
      }
    }

    // movement
    let buttons: number;
    if (!Number.isNaN(this.escapeX)) {
      const g = this.escapeGoal;
      g.x = this.escapeX;
      g.y = self.y;
      buttons = this.nav.motor.step(game.world, self, game.tuning, env, g);
    } else if (!Number.isNaN(this.walkOutX)) {
      const g = this.escapeGoal;
      g.x = this.walkOutX;
      g.y = self.y;
      buttons = this.nav.motor.step(game.world, self, game.tuning, env, g);
    } else buttons = this.nav.step(game, self, env);
    buttons |= this.hop(self);

    // aim and trigger, at a target it can still see: smoke or a flashbang can take it away between looks
    const q = this.target >= 0 ? game.players[this.target] : null;
    const contact = q ? this.perception.contacts[q.id]! : null;
    if (q && contact?.visible) {
      if (this.perception.canSee(game, self, q)) this.perception.refresh(q, tick);
      else contact.visible = false;
    }
    const inSight = q?.alive === true && contact?.visible === true;
    const trig = this.trig;
    trig.target = null;
    trig.onTarget = false;
    // fights back on the way out of a hazard too, if it can see its target
    trig.fighting = this.mode === 'fight' || this.mode === 'retreat' || (this.mode === 'escape' && inSight);
    const t = game.tuning;
    if (q && inSight && trig.fighting && !this.planned) {
      const sx = self.shoulderX(t);
      const sy = self.shoulderY(t);
      const centre = this.aim.track(self, q, sx, sy);
      const dx = q.x - sx;
      const dy = q.y + 0.85 - sy;
      // in view isn't in reach: no shots into a wall
      if (this.lineOfFire(self.x, self.y, q)) {
        trig.target = q;
        trig.dist = Math.sqrt(dx * dx + dy * dy);
        trig.onTarget = this.aim.onTarget(centre, trig.dist);
      }
    } else if (this.planned) {
      this.aim.turnTo(this.planned.angle);
    } else {
      this.aim.drop();
      this.aim.turnTo(this.lookAngle(self, contact));
    }
    const hands = this.hands;
    hands.buttons = 0;
    hands.weaponSelect = 0;
    this.gunner.step(self, trig, hands);
    buttons |= hands.buttons;
    buttons |= this.shieldKey(self);
    out.weaponSelect = hands.weaponSelect;
    out.throwStrength = 7;

    // frags only (for now): while it has some, the belt stays on them (the cycle key steps through
    // the types held; a pickup can leave it on smoke, say, once the frags ran out)
    const onFrags = self.grenadeType === FRAG.index;
    if (!onFrags && self.frags > 0 && (self.prevButtons & Btn.CycleGrenade) === 0) buttons |= Btn.CycleGrenade;
    // a planned grenade goes once the arm is there
    if (this.planned) {
      if (tick > this.throwExpires || self.frags <= 0) this.planned = null;
      else if (onFrags && Math.abs(wrapAngle(this.aim.angle - this.planned.angle)) < 3 * DEG2RAD && self.throwCooldown === 0 && (self.prevButtons & Btn.Grenade) === 0) {
        buttons |= Btn.Grenade;
        out.throwStrength = this.planned.strength;
        this.planned = null;
      }
    }

    // a dodge overrides the movement keys for its one tick: they set the dash direction
    if (this.dodge !== 0) {
      buttons = (buttons & ~(Btn.Left | Btn.Right | Btn.Jet | Btn.Down)) | this.dodge | Btn.Dash;
      this.dodge = 0;
    }
    out.buttons = game.inputsFrozen ? 0 : buttons;
    out.aim = angleToU16(this.aim.angle);
  }

  // ── behaviour tree: conditions and actions (10 Hz) ──

  /** Below the retreat HP (until regenerated past the recover HP), with someone dangerous about. */
  private hurt(): boolean {
    const hp = this.self.hp;
    if (hp < this.level.retreatHp) this.retreating = true;
    else if (hp >= this.level.recoverHp) this.retreating = false;
    return this.retreating && this.threat() !== null;
  }

  /** Back off out of the threat's sight to regenerate; shoot back if it's in view meanwhile. */
  private fallBack(): Status {
    this.mode = 'retreat';
    const threat = this.threat()!;
    this.target = threat.id;
    const c = this.perception.contacts[threat.id]!;
    if (c.visible) this.aim.acquire(threat.id);
    if (this.now >= this.coverAt || !this.nav.busy) {
      this.coverAt = this.now + 90;
      const cover = this.pickCover(c);
      if (cover >= 0 && cover !== this.nav.goal) this.nav.plan(this.self, cover);
    }
    return Status.Running;
  }

  /** Someone in sight: picks who to fight (the nearest, or whoever's hurting it), keeping its target unless another is much closer. */
  private spot(): boolean {
    const self = this.self;
    let best = -1;
    let bestScore = Infinity;
    for (const q of this.game.players) {
      if (!q || q === self || !q.alive) continue;
      const c = this.perception.contacts[q.id]!;
      if (!c.visible) continue;
      const dx = q.x - self.x;
      const dy = q.y - self.y;
      let score = Math.sqrt(dx * dx + dy * dy);
      if (q.id === this.target) score *= 0.6;
      if (c.hurtTick >= 0 && this.now - c.hurtTick < 120) score *= 0.7;
      if (!this.lineOfFire(self.x, self.y, q)) score += 8; // one it can shoot at first
      if (score < bestScore) {
        bestScore = score;
        best = q.id;
      }
    }
    if (best < 0) return false;
    this.target = best;
    this.aim.acquire(best);
    return true;
  }

  /**
   * Holds a spot at the gun's range with a line of fire and moves on to another every second or
   * so (strafing, 2–5 m), sooner if it loses the line; never replans mid-flight. With no spot nearby
   * that has a line (the target's behind a wall, on another level), it goes after the target
   * instead, around the obstacle. A grenade now and then.
   */
  private engage(): Status {
    this.mode = 'fight';
    const q = this.game.players[this.target]!;
    const self = this.self;
    const flying = !self.grounded && this.nav.busy;
    if (!flying && (this.now >= this.repositionAt || !this.lineOfFire(self.x, self.y, q))) {
      const strafe = this.level.strafe;
      this.repositionAt = this.now + Math.round((0.6 + (1 - strafe) * 1.6 + 0.8 * this.rng.nextFloat()) * 60);
      if (this.rng.nextFloat() < strafe) this.strafeSide = -this.strafeSide;
      const spot = this.pickSpot(q, this.preferredRange(self, q));
      let goal = spot.id;
      if (!spot.los) {
        goal = this.graph.nearestUsable(q.x, q.y, 4, this.avoid);
        this.repositionAt = this.now + 60; // closing in: look again in a second
      }
      if (goal >= 0 && goal !== this.nav.goal) this.nav.plan(self, goal);
    }
    this.considerGrenade(this.perception.contacts[q.id]!);
    return Status.Running;
  }

  /** A clear line of fire from a body at (x, y) to q's torso. */
  private lineOfFire(x: number, y: number, q: PlayerState): boolean {
    const dx = q.x - x;
    const dy = q.y + 0.85 - (y + EYE);
    const d = Math.sqrt(dx * dx + dy * dy);
    return d < 1e-6 || !this.game.world.raycast(x, y + EYE, dx / d, dy / d, d, SegFlag.BulletPass, ray);
  }

  /**
   * Someone known but out of sight, or gunfire it heard: the freshest news (a lost sighting, a hit
   * from someone it heard, a SOUND with no name).
   */
  private lead(): boolean {
    const self = this.self;
    let best = -1;
    let bestTick = -1;
    for (const q of this.game.players) {
      if (!q || q === self) continue;
      const c = this.perception.contacts[q.id]!;
      if (c.known && c.tick > bestTick) {
        bestTick = c.tick;
        best = q.id;
      }
    }
    const noise = this.perception.noise;
    if (noise.tick > bestTick) {
      this.target = -1;
      this.huntX = noise.x;
      this.huntY = noise.y;
      this.huntTick = noise.tick;
      return true;
    }
    if (best < 0) return false;
    const c = this.perception.contacts[best]!;
    this.target = best;
    this.huntX = c.x;
    this.huntY = c.y;
    this.huntTick = c.tick;
    return true;
  }

  /** Goes where it was last seen or heard; lobs a grenade at someone it knows of if that's fresh. */
  private hunt(): Status {
    this.mode = 'hunt';
    const goal = this.graph.nearestUsable(this.huntX, this.huntY, 4, this.avoid);
    let lost = goal < 0;
    // no way there (an EMP storm, say), or there already (nothing left to follow) and nobody about: let it go
    if (!lost && (goal !== this.nav.goal || !this.nav.busy)) lost = !this.nav.plan(this.self, goal) || !this.nav.busy;
    if (lost) {
      if (this.target >= 0) this.perception.contacts[this.target]!.known = false;
      else this.perception.noise.tick = -1;
      return Status.Failure;
    }
    if (this.target >= 0 && this.now - this.huntTick < 120) this.considerGrenade(this.perception.contacts[this.target]!);
    return Status.Running;
  }

  /**
   * An item it has seen that's worth the detour: a shield better than its own by SHIELD_GAIN HP,
   * within ITEM_REACH m. The nearest such one.
   */
  private wantItem(): boolean {
    const self = this.self;
    let best = -1;
    let bestD = ITEM_REACH * ITEM_REACH;
    this.perception.items.forEach((it, slot) => {
      if (it.tick < 0) return;
      const def = pickupDefs[it.def];
      if (def?.kind !== 'shield' || it.hp < self.shieldHp + SHIELD_GAIN) return;
      const d = (it.x - self.x) * (it.x - self.x) + (it.y - self.y) * (it.y - self.y);
      if (d < bestD) {
        bestD = d;
        best = slot;
      }
    });
    this.item = best;
    return best >= 0;
  }

  /** Goes and stands on it (taking it is the sim's touch rule, as for humans). */
  private grab(): Status {
    this.mode = 'grab';
    this.target = -1;
    const it = this.perception.items[this.item]!;
    const goal = this.graph.nearestUsable(it.x, it.y, 2.5, this.avoid);
    if (goal < 0) {
      it.tick = -1; // nowhere to stand by it: forget it
      return Status.Failure;
    }
    if (goal !== this.nav.goal || !this.nav.busy) {
      const there = Math.abs(this.self.x - it.x) < 1 && Math.abs(this.self.y - it.y) < 1.5;
      if (there || !this.nav.plan(this.self, goal)) {
        it.tick = -1; // there and it's gone (or no way to it)
        return Status.Failure;
      }
    }
    return Status.Running;
  }

  /**
   * The shield key: up in front for a fight (it comes up by itself with a one-handed gun), on the
   * back otherwise (it guards the back, weighs nothing there and lets the bot dash). Pressed at most
   * twice a second.
   */
  private shieldKey(self: PlayerState): number {
    if (self.shieldHp <= 0 || this.now < this.shieldAt || (self.prevButtons & Btn.Shield) !== 0) return 0;
    const up = self.shieldTicks > 0;
    const wantUp = this.mode === 'fight';
    // up: sling it when the fight's over; on the back by choice: raise it for a fight
    if ((up && !wantUp) || (!up && wantUp && self.shieldStowed)) {
      this.shieldAt = this.now + 30;
      return Btn.Shield;
    }
    return 0;
  }

  private roam(): Status {
    this.mode = 'roam';
    this.target = -1;
    const nav = this.nav;
    if (nav.busy) return Status.Running;
    if (nav.failed && nav.goal >= 0 && this.retries < 3) {
      this.retries++;
      if (nav.plan(this.self, nav.goal)) return Status.Running;
    }
    this.retries = 0;
    this.wander(this.self);
    return Status.Running;
  }

  // ── helpers ──

  /** The contact that's the worst news: whoever hurt it last, else the nearest known. */
  private threat(): PlayerState | null {
    let best: PlayerState | null = null;
    let bestScore = Infinity;
    for (const q of this.game.players) {
      if (!q || q === this.self || !q.alive) continue;
      const c = this.perception.contacts[q.id]!;
      if (!c.known) continue;
      const recentHurt = c.hurtTick >= 0 && this.now - c.hurtTick < 300;
      const dx = c.x - this.self.x;
      const dy = c.y - this.self.y;
      const score = Math.sqrt(dx * dx + dy * dy) * (recentHurt ? 0.3 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = q;
      }
    }
    return best;
  }

  /** Where it fights from, by the gun in hand: a bit inside the falloff start (3 to 20 m). */
  private preferredRange(self: PlayerState, q: PlayerState): number {
    const dx = q.x - self.x;
    const dy = q.y - self.y;
    const slot = self.weapons[this.gunner.bestSlot(self, Math.sqrt(dx * dx + dy * dy))]!;
    const def = slot.def === NO_WEAPON ? undefined : weapons[slot.def];
    if (!def) return 3;
    if (def.fireMode === 'melee') return 1;
    return Math.max(3, Math.min(20, def.falloffStart * 0.8));
  }

  /**
   * A node nearby (8 m either side, 6 m down to 4 m up) at about `range` from `q` with a line of
   * fire to it: a strafe of 2–5 m to the strafe side scores best, staying put worst.
   */
  private pickSpot(q: PlayerState, range: number): { id: number; los: boolean } {
    const self = this.self;
    let best = -1;
    let bestLos = false;
    let bestScore = -Infinity;
    this.graph.forNear(self.x, self.y - 1, 8, 5, (id) => {
      const n = this.graph.nodes[id]!;
      if (!n.usable || this.avoid(id)) return;
      const dx = q.x - n.x;
      const dy = q.y + 0.85 - (n.y + EYE);
      const d = Math.sqrt(dx * dx + dy * dy);
      const los = d < 1e-6 || !this.game.world.raycast(n.x, n.y + EYE, dx / d, dy / d, d, SegFlag.BulletPass, ray);
      const move = Math.abs(n.x - self.x) + Math.abs(n.y - self.y);
      const strafe = move < 1 ? -1.5 : move <= 5 ? (Math.sign(n.x - self.x) === this.strafeSide ? 2 : 0.5) : -0.2 * (move - 5);
      const score = -0.6 * Math.abs(d - range) + (los ? 4 : -6) + strafe - 3 * n.hazard + 1.5 * this.rng.nextFloat();
      if (score > bestScore) {
        bestScore = score;
        best = id;
        bestLos = los;
      }
    });
    return { id: best, los: bestLos };
  }

  /** A node within 20 m the threat can't see, as far from it as is sensible. */
  private pickCover(c: Contact): number {
    const self = this.self;
    let best = -1;
    let bestScore = -Infinity;
    this.graph.forNear(self.x, self.y + 1, 20, 8, (id) => {
      const n = this.graph.nodes[id]!;
      if (!n.usable || this.avoid(id)) return;
      const tx = n.x - c.x;
      const ty = n.y + 0.9 - (c.y + EYE);
      const far = Math.sqrt(tx * tx + ty * ty);
      const hidden = far > 1e-6 && this.game.world.raycast(c.x, c.y + EYE, tx / far, ty / far, far, SegFlag.BulletPass, ray);
      const sx = n.x - self.x;
      const sy = n.y - self.y;
      const score = Math.min(far, 25) + (hidden ? 15 : 0) - 0.4 * Math.sqrt(sx * sx + sy * sy) - 3 * n.hazard;
      if (score > bestScore) {
        bestScore = score;
        best = id;
      }
    });
    return best;
  }

  /** Grenades: rationed (a few seconds apart, by level), 7–22 m away, only a throw that lands near and not on itself. */
  private considerGrenade(c: Contact): void {
    const self = this.self;
    if (this.planned || self.frags <= 0 || self.throwCooldown > 0 || this.now < this.nextGrenade || this.level.grenades <= 0) return;
    if (this.rng.nextFloat() > this.level.grenades * 0.06) return;
    this.nextGrenade = this.now + Math.round((4 + 5 * this.rng.nextFloat()) * 60);
    const dx = c.x - self.x;
    const dy = c.y - self.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < 7 || d > 22) return;
    // where it'll be when the fuse runs out, roughly (part of its motion)
    const shot = solveThrow(this.game, self, c.x + c.vx * 0.5, c.y);
    if (!shot) return;
    this.planned = shot;
    this.throwExpires = this.now + 45;
  }

  /** Occasional short jet hops in a fight (harder to hit), keeping fuel for getting about. */
  private hop(self: PlayerState): number {
    if (this.mode !== 'fight' || !this.level.hops) return 0;
    if (this.hopTicks > 0) {
      this.hopTicks--;
      return Btn.Jet;
    }
    if (self.grounded && self.fuel > 45 && this.now >= this.nextHop && !this.nav.jetBlocked) {
      this.hopTicks = 6 + this.rng.int(10);
      this.nextHop = this.now + Math.round((1.5 + 2.5 * this.rng.nextFloat()) * 60);
    }
    return 0;
  }

  /**
   * Hit this tick: maybe dash away from the attacker (cooldown, fuel and the jetpack permitting),
   * into open space. Away from where it knows the attacker is; a random side if it can't place it.
   * Gas isn't dodged: the tree walks it out.
   */
  private maybeDodge(game: Game, self: PlayerState, env: BodyEnv | null): void {
    if (self.dashCooldown > 0 || self.fuel < game.tuning.dashFuelCost + 5 || game.inputsFrozen || dashBlocked(self, env)) return;
    let from = -1;
    for (const e of game.events) {
      if (e.type === 'hit' && e.target === self.id && e.attacker >= 0 && e.attacker !== self.id && e.source !== DamageSource.Gas) from = e.attacker;
    }
    if (from < 0 || this.rng.nextFloat() >= this.level.dodge) return;
    const c = this.perception.contacts[from]!;
    const away = c.known ? (self.x >= c.x ? 1 : -1) : this.rng.nextFloat() < 0.5 ? 1 : -1;
    const awayBtn = away > 0 ? Btn.Right : Btn.Left;
    // candidates: up-and-away, away, straight up; first one with room (and ground under a level dash)
    const options: [number, number, number][] = [
      [Btn.Jet | awayBtn, away * 0.707, 0.707],
      [awayBtn, away, 0],
      [Btn.Jet, 0, 1],
    ];
    if (this.rng.nextFloat() < 0.5) options.push(options.shift()!);
    const cy = self.y + this.bodyMid;
    for (const [buttons, dx, dy] of options) {
      if (game.world.raycast(self.x, cy, dx, dy, 2.6, SegFlag.OneWay, ray)) continue;
      if (dy === 0 && !game.world.raycast(self.x + dx * 2.4, cy, 0, -1, 3, 0, ray)) continue;
      this.dodge = buttons;
      return;
    }
  }

  /**
   * No target in sight: toward where it last knew its target to be (one that just went into
   * smoke, say), or what it's hunting; else where it's going.
   */
  private lookAngle(self: PlayerState, contact: Contact | null): number {
    if (contact?.known && this.mode !== 'roam' && this.mode !== 'grab') return simAtan2(contact.y + 0.85 - (self.y + EYE), contact.x - self.x);
    if (this.mode === 'hunt' && this.target < 0) return simAtan2(this.huntY + 0.85 - (self.y + EYE), this.huntX - self.x);
    const link = this.nav.link;
    if (link) {
      const to = this.graph.nodes[link.to]!;
      return simAtan2(to.y + 0.85 - (self.y + EYE), to.x - self.x);
    }
    return this.aim.angle;
  }

  /** A node a running map event has made a hazard: reversed gravity (a gravity pocket) right now. */
  private readonly nodeBlocked = (id: number): boolean => {
    if (!this.mech) return false;
    if (this.blockTick[id] === this.now) return this.blockValue[id] === 1;
    const n = this.graph.nodes[id]!;
    const blocked = this.mech.envAt(n.x, n.y + this.bodyMid, this.probeEnv).gravityMul < 0;
    this.blockTick[id] = this.now;
    this.blockValue[id] = blocked ? 1 : 0;
    return blocked;
  };

  /** Extra seconds for going into a node in gas it has seen, more toward the centre (the navigator's penalty). */
  private readonly gasCost = (id: number): number => {
    if (!this.perception.knowsGas) return 0;
    if (this.gasTick[id] === this.now) return this.gasValue[id]!;
    const n = this.graph.nodes[id]!;
    const depth = this.perception.gasAt(this.game, n.x, n.y + this.bodyMid, GAS_MARGIN);
    const cost = depth > 0 ? GAS_COST * (1 + 2 * depth) : 0;
    this.gasTick[id] = this.now;
    this.gasValue[id] = cost;
    return cost;
  };

  /**
   * Extra seconds for a link through gas it has seen: into a node in it, or a flight (a jet, a
   * drop) whose middle is in it.
   */
  private readonly linkGas = (l: NavLink): number => {
    if (!this.perception.knowsGas) return 0;
    let c = this.gasCost(l.to);
    if (l.kind !== LinkKind.Walk) {
      if (this.gasLinkTick[l.id] !== this.now) {
        const a = this.graph.nodes[l.from]!;
        const b = this.graph.nodes[l.to]!;
        const depth = this.perception.gasAt(this.game, (a.x + b.x) / 2, (a.y + b.y) / 2 + this.bodyMid, GAS_MARGIN);
        this.gasLinkTick[l.id] = this.now;
        this.gasLinkValue[l.id] = depth > 0 ? GAS_COST * (1 + 2 * depth) : 0;
      }
      c += this.gasLinkValue[l.id]!;
    }
    return c;
  };

  /** Nowhere to head for right now: a map event's hazard, or in gas it has seen. */
  private readonly avoid = (id: number): boolean => this.nodeBlocked(id) || this.gasCost(id) > 0;

  /**
   * Its body is in gas it has seen (it always sees the cloud it's in, unless whited out). Once on
   * its way out it counts as in until it's GAS_CLEAR past the edge: out for good, not back and
   * forth at the rim.
   */
  private inGas(): boolean {
    const margin = this.exitNode >= 0 ? GAS_CLEAR : GAS_MARGIN;
    if (this.perception.gasAt(this.game, this.self.x, this.self.y + this.bodyMid, margin, this.cloud) > 0) return true;
    this.exitNode = -1;
    return false;
  }

  /**
   * Out of the gas: the nearest node clear of it, by a path its gas cost keeps short; it fights back
   * on the way if someone's in sight. With no path out, it walks straight away from the centre.
   */
  private leaveGas(): Status {
    this.mode = 'escape';
    if (!this.spot()) this.target = -1;
    const nav = this.nav;
    if (nav.busy && nav.goal === this.exitNode) return Status.Running;
    this.exitNode = this.gasExit();
    if (this.exitNode >= 0 && nav.plan(this.self, this.exitNode)) return Status.Running;
    this.exitNode = -1;
    nav.stop();
    const c = this.cloud;
    this.walkOutX = this.self.x >= c.x ? c.x + c.r + GAS_CLEAR : c.x - c.r - GAS_CLEAR;
    return Status.Running;
  }

  /**
   * A flashbang's full white: it sees nothing and knows no one (Perception), so it starts nothing
   * new; a way it was already going (out of a fight, say) it keeps going.
   */
  private waitOut(): Status {
    this.mode = 'blind';
    this.target = -1;
    return Status.Running;
  }

  /** The nearest usable node clear of gas by GAS_CLEAR, preferring ones it needn't climb to (−1: none near). */
  private gasExit(): number {
    const self = this.self;
    let best = -1;
    let bestScore = Infinity;
    this.graph.forNear(self.x, self.y, 12, 6, (id) => {
      const n = this.graph.nodes[id]!;
      if (!n.usable || this.nodeBlocked(id) || this.perception.gasAt(this.game, n.x, n.y + this.bodyMid, GAS_CLEAR) > 0) return;
      const dx = n.x - self.x;
      const dy = n.y - self.y;
      const score = Math.sqrt(dx * dx + dy * dy) + (dy > 1 ? 3 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = id;
      }
    });
    return best;
  }

  /** The x just past the nearer side of the reversed-gravity zone the bot is in (NaN if none). */
  private pocketExit(self: PlayerState): number {
    const mech = this.mech;
    if (!mech) return NaN;
    const y = self.y + this.bodyMid;
    for (const z of mech.zones) {
      if (mech.zoneOn[z.index] === 0 || z.def.gravityMul >= 0 || !mech.contains(z, self.x, y)) continue;
      return self.x - z.minX <= z.maxX - self.x ? z.minX - 1.5 : z.maxX + 1.5;
    }
    return NaN;
  }

  private respawned(): void {
    this.nav.stop();
    this.nav.forget();
    this.perception.forgetAll();
    this.aim.drop();
    this.retries = 0;
    this.target = -1;
    this.retreating = false;
    this.planned = null;
    this.walkOutX = NaN;
    this.exitNode = -1;
    this.mode = 'roam';
  }

  /**
   * Somewhere new to go: a usable node at least 12 m away (a few tries), else anywhere on the
   * surface it stands on (always walkable, e.g. inside an EMP field with no jetpack).
   */
  private wander(self: PlayerState): void {
    const nodes = this.graph.nodes;
    for (let tries = 0; tries < 6; tries++) {
      const n = nodes[this.rng.int(nodes.length)]!;
      if (!n.usable || this.avoid(n.id)) continue;
      const dx = n.x - self.x;
      const dy = n.y - self.y;
      if (dx * dx + dy * dy < 144) continue;
      if (this.nav.plan(self, n.id)) return;
    }
    const here = this.nav.locate(self);
    if (here < 0) return;
    const surface = nodes[here]!.surface;
    for (let tries = 0; tries < 6; tries++) {
      const n = nodes[this.rng.int(nodes.length)]!;
      if (n.surface === surface && n.id !== here && this.nav.plan(self, n.id)) return;
    }
  }
}
