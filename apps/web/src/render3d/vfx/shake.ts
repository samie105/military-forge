/**
 * Trauma camera shake (docs/01 §5): events add trauma (0…1), the offset is MAX × trauma² on smooth
 * noise, and trauma drains linearly. The offset moves the 3D camera only: the 2D Camera (mouse
 * aim, AOI, HUD) never shakes, and 0.3 m stays far inside AOI_MARGIN (w1-render3d-interfaces §2).
 * A shot's camera kick (recoil.ts) rides on the same offset: a nudge against the shot that
 * settles in a few frames. Reduced motion turns both off.
 */

/** metres at trauma 1 */
export const SHAKE_MAX = 0.3;
/** trauma drained per second */
export const SHAKE_DECAY = 1.4;
/** a blast this far from the view centre (or nearer) shakes the camera, falling off to 0 */
export const SHAKE_RANGE = 30;
/** the camera kick settles at this rate, 1/s */
export const KICK_RECOVER = 14;
/** the most a burst of kicks can push the camera, m */
export const KICK_LIMIT = 0.15;

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
  private kx = 0;
  private ky = 0;

  add(amount: number): void {
    if (this.enabled) this.trauma = Math.min(1, this.trauma + amount);
  }

  /** A camera kick (m) along (dx, dy): a shot's recoil pushes the view back against the shot. */
  kick(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.kx += dx;
    this.ky += dy;
    const len = Math.sqrt(this.kx * this.kx + this.ky * this.ky);
    if (len > KICK_LIMIT) {
      this.kx *= KICK_LIMIT / len;
      this.ky *= KICK_LIMIT / len;
    }
  }

  /** Advances the shake; `offset` holds this frame's displacement in metres. */
  update(dt: number): { x: number; y: number } {
    this.t += dt;
    this.trauma = this.enabled ? Math.max(0, this.trauma - SHAKE_DECAY * dt) : 0;
    if (!this.enabled) this.kx = this.ky = 0;
    const s = SHAKE_MAX * this.trauma * this.trauma;
    const t = this.t;
    // two incommensurate sines per axis: smooth, never periodic enough to read as a wobble
    this.offset.x = s * (0.6 * Math.sin(t * 61.7) + 0.4 * Math.sin(t * 37.3 + 1.7)) + this.kx;
    this.offset.y = s * (0.6 * Math.sin(t * 53.1 + 0.9) + 0.4 * Math.sin(t * 29.9 + 4.2)) + this.ky;
    // a kick shows in full on the frame it lands, then settles
    const settle = Math.exp(-KICK_RECOVER * dt);
    this.kx *= settle;
    this.ky *= settle;
    return this.offset;
  }
}
