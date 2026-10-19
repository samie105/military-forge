/**
 * Own grenades and projectiles, predicted (docs/05 §7.3). The predictor drops what its throws and
 * shots launch (its world holds only the local player, and a replay would step them twice), so
 * until now an own grenade appeared only when a snapshot brought it: a round trip after the throw
 * (241 ms at 150 ms ±40, ~690 ms on the owner's MTN phone; scripts/netfeel.ts), born where the hand
 * had been. Here each one the prediction throws is copied into a world of its own and flown there,
 * tick for tick with the prediction, so it leaves the hand on the frame of the throw.
 *
 * Matching the server's copy: the first own grenade of the same type that appears in a snapshot
 * after the throw. While matched, the server's copy is hidden and ours is drawn (it is a round trip
 * ahead, like the local player). Ours stops where it settles (a frag about to blow, a mine that
 * landed) and hands over once the server's copy reaches that spot; it goes when the server's is
 * gone (the blast arrives in the same snapshot). If the server's copy is somewhere else at the same
 * tick (a blade cutting a player ours can't see, a throw the server made later), the server's is
 * drawn from then on. A throw no snapshot ever shows (a press the server never got) fades out.
 */
import { grenades as grenadeDefs, type MapDef, type Tuning } from '@military-forge/content';
import type { SnapshotMsg } from '@military-forge/protocol';
import { Game, MineState, stepGrenade, type GrenadeState, type SimEvent } from '@military-forge/sim';

/** A grenade or projectile as drawn this frame (NetClient.grenadeViews). */
export interface GrenadeView {
  /** stable while it flies: 's<id>' for the server's, 'p<n>' for one of our own predicted */
  key: string;
  /** the server's id, or OWN_ID_BASE + n for a predicted one */
  id: number;
  owner: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuse: number;
  type: number;
  state: number;
}

/** predicted grenades are drawn with ids from here up (the server's are < MAX_GRENADES) */
export const OWN_ID_BASE = 1000;
const HISTORY = 128;
/** a throw no snapshot has shown this many ticks after it never happened on the server (a late press waits ≤ 45) */
const UNMATCHED_TICKS = 75;
/** ours and the server's further apart than this at the same tick: draw the server's */
export const DIVERGED_M = 1.5;
/** a settled copy hands over to the server's once that one is this close */
const HANDOVER_M = 0.3;
const dist = (dx: number, dy: number) => Math.sqrt(dx * dx + dy * dy);
/** our copies at most (the pool is the sim's) */
const MAX_OWN = 16;

interface Own {
  n: number;
  owner: number;
  /** the tick it was thrown or launched */
  tick: number;
  type: number;
  /** our copy in `fx` while it flies; null once it settled or ended */
  g: GrenadeState | null;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuse: number;
  state: number;
  /** the server's id, once a snapshot showed it; −1 before */
  serverId: number;
  diverged: boolean;
  /** our positions by tick (& HISTORY - 1): to compare with the server's at a snapshot's tick */
  readonly ht: Float64Array;
  readonly hx: Float64Array;
  readonly hy: Float64Array;
}

export class OwnProjectiles {
  /** the world our copies fly in: the room's map, seed and tuning, no players */
  readonly fx: Game;
  /** the last tick our copies were stepped through */
  private stepped = -1;
  private readonly own: Own[] = [];
  /** own grenade ids in the newest snapshot */
  private serverOwn = new Set<number>();
  private next = 0;
  /** predicted copies made, matched, diverged, never shown by the server (tests, net graph) */
  readonly stats = { predicted: 0, matched: 0, diverged: 0, unmatched: 0 };

  constructor(map: MapDef, seed: number, tuning: Tuning) {
    this.fx = new Game({ map, seed, tuning, dummies: false });
  }

  set tuning(t: Tuning) {
    this.fx.tuning = t;
  }

  /**
   * After the prediction simulated `tick` (forward, not a replay): step our copies through it,
   * then copy what that tick threw or launched (`events`, from `pred`'s world) for `owner`.
   */
  afterStep(tick: number, pred: Game, owner: number, events: readonly SimEvent[]): void {
    this.stepTo(tick);
    for (const e of events) {
      if ((e.type !== 'throw' && e.type !== 'launch') || e.owner !== owner) continue;
      const src = pred.grenades[e.grenade];
      if (src) this.add(tick, src);
    }
  }

  /** A snapshot arrived: match new own grenades, check the matched ones, drop what's over. */
  onSnapshot(msg: SnapshotMsg, me: number): void {
    // the snapshot shows the world after the server simulated serverTick − 1
    const at = msg.serverTick - 1;
    const now = new Set<number>();
    for (const g of msg.grenades) {
      if (g.owner !== me) continue;
      now.add(g.id);
      let o = this.own.find((x) => x.serverId === g.id);
      if (!o && !this.serverOwn.has(g.id)) {
        o = this.own.find((x) => x.serverId < 0 && x.type === g.type && x.tick <= at);
        if (o) {
          o.serverId = g.id;
          this.stats.matched++;
        }
      }
      if (!o || o.diverged) continue;
      const i = at & (HISTORY - 1);
      if (o.ht[i] === at && dist(o.hx[i]! - g.x, o.hy[i]! - g.y) > DIVERGED_M) {
        o.diverged = true;
        this.stats.diverged++;
      } else if (!o.g && dist(o.x - g.x, o.y - g.y) < HANDOVER_M) o.serverId = -2; // handed over: the server's is drawn
    }
    for (let k = this.own.length - 1; k >= 0; k--) {
      const o = this.own[k]!;
      const gone = o.serverId === -2 || (o.serverId >= 0 && !now.has(o.serverId)) || (o.serverId === -1 && at > o.tick + UNMATCHED_TICKS);
      if (!gone) continue;
      if (o.serverId === -1) this.stats.unmatched++;
      this.drop(k);
    }
    this.serverOwn = now;
  }

  /**
   * What to draw: the snapshot's grenades, but ours instead of the server's copies we predicted.
   * `snapshot`: the newest (2D view: grenades as of the newest snapshot).
   */
  views(snapshot: SnapshotMsg | null): GrenadeView[] {
    const out: GrenadeView[] = [];
    if (snapshot) {
      for (const g of snapshot.grenades) {
        if (this.predicts(g.id)) continue;
        out.push({ key: `s${g.id}`, id: g.id, owner: g.owner, x: g.x, y: g.y, vx: g.vx, vy: g.vy, fuse: g.fuse, type: g.type, state: g.state });
      }
    }
    for (const o of this.own) if (!o.diverged) out.push(this.view(o));
    return out;
  }

  /** Our predicted grenades only (a view that draws the others on its own timeline). */
  ownViews(): GrenadeView[] {
    const out: GrenadeView[] = [];
    for (const o of this.own) if (!o.diverged) out.push(this.view(o));
    return out;
  }

  /** Whether the server's grenade `id` (one of ours) is drawn as our prediction instead. */
  predicts(id: number): boolean {
    for (const o of this.own) if (o.serverId === id && !o.diverged) return true;
    return false;
  }

  get count(): number {
    return this.own.length;
  }

  private view(o: Own): GrenadeView {
    return { key: `p${o.n}`, id: OWN_ID_BASE + (o.n % 1000), owner: o.owner, x: o.x, y: o.y, vx: o.vx, vy: o.vy, fuse: o.fuse, type: o.type, state: o.state };
  }

  private add(tick: number, src: GrenadeState): void {
    if (this.own.length >= MAX_OWN) this.drop(0);
    const g = this.fx.allocGrenade();
    if (!g) return;
    g.alive = true;
    g.owner = src.owner;
    g.type = src.type;
    g.state = src.state;
    g.x = src.x;
    g.y = src.y;
    g.vx = src.vx;
    g.vy = src.vy;
    g.fuse = src.fuse;
    g.hp = src.hp;
    g.born = src.born;
    g.weapon = src.weapon;
    g.hits = src.hits;
    const o: Own = {
      n: this.next++,
      owner: src.owner,
      tick,
      type: src.type,
      g,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      fuse: 0,
      state: 0,
      serverId: -1,
      diverged: false,
      ht: new Float64Array(HISTORY).fill(-1),
      hx: new Float64Array(HISTORY),
      hy: new Float64Array(HISTORY),
    };
    this.own.push(o);
    this.stats.predicted++;
    this.record(o, tick);
  }

  private stepTo(tick: number): void {
    if (this.stepped < 0 || tick - this.stepped > HISTORY) this.stepped = tick - 1;
    while (this.stepped < tick) {
      const t = ++this.stepped;
      this.fx.tick = t;
      this.fx.events.length = 0;
      for (const o of this.own) {
        if (!o.g) continue;
        stepGrenade(this.fx, o.g);
        this.record(o, t);
      }
      // what blew up left clouds and blasts in the fx world: nothing there needs them
      for (const c of this.fx.clouds) c.alive = false;
    }
  }

  /** Our copy's state after `tick`; it settles when it ends or (a mine) lands. */
  private record(o: Own, tick: number): void {
    const g = o.g;
    if (!g) return;
    const i = tick & (HISTORY - 1);
    if (g.alive) {
      o.x = g.x;
      o.y = g.y;
      o.vx = g.vx;
      o.vy = g.vy;
      o.fuse = g.fuse;
      o.state = g.state;
      o.ht[i] = tick;
      o.hx[i] = g.x;
      o.hy[i] = g.y;
    }
    const mine = grenadeDefs[g.type]?.effect === 'mine';
    if (!g.alive || (mine && g.state !== MineState.Flying)) {
      // settled where it is: drawn there until the server's copy gets there (or is gone)
      g.alive = false;
      o.g = null;
      o.vx = o.vy = 0;
    }
  }

  private drop(k: number): void {
    const o = this.own[k]!;
    if (o.g) o.g.alive = false;
    this.own.splice(k, 1);
  }
}
