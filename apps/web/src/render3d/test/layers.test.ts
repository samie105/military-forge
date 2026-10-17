import { movementTestMap } from '@military-forge/content';
import { Box3 } from 'three';
import { describe, expect, it } from 'vitest';
import { FORE_FADED, buildDepthLayers, coversPlayer, hash01, projectToPlane, updateForeground, type Rect } from '../layers';
import { lightingFor } from '../lighting';
import { playerView } from './helpers';

describe('depth layers', () => {
  it('lays the dressing out from a hash, identically on every build', () => {
    expect(hash01(7, 3)).toBe(hash01(7, 3));
    const values = Array.from({ length: 1000 }, (_, i) => hash01(i, 1));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const a = buildDepthLayers(movementTestMap, lightingFor('movement-test'));
    const b = buildDepthLayers(movementTestMap, lightingFor('movement-test'));
    expect(a.foreground.map((f) => f.bounds)).toEqual(b.foreground.map((f) => f.bounds));
    expect(a.foreground.length).toBeGreaterThan(5);
  });

  it('keeps the background behind the gameplay band and the foreground in front of it', () => {
    const layers = buildDepthLayers(movementTestMap, lightingFor('movement-test'));
    layers.background.updateMatrixWorld(true);
    expect(layers.background.children).toHaveLength(4); // sky, far, ground, mid
    for (const layer of layers.background.children) expect(new Box3().setFromObject(layer).max.z).toBeLessThanOrEqual(-1 + 1e-9);
    for (const f of layers.foreground) expect(f.z).toBeGreaterThan(1);
  });

  it('projects a foreground rectangle onto the plane the way the camera sees it', () => {
    const r: Rect = { x0: 10, y0: 0, x1: 12, y1: 1 };
    expect(projectToPlane(r, 0, 0, 0, 30, { x0: 0, y0: 0, x1: 0, y1: 0 })).toEqual(r);
    const p = projectToPlane(r, 3, 0, 0, 30, { x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(p.x0).toBeCloseTo(10 * (30 / 27), 9); // nearer the camera: further from the centre on screen
    expect(p.x1).toBeCloseTo(12 * (30 / 27), 9);
  });

  it('dither-fades a foreground prop only while it covers a living player', () => {
    const r: Rect = { x0: 10, y0: -8, x1: 12, y1: 1 };
    expect(coversPlayer(r, [playerView({ x: 11 })])).toBe(true);
    expect(coversPlayer(r, [playerView({ x: 11, alive: false })])).toBe(false);
    expect(coversPlayer(r, [playerView({ x: 13 })])).toBe(false);
    expect(coversPlayer(r, [playerView({ x: 11, y: 5 })])).toBe(false);

    const layers = buildDepthLayers(movementTestMap, lightingFor('movement-test'));
    const prop = layers.foreground[0]!;
    const behind = playerView({ x: (prop.bounds.x0 + prop.bounds.x1) / 2 });
    const cam = { x: behind.x, y: 5, z: 32 };
    for (let i = 0; i < 30; i++) updateForeground(layers.foreground, [behind], cam, 1 / 60);
    expect(prop.opacity).toBeCloseTo(FORE_FADED, 2);
    expect(layers.foreground[layers.foreground.length - 1]!.opacity).toBe(1);
    for (let i = 0; i < 30; i++) updateForeground(layers.foreground, [], cam, 1 / 60);
    expect(prop.material.opacity).toBeGreaterThan(0.98);
  });
});
