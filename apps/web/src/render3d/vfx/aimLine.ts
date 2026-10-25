/**
 * The sniper's aim line in 3D (Frame.aimLine, from aimLine.ts: the sim's own ray for a shot fired
 * now, cut at the first solid). A thin laser-red line that leaves the drawn muzzle, bends gently onto
 * that ray within CONVERGE_M (the drawn gun sits below the sim's shoulder line, as with the tracers,
 * gunfire.ts) and runs on it, fading with distance, to a dot where it meets a wall. Local player only.
 *
 * A red core over a faint dark rim (the throw arc's recipe, throwArc.ts), so it reads on bright sky
 * and on dark walls alike. Cheap on phones: one small alpha layer (≤ 2 × AIM_QUADS quads, the
 * throw arc's material settings, so no new shader to warm up), hidden and drawing nothing while no
 * scoped gun is in hand or a throw is aimed.
 */
import { Vector3 } from 'three';
import { AIM_NOT_READY, AIM_SURE_SPREAD, aimLineStrength, type AimLineView } from '../../aimLine';
import type { Frame } from '../../view';
import { ATLAS_GRID, Cell, vfxAtlas } from './atlas';
import type { MuzzleLookup } from './gunfire';
import type { VfxContext, VfxModule } from './index';
import { ParticleLayer } from './particles';

/** the line is cut into this many quads, each a step fainter */
export const AIM_SEGMENTS = 10;
/** quads of one pass (rim or core): the segments, the bend from the drawn muzzle and the dot */
export const AIM_QUADS = AIM_SEGMENTS + 2;
/**
 * metres along the sim's ray where the line from the drawn muzzle (≈ 0.3 m under the sim's
 * shoulder line) joins it: a gentle bend instead of a kink at the gun; the ray is exact past it
 */
export const CONVERGE_M = 3;
/** the core's half-width on screen (px): the Line cell's soft core reads as ~1.5 px */
const HALF_PX = 2;
/** the dark rim under it, as a multiple of the core's width */
const RIM = 2.4;
/** the dot where it meets a wall (px) */
const DOT_PX = 5;
/** laser red */
const TINT = [1, 0.13, 0.08] as const;
/** opacity at the muzzle, ready to fire; the far end keeps FAR of it, reached by FADE_M */
const NEAR = 0.85;
const FAR = 0.2;
const FADE_M = 40;
/** the rim's darkness, as a share of the core's opacity */
const RIM_ALPHA = 0.3;

const _m = new Vector3();
const _d = new Vector3();

export class AimLine implements VfxModule {
  readonly layer: ParticleLayer;

  constructor(private readonly muzzles: MuzzleLookup = () => false) {
    this.layer = new ParticleLayer(AIM_QUADS * 2, { texture: vfxAtlas(), grid: [ATLAS_GRID, ATLAS_GRID], blend: 'alpha', depthTest: false, renderOrder: 14 });
    this.layer.mesh.name = 'vfx-aim-line';
  }

  update(frame: Frame, _dt: number, fx: Pick<VfxContext, 'camera'>): void {
    this.layer.begin();
    const view = frame.aimLine;
    // a throw being aimed has the screen: one line at a time
    if (view && !frame.throwArc) {
      const ppm = Math.max(1, fx.camera.ppm);
      this.pass(view, ppm, true);
      this.pass(view, ppm, false);
    }
    this.layer.end();
  }

  /** One pass of the line: the dark rim first, then the red core over it. */
  private pass(view: AimLineView, ppm: number, rim: boolean): void {
    const L = this.layer;
    const half = (HALF_PX * (rim ? RIM : 1)) / ppm;
    const k = aimLineStrength(view) * (rim ? RIM_ALPHA : 1);
    const r = rim ? 0 : TINT[0];
    const g = rim ? 0 : TINT[1];
    const b = rim ? 0 : TINT[2];
    const dx = view.ex - view.ox;
    const dy = view.ey - view.oy;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-3) return this.dot(view, ppm, rim, r, g, b, 0);
    const ux = dx / len;
    const uy = dy / len;
    // it leaves the drawn muzzle (when that's near the sim's: a gun mid-swap may not be) and meets
    // the sim's ray CONVERGE_M along it, then runs on it: a laser on the gun, true past the bend
    const drawn = this.muzzles(view.shooter, view.weapon, _m, _d, true) && Math.abs(_m.x - view.ox) + Math.abs(_m.y - view.oy) < 1.2;
    const z = drawn ? _m.z : 0;
    let t0 = 0;
    if (drawn) {
      t0 = Math.min(CONVERGE_M, len);
      const jx = view.ox + ux * t0 - _m.x;
      const jy = view.oy + uy * t0 - _m.y;
      const jl = Math.sqrt(jx * jx + jy * jy);
      if (jl > 1e-3) L.quad(_m.x + jx / 2, _m.y + jy / 2, z, jx * 0.515, jy * 0.515, 0, (-jy / jl) * half, (jx / jl) * half, 0, r, g, b, NEAR * k, Cell.Line);
    }
    const step = (len - t0) / AIM_SEGMENTS;
    if (step > 1e-3) {
      // each quad a touch longer than its step, so the Line cell's soft ends meet: no gaps
      const ha = step * 0.515;
      for (let i = 0; i < AIM_SEGMENTS; i++) {
        const mid = t0 + (i + 0.5) * step;
        const fade = NEAR - (NEAR - FAR) * Math.min(1, mid / FADE_M);
        L.quad(view.ox + ux * mid, view.oy + uy * mid, z, ux * ha, uy * ha, 0, -uy * half, ux * half, 0, r, g, b, fade * k, Cell.Line);
      }
    }
    this.dot(view, ppm, rim, r, g, b, z);
  }

  /** Where it meets a wall, when the shot is sure to go there. */
  private dot(view: AimLineView, ppm: number, rim: boolean, r: number, g: number, b: number, z: number): void {
    if (!view.hit || view.spread > AIM_SURE_SPREAD) return;
    const a = (view.ready ? 1 : AIM_NOT_READY) * (rim ? 0.6 : 1);
    this.layer.sprite(view.ex, view.ey, z, (DOT_PX * (rim ? 1.8 : 1)) / ppm, 0, r, g * 2, b * 2, a, Cell.Dot);
  }

  dispose(): void {
    this.layer.dispose();
  }
}
