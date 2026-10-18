import { FRAG, movementTestMap } from '@military-forge/content';
import { angleToU16 } from '@military-forge/shared';
import { Game, createInput } from '@military-forge/sim';
import { DataTexture } from 'three';
import { describe, expect, it } from 'vitest';
import { predictThrow, throwArcView } from '../../throwPreview';
import { Cell } from '../vfx/atlas';
import { ThrowArc } from '../vfx/throwArc';

/** A frag's arc from open floor, aimed 35° up at strength 3. */
function arc() {
  const game = new Game({ map: movementTestMap });
  const me = game.addPlayer('P');
  me.x = 118;
  me.y = 0;
  const input = { ...createInput(), aim: angleToU16((35 * Math.PI) / 180) };
  for (let i = 0; i < 30; i++) game.step([input]);
  const view = throwArcView();
  predictThrow(game, me, FRAG, 3, view);
  return view;
}

const tex = new DataTexture(new Uint8Array(4), 1, 1);
const attr = (a: ThrowArc, name: string) => a.layer.mesh.geometry.getAttribute(name).array as Float32Array;
const cells = (a: ThrowArc) => Array.from(attr(a, 'iCell').subarray(0, a.layer.count));

describe('ThrowArc (3D)', () => {
  it('dots the path and rings the landing; nothing without a throw aimed', () => {
    const a = new ThrowArc(tex, [4, 4]);
    a.update(arc(), false, 1 / 60, 40, false);
    expect(a.layer.count).toBeGreaterThan(2 * 8);
    expect(cells(a)).toContain(Cell.Ring);
    expect(cells(a).filter((c) => c === Cell.Dot).length).toBeGreaterThan(16);
    expect(a.layer.mesh.visible).toBe(true);
    a.update(null, false, 1 / 60, 40, false);
    expect(a.layer.count).toBe(0);
    expect(a.layer.mesh.visible).toBe(false);
  });

  it('a burst where it goes off, when its fuse ends inside the preview', () => {
    const a = new ThrowArc(tex, [4, 4]);
    const view = arc();
    a.update(view, false, 1 / 60, 40, false);
    expect(cells(a)).not.toContain(Cell.Star);
    view.detonates = true;
    a.update(view, false, 1 / 60, 40, false);
    expect(cells(a)).toContain(Cell.Star);
  });

  it('keeps its dots a constant size on screen, still under reduced motion, amber during a map event warning', () => {
    const a = new ThrowArc(tex, [4, 4]);
    const view = arc();
    const lastDot = (ppm: number) => {
      a.update(view, false, 1 / 60, ppm, false);
      const axis = attr(a, 'iAxisA');
      const i = a.layer.count - 1; // the last dot's bright core
      return Math.sqrt(axis[3 * i]! ** 2 + axis[3 * i + 1]! ** 2);
    };
    expect(lastDot(20) * 20).toBeCloseTo(lastDot(40) * 40, 5);
    const firstDotX = () => {
      a.update(view, false, 1 / 60, 40, true);
      return attr(a, 'iPos')[3 * 2]; // after the landing ring's two sprites
    };
    expect(firstDotX()).toBe(firstDotX());
    const green = (uncertain: boolean) => {
      a.update(view, uncertain, 1 / 60, 40, true);
      return attr(a, 'iColor')[4 * (a.layer.count - 1) + 1]!; // the last core's green
    };
    expect(green(true)).toBeLessThan(green(false) - 0.2);
  });
});
