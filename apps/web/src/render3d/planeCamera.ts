/**
 * The 3D side camera (docs/01 §5) on top of the 2D Camera's follow/look-ahead/zoom.
 *
 * The 2D Camera stays the single source of truth for where the gameplay plane (z = 0) is on
 * screen: mouse aim, the 2D debug overlay and the HUD all use `toScreenX/Y` / `toWorldX/Y`. The
 * perspective camera is derived from it so that z = 0 maps to the screen exactly the same way:
 * - FOV 35° (vertical), distance chosen so the plane's visible height is the camera's
 *   (`2 × halfExtents.halfH`). On a screen taller than 4:3 that's the letterbox band (`Camera.band`):
 *   the renderer draws into the band only, so 3D never shows more than the server's AOI either;
 * - the 5° downward look is a lens shift: the camera sits above the focus and looks straight down
 *   −Z with an off-axis frustum. A real pitch would keystone the plane (the bottom edge ~3% wider
 *   than the top) and break the 1:1 mapping; the shift keeps the depth cue (you see the tops of
 *   ledges, the background slides with parallax) without it.
 */
import type { MapDef } from '@military-forge/content';
import type { PerspectiveCamera } from 'three';
import { Camera } from '../camera';

/** vertical field of view, degrees (docs/01 §5) */
export const FOV_DEG = 35;
/** downward look, degrees, done as a lens shift (see above) */
export const TILT_DEG = 5;
/** zoom changes ease in over this long (docs/01 §5: 0.25 s) */
const ZOOM_SECONDS = 0.25;

export class PlaneCamera extends Camera {
  /** zoomed width (m), eased toward the zoom level's width */
  private easedWidth = 0;

  /**
   * The zoom level's width, eased. The tall-screen letterbox (never more height than the server's
   * AOI covers, `VIEW_MAX_ASPECT`) is the base Camera's `halfExtents`/`band`, so it is not applied
   * again here.
   */
  override get viewWidth(): number {
    return this.easedWidth || super.viewWidth;
  }

  override follow(px: number, py: number, mouseWorldX: number, mouseWorldY: number, dt: number, map: MapDef): void {
    const target = super.viewWidth;
    // ~98% of the way in ZOOM_SECONDS
    this.easedWidth = this.easedWidth ? this.easedWidth + (target - this.easedWidth) * (1 - Math.exp((-4 * dt) / ZOOM_SECONDS)) : target;
    if (Math.abs(this.easedWidth - target) < 1e-3) this.easedWidth = target;
    super.follow(px, py, mouseWorldX, mouseWorldY, dt, map);
  }
}

export interface PlanePose {
  x: number;
  y: number;
  z: number;
  /** vertical frustum shift, as a fraction of the view height (`setViewOffset` units) */
  shift: number;
  /** of the band the 3D view renders into (the whole screen up to 4:3) */
  aspect: number;
}

/** Where the perspective camera goes so that z = 0 lands on screen exactly where `cam` puts it. */
export function planePose(cam: Camera, fovDeg = FOV_DEG, tiltDeg = TILT_DEG, out: PlanePose = { x: 0, y: 0, z: 0, shift: 0, aspect: 1 }): PlanePose {
  const halfTan = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  const tiltTan = Math.tan((tiltDeg * Math.PI) / 180);
  const visibleH = 2 * cam.halfExtents.halfH;
  const dist = visibleH / 2 / halfTan;
  out.x = cam.x;
  out.y = cam.y + dist * tiltTan;
  out.z = dist;
  out.shift = tiltTan / (2 * halfTan);
  const { top, bottom } = cam.band;
  out.aspect = cam.width / (bottom - top);
  return out;
}

/** Applies `pose` to a three.js camera (no rotation: it looks down −Z). */
export function applyPlanePose(camera3: PerspectiveCamera, pose: PlanePose, fovDeg = FOV_DEG): void {
  camera3.position.set(pose.x, pose.y, pose.z);
  camera3.quaternion.identity();
  camera3.fov = fovDeg;
  // nothing is closer than the foreground layer (z ≤ +6); far reaches past the sky card (z −46)
  camera3.near = Math.max(0.5, pose.z - 12);
  camera3.far = pose.z + 80;
  // setViewOffset also sets aspect = fullWidth / fullHeight; it calls updateProjectionMatrix
  camera3.setViewOffset(pose.aspect, 1, 0, pose.shift, pose.aspect, 1);
  camera3.updateMatrixWorld();
}
