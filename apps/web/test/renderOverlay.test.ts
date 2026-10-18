import { MINE, defaultTuning, movementTestMap } from '@military-forge/content';
import { MineState, type SimEvent } from '@military-forge/sim';
import { describe, expect, it, vi } from 'vitest';
import { Camera } from '../src/camera';
import { Renderer, mineLight, type RenderOptions } from '../src/render';
import { playerView } from '../src/render3d/test/helpers';
import { throwArcView } from '../src/throwPreview';
import type { Frame } from '../src/view';

/** A 2D context that records every fill and stroke with the colour it used. */
function recordingCanvas() {
  const fills: string[] = [];
  const strokes: string[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'fill') return () => fills.push(String(target.fillStyle));
      if (prop === 'stroke') return () => strokes.push(String(target.strokeStyle));
      return () => {};
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  const canvas = { getContext: () => ctx, clientWidth: 1280, clientHeight: 720, width: 0, height: 0 } as unknown as HTMLCanvasElement;
  return { canvas, fills, strokes };
}

const GRENADE = '#3fb950';
const isBlast = (fill: string) => fill.startsWith('rgba(255,166,87');
/** our own tracer's colour */
const isTracer = (stroke: string) => stroke.startsWith('rgba(255,236,150');
/** our own dash band's colour */
const isDash = (stroke: string) => stroke.startsWith('rgba(88,166,255');
/** a ricochet's tracer and its spark fan */
const isRicochet = (stroke: string) => stroke.startsWith('rgba(165,243,252') || stroke.startsWith('rgba(255,244,200');

function setup() {
  const { canvas, fills, strokes } = recordingCanvas();
  const camera = new Camera();
  camera.resize(1280, 720);
  camera.x = 20;
  camera.y = 3;
  const r = new Renderer(canvas, camera, movementTestMap, () => defaultTuning);
  const frame: Frame = { tick: 1, localId: 0, players: [playerView({ x: 18 })], grenades: [{ x: 21, y: 1, fuse: 40 }] };
  const blast: SimEvent = { type: 'explosion', x: 22, y: 0.2, radius: 4, owner: 0 };
  const shot: SimEvent = { type: 'shot', shooter: 0, weapon: 0, ox: 18.5, oy: 1.2, ex: 25, ey: 1.3, hit: 1, target: -1, zone: 0 };
  const dash: SimEvent = { type: 'dash', player: 0, x: 18, y: 0, dir: 0 };
  const bounce: SimEvent = { type: 'ricochet', shooter: 0, owner: 4, weapon: 0, x: 24, y: 1.3, nx: -1, ny: 0, ex: 20, ey: 3, hit: 0, target: -1, zone: 0 };
  return { r, fills, strokes, frame, blast, shot, dash, bounce };
}

describe('2D overlay over the 3D view', () => {
  const opts = (over: Partial<RenderOptions>): RenderOptions => ({ showHitboxes: false, showGrid: false, showNet: false, overlay: true, ...over });

  it('leaves grenades, tracers, ricochets, blasts and dashes to render3d', () => {
    const { r, fills, strokes, frame, blast, shot, dash, bounce } = setup();
    r.onEvents([blast, shot, dash, bounce], 0);
    r.render(frame, 1 / 60, opts({}), '');
    expect(fills.filter(isBlast)).toEqual([]);
    expect(fills).not.toContain(GRENADE);
    expect(strokes.filter(isTracer)).toEqual([]);
    expect(strokes.filter(isDash)).toEqual([]);
    expect(strokes.filter(isRicochet)).toEqual([]);
  });

  it('draws them again as the debug overlay (hitboxes H or grid B)', () => {
    for (const debug of [{ showHitboxes: true }, { showGrid: true }]) {
      const { r, fills, strokes, frame, blast, shot, dash } = setup();
      r.onEvents([blast, shot, dash], 0);
      r.render(frame, 1 / 60, opts(debug), '');
      expect(fills.some(isBlast)).toBe(true);
      expect(fills).toContain(GRENADE);
      expect(strokes.some(isTracer)).toBe(true);
      expect(strokes.some(isDash)).toBe(true);
    }
  });

  it('draws them in the 2D view (?render=2d)', () => {
    const { r, fills, strokes, frame, blast, shot, dash, bounce } = setup();
    r.onEvents([blast, shot, dash, bounce], 0);
    r.render(frame, 1 / 60, opts({ overlay: false }), '');
    expect(fills.some(isBlast)).toBe(true);
    expect(fills).toContain(GRENADE);
    expect(strokes.some(isTracer)).toBe(true);
    expect(strokes.some(isDash)).toBe(true);
    expect(strokes.some(isRicochet)).toBe(true);
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

describe('the throw arc in 2D (review M5)', () => {
  const opts = (over: Partial<RenderOptions>): RenderOptions => ({ showHitboxes: false, showGrid: false, showNet: false, overlay: true, ...over });
  /** a 4 m arc from (19, 1.5), landing halfway */
  function arcFrame(): Frame {
    const view = throwArcView();
    for (let i = 0; i <= 20; i++) {
      view.points[i * 2] = 19 + i * 0.2;
      view.points[i * 2 + 1] = 1.5 + Math.sin((i / 20) * Math.PI);
    }
    view.count = 21;
    view.land = 10;
    return { tick: 1, localId: 0, players: [playerView({ x: 18 })], grenades: [], throwArc: view };
  }
  const isCore = (fill: string) => fill.startsWith('rgba(255,247,209');
  const isRing = (stroke: string) => stroke.startsWith('rgba(255,224,120');

  it('the 2D view draws the dots and the landing ring', () => {
    const { r, fills, strokes } = setup();
    r.render(arcFrame(), 1 / 60, opts({ overlay: false }), '');
    expect(fills.filter(isCore).length).toBeGreaterThan(5);
    expect(strokes.some(isRing)).toBe(true);
  });

  it('over the 3D view it leaves the arc to render3d', () => {
    const { r, fills, strokes } = setup();
    r.render(arcFrame(), 1 / 60, opts({}), '');
    expect(fills.filter(isCore)).toEqual([]);
    expect(strokes.filter(isRing)).toEqual([]);
  });

  it('amber when a map event starts or ends mid-flight', () => {
    const { r, fills } = setup();
    const f = arcFrame();
    f.throwArc!.changes = true;
    r.render(f, 1 / 60, opts({ overlay: false }), '');
    expect(fills.filter(isCore)).toEqual([]);
    expect(fills.some((c) => c.startsWith('rgba(255,168,51'))).toBe(true);
  });
});

describe('flashbang and EMP bursts (review L7)', () => {
  const opts = (over: Partial<RenderOptions>): RenderOptions => ({ showHitboxes: false, showGrid: false, showNet: false, overlay: true, ...over });
  const pop: SimEvent = { type: 'explosion', x: 22, y: 1, radius: 4, owner: 0, grenade: 3 } as SimEvent; // a flashbang
  const ring: SimEvent = { type: 'explosion', x: 22, y: 1, radius: 4, owner: 0, grenade: 5 } as SimEvent; // an EMP
  const isPop = (fill: string) => fill.startsWith('rgba(255,255,255') || fill.startsWith('rgba(120,124,130') || fill.startsWith('rgba(88,166,255');

  it('over the 3D view they are left to render3d (clouds.ts draws the pop and the ring)', () => {
    const { r, fills, frame } = setup();
    r.onEvents([pop, ring], 0);
    r.render(frame, 1 / 60, opts({}), '');
    expect(fills.filter(isPop)).toEqual([]);
  });

  it('the 2D view still draws them', () => {
    const { r, fills, frame } = setup();
    r.onEvents([pop, ring], 0);
    r.render(frame, 1 / 60, opts({ overlay: false }), '');
    expect(fills.some(isPop)).toBe(true);
  });
});

describe('2D mine light: Reduce motion caps it as Reduce flashes does (review low)', () => {
  /** light changes in one second, sampled every millisecond */
  const changes = (state: number, calm: boolean) => {
    let n = 0;
    for (let t = 1; t < 1000; t++) if (mineLight(state, t, calm) !== mineLight(state, t - 1, calm)) n++;
    return n;
  };

  it('armed 4 Hz and triggered 8 Hz, both 3 Hz at most when calm', () => {
    expect(changes(MineState.Armed, false)).toBe(7); // 8 half-periods a second
    expect(changes(MineState.Triggered, false)).toBe(15);
    expect(changes(MineState.Armed, true)).toBeLessThanOrEqual(6);
    expect(changes(MineState.Triggered, true)).toBeLessThanOrEqual(6);
  });

  it('the 2D view blinks calm under Reduce motion', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(150); // 4 Hz: dark by now; 3 Hz: still lit
    try {
      const lit = (reducedMotion: boolean) => {
        const { r, fills } = setup();
        r.reducedMotion = reducedMotion;
        const frame: Frame = { tick: 1, localId: 0, players: [playerView({ x: 18 })], grenades: [{ x: 21, y: 0.1, fuse: 0, type: MINE.index, state: MineState.Armed }] };
        r.render(frame, 1 / 60, { showHitboxes: false, showGrid: false, showNet: false, overlay: false }, '');
        return fills.includes('#f85149');
      };
      expect(lit(false)).toBe(false);
      expect(lit(true)).toBe(true);
    } finally {
      now.mockRestore();
    }
  });
});
