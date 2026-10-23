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
import { TOUCH_EDGE_OVERRUN } from '../src/touch/controller';

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

describe('tall maps: the view leans the way you fly (maps-vertical)', () => {
  const map = getMap('vertical-test');
  const mid = (map.bounds.minX + map.bounds.maxX) / 2;

  /** steady flight at vy for 3 s, mouse on the focus: where the camera's centre settles above the focus */
  const settled = (vy: number, width = 1600, height = 900, viewScale = 1) => {
    const cam = new Camera();
    cam.resize(width, height);
    cam.viewScale = viewScale;
    cam.flightVy = vy;
    for (let i = 0; i < 180; i++) cam.follow(mid, 40, mid, 40.9, 1 / 60, map);
    return { cam, offset: cam.y - (40 + 0.9) };
  };

  it('up while climbing, further down while falling, level otherwise', () => {
    const still = settled(0).offset;
    const climbing = settled(6.5).offset;
    const falling = settled(-18).offset;
    expect(Math.abs(still)).toBeLessThan(1e-6);
    expect(climbing).toBeGreaterThan(2);
    expect(falling).toBeLessThan(-3);
    expect(-falling).toBeGreaterThan(climbing);
    // a jump or a step down barely moves it
    expect(Math.abs(settled(1.5).offset)).toBeLessThan(1e-6);
    expect(Math.abs(settled(-3.5).offset)).toBeLessThan(1e-6);
  });

  it('a phone in landscape leans further than a 4:3 screen: it has more of the AOI to spare', () => {
    expect(settled(-18, 812, 375).offset).toBeLessThan(settled(-18, 1200, 900).offset);
  });

  it('however far it leans, at any view and aim, the whole soldier stays on screen', () => {
    for (const [w, h] of [[844, 390], [667, 375], [1280, 720]] as const)
      for (const view of [0.62, 0.94, 1])
        for (const vy of [-18, 6.5])
          for (const aimDy of [-12, 12]) {
            const cam = new Camera();
            cam.resize(w, h);
            cam.viewScale = view;
            cam.flightVy = vy;
            for (let i = 0; i < 240; i++) cam.follow(mid, 40, mid, 40.9 + aimDy, 1 / 60, map);
            const { halfH } = cam.halfExtents;
            // feet at 40, the head 1.75 above: both inside the view, with room to spare
            expect(40 - (cam.y - halfH), `${w}×${h} view ${view} vy ${vy} aim ${aimDy}: feet`).toBeGreaterThan(0.5);
            expect(cam.y + halfH - (40 + 1.75), `${w}×${h} view ${view} vy ${vy} aim ${aimDy}: head`).toBeGreaterThan(0.5);
          }
  });

  it('on touch, a soldier at the map\'s very edge stays out of the dials\' columns (the view runs past the edge)', () => {
    for (const [w, h] of [[780, 360], [844, 390], [667, 375]] as const) {
      const at = (x: number, overrun: { x: number; down: number }) => {
        const cam = new Camera();
        cam.resize(w, h);
        cam.viewScale = 0.8;
        cam.edgeOverrun = overrun;
        for (let i = 0; i < 120; i++) cam.follow(x, 40, x, 40.9, 1 / 60, map);
        return cam.toScreenX(x) / w;
      };
      const desk = { x: 0, down: 0 };
      // the desktop stops at the edge: the soldier slides to the screen's side
      expect(at(map.bounds.maxX - 0.5, desk)).toBeGreaterThan(0.85);
      // touch: left of the aim dial's column (it starts at ~74 %), right of the move dial's (ends ~26 %)
      expect(at(map.bounds.maxX - 0.5, TOUCH_EDGE_OVERRUN), `${w}: right edge`).toBeLessThan(0.74);
      expect(at(map.bounds.minX + 0.5, TOUCH_EDGE_OVERRUN), `${w}: left edge`).toBeGreaterThan(0.26);
    }
  });

  it('look-ahead off keeps the view on the soldier', () => {
    const cam = new Camera();
    cam.resize(812, 375);
    cam.lookAhead = 0;
    cam.flightVy = -18;
    for (let i = 0; i < 180; i++) cam.follow(mid, 40, mid, 40.9, 1 / 60, map);
    expect(cam.y).toBeCloseTo(40.9, 6);
  });

  it("a phone's close view pulls back out on a fast climb or fall, and closes in again after", () => {
    const close = settled(0, 812, 375, 0.62).cam.viewWidth;
    const flying = settled(-18, 812, 375, 0.62).cam;
    expect(flying.viewWidth).toBeGreaterThan(close * 1.4);
    expect(flying.viewWidth).toBeLessThanOrEqual(36 + 1e-9); // never past the zoom level's own view
    flying.flightVy = 0;
    for (let i = 0; i < 240; i++) flying.follow(mid, 40, mid, 40.9, 1 / 60, map);
    expect(flying.viewWidth).toBeLessThan(close * 1.05);
  });

  it('never shows more than the AOI sends, for any flight, screen, zoom, view distance and reticle', () => {
    const game = new Game({ map, dummies: false });
    const p = game.addPlayer('me');
    const zoomMax = Math.max(...p.weapons.map((w) => weapons[w.def]?.zoomMax ?? 1));
    const aoi: ViewRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    const b = map.bounds;
    let checked = 0;
    for (let aspect = 0.4; aspect <= 2.5 + 1e-9; aspect += 0.3) {
      for (let zoom = 0; zoom < zoomMax; zoom++) {
        for (const viewScale of [0.5, 0.62, 1]) {
          for (const vy of [-36, -14, -6, 0, 4, 6.5, 20]) {
            for (const [px, py] of [
              [mid, 1],
              [mid, 40],
              [b.maxX - 1, b.maxY - 4],
              [b.minX + 1, 0],
            ] as const) {
              for (const my of [-1e4, 1e4, py]) {
                const cam = new Camera();
                cam.resize(1200, 1200 * aspect);
                cam.setZoom(zoom, zoomMax);
                cam.viewScale = viewScale;
                cam.flightVy = vy;
                cam.follow(px, py, px, my, 1, map); // first call: jumps straight to the target
                for (let i = 0; i < 120; i++) cam.follow(px, py, px, my, 1 / 60, map); // settle the lean and pull
                p.x = px;
                p.y = py;
                p.vx = 0;
                p.vy = 0; // strict: no velocity margin from the AOI
                aoiRect(p, map, aoi);
                const { halfW, halfH } = cam.halfExtents;
                expect(cam.x - halfW).toBeGreaterThanOrEqual(aoi.minX + AOI_MARGIN - 1e-6);
                expect(cam.x + halfW).toBeLessThanOrEqual(aoi.maxX - AOI_MARGIN + 1e-6);
                expect(cam.y - halfH, `aspect ${aspect} zoom ${zoom} scale ${viewScale} vy ${vy} at ${px},${py}`).toBeGreaterThanOrEqual(aoi.minY + AOI_MARGIN - 1e-6);
                expect(cam.y + halfH, `aspect ${aspect} zoom ${zoom} scale ${viewScale} vy ${vy} at ${px},${py}`).toBeLessThanOrEqual(aoi.maxY - AOI_MARGIN + 1e-6);
                checked++;
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('a climb that turns into a fall stays inside the AOI frame by frame (the springs lag; the margin covers them)', () => {
    const game = new Game({ map, dummies: false });
    const p = game.addPlayer('me');
    const aoi: ViewRect = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    for (const [w, h, scale] of [
      [812, 375, 0.62],
      [1600, 900, 1],
      [1200, 900, 1],
    ] as const) {
      const cam = new Camera();
      cam.resize(w, h);
      cam.viewScale = scale;
      let y = 0;
      let vy = 0;
      for (let t = 0; t < 12 * 60; t++) {
        // 4 s of jetting up, then a fall back to the street, then standing
        vy = t < 240 ? 6.5 : y > 0 ? Math.max(-36, vy - 20 / 60) : 0;
        y = Math.max(0, y + vy / 60);
        cam.flightVy = vy;
        cam.follow(mid, y, mid, y, 1 / 60, map);
        p.x = mid;
        p.y = y;
        p.vx = 0;
        p.vy = vy;
        aoiRect(p, map, aoi);
        const { halfH } = cam.halfExtents;
        expect(cam.y - halfH, `${w}×${h} t ${t}`).toBeGreaterThanOrEqual(aoi.minY);
        expect(cam.y + halfH, `${w}×${h} t ${t}`).toBeLessThanOrEqual(aoi.maxY);
      }
    }
  });
});
