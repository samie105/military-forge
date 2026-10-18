/**
 * Online play in 3D (docs/05 §10; w6-netcode-interfaces.md, "Lag compensation").
 *
 * Remote players are drawn ONLY at `net.remotePose(id, tick, out)`, with `tick` from
 * `net.remoteRenderTick(now)` taken once per drawn frame. The next INPUT reports that tick, and the
 * server rewinds its targets with the same interpolation, so a hit lands on what this view showed.
 * Nothing is smoothed or extrapolated on top. The local player stays as predicted (the Frame's).
 *
 * The rest of the snapshot world rides on the same timeline:
 * - grenades are interpolated between the snapshots around the render tick;
 * - remote shots, dashes and blasts wait until the render tick reaches the snapshot that brought
 *   them, so a tracer leaves the remote gun where that gun is drawn, a dash kicks off where that
 *   player is, and a blast goes off where its grenade is.
 * Own shots and dashes come from prediction and play at once.
 */
import { DT, type SimEvent } from '@military-forge/sim';
import { bracketSnapshots, lerpPosition, type RemotePose, type SnapshotBracket } from '@military-forge/netcode';
import type { SnapshotMsg } from '@military-forge/protocol';
import type { Frame, GrenadeView, PlayerView } from '../view';
import type { GrenadeSample } from './grenadeTracker';

/** What the 3D view needs from NetClient (tests pass a fake). */
export interface RemoteView {
  readonly myId: number;
  /** received snapshots, oldest first */
  readonly snapshots: readonly { msg: SnapshotMsg }[];
  remoteRenderTick(now?: number): number;
  remotePose(id: number, renderTick: number, out: RemotePose): RemotePose | null;
}

/** A grenade on the remote timeline (the snapshot's id, velocity and type ride along). */
type TimelineGrenade = GrenadeView & GrenadeSample;

/** events held for the render tick: at most this many */
const HELD_MAX = 512;
/**
 * Held events more than this far behind the render tick are dropped, not played: the view stopped
 * drawing for a while (a hidden tab), and a burst of stale tracers and blasts on return helps no one.
 */
const STALE_TICKS = 30;

type SnapshotGrenade = SnapshotMsg['grenades'][number];

/**
 * The grenade `id` in `list` with between `minFuse` and `maxFuse` ticks left: a grenade's fuse only
 * goes down, so a reused id with a fresher fuse is another grenade.
 */
function byId(list: readonly SnapshotGrenade[], id: number, minFuse: number, maxFuse = Infinity): SnapshotGrenade | null {
  for (const g of list) if (g.id === id && g.fuse >= minFuse && g.fuse <= maxFuse) return g;
  return null;
}

export class OnlineView {
  /** the render tick of the last frame (remoteRenderTick) */
  tick = 0;
  private readonly out: Frame = { tick: 0, localId: -1, players: [], grenades: [] };
  /** the out frame's own lists (the rest of its fields are the input frame's) */
  private readonly players: PlayerView[] = [];
  private readonly timeline: TimelineGrenade[] = [];
  /** pooled copies of remote players, positioned at remotePose */
  private readonly remote: PlayerView[] = [];
  private readonly grenades: TimelineGrenade[] = [];
  private readonly pose: RemotePose = { x: 0, y: 0, src: null! };
  private readonly bracket: SnapshotBracket = { a: null!, b: null!, alpha: 0 };
  private readonly lerped = { x: 0, y: 0 };
  /** held events and the snapshot tick each waits for, oldest first */
  private readonly held: SimEvent[] = [];
  private readonly heldTick: number[] = [];
  private readonly batch: SimEvent[] = [];

  constructor(readonly net: RemoteView) {}

  /**
   * This frame's picture: everything the input frame carries (the map event, pickups, smoke and
   * gas, net stats…), with the local player as predicted, remote players at remotePose on this
   * frame's render tick and grenades on the same timeline. Clouds stay on the newest snapshot, the
   * one that decides who smoke hides. Reuses its arrays (no allocation per frame once warm).
   */
  frame(input: Frame, now: number): Frame {
    const net = this.net;
    const tick = (this.tick = net.remoteRenderTick(now));
    const out = this.out as unknown as Record<string, unknown>;
    // a field the input dropped this frame goes too (undefined reads as absent)
    for (const k in out) if (!(k in input)) out[k] = undefined;
    Object.assign(out, input);
    const players = (out.players = this.players);
    out.grenades = this.timeline;
    players.length = 0;
    let r = 0;
    for (const p of input.players) {
      if (p.isLocal || p.id === net.myId) {
        players.push(p);
        continue;
      }
      const pose = net.remotePose(p.id, tick, this.pose);
      if (!pose) continue; // no snapshot has it (yet): not drawn
      const q = (this.remote[r] ??= { ...p });
      r++;
      Object.assign(q, p);
      q.x = pose.x;
      q.y = pose.y;
      players.push(q);
    }
    this.timelineGrenades(tick, this.timeline);
    return this.out;
  }

  /** Grenades between the snapshots around `tick`: by id, interpolated; thrown or gone in between, carried by their velocity. */
  private timelineGrenades(tick: number, out: TimelineGrenade[]): void {
    out.length = 0;
    const br = bracketSnapshots(this.net.snapshots, tick, this.bracket);
    if (!br) return;
    const { a, b, alpha } = br;
    let n = 0;
    for (const gb of b.grenades) {
      const ga = a === b ? gb : byId(a.grenades, gb.id, gb.fuse);
      const g = this.grenade(n++, gb);
      if (ga) {
        lerpPosition(ga.x, ga.y, gb.x, gb.y, alpha, this.lerped);
        g.x = this.lerped.x;
        g.y = this.lerped.y;
        g.fuse = Math.round(ga.fuse + (gb.fuse - ga.fuse) * alpha);
      } else {
        // thrown since a: back along its path to the render tick
        const back = Math.max(0, b.serverTick - tick) * DT;
        g.x = gb.x - gb.vx * back;
        g.y = gb.y - gb.vy * back;
        g.fuse = gb.fuse + Math.round(back / DT);
      }
      out.push(g);
    }
    if (a !== b && alpha < 1) {
      // in a but not in b: it went off (its blast waits for b's tick) or left the view; carry it on
      for (const ga of a.grenades) {
        if (byId(b.grenades, ga.id, -1, ga.fuse)) continue;
        const g = this.grenade(n++, ga);
        const ahead = Math.max(0, tick - a.serverTick) * DT;
        g.x = ga.x + ga.vx * ahead;
        g.y = ga.y + ga.vy * ahead;
        g.fuse = Math.max(1, ga.fuse - Math.round(ahead / DT));
        out.push(g);
      }
    }
  }

  private grenade(i: number, src: SnapshotGrenade): TimelineGrenade {
    const g = (this.grenades[i] ??= { id: 0, x: 0, y: 0, vx: 0, vy: 0, fuse: 0 });
    g.id = src.id;
    g.vx = src.vx;
    g.vy = src.vy;
    g.type = src.type;
    g.state = src.state; // a mine's light: flying, arming, armed, triggered
    return g;
  }

  /**
   * Sim events from OnlineMode. Own shots and dashes (predicted) go to `emit` now; remote shots,
   * ricochets, dashes and blasts wait for the render tick to reach the snapshot that brought them
   * (release). Others pass straight on.
   */
  hold(events: readonly SimEvent[], localId: number, emit: (events: readonly SimEvent[]) => void): void {
    const snaps = this.net.snapshots;
    const at = snaps.length ? snaps[snaps.length - 1]!.msg.serverTick : 0;
    const now = this.batch;
    now.length = 0;
    for (const e of events) {
      const timeline =
        ((e.type === 'shot' || e.type === 'ricochet') && e.shooter !== localId) || (e.type === 'dash' && e.player !== localId) || e.type === 'explosion';
      if (timeline && this.held.length < HELD_MAX) {
        this.held.push(e);
        this.heldTick.push(at);
      } else if (!timeline) now.push(e);
    }
    if (now.length) emit(now);
  }

  /**
   * Hands on the held events whose snapshot the render tick has reached, one batch per snapshot;
   * ones half a second stale are dropped.
   */
  release(emit: (events: readonly SimEvent[]) => void): void {
    let i = 0;
    while (i < this.held.length && this.heldTick[i]! <= this.tick) {
      const at = this.heldTick[i]!;
      const batch = this.batch;
      batch.length = 0;
      while (i < this.held.length && this.heldTick[i] === at) batch.push(this.held[i++]!);
      if (this.tick - at <= STALE_TICKS) emit(batch);
    }
    if (i > 0) {
      this.held.splice(0, i);
      this.heldTick.splice(0, i);
    }
  }

  /** events waiting for the render tick */
  get pending(): number {
    return this.held.length;
  }
}
