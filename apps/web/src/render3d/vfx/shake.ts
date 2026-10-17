/**
 * Trauma camera shake (docs/01 §5): events add trauma (0…1), the offset is MAX × trauma² on smooth
 * noise, and trauma drains linearly. The offset moves the 3D camera only: the 2D Camera (mouse
 * aim, AOI, HUD) never shakes, and 0.3 m stays far inside AOI_MARGIN (w1-render3d-interfaces §2).
 * Reduced motion turns it off.
 */

/** metres at trauma 1 */
export const SHAKE_MAX = 0.3;
/** trauma drained per second */
export const SHAKE_DECAY = 1.4;
/** a blast this far from the view centre (or nearer) shakes the camera, falling off to 0 */
export const SHAKE_RANGE = 30;

/**
 * Trauma a blast adds at distance `d` from the view: full within `full` (the blast radius), falling
 * to nothing at `zero` (the radius + SHAKE_RANGE, or the Forge's suggestion).
 */
export function blastTrauma(d: number, full: number, zero = full + SHAKE_RANGE): number {
  const k = Math.max(0, Math.min(1, (zero - d) / (zero - full)));
  return 0.85 * k * k;
}

export class CameraShake {
  trauma = 0;
  enabled = true;
  private t = 0;
  readonly offset = { x: 0, y: 0 };

  add(amount: number): void {
    if (this.enabled) this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Advances the shake; `offset` holds this frame's displacement in metres. */
  update(dt: number): { x: number; y: number } {
    this.t += dt;
    this.trauma = this.enabled ? Math.max(0, this.trauma - SHAKE_DECAY * dt) : 0;
    const s = SHAKE_MAX * this.trauma * this.trauma;
    const t = this.t;
    // two incommensurate sines per axis: smooth, never periodic enough to read as a wobble
    this.offset.x = s * (0.6 * Math.sin(t * 61.7) + 0.4 * Math.sin(t * 37.3 + 1.7));
    this.offset.y = s * (0.6 * Math.sin(t * 53.1 + 0.9) + 0.4 * Math.sin(t * 29.9 + 4.2));
    return this.offset;
  }
}
