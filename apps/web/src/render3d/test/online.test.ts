import type { RemotePose } from '@military-forge/netcode';
import type { SnapshotMsg } from '@military-forge/protocol';
import type { SimEvent } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../../view';
import { OnlineView, type RemoteView } from '../online';
import { playerView } from './helpers';

type Grenade = SnapshotMsg['grenades'][number];
const snap = (serverTick: number, grenades: Grenade[] = []) => ({ msg: { serverTick, grenades, players: [] } as unknown as SnapshotMsg });
const gren = (id: number, x: number, fuse: number, over: Partial<Grenade> = {}): Grenade => ({ id, owner: 1, x, y: 3, vx: 6, vy: 0, fuse, type: 0, state: 0, ...over }) as Grenade;

/** A NetClient stand-in: remotePose puts player `id` at (id × 10 + tick / 100, 1) and counts the calls. */
function fakeNet(snapshots: { msg: SnapshotMsg }[], renderTick: number): RemoteView & { tickCalls: number; poseCalls: [number, number][] } {
  return {
    myId: 0,
    snapshots,
    tickCalls: 0,
    poseCalls: [],
    remoteRenderTick() {
      this.tickCalls++;
      return renderTick;
    },
    remotePose(id: number, tick: number, out: RemotePose) {
      this.poseCalls.push([id, tick]);
      if (id === 9) return null; // nothing in the snapshots for this one
      out.x = id * 10 + tick / 100;
      out.y = 1;
      return out;
    },
  };
}

const frame = (over: Partial<Frame> = {}): Frame => ({
  tick: 500,
  localId: 0,
  players: [playerView({ id: 0, isLocal: true, x: 2, y: 0 }), playerView({ id: 3, isLocal: false, x: 99, y: 99 }), playerView({ id: 9, isLocal: false })],
  grenades: [],
  ...over,
});

describe('OnlineView: remote players only through remoteRenderTick + remotePose', () => {
  it('draws remote players exactly where remotePose puts them at this frame’s render tick', () => {
    const net = fakeNet([snap(100), snap(102)], 101.5);
    const view = new OnlineView(net);
    const f = view.frame(frame(), 1000);
    expect(net.tickCalls).toBe(1); // once per drawn frame
    expect(net.poseCalls).toEqual([
      [3, 101.5],
      [9, 101.5],
    ]);
    const p3 = f.players.find((p) => p.id === 3)!;
    expect([p3.x, p3.y]).toEqual([30 + 101.5 / 100, 1]); // not the Frame's 99, 99: no smoothing on top
    expect(f.players.some((p) => p.id === 9)).toBe(false); // no pose: not drawn
    const me = f.players.find((p) => p.id === 0)!;
    expect([me.x, me.y]).toEqual([2, 0]); // the local player as predicted
    expect(view.tick).toBe(101.5);
  });

  it('keeps everything else the frame carries: the map event, pickups, smoke and gas', () => {
    const view = new OnlineView(fakeNet([snap(100), snap(102)], 101));
    const mapEvent = { id: 'fog', phase: 'active', zones: [] } as unknown as NonNullable<Frame['mapEvent']>;
    const pickups = [{ id: 1, def: 0, x: 5, y: 0 }];
    const clouds = [{ id: 2, type: 1, x: 8, y: 1, radius: 3, density: 1, opaque: 2.5, age: 1 }];
    const f = view.frame(frame({ mapEvent, pickups, clouds }), 0);
    expect(f.mapEvent).toBe(mapEvent);
    expect(f.pickups).toBe(pickups);
    expect(f.clouds).toBe(clouds);
    // the next frame without clouds has none (nothing stale carried over)
    const g = view.frame(frame({ mapEvent, pickups }), 1);
    expect(g.clouds).toBeUndefined();
    expect(g.pickups).toBe(pickups);
  });

  it('allocates nothing per frame once warm: the same frame and player objects come back', () => {
    const view = new OnlineView(fakeNet([snap(100), snap(102)], 101));
    const a = view.frame(frame(), 1);
    const p = a.players.find((q) => q.id === 3);
    const b = view.frame(frame(), 2);
    expect(b).toBe(a);
    expect(b.players.find((q) => q.id === 3)).toBe(p);
  });
});

describe('OnlineView: grenades on the remote timeline', () => {
  it('interpolates a grenade by id between the snapshots around the render tick', () => {
    const view = new OnlineView(fakeNet([snap(100, [gren(4, 10, 60)]), snap(102, [gren(4, 11, 58)])], 101.5));
    const g = view.frame(frame(), 0).grenades as (Frame['grenades'][number] & { id?: number })[];
    expect(g.length).toBe(1);
    expect(g[0]!.id).toBe(4);
    expect(g[0]!.x).toBeCloseTo(10.75);
    expect(g[0]!.fuse).toBe(59);
  });

  it('a grenade thrown since the older snapshot comes back along its path; one gone since it carries on', () => {
    const view = new OnlineView(fakeNet([snap(100, [gren(1, 20, 30)]), snap(102, [gren(2, 5, 95)])], 101));
    const g = view.frame(frame(), 0).grenades as (Frame['grenades'][number] & { id?: number })[];
    const thrown = g.find((x) => x.id === 2)!;
    expect(thrown.x).toBeCloseTo(5 - 6 / 60); // one tick back at 6 m/s
    const gone = g.find((x) => x.id === 1)!;
    expect(gone.x).toBeCloseTo(20 + 6 / 60); // one tick on: its blast waits for tick 102
  });

  it('carries each grenade’s type and a mine’s state (its light)', () => {
    const view = new OnlineView(fakeNet([snap(100, [gren(4, 10, 60, { type: 4, state: 2 })]), snap(102, [gren(4, 10, 58, { type: 4, state: 2 })])], 101));
    const g = view.frame(frame(), 0).grenades[0]!;
    expect([g.type, g.state]).toEqual([4, 2]);
  });

  it('a reused id with a fresh fuse is a different grenade', () => {
    const view = new OnlineView(fakeNet([snap(100, [gren(7, 20, 3)]), snap(102, [gren(7, 2, 95)])], 101));
    const g = view.frame(frame(), 0).grenades;
    expect(g.length).toBe(2);
  });
});

describe('OnlineView: events on the remote timeline', () => {
  const shot = (shooter: number): SimEvent => ({ type: 'shot', shooter, weapon: 0, ox: 0, oy: 1, ex: 9, ey: 1, hit: 0, target: -1, zone: 0 });
  const blast: SimEvent = { type: 'explosion', x: 5, y: 1, radius: 4, owner: 2 };

  it('plays own shots at once; holds remote shots and blasts until the render tick reaches their snapshot', () => {
    const snaps = [snap(100), snap(104)];
    const net = fakeNet(snaps, 101);
    const view = new OnlineView(net);
    const emitted: SimEvent[][] = [];
    const emit = (e: readonly SimEvent[]) => emitted.push([...e]);
    view.hold([shot(0)], 0, emit); // ours, from prediction
    expect(emitted).toEqual([[shot(0)]]);
    view.hold([shot(5), shot(5), blast, { type: 'death', victim: 3, killer: 5, source: 0 }], 0, emit); // snapshot 104's
    expect(emitted.length).toBe(2); // the death passes straight on
    expect(view.pending).toBe(3);
    view.frame(frame(), 0); // render tick 101
    view.release(emit);
    expect(view.pending).toBe(3);
    (net as { remoteRenderTick: () => number }).remoteRenderTick = () => 104;
    view.frame(frame(), 0);
    view.release(emit);
    expect(view.pending).toBe(0);
    expect(emitted[2]).toEqual([shot(5), shot(5), blast]); // one batch: a shotgun's pellets stay together
  });

  it('a remote dash kicks off on the remote timeline; our own at once', () => {
    const snaps = [snap(100), snap(104)];
    const net = fakeNet(snaps, 101);
    const view = new OnlineView(net);
    const emitted: SimEvent[][] = [];
    const emit = (e: readonly SimEvent[]) => emitted.push([...e]);
    const dash = (player: number): SimEvent => ({ type: 'dash', player, x: 4, y: 0, dir: 0 });
    view.hold([dash(0), dash(5)], 0, emit);
    expect(emitted).toEqual([[dash(0)]]);
    expect(view.pending).toBe(1);
    (net as { remoteRenderTick: () => number }).remoteRenderTick = () => 104;
    view.frame(frame(), 0);
    view.release(emit);
    expect(emitted[1]).toEqual([dash(5)]);
  });

  it('a remote ricochet waits for the render tick like the shot it came from', () => {
    const net = fakeNet([snap(100), snap(104)], 101);
    const view = new OnlineView(net);
    const emitted: SimEvent[][] = [];
    const bounce = (shooter: number): SimEvent => ({ type: 'ricochet', shooter, owner: 2, weapon: 0, x: 3, y: 1, nx: -1, ny: 0, ex: 0, ey: 2, hit: 0, target: -1, zone: 0 });
    view.hold([bounce(0), bounce(5)], 0, (e) => emitted.push([...e]));
    expect(emitted).toEqual([[bounce(0)]]);
    expect(view.pending).toBe(1);
  });

  it('releases one batch per snapshot, oldest first', () => {
    const snaps = [snap(100)];
    const net = fakeNet(snaps, 103);
    const view = new OnlineView(net);
    const emitted: SimEvent[][] = [];
    view.hold([shot(3)], 0, () => {});
    snaps.push(snap(102));
    view.hold([shot(4)], 0, () => {});
    view.frame(frame(), 0);
    view.release((e) => emitted.push([...e]));
    expect(emitted.map((b) => (b[0] as { shooter: number }).shooter)).toEqual([3, 4]);
  });
});

describe('OnlineView after a pause', () => {
  it('drops held events half a second stale instead of firing them all at once (a hidden tab)', () => {
    const snaps = [snap(100)];
    const net = fakeNet(snaps, 100);
    const view = new OnlineView(net);
    view.hold([{ type: 'explosion', x: 1, y: 1, radius: 4, owner: 2 }], 0, () => {});
    (net as { remoteRenderTick: () => number }).remoteRenderTick = () => 100 + 31;
    view.frame(frame(), 0);
    const emitted: SimEvent[][] = [];
    view.release((e) => emitted.push([...e]));
    expect(emitted).toEqual([]);
    expect(view.pending).toBe(0);
  });
});
