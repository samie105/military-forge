/**
 * The throw arc in 3D (the path is throwPreview.ts's, from the Frame): high-contrast dots, a dark
 * rim under a bright core so it reads on sky and on walls, marching slowly along the path. A ring
 * marks where it first comes down and a small burst where it goes off; bounces after the landing
 * are fainter. During a map event's warning the arc turns amber: a zone switching on mid-flight
 * isn't foreseen.
 */
import type { Texture } from 'three';
import { ARC_DOTS, ARC_MARCH, ARC_SPACING, arcDots, type ThrowArcView } from '../../throwPreview';
import { Cell } from './atlas';
import { ParticleLayer } from './particles';

/** a dot's core on screen (px) at the least, and its dark rim around it */
const CORE_PX = 6;
const RIM = 1.75;
/** the dots' core: warm white, or amber while a map event may change the path */
const CORE = [1, 0.97, 0.82] as const;
const UNSURE = [1, 0.66, 0.2] as const;

export class ThrowArc {
  readonly layer: ParticleLayer;
  private phase = 0;
  private core = 0.1;
  private tint: readonly [number, number, number] = CORE;
  private readonly dot = (x: number, y: number, after: boolean, fade: number): void => {
    const size = after ? this.core * 0.7 : this.core;
    const [r, g, b] = this.tint;
    this.layer.sprite(x, y, 0.05, size * RIM, 0, 0, 0, 0, (after ? 0.35 : 0.7) * fade, Cell.Dot);
    this.layer.sprite(x, y, 0.05, size, 0, r, g, b, (after ? 0.5 : 1) * fade, Cell.Dot);
  };

  constructor(texture: Texture, grid: readonly [number, number]) {
    this.layer = new ParticleLayer(ARC_DOTS * 2 + 6, { texture, grid, blend: 'alpha', depthTest: false, renderOrder: 15 });
    this.layer.mesh.name = 'vfx-arc';
  }

  /**
   * Draws `view` (nothing when null: no throw aimed). `uncertain`: a map event is in its warning.
   * `ppm`: screen pixels per metre (the dots keep their size on screen).
   */
  update(view: ThrowArcView | null | undefined, uncertain: boolean, dt: number, ppm: number, reducedMotion: boolean): void {
    this.layer.begin();
    if (view && view.count > 1) {
      this.phase = reducedMotion ? 0 : (this.phase + ARC_MARCH * dt) % ARC_SPACING;
      this.core = Math.max(0.08, CORE_PX / Math.max(1, ppm));
      this.tint = uncertain ? UNSURE : CORE;
      this.marks(view);
      arcDots(view, this.phase, this.dot);
    }
    this.layer.end();
  }

  /** The landing ring and the burst where it goes off, first, so the dots crossing them stay on top. */
  private marks(view: ThrowArcView): void {
    const pts = view.points;
    const L = this.layer;
    const [r, g, b] = this.tint;
    if (view.land >= 0) {
      const x = pts[view.land * 2]!;
      const y = pts[view.land * 2 + 1]!;
      L.sprite(x, y, 0.05, this.core * 7.5, 0, 0, 0, 0, 0.7, Cell.Ring);
      L.sprite(x, y, 0.05, this.core * 6.4, 0, r, g * 0.95, b * 0.55, 1, Cell.Ring);
    }
    if (view.detonates) {
      const end = view.count - 1;
      const x = pts[end * 2]!;
      const y = pts[end * 2 + 1]!;
      L.sprite(x, y, 0.05, this.core * 4.2, 0.4, 0, 0, 0, 0.6, Cell.Star);
      L.sprite(x, y, 0.05, this.core * 3.6, 0.4, 1, 0.55, 0.2, 1, Cell.Star);
    }
  }

  dispose(): void {
    this.layer.dispose();
  }
}
