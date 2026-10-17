/**
 * A blast's light on the scene. docs/11 §2: no real-time point lights on Low/Medium, so every
 * preset tints the hemisphere light warm for a moment (the "light-probe tint"), and High also pops
 * one pooled PointLight at the blast. That light stays in the scene at intensity 0 between blasts:
 * adding, removing or hiding a light changes every lit material's shader.
 *
 * Photosensitivity (docs/11 §5): at most 3 new flashes a second; a blast inside that window only
 * keeps the light up. Reduced motion keeps a third of the strength.
 */
import { Color, PointLight, type DirectionalLight, type HemisphereLight } from 'three';

export const FLASH_MIN_INTERVAL = 1 / 3;
const POINT_PEAK = 140;

export class SceneFlash {
  /** 0…1 */
  level = 0;
  reduced = false;
  /** High preset only (setPointLight) */
  readonly point = new PointLight(0xffb468, 0, 16, 2);
  private sinceSpike = Infinity;
  /** how fast the flash dies away (time constant, s) */
  private tau = 0.09;
  private readonly baseIntensity: number;
  private readonly sunIntensity: number;
  private readonly baseColor = new Color();
  private readonly warm = new Color(0xffc480);

  constructor(
    private readonly hemi: HemisphereLight,
    private readonly sun: DirectionalLight,
  ) {
    this.baseIntensity = hemi.intensity;
    this.sunIntensity = sun.intensity;
    this.baseColor.copy(hemi.color);
  }

  /** The Forge's light style: colour, and how long it lasts. */
  style(color: Color, seconds: number): void {
    this.point.color.copy(color);
    this.warm.copy(color);
    this.tau = seconds / 2;
  }

  /** A blast at (x, y), `strength` 0…1 by its distance from the view. True if it flashed. */
  trigger(x: number, y: number, strength: number): boolean {
    if (this.sinceSpike < FLASH_MIN_INTERVAL) return false;
    const s = strength * (this.reduced ? 0.33 : 1);
    if (s <= this.level) return false;
    this.level = s;
    this.sinceSpike = 0;
    // in front of the plane, so it lights the front faces and the characters' fronts
    this.point.position.set(x, y + 1, 2.5);
    return true;
  }

  update(dt: number): void {
    this.sinceSpike += dt;
    this.level *= Math.exp(-dt / this.tau);
    if (this.level < 0.002) this.level = 0;
    // the toon ramp bands direct light, so the flash lifts the sun as well as the sky light
    this.hemi.intensity = this.baseIntensity * (1 + 1.8 * this.level);
    this.hemi.color.copy(this.baseColor).lerp(this.warm, 0.6 * this.level);
    this.sun.intensity = this.sunIntensity * (1 + 1.2 * this.level);
    this.point.intensity = POINT_PEAK * this.level;
  }
}
