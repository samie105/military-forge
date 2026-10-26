import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerView } from '../../view';
import { SoldierRoster } from '../roster';
import { playerView } from './helpers';

/** A soldier stand-in: who it was built for, where it was last drawn, and whether it was freed. */
class Soldier {
  x = 0;
  disposed = false;
  constructor(readonly builtFor: number) {}
  dispose(): void {
    this.disposed = true;
  }
}

/** A roster whose builds wait until the test resolves them; the "scene" is a set, like Renderer3D's. */
function harness() {
  const scene = new Set<Soldier>();
  const builds: { id: number; resolve: (s: Soldier) => void; reject: (e: unknown) => void }[] = [];
  const roster = new SoldierRoster<Soldier>({
    build: (id) =>
      new Promise<Soldier>((resolve, reject) => {
        builds.push({ id, resolve, reject });
      }),
    attach: (_id, s) => scene.add(s),
    detach: (_id, s) => {
      scene.delete(s);
      s.dispose();
    },
    failed: () => {},
  });
  const draw = (players: readonly PlayerView[]) => roster.sync(players, (s, p) => (s.x = p.x));
  /** lands build i (the soldier it was asked for) */
  const land = async (i: number) => {
    builds[i]!.resolve(new Soldier(builds[i]!.id));
    await Promise.resolve();
    await Promise.resolve();
  };
  return { roster, scene, builds, draw, land };
}

/** Every soldier in the scene is some player's drawn soldier, and each player's soldier was built for that player. */
function consistent(roster: SoldierRoster<Soldier>, scene: Set<Soldier>): void {
  expect([...scene].sort((a, b) => a.builtFor - b.builtFor)).toEqual([...roster.live.values()].sort((a, b) => a.builtFor - b.builtFor));
  for (const [id, s] of roster.live) expect(s.builtFor).toBe(id);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SoldierRoster: which soldier is drawn for which player', () => {
  it('pooled views reshuffled every frame, builds landing in any order: every player ends up with their own soldier', async () => {
    const { roster, scene, builds, draw, land } = harness();
    // online.ts pools its PlayerViews: one object per slot, reassigned every frame
    const pool = Array.from({ length: 6 }, () => playerView({ isLocal: false }));
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    let landed = 0;
    for (let frame = 0; frame < 400; frame++) {
      // who is in view this frame (AOI), in a shuffled order, each in whichever pool slot comes next
      const ids = [0, 1, 2, 3, 4, 5].filter(() => rand() < 0.8).sort(() => rand() - 0.5);
      const views = ids.map((id, i) => Object.assign(pool[i]!, playerView({ id, isLocal: false, x: id * 10 + frame / 1000 })));
      draw(views);
      // some builds land between frames, in any order
      while (landed < builds.length && rand() < 0.3) await land(landed++);
      consistent(roster, scene);
    }
    // everyone in view, a few frames for the last builds to land
    for (let i = 0; i < 4; i++) {
      draw([0, 1, 2, 3, 4, 5].map((id, k) => Object.assign(pool[k]!, playerView({ id, isLocal: false, x: id * 10 }))));
      while (landed < builds.length) await land(landed++);
    }
    draw([0, 1, 2, 3, 4, 5].map((id, k) => Object.assign(pool[k]!, playerView({ id, isLocal: false, x: id * 10 }))));
    consistent(roster, scene);
    expect(roster.pending.size).toBe(0);
    expect(scene.size).toBe(6);
    for (let id = 0; id < 6; id++) expect(roster.get(id)!.x).toBe(id * 10);
  });

  it('the old failure: two players, one pool slot each; a build lands after the slots swap', async () => {
    const { roster, scene, draw, land } = harness();
    const a = playerView({ id: 1, isLocal: false, x: 1 });
    const b = playerView({ id: 2, isLocal: false, x: 2 });
    draw([a, b]);
    await land(0); // player 1 is drawn
    // the slots swap before player 2's soldier arrives
    Object.assign(a, playerView({ id: 2, isLocal: false, x: 2 }));
    Object.assign(b, playerView({ id: 1, isLocal: false, x: 1 }));
    draw([a, b]);
    await land(1);
    draw([a, b]);
    // before the fix: player 1's soldier was replaced (the old one left in the scene, frozen) and player 2
    // stayed pending for ever (never drawn, only its health bar)
    consistent(roster, scene);
    expect(scene.size).toBe(2);
    expect(roster.isPending(2)).toBe(false);
    expect(roster.get(1)!.x).toBe(1);
    expect(roster.get(2)!.x).toBe(2);
  });

  it('a build for a player who left is thrown away when it lands; a return starts a fresh one', async () => {
    const { roster, scene, builds, draw, land } = harness();
    draw([playerView({ id: 5, isLocal: false })]);
    draw([]);
    expect(roster.isPending(5)).toBe(false);
    draw([playerView({ id: 5, isLocal: false })]);
    expect(builds.length).toBe(2);
    await land(0);
    expect(builds[0]!.id).toBe(5);
    expect(scene.size).toBe(0); // the stale one was freed, not drawn
    await land(1);
    expect(scene.size).toBe(1);
    consistent(roster, scene);
  });

  it('clear() frees every soldier and drops the builds in flight', async () => {
    const { roster, scene, draw, land } = harness();
    draw([playerView({ id: 1, isLocal: false }), playerView({ id: 2, isLocal: false })]);
    await land(0);
    roster.clear();
    expect(scene.size).toBe(0);
    await land(1);
    expect(scene.size).toBe(0);
    expect(roster.live.size).toBe(0);
  });

  it('a player who leaves takes their soldier out of the scene', async () => {
    const { roster, scene, draw, land } = harness();
    draw([playerView({ id: 1, isLocal: false }), playerView({ id: 2, isLocal: false })]);
    await land(0);
    await land(1);
    draw([playerView({ id: 2, isLocal: false })]);
    consistent(roster, scene);
    expect([...roster.live.keys()]).toEqual([2]);
  });

  it('a failed build is tried again after a back-off', async () => {
    vi.useFakeTimers();
    const { roster, builds, draw } = harness();
    const p = playerView({ id: 4, isLocal: false });
    draw([p]);
    builds[0]!.reject(new Error('offline'));
    await Promise.resolve();
    await Promise.resolve();
    draw([p]);
    expect(builds.length).toBe(1); // waiting out the back-off
    vi.advanceTimersByTime(1000);
    draw([p]);
    expect(builds.length).toBe(2);
    expect(roster.isPending(4)).toBe(true);
  });
});
