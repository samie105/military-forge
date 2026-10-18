/**
 * Follows paths through the nav graph with the motor.
 *
 * - Plans with A*, each bot weighing links by time, fuel, hazards (the map's, and gas it has seen)
 *   and the links that failed it.
 * - Steers along the links tick by tick, looking ahead over level walk links so it doesn't stop at
 *   every node.
 * - Waits on the ground for the fuel a jet link needs.
 * - Gives a link up when it stops making progress (knocked off it, blocked, out of fuel). The bot
 *   then replans and that link costs more next time.
 */
import type { BodyEnv, Game, PlayerState } from '@military-forge/sim';
import { Motor, type MotorGoal } from '../motor';
import { PathFinder } from './astar';
import { LinkKind, type NavGraph, type NavLink, type NavNode } from './graph';

/** a node counts as reached within this (m) */
const ARRIVE_X = 0.35;
const ARRIVE_Y = 0.6;
/** walk links: aim this far ahead along the path (m) */
const LOOKAHEAD = 6;
/** fuel kept on top of what a jet link burned in its check */
const FUEL_MARGIN = 8;
/** longest wait on the ground for fuel before trying anyway (ticks) */
const FUEL_WAIT = 240;
/** off the graph with no node within 8 m, it heads for one this far off (m) */
const APPROACH_FAR = 20;

export class Navigator {
  readonly finder: PathFinder;
  readonly motor = new Motor();
  /** link ids from the start of the plan; `at` is the one being followed */
  readonly path: number[] = [];
  private at = 0;
  /** where the current plan goes (−1: none) */
  goal = -1;
  /** the plan starts at a node the body isn't at yet (planned from the air, or off the graph): go there first */
  private approach = -1;
  /** the last link gave up: replan (the brain does it on its next think) */
  failed = false;
  /** routes that burn more fuel than this are skipped (jet skill) */
  maxFuel = Infinity;
  /** the jetpack is down (an EMP field or storm, an EMP grenade): plans walk, and a jet link not yet started is dropped */
  jetBlocked = false;
  /** no waiting on the ground for fuel (it's getting out of gas); set by the brain */
  hurry = false;
  /** a node nobody should go to right now (a map event made it a hazard); set by the brain */
  blocked: (node: number) => boolean = () => false;
  /** extra seconds for taking a link right now (into or through gas the bot has seen); set by the brain */
  penalty: (link: NavLink) => number = () => 0;
  private readonly fails = new Map<number, number>();
  private linkTicks = 0;
  private best = Infinity;
  private stall = 0;
  private fuelWait = 0;
  private readonly mgoal: MotorGoal = { x: 0, y: 0, jet: false, early: false };

  constructor(readonly graph: NavGraph) {
    this.finder = new PathFinder(graph);
  }

  /** Following a plan that isn't finished. */
  get busy(): boolean {
    return this.approach >= 0 || this.at < this.path.length;
  }

  /** The link being followed, or null. */
  get link(): NavLink | null {
    return this.busy ? this.graph.links[this.path[this.at]!]! : null;
  }

  stop(): void {
    this.path.length = 0;
    this.at = 0;
    this.approach = -1;
    this.goal = -1;
    this.failed = false;
    this.motor.reset();
  }

  /** Stands still for now (a countdown): the link in progress starts its clock again afterwards. */
  hold(): void {
    this.linkTicks = 0;
    this.best = Infinity;
    this.stall = 0;
  }

  /** How many times links have given up on it this life (tests, debug). */
  get failures(): number {
    let n = 0;
    for (const f of this.fails.values()) n += f;
    return n;
  }

  /** Forget which links failed (a new life). */
  forget(): void {
    this.fails.clear();
  }

  /** The node the body stands at, or −1 (in the air, or off the graph). */
  locate(self: PlayerState): number {
    return self.grounded ? this.graph.nearest(self.x, self.y, 1.5) : -1;
  }

  readonly linkCost = (l: NavLink): number => {
    if (l.fuel > this.maxFuel || (this.jetBlocked && l.fuel > 0) || this.blocked(l.to)) return -1;
    let c = l.time * (1 + this.graph.nodes[l.to]!.hazard);
    c += (l.fuel / 100) * 0.8; // burnt fuel is time spent refilling later
    c += this.penalty(l);
    const f = this.fails.get(l.id);
    if (f) c *= 1 + 3 * f;
    return c;
  };

  /**
   * Plans from where the body is to node `goal`. In the air or off the graph (floating in zero-g,
   * knocked onto a crate), it plans from the nearest node within 8 m (else APPROACH_FAR, or `via`)
   * and goes there first. False when there's no way.
   */
  plan(self: PlayerState, goal: number, via = -1): boolean {
    const following = this.leg();
    let start = via >= 0 ? -1 : this.locate(self);
    if (start >= 0 && this.blocked(start)) start = -1;
    const approach = start < 0;
    if (approach) start = via >= 0 ? via : this.graph.nearestUsable(self.x, self.y, 8, this.blocked);
    // nothing near (the middle of a wide zero-g dome, which has no nodes): farther afield
    if (approach && start < 0 && via < 0) start = this.graph.nearestUsable(self.x, self.y, APPROACH_FAR, this.blocked);
    this.failed = false;
    this.approach = -1;
    if (start < 0 || !this.finder.find(start, goal, this.linkCost, this.path)) {
      this.path.length = 0;
      this.at = 0;
      return false;
    }
    if (approach) this.approach = start;
    this.at = 0;
    this.goal = goal;
    // a new plan that goes on along the leg it was on keeps that leg's clock: replanning every
    // second toward the next spot over mustn't hide a body that isn't getting anywhere
    if (this.leg() !== following) this.resetLink();
    return true;
  }

  /** What it's following now, as a key: the link id, −2 − node for an approach leg, −1 for nothing. */
  private leg(): number {
    if (this.approach >= 0) return -2 - this.approach;
    return this.at < this.path.length ? this.path[this.at]! : -1;
  }

  /** The plan's estimated cost from here (s), or Infinity. */
  remaining(): number {
    let c = 0;
    for (let i = this.at; i < this.path.length; i++) c += this.linkCost(this.graph.links[this.path[i]!]!);
    return this.busy ? c : Infinity;
  }

  private resetLink(): void {
    this.linkTicks = 0;
    this.best = Infinity;
    this.stall = 0;
    this.fuelWait = 0;
    this.motor.reset();
  }

  /** Movement buttons for this tick (0 with nothing to follow). */
  step(game: Game, self: PlayerState, env: BodyEnv | null): number {
    const g = this.graph;
    // in (near) zero-g a body floats over the floor: close enough counts without touching down
    const down = self.grounded || (env !== null && env.gravityMul < 0.2);
    if (this.approach >= 0) {
      const n = g.nodes[this.approach]!;
      if (down && Math.abs(self.x - n.x) < ARRIVE_X && Math.abs(self.y - n.y) < ARRIVE_Y) {
        this.approach = -1;
        this.resetLink();
      } else return this.steer(game, self, env, n, true, true, 2);
    }
    while (this.at < this.path.length) {
      const to = g.nodes[g.links[this.path[this.at]!]!.to]!;
      if (!(down && Math.abs(self.x - to.x) < ARRIVE_X && Math.abs(self.y - to.y) < ARRIVE_Y)) break;
      this.at++;
      this.resetLink();
    }
    const link = this.link;
    if (!link) return 0;
    if (this.jetBlocked && link.fuel > 0 && self.grounded) {
      // no jetpack: this way is closed for now (not the link's fault)
      this.path.length = 0;
      this.at = 0;
      this.failed = true;
      return 0;
    }
    const target = link.kind === LinkKind.Walk ? this.lookahead(self) : g.nodes[link.to]!;

    // a jet link wants the fuel its check burned (plus a margin, but never more than a full tank):
    // refill on the ground first, unless it's in a hurry (getting out of gas)
    const want = Math.min(link.fuel + FUEL_MARGIN, game.tuning.fuelMax - 0.5);
    if (link.kind === LinkKind.Air && link.fuel > 0 && self.grounded && self.fuel < want && this.fuelWait < FUEL_WAIT && !this.hurry) {
      this.fuelWait++;
      return 0;
    }

    const buttons = this.steer(game, self, env, target, link.kind === LinkKind.Air, link.early, link.time);
    if (this.failed) this.fails.set(link.id, (this.fails.get(link.id) ?? 0) + 1);
    return buttons;
  }

  /** The motor toward `target`; drops the plan (`failed`) when it stops getting closer. */
  private steer(game: Game, self: PlayerState, env: BodyEnv | null, target: NavNode, jet: boolean, early: boolean, expected: number): number {
    const mg = this.mgoal;
    mg.x = target.x;
    mg.y = target.y;
    mg.jet = jet;
    mg.early = early;
    const buttons = this.motor.step(game.world, self, game.tuning, env, mg);
    this.linkTicks++;
    const d = Math.abs(self.x - target.x) + Math.abs(self.y - target.y);
    if (d < this.best - 0.1) {
      this.best = d;
      this.stall = 0;
    } else this.stall++;
    if (this.stall > (jet ? 120 : 75) || this.linkTicks > (expected * 2 + 2) * 60) {
      this.path.length = 0;
      this.at = 0;
      this.approach = -1;
      this.failed = true;
    }
    return buttons;
  }

  /** The farthest node ahead along consecutive level walk links, in one direction, within LOOKAHEAD. */
  private lookahead(self: PlayerState): NavNode {
    const g = this.graph;
    let target = g.nodes[g.links[this.path[this.at]!]!.to]!;
    const dir = target.x >= self.x ? 1 : -1;
    for (let i = this.at + 1; i < this.path.length; i++) {
      const l = g.links[this.path[i]!]!;
      if (l.kind !== LinkKind.Walk) break;
      const n = g.nodes[l.to]!;
      if (Math.abs(n.y - self.y) > 0.6 || (n.x - target.x) * dir <= 0 || Math.abs(n.x - self.x) > LOOKAHEAD) break;
      target = n;
    }
    return target;
  }
}
