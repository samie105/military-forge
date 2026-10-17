import { defaultTuning, movementTestMap } from '@military-forge/content';
import type { SimEvent } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Camera } from '../src/camera';
import { Renderer, type RenderOptions } from '../src/render';
import { playerView } from '../src/render3d/test/helpers';
import type { Frame } from '../src/view';

/** A 2D context that records every fill with the colour it used. */
function recordingCanvas() {
  const fills: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'fill') return () => fills.push(String(target.fillStyle));
      return () => {};
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  const canvas = { getContext: () => ctx, clientWidth: 1280, clientHeight: 720, width: 0, height: 0 } as unknown as HTMLCanvasElement;
  return { canvas, fills };
}

const GRENADE = '#3fb950';
const isBlast = (fill: string) => fill.startsWith('rgba(255,166,87');

function setup() {
  const { canvas, fills } = recordingCanvas();
  const camera = new Camera();
  camera.resize(1280, 720);
  camera.x = 20;
  camera.y = 3;
  const r = new Renderer(canvas, camera, movementTestMap, () => defaultTuning);
  const frame: Frame = { tick: 1, localId: 0, players: [playerView({ x: 18 })], grenades: [{ x: 21, y: 1, fuse: 40 }] };
  const blast: SimEvent = { type: 'explosion', x: 22, y: 0.2, radius: 4, owner: 0 };
  return { r, fills, frame, blast };
}

describe('2D overlay over the 3D view', () => {
  const opts = (over: Partial<RenderOptions>): RenderOptions => ({ showHitboxes: false, showGrid: false, showNet: false, overlay: true, ...over });

  it('leaves grenades and blasts to render3d', () => {
    const { r, fills, frame, blast } = setup();
    r.onEvents([blast], 0);
    r.render(frame, 1 / 60, opts({}), '');
    expect(fills.filter(isBlast)).toEqual([]);
    expect(fills).not.toContain(GRENADE);
  });

  it('draws them again as the debug overlay (hitboxes H or grid B)', () => {
    for (const debug of [{ showHitboxes: true }, { showGrid: true }]) {
      const { r, fills, frame, blast } = setup();
      r.onEvents([blast], 0);
      r.render(frame, 1 / 60, opts(debug), '');
      expect(fills.some(isBlast)).toBe(true);
      expect(fills).toContain(GRENADE);
    }
  });

  it('draws them in the 2D view (?render=2d)', () => {
    const { r, fills, frame, blast } = setup();
    r.onEvents([blast], 0);
    r.render(frame, 1 / 60, opts({ overlay: false }), '');
    expect(fills.some(isBlast)).toBe(true);
    expect(fills).toContain(GRENADE);
  });

  it('a blast hidden by the overlay still ages out: turning H on later shows no stale blast', () => {
    const { r, fills, frame, blast } = setup();
    r.onEvents([blast], 0);
    for (let i = 0; i < 40; i++) r.render(frame, 1 / 60, opts({}), '');
    fills.length = 0;
    r.render(frame, 1 / 60, opts({ showHitboxes: true }), '');
    expect(fills.filter(isBlast)).toEqual([]);
  });

  it('hands every event batch to the 3D view', () => {
    const { r, blast } = setup();
    const got: [readonly SimEvent[], number][] = [];
    r.forwardEvents = (events, localId) => got.push([events, localId]);
    r.onEvents([blast], 3);
    expect(got).toEqual([[[blast], 3]]);
  });
});
