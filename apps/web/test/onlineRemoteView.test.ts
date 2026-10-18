import { HAMMER, K47 } from '@military-forge/content';
import type { SnapshotPlayer } from '@military-forge/protocol';
import { describe, expect, it } from 'vitest';
import { OnlineMode } from '../src/onlineMode';
import type { PlayerView } from '../src/view';

/** A remote player as a snapshot carries it. */
const remote = (over: Partial<SnapshotPlayer> = {}): SnapshotPlayer => ({
  id: 3,
  alive: true,
  isBot: false,
  grounded: true,
  crouched: false,
  jetting: false,
  dual: false,
  reloading: false,
  dashing: false,
  x: 10,
  y: 0,
  vx: 0,
  vy: 0,
  aim: 0,
  hp: 100,
  active: 1,
  weapons: [{ def: K47.index }, { def: HAMMER.index }],
  respawnTicks: 0,
  kills: 0,
  deaths: 0,
  shield: 'none',
  ...over,
});

describe("OnlineMode's view of a remote player", () => {
  // remoteView needs only the names it reads from the net client
  const mode = Object.assign(Object.create(OnlineMode.prototype), { net: { names: new Map<number, string>() } }) as unknown as {
    remoteView(src: SnapshotPlayer, isLocal: boolean, x: number, y: number): PlayerView;
  };

  it('marks the gun in hand reloading while the snapshot says so (a revolver drops its casings then)', () => {
    expect(mode.remoteView(remote(), false, 10, 0).weapons.map((w) => w.reloadTicks)).toEqual([0, 0]);
    expect(mode.remoteView(remote({ reloading: true }), false, 10, 0).weapons.map((w) => w.reloadTicks)).toEqual([0, 1]);
  });
});
