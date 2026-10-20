/**
 * The 2D camera never shows more than the server's AOI sends (docs/05 §9): for any screen shape,
 * zoom level, reticle position and player position, what's on screen lies inside aoiRect.
 */
import { getMap, weapons } from '@military-forge/content';
import { AOI_MARGIN, aoiRect } from '@military-forge/netcode';
import type { ViewRect } from '@military-forge/protocol';
import { Game } from '@military-forge/sim';
import { describe, expect, it } from 'vitest';
import { Camera } from '../src/camera';

describe('camera vs AOI', () => {
  it('the visible rect lies inside the AOI rect for every aspect, zoom, reticle and position', () => {
    const map = getMap('movement-test');
    const game = new Game({ map, dummies: false });
    const p = game.addPlayer('me');
    const zoomMax = Math.max(...p.weapons.map((w) => weapons[w.def]?.zoomMax ?? 1));
    const aoi: ViewRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const b = map.bounds;
    let checked = 0;
    for (let aspect = 0.4; aspect <= 2.5 + 1e-9; aspect += 0.15) {
      for (let zoom = 0; zoom < zoomMax; zoom++) {
        for (const [px, py] of [
          [b.minX + 1, b.minY + 1],
          [b.maxX - 1, b.maxY - 2],
          [(b.minX + b.maxX) / 2, 0],
          [30, 40],
          [b.maxX - 1, 0],
        ] as const) {
          for (const [mx, my] of [
            [-1e4, -1e4],
            [1e4, 1e4],
            [-1e4, 1e4],
            [1e4, -1e4],
          ] as const) {
            const cam = new Camera();
            cam.resize(1200, 1200 * aspect);
            cam.setZoom(zoom, zoomMax);
            cam.follow(px, py, mx, my, 1, map); // first call: jumps straight to the target
            p.x = px;
            p.y = py;
            aoiRect(p, map, aoi);
            const { halfW, halfH } = cam.halfExtents;
            // strict: without the AOI's safety margin (velocity is 0 here)
            expect(cam.x - halfW).toBeGreaterThanOrEqual(aoi.minX + AOI_MARGIN - 1e-9);
            expect(cam.x + halfW).toBeLessThanOrEqual(aoi.maxX - AOI_MARGIN + 1e-9);
            expect(cam.y - halfH).toBeGreaterThanOrEqual(aoi.minY + AOI_MARGIN - 1e-9);
            expect(cam.y + halfH).toBeLessThanOrEqual(aoi.maxY - AOI_MARGIN + 1e-9);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(400);
  });

  it('tall screens are letterboxed: the full view width, and only a 4:3 band of height', () => {
    const cam = new Camera();
    cam.resize(800, 1600); // portrait
    const { halfW, halfH } = cam.halfExtents;
    expect(halfW * 2).toBeCloseTo(cam.viewWidth, 6); // as wide as on any screen
    expect(halfH * 2).toBeCloseTo(cam.viewWidth * 0.75, 6); // only 4:3 of it tall
    const { top, bottom } = cam.band;
    expect(bottom - top).toBeCloseTo(600, 6);
    expect(top).toBeCloseTo(500, 6);
    // wide screens: no bars
    cam.resize(1600, 900);
    expect(cam.band).toEqual({ top: 0, bottom: 900 });
  });

  it('a respawn far away moves the camera at once instead of panning across unsent ground', () => {
    const map = getMap('movement-test');
    const game = new Game({ map, dummies: false });
    const p = game.addPlayer('me');
    const cam = new Camera();
    cam.resize(1600, 900);
    const b = map.bounds;
    const from = b.minX + 20;
    for (let i = 0; i < 30; i++) cam.follow(from, 0, from, 0, 1 / 60, map);
    const to = b.maxX - 20;
    cam.follow(to, 0, to, 0, 1 / 60, map); // the next frame is already there
    p.x = to;
    p.y = 0;
    const aoi: ViewRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    aoiRect(p, map, aoi);
    const { halfW } = cam.halfExtents;
    expect(cam.x - halfW).toBeGreaterThanOrEqual(aoi.minX);
    expect(cam.x + halfW).toBeLessThanOrEqual(aoi.maxX);
  });
});

describe('the phone view (Camera.viewScale, Settings → Touch → View distance)', () => {
  it('sits closer than the zoom level: a smaller view, bigger soldiers; never wider than the level, never under half', () => {
    const cam = new Camera();
    cam.resize(812, 375);
    const full = cam.viewWidth;
    const ppm = cam.ppm;
    cam.viewScale = 0.62;
    expect(cam.viewWidth).toBeCloseTo(full * 0.62, 6);
    expect(cam.ppm).toBeCloseTo(ppm / 0.62, 6); // a soldier ~1.6× as tall on screen
    cam.viewScale = 3;
    expect(cam.viewWidth).toBeCloseTo(full, 6);
    cam.viewScale = 0.1;
    expect(cam.viewWidth).toBeCloseTo(full * 0.5, 6);
  });

  it('look-ahead scales with the setting; off, the view stays on the soldier', () => {
    const map = getMap('movement-test') ?? getMap('lunar-outpost')!;
    const cx = (map.bounds.minX + map.bounds.maxX) / 2;
    const cy = (map.bounds.minY + map.bounds.maxY) / 2;
    const at = (la: number) => {
      const cam = new Camera();
      cam.resize(812, 375);
      cam.lookAhead = la;
      cam.follow(cx, cy, cx + 30, cy, 1, map);
      return cam.x;
    };
    expect(at(1)).toBeGreaterThan(at(0));
    expect(at(0)).toBeCloseTo(cx, 3);
  });
});
