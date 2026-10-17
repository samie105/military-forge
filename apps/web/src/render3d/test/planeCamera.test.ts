import { BASE_VIEW_WIDTH, Camera, ZOOM_MULTIPLIERS } from '../../camera';
import { movementTestMap } from '@military-forge/content';
import { VIEW_MAX_ASPECT } from '@military-forge/netcode';
import { PerspectiveCamera, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { PlaneCamera, applyPlanePose, planePose } from '../planeCamera';

function rig(width: number, height: number, x = 60, y = 8): { cam: PlaneCamera; cam3: PerspectiveCamera } {
  const cam = new PlaneCamera();
  cam.resize(width, height);
  cam.x = x;
  cam.y = y;
  const cam3 = new PerspectiveCamera();
  applyPlanePose(cam3, planePose(cam));
  return { cam, cam3 };
}

function toScreen(cam3: PerspectiveCamera, cam: PlaneCamera, x: number, y: number, z = 0): [number, number] {
  const p = new Vector3(x, y, z).project(cam3);
  return [((p.x + 1) / 2) * cam.width, ((1 - p.y) / 2) * cam.height];
}

describe('PlaneCamera + planePose', () => {
  it('maps the z = 0 gameplay plane exactly like the 2D camera (mouse aim, overlay and HUD line up)', () => {
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [800, 600],
      [2560, 1080],
    ] as const) {
      const { cam, cam3 } = rig(w, h);
      for (const [x, y] of [
        [60, 8],
        [43.2, -1.5],
        [75.9, 17.25],
        [cam.toWorldX(0), cam.toWorldY(0)],
        [cam.toWorldX(w), cam.toWorldY(h)],
      ] as const) {
        const [sx, sy] = toScreen(cam3, cam, x, y);
        expect(sx).toBeCloseTo(cam.toScreenX(x), 6);
        expect(sy).toBeCloseTo(cam.toScreenY(y), 6);
      }
    }
  });

  it('looks 5° down: the camera sits above the focus, and nearer things shift down on screen', () => {
    const { cam, cam3 } = rig(1280, 720);
    expect(cam3.position.y).toBeGreaterThan(cam.y);
    expect(cam3.position.y - cam.y).toBeCloseTo(cam3.position.z * Math.tan((5 * Math.PI) / 180), 9);
    const [, onPlane] = toScreen(cam3, cam, 60, 8, 0);
    const [, inFront] = toScreen(cam3, cam, 60, 8, 1);
    expect(inFront).toBeGreaterThan(onPlane); // the front edge of a ledge shows below its collision line
  });

  it('never shows more of the plane than the AOI camera model: wide screens keep the width, tall ones crop the sides', () => {
    const visible = (w: number, h: number) => {
      const { cam } = rig(w, h);
      return { width: cam.width / cam.ppm, height: cam.height / cam.ppm };
    };
    expect(visible(1920, 1080).width).toBeCloseTo(BASE_VIEW_WIDTH, 9);
    expect(visible(1024, 768)).toEqual({ width: BASE_VIEW_WIDTH, height: BASE_VIEW_WIDTH * VIEW_MAX_ASPECT });
    for (const [w, h] of [
      [720, 900],
      [600, 1200],
      [1000, 1000],
    ]) {
      const v = visible(w!, h!);
      expect(v.height).toBeCloseTo(BASE_VIEW_WIDTH * VIEW_MAX_ASPECT, 9);
      expect(v.width).toBeLessThan(BASE_VIEW_WIDTH);
    }
  });

  it('crops tall screens once: the 3D view shows exactly what the 2D camera (and the AOI) shows', () => {
    for (const [w, h] of [
      [960, 1080],
      [1280, 1024],
      [1080, 1920],
      [1920, 1080],
    ] as const) {
      const cam = new PlaneCamera();
      const flat = new Camera();
      cam.resize(w, h);
      flat.resize(w, h);
      expect(cam.ppm).toBeCloseTo(flat.ppm, 9);
      // and the perspective frustum's plane height matches it
      const { cam3 } = rig(w, h);
      const pose = planePose(cam);
      const visibleH = 2 * pose.z * Math.tan(((cam3.fov / 2) * Math.PI) / 180);
      expect(visibleH).toBeCloseTo(h / flat.ppm, 6);
    }
  });

  it('eases zoom changes over ~0.25 s instead of snapping (docs/01 §5)', () => {
    const cam = new PlaneCamera();
    cam.resize(1600, 900);
    cam.follow(60, 0, 60, 0, 1 / 60, movementTestMap);
    cam.setZoom(2, 3);
    const target = BASE_VIEW_WIDTH * ZOOM_MULTIPLIERS[2]!;
    cam.follow(60, 0, 60, 0, 1 / 60, movementTestMap);
    expect(cam.viewWidth).toBeGreaterThan(BASE_VIEW_WIDTH);
    expect(cam.viewWidth).toBeLessThan(BASE_VIEW_WIDTH + (target - BASE_VIEW_WIDTH) * 0.3);
    for (let i = 0; i < 15; i++) cam.follow(60, 0, 60, 0, 1 / 60, movementTestMap);
    expect(cam.viewWidth).toBeGreaterThan(BASE_VIEW_WIDTH + (target - BASE_VIEW_WIDTH) * 0.97);
    for (let i = 0; i < 60; i++) cam.follow(60, 0, 60, 0, 1 / 60, movementTestMap);
    expect(cam.viewWidth).toBe(target);
  });
});
