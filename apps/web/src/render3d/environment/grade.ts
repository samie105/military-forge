/**
 * Palette discipline per depth layer (docs/11 §4, docs/04 §8): the background is low-saturation
 * and low-contrast, the gameplay plane mid, players and projectiles the loudest. The kit is
 * vertex-coloured, so the grade is applied once to the merged vertex colours at load: no shader
 * changes, no per-frame cost, and it holds at every zoom (scene fog alone depends on how far the
 * camera has pulled back).
 *
 * All maths is in linear RGB (glTF vertex colours and three's working space).
 */
import { Color } from 'three';
import type { GradedLayer } from './layout';

export interface LayerGrade {
  /** 1 = as authored, 0 = grey */
  saturation: number;
  /** multiplies the colour (exposure) */
  gain: number;
  /** pull toward the haze colour: `haze` at z = 0, plus `hazePerM` per metre behind the plane */
  haze: number;
  hazePerM: number;
  /** a ceiling on the haze pull */
  hazeMax: number;
}

export interface MapGrade {
  /** linear RGB the far layers fade toward (the horizon / fog colour) */
  hazeColor: Color;
  /** a gentle colour cast over the whole kit (multiplied in), e.g. warm sunlight in the dust */
  tint: Color;
  layers: Record<GradedLayer, LayerGrade>;
  /**
   * Baked ambient occlusion on walls: vertical faces darken toward their foot over this height (m),
   * down to `aoFloor` at y = 0. Upward faces (floors, roofs) get contact shadows instead.
   */
  aoHeight: number;
  aoFloor: number;
  /** extra saturation on the gameplay layer's floor (upward faces at ground level): the pavement stays quieter than what stands on it */
  floorSaturation: number;
}

/** Relative luminance of a linear colour. */
export function luminance(c: Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** Saturation in place: 1 keeps the colour, 0 is its grey. */
export function saturate(c: Color, s: number): Color {
  const l = luminance(c);
  c.r = l + (c.r - l) * s;
  c.g = l + (c.g - l) * s;
  c.b = l + (c.b - l) * s;
  return c;
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * The graded colour of one vertex. `y`/`z` are its world height and depth, `ny` the up component
 * of its normal (for wall AO).
 */
export function gradeVertex(c: Color, grade: MapGrade, layer: GradedLayer, y: number, z: number, ny: number): Color {
  const g = grade.layers[layer];
  saturate(c, layer === 'gameplay' && ny > 0.7 && y < 0.05 ? g.saturation * grade.floorSaturation : g.saturation);
  c.multiply(grade.tint).multiplyScalar(g.gain);
  if (layer !== 'far' && Math.abs(ny) < 0.5 && grade.aoHeight > 0) {
    c.multiplyScalar(grade.aoFloor + (1 - grade.aoFloor) * smooth(y / grade.aoHeight));
  }
  const behind = Math.max(0, -z);
  const k = Math.min(g.hazeMax, g.haze + g.hazePerM * behind);
  if (k > 0) c.lerp(grade.hazeColor, k);
  return c;
}
