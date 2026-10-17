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

  it('tall screens crop the sides instead of showing more height', () => {
    const cam = new Camera();
    cam.resize(800, 1600); // portrait
    const { halfW, halfH } = cam.halfExtents;
    expect(halfH / halfW).toBeCloseTo(2, 6); // the screen's shape…
    expect(halfH * 2).toBeCloseTo(cam.viewWidth * 0.75, 6); // …but only 4:3 of the view width tall
  });
});
