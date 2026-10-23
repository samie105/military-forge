import { getMap } from '@military-forge/content';
import { SpectateMode, SpectateQueue, type SpectateMsg } from '@military-forge/protocol';
import { describe, expect, it } from 'vitest';
import { MOVE_ON_AFTER_S, NO_ACTIONS, SpectateDirector, type SpectateActions } from '../../src/spectate/director';
import type { Frame, PlayerView } from '../../src/view';

const map = getMap('movement-test');
const cam = { x: 20, y: 6, viewWidth: 36 };

function player(id: number, x: number, alive = true, extra: Partial<PlayerView> = {}): PlayerView {
  return { id, name: `P${id}`, isBot: false, isLocal: false, alive, x, y: 3, vx: 0, vy: 0, grounded: true, crouched: false, jetting: false, aim: 0, hp: alive ? 80 : 0, fuel: 0, fuelRegenDelay: 0, frags: 0, active: 0, dual: false, weapons: [{ def: 0, mag: 0, reserve: 0, reloadTicks: 0 }], kills: id, deaths: 0, ...extra } as PlayerView;
}
const frame = (players: PlayerView[], localId = -1): Frame => ({ tick: 1, localId, players, grenades: [] });
const state = (m: Partial<SpectateMsg>): SpectateMsg => ({ type: 0x2d as SpectateMsg['type'], mode: SpectateMode.Spectator, follow: -1, queue: SpectateQueue.Watching, delayTicks: 180, slots: 0, spectators: [], ...m });
const act = (a: Partial<SpectateActions>): SpectateActions => ({ ...NO_ACTIONS, ...a });

function link() {
  const calls: (string | number | boolean)[][] = [];
  return { calls, follow: (id: number) => calls.push(['follow', id]), play: (w: 'now' | 'next' | false) => calls.push(['play', w]) };
}

describe('spectate director', () => {
  it('cycles through the living by id, both ways, wrapping', () => {
    const ps = [player(4, 0), player(1, 0), player(7, 0, false), player(2, 0)];
    expect(SpectateDirector.cycle(ps, 1, 1)).toBe(2);
    expect(SpectateDirector.cycle(ps, 4, 1)).toBe(1);
    expect(SpectateDirector.cycle(ps, 1, -1)).toBe(4);
    expect(SpectateDirector.cycle(ps, -1, 1)).toBe(1);
    expect(SpectateDirector.cycle(ps, 2, 1, 4)).toBe(1); // never yourself
    expect(SpectateDirector.cycle([player(3, 0, false)], -1, 1)).toBe(3); // nobody alive: the dead
    expect(SpectateDirector.cycle([], -1, 1)).toBe(-1);
  });

  it('watching: follows someone at once, moves on when they stay down, tells the room', () => {
    const d = new SpectateDirector();
    const l = link();
    const room = { spectating: true, state: state({}), delay: 3 };
    const ps = [player(0, 10), player(1, 30)];
    const v = d.update(frame(ps), room, l, NO_ACTIONS, 0.016, map, cam)!;
    expect(v).toMatchObject({ kind: 'watch', followId: 0, x: 10, free: false, delay: 3, name: 'P0' });
    expect(l.calls).toEqual([['follow', 0]]);
    ps[0] = player(0, 10, false);
    for (let t = 0; t < MOVE_ON_AFTER_S / 0.1 - 2; t++) d.update(frame(ps), room, l, NO_ACTIONS, 0.1, map, cam);
    expect(d.followId).toBe(0); // a moment down: still on them
    d.update(frame(ps), room, l, NO_ACTIONS, 0.3, map, cam);
    expect(d.followId).toBe(1);
    expect(d.update(frame(ps), room, l, act({ prev: true }), 0.016, map, cam)!.followId).toBe(1); // the only one alive
  });

  it('watching: the free camera pans (keys, drags) inside the map and zooms; a click on a soldier follows them', () => {
    const d = new SpectateDirector();
    const l = link();
    const room = { spectating: true, state: state({}), delay: 3 };
    const ps = [player(0, 10), player(1, 30)];
    d.update(frame(ps), room, l, NO_ACTIONS, 0.016, map, cam);
    let v = d.update(frame(ps), room, l, act({ toggleFree: true }), 0.016, map, cam)!;
    expect(v.free).toBe(true);
    expect(v.followId).toBe(-1);
    expect(v.zoom).toBe(6);
    const x0 = v.x;
    v = d.update(frame(ps), room, l, act({ panX: 1, dragX: 2 }), 0.5, map, cam)!;
    expect(v.x).toBeGreaterThan(x0 + 2);
    v = d.update(frame(ps), room, l, act({ panX: -1 }), 100, map, cam)!;
    expect(v.x).toBe(map.bounds.minX);
    v = d.update(frame(ps), room, l, act({ zoom: -2 }), 0.016, map, cam)!;
    expect(v.zoom).toBe(4);
    v = d.update(frame(ps), room, l, act({ pick: { x: 30.5, y: 4 } }), 0.016, map, cam)!;
    expect(v).toMatchObject({ free: false, followId: 1, x: 30 });
    v = d.update(frame(ps), room, l, act({ followId: 0 }), 0.016, map, cam)!;
    expect(v.followId).toBe(0);
  });

  it('Join: "now" while a slot is free, "next" otherwise, and a second press leaves the queue', () => {
    const d = new SpectateDirector();
    const l = link();
    const ps = [player(0, 10)];
    d.update(frame(ps), { spectating: true, state: state({ slots: 2 }), delay: 3 }, l, act({ join: true }), 0.016, map, cam);
    d.update(frame(ps), { spectating: true, state: state({ slots: 0 }), delay: 3 }, l, act({ join: true }), 0.016, map, cam);
    d.update(frame(ps), { spectating: true, state: state({ queue: SpectateQueue.Next }), delay: 3 }, l, act({ join: true }), 0.016, map, cam);
    expect(l.calls.filter((c) => c[0] === 'play')).toEqual([
      ['play', 'now'],
      ['play', 'next'],
      ['play', false],
    ]);
  });

  it('the death cam: the camera goes where the room says; prev / next ask the room; alive again: off', () => {
    const d = new SpectateDirector();
    const l = link();
    const me = player(5, 2, false, { isLocal: true });
    const ps = [me, player(1, 40), player(2, 60)];
    const room = (follow: number) => ({ spectating: false, state: state({ mode: SpectateMode.Dead, follow }), delay: 0 });
    let v = d.update(frame(ps, 5), room(1), l, NO_ACTIONS, 0.016, map, cam)!;
    expect(v).toMatchObject({ kind: 'death', followId: 1, x: 40, free: false, zoom: 0, delay: 0 });
    v = d.update(frame(ps, 5), room(1), l, act({ next: true, toggleFree: true }), 0.016, map, cam)!;
    expect(l.calls).toEqual([['follow', 2]]);
    expect(v.followId).toBe(1); // until the room says so
    expect(v.free).toBe(false); // no free camera on the death cam
    expect(d.update(frame(ps, 5), room(2), l, NO_ACTIONS, 0.016, map, cam)!.x).toBe(60);
    // nobody to follow (the room says -1): our own body
    expect(d.update(frame(ps, 5), room(-1), l, NO_ACTIONS, 0.016, map, cam)!.x).toBe(2);
    ps[0] = player(5, 2, true, { isLocal: true });
    expect(d.update(frame(ps, 5), room(-1), l, NO_ACTIONS, 0.016, map, cam)).toBeNull();
    // a v19 server never says Dead: no death cam
    expect(d.update(frame([player(5, 2, false)], 5), { spectating: false, state: null, delay: 0 }, l, NO_ACTIONS, 0.016, map, cam)).toBeNull();
  });
});
