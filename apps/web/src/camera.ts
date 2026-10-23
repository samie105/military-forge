/**
 * Side-view camera (docs/01 §5): spring follow + look-ahead toward the reticle, zoom levels from
 * docs/03 §10 (zoom = camera pulls back to show more of the map).
 *
 * Tall maps (maps-vertical, NOTES §48): the view also leans the way you fly, up while you climb
 * and further down while you fall, so the tier you're heading for comes into view before you get
 * there; and a phone's close view (`viewScale` under 1) eases back out to the level's full view
 * while you climb or fall fast. Neither ever shows more than the server's area of interest sends
 * (packages/netcode aoi.ts): the lean shares the reticle look-ahead's budget, which on screens
 * wider than 4:3 (every phone in landscape) is larger than the reticle uses (`leanBudget`).
 */
import type { MapDef } from '@military-forge/content';
import { AOI_MARGIN, VIEW_BASE_WIDTH, VIEW_FOCUS_Y, VIEW_LOOKAHEAD, VIEW_MAX_ASPECT, VIEW_ZOOM_MULTIPLIERS } from '@military-forge/netcode';

// The camera model is shared with the server's AOI (packages/netcode/src/aoi.ts): keep them one.
export const BASE_VIEW_WIDTH = VIEW_BASE_WIDTH;
export const ZOOM_MULTIPLIERS = VIEW_ZOOM_MULTIPLIERS;

/** the view leans up from this climb speed (m/s), fully at RISE_FULL (a jet's top speed is 6.5) */
const RISE_FROM = 2;
const RISE_FULL = 6;
/** and down from this fall speed, fully at FALL_FULL */
const FALL_FROM = 4;
const FALL_FULL = 14;
/** shares of the lean budget: falling leans further (you need to see where you land) */
const RISE_LEAN = 0.45;
const FALL_LEAN = 0.65;
/** 1/s: how quickly the lean follows the flight */
const FLIGHT_EASE = 3;
/** a close view pulls back out above this vertical speed (m/s) … */
const PULL_SPEED = 5;
/** … this quickly (1/s), and back in as quickly once the flight slows */
const PULL_EASE = 1.6;

export class Camera {
  x = 0;
  y = 0;
  /** 0-based zoom level index */
  zoom = 0;
  width = 1;
  height = 1;
  /** how far the view leans toward the reticle, 0–1 (phones: Settings → Touch → Look-ahead) */
  lookAhead = 1;
  /**
   * How much of the zoom level's view shows, 0.5–1: under 1 the view sits closer (phones: soldiers big
   * enough to read on a small screen; a pinch changes it). Never wider than the level, so the
   * server's area of interest (AOI_MARGIN, packages/netcode/src/aoi.ts) still covers it.
   */
  viewScale = 1;
  /**
   * The soldier's vertical speed (m/s), set before `follow`: the view leans the way it flies. 0 (or
   * never set) keeps the plain follow.
   */
  flightVy = 0;
  /** eased vertical lean toward where the soldier is flying (m) */
  private flightLean = 0;
  /** eased 0–1: how far a close view (viewScale < 1) has pulled back out for a fast climb or fall */
  private flightPull = 0;
  private initialised = false;
  private lastPx = 0;
  private lastPy = 0;

  get viewWidth(): number {
    const scale = Math.max(0.5, Math.min(1, this.viewScale));
    return BASE_VIEW_WIDTH * ZOOM_MULTIPLIERS[this.zoom]! * (scale + (1 - scale) * this.flightPull);
  }

  /**
   * How far the view may sit above or below the focus (m) and still show only what the server's
   * AOI covers: the AOI's reticle look-ahead (35% of the 4:3 half-height of this zoom level), plus
   * the height the AOI serves that this screen doesn't show. Never under the reticle look-ahead's
   * own reach on this screen.
   */
  get leanBudget(): number {
    const halfS = (BASE_VIEW_WIDTH * ZOOM_MULTIPLIERS[this.zoom]! * VIEW_MAX_ASPECT) / 2;
    const { halfH } = this.halfExtents;
    return Math.max(VIEW_LOOKAHEAD * halfH, VIEW_LOOKAHEAD * halfS + halfS - halfH);
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
    // tall maps: lean the way the soldier flies, and pull a close view back out on a fast climb or fall
    const lean = Math.max(0, Math.min(1, this.lookAhead));
    const vy = Number.isFinite(this.flightVy) ? this.flightVy : 0;
    const easeIn = this.initialised ? 1 - Math.exp(-dt * FLIGHT_EASE) : 1;
    this.flightPull += ((Math.abs(vy) > PULL_SPEED ? lean : 0) - this.flightPull) * (this.initialised ? 1 - Math.exp(-dt * PULL_EASE) : 1);
    const { halfW, halfH } = this.halfExtents;
    const budget = this.leanBudget;
    const rising = Math.max(0, Math.min(1, (vy - RISE_FROM) / (RISE_FULL - RISE_FROM)));
    const falling = Math.max(0, Math.min(1, (-vy - FALL_FROM) / (FALL_FULL - FALL_FROM)));
    const leanTarget = lean * budget * (RISE_LEAN * rising - FALL_LEAN * falling);
    this.flightLean += (leanTarget - this.flightLean) * easeIn;
    const cx = px;
    const cy = py + VIEW_FOCUS_Y;
    // look-ahead toward the reticle, up to 35% of the half view; with the flight lean, within the budget
    const la = VIEW_LOOKAHEAD * lean;
    const lx = Math.max(-halfW * la, Math.min(halfW * la, (mouseWorldX - cx) * la));
    const ly = Math.max(-halfH * la, Math.min(halfH * la, (mouseWorldY - cy) * la));
    let tx = cx + lx;
    let ty = cy + Math.max(-budget, Math.min(budget, ly + this.flightLean));
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

  /** Jumps to where the view is heading on the next follow, without the spring (a two-finger double tap). */
  recentre(): void {
    this.initialised = false;
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
