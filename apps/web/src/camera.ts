/**
 * Side-view camera (docs/01 §5): spring follow + look-ahead toward the reticle, zoom levels from
 * docs/03 §10 (zoom = camera pulls back to show more of the map).
 */
import type { MapDef } from '@military-forge/content';
import { AOI_MARGIN, VIEW_BASE_WIDTH, VIEW_FOCUS_Y, VIEW_LOOKAHEAD, VIEW_MAX_ASPECT, VIEW_ZOOM_MULTIPLIERS } from '@military-forge/netcode';

// The camera model is shared with the server's AOI (packages/netcode/src/aoi.ts): keep them one.
export const BASE_VIEW_WIDTH = VIEW_BASE_WIDTH;
export const ZOOM_MULTIPLIERS = VIEW_ZOOM_MULTIPLIERS;

export class Camera {
  x = 0;
  y = 0;
  /** 0-based zoom level index */
  zoom = 0;
  width = 1;
  height = 1;
  private initialised = false;
  private lastPx = 0;
  private lastPy = 0;

  get viewWidth(): number {
    return BASE_VIEW_WIDTH * ZOOM_MULTIPLIERS[this.zoom]!;
  }

  /** pixels per metre: the full view width always fits the screen */
  get ppm(): number {
    return this.width / this.viewWidth;
  }

  /**
   * Half the visible width and height in metres. Never taller than the server's AOI serves (4:3 of
   * the view width, packages/netcode/src/aoi.ts): taller screens are letterboxed (`band`).
   */
  get halfExtents(): { halfW: number; halfH: number } {
    return { halfW: this.viewWidth / 2, halfH: Math.min(this.height / 2 / this.ppm, (this.viewWidth * VIEW_MAX_ASPECT) / 2) };
  }

  /** The screen rows that show the world (the rest are letterbox bars), in pixels. */
  get band(): { top: number; bottom: number } {
    const h = Math.min(this.height, this.viewWidth * VIEW_MAX_ASPECT * this.ppm);
    const top = (this.height - h) / 2;
    return { top, bottom: top + h };
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  setZoom(level: number, maxLevel: number): void {
    this.zoom = Math.max(0, Math.min(maxLevel - 1, level));
  }

  follow(px: number, py: number, mouseWorldX: number, mouseWorldY: number, dt: number, map: MapDef): void {
    // a canvas with no size yet (page loaded hidden) would make everything NaN, and NaN sticks:
    // the mouse's world position is derived from the camera
    if (this.width <= 1 || this.height <= 1) return;
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) this.initialised = false;
    // a teleport (respawn): jump, don't pan across ground the AOI doesn't cover
    if (Math.abs(px - this.lastPx) > AOI_MARGIN || Math.abs(py - this.lastPy) > AOI_MARGIN) this.initialised = false;
    this.lastPx = px;
    this.lastPy = py;
    if (!Number.isFinite(mouseWorldX) || !Number.isFinite(mouseWorldY)) {
      mouseWorldX = px;
      mouseWorldY = py;
    }
    const { halfW, halfH } = this.halfExtents;
    const cx = px;
    const cy = py + VIEW_FOCUS_Y;
    // look-ahead toward the reticle, up to 35% of the half view
    const la = VIEW_LOOKAHEAD;
    const lx = Math.max(-halfW * la, Math.min(halfW * la, (mouseWorldX - cx) * la));
    const ly = Math.max(-halfH * la, Math.min(halfH * la, (mouseWorldY - cy) * la));
    let tx = cx + lx;
    let ty = cy + ly;
    const b = map.bounds;
    tx = Math.max(b.minX + halfW, Math.min(b.maxX - halfW, tx));
    ty = Math.max(b.minY + halfH, Math.min(b.maxY - halfH, ty));
    if (!this.initialised) {
      this.x = tx;
      this.y = ty;
      this.initialised = true;
      return;
    }
    const k = 1 - Math.exp(-dt * 10);
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;
  }

  toScreenX(x: number): number {
    return (x - this.x) * this.ppm + this.width / 2;
  }

  toScreenY(y: number): number {
    return this.height / 2 - (y - this.y) * this.ppm;
  }

  toWorldX(sx: number): number {
    return (sx - this.width / 2) / this.ppm + this.x;
  }

  toWorldY(sy: number): number {
    return (this.height / 2 - sy) / this.ppm + this.y;
  }
}
