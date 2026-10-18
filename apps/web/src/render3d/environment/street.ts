/**
 * The ground around the gameplay band (docs/11 §2):
 * - in front (z > +1): a kerb, a gutter, the road and the near pavement. The camera looks down 5°,
 *   so the street fills the screen below the market's ground line, which no player can reach (the
 *   play space ends at y = 0). The near pavement slopes away gently so it reaches the bottom edge
 *   of the view inside the camera's near plane (z ≤ +12) at every zoom;
 * - behind (z < −1): the yard the mid-depth blocks stand on, fading into the haze.
 * Both are one vertex-coloured mesh each, lit like the kit and weathered with the same tiling map.
 */
import { Color } from 'three';
import type { EnvironmentLook } from './looks';
import { QuadBuilder } from './shapes';
import { hash2 } from './textures';

/** where the kit's pavement ends and the street begins (W8's ground piece runs to z +1.11) */
export const KERB_Z = 1.1;
const KERB_TOP_Z = 1.36;
const KERB_DROP = 0.17;
const GUTTER_Z = 1.75;
const ROAD_FAR_Z = 5.4;
const NEAR_KERB_Z = 5.7;
const FLAT_Z = 8.6;
const NEAR_EDGE_Z = 12.3;
const NEAR_EDGE_Y = -1.25;

/** Height of the street surface at depth z (z ≥ KERB_Z), for placing props on it. */
export function streetHeight(z: number): number {
  if (z < KERB_TOP_Z) return 0;
  if (z < NEAR_KERB_Z) return -KERB_DROP;
  if (z < FLAT_Z) return 0;
  return (NEAR_EDGE_Y * (Math.min(z, NEAR_EDGE_Z) - FLAT_Z)) / (NEAR_EDGE_Z - FLAT_Z);
}

export function buildStreet(look: EnvironmentLook, x0: number, x1: number): QuadBuilder {
  const s = look.street;
  const q = new QuadBuilder(4);
  const kerb = new Color(s.kerb);
  const kerbAlt = new Color(s.kerbAlt);
  const step = 1.2;
  // kerb stones, painted in alternating blocks (low contrast: the gameplay plane stays louder)
  for (let i = 0, x = x0; x < x1; i++, x += step) {
    const c = i % 2 ? kerbAlt : kerb;
    const wear = 0.9 + 0.12 * hash2(i, 0, 5);
    const xe = Math.min(x1, x + step);
    q.quad([x, 0, KERB_TOP_Z], [xe, 0, KERB_TOP_Z], [xe, 0, KERB_Z], [x, 0, KERB_Z], c, [wear, wear, wear, wear]);
    q.quad([x, -KERB_DROP, KERB_TOP_Z], [xe, -KERB_DROP, KERB_TOP_Z], [xe, 0, KERB_TOP_Z], [x, 0, KERB_TOP_Z], c, [wear * 0.78, wear * 0.78, wear * 0.86, wear * 0.86], 'xy');
  }
  // the gutter, then the road in 6 m slabs whose tone varies a little (patched tarmac)
  const asphalt = new Color(s.asphalt);
  const gutter = new Color(s.gutter);
  const y = -KERB_DROP;
  for (let i = 0, x = x0; x < x1; i++, x += 6) {
    const xe = Math.min(x1, x + 6);
    q.quad([x, y, GUTTER_Z], [xe, y, GUTTER_Z], [xe, y, KERB_TOP_Z], [x, y, KERB_TOP_Z], gutter, [0.85, 0.85, 0.7, 0.7]);
    const t = 0.93 + 0.12 * hash2(i, 1, 9);
    q.quad([x, y, ROAD_FAR_Z], [xe, y, ROAD_FAR_Z], [xe, y, GUTTER_Z], [x, y, GUTTER_Z], asphalt, [t, t, t * 0.97, t * 0.97]);
    // the near lane meets the near kerb in a darker band of grit
    q.quad([x, y, NEAR_KERB_Z], [xe, y, NEAR_KERB_Z], [xe, y, ROAD_FAR_Z], [x, y, ROAD_FAR_Z], asphalt, [t * 0.8, t * 0.8, t, t]);
  }
  // the centre line: faded dashes
  const marking = new Color(s.marking);
  for (let x = Math.ceil(x0 / 7) * 7; x < x1 - 3; x += 7) {
    const z = 3.45;
    q.quad([x, y + 0.004, z + 0.07], [x + 3, y + 0.004, z + 0.07], [x + 3, y + 0.004, z - 0.07], [x, y + 0.004, z - 0.07], marking, [0.72, 0.72, 0.72, 0.72]);
  }
  // the near kerb (its top: the face toward the market is never seen) and the near pavement
  const pavement = new Color(s.pavement);
  for (let i = 0, x = x0; x < x1; i++, x += step) {
    const xe = Math.min(x1, x + step);
    q.quad([x, 0, FLAT_Z - 2.6], [xe, 0, FLAT_Z - 2.6], [xe, 0, NEAR_KERB_Z], [x, 0, NEAR_KERB_Z], i % 2 ? kerbAlt : kerb, [0.9, 0.9, 0.9, 0.9]);
  }
  // the near pavement: staggered slabs with dark joints, each slab its own tone, darkening toward
  // the bottom of the frame (it is the foreground: keep it quiet)
  const joint = pavement.clone().multiplyScalar(0.55);
  const rows = [FLAT_Z - 2.6, FLAT_Z - 1.3, FLAT_Z, FLAT_Z + 1.25, FLAT_Z + 2.5, NEAR_EDGE_Z];
  for (let x = x0; x < x1; x += 12) {
    const xe = Math.min(x1, x + 12);
    q.quad([x, 0, FLAT_Z], [xe, 0, FLAT_Z], [xe, 0, FLAT_Z - 2.6], [x, 0, FLAT_Z - 2.6], joint);
    q.quad([x, NEAR_EDGE_Y, NEAR_EDGE_Z], [xe, NEAR_EDGE_Y, NEAR_EDGE_Z], [xe, 0, FLAT_Z], [x, 0, FLAT_Z], joint);
    // a face below the near edge, in case a very wide zoom looks under it
    q.quad([x, NEAR_EDGE_Y - 30, NEAR_EDGE_Z], [xe, NEAR_EDGE_Y - 30, NEAR_EDGE_Z], [xe, NEAR_EDGE_Y, NEAR_EDGE_Z], [x, NEAR_EDGE_Y, NEAR_EDGE_Z], pavement, [0.3, 0.3, 0.45, 0.45], 'xy');
  }
  const gap = 0.03;
  const lift = 0.006;
  for (let r = 0; r + 1 < rows.length; r++) {
    const za = rows[r]! + gap;
    const zb = rows[r + 1]! - gap;
    const ya = streetHeight(za) + lift;
    const yb = streetHeight(zb) + lift;
    const dark = 1 - 0.09 * r;
    const slab = 1.5;
    for (let i = 0, x = x0 - (r % 2) * slab * 0.5; x < x1; i++, x += slab) {
      const t = dark * (0.88 + 0.17 * hash2(i, r, 21));
      const xa = Math.max(x0, x + gap);
      const xb = Math.min(x1, x + slab - gap);
      if (xb <= xa) continue;
      q.quad([xa, yb, zb], [xb, yb, zb], [xb, ya, za], [xa, ya, za], pavement, [t * 0.96, t * 0.96, t, t]);
    }
  }
  return q;
}

/** The yard behind the band: from the back of the kit's ground (z −1) to deep in the haze. */
export function buildBackGround(look: EnvironmentLook, x0: number, x1: number, depth = 80): QuadBuilder {
  const q = new QuadBuilder(5);
  const near = new Color(look.street.backGround);
  const haze = new Color(look.grade.haze);
  const rows = [-0.98, -4, -9, -16, -26, -40, -depth];
  for (let r = 0; r + 1 < rows.length; r++) {
    const za = rows[r]!;
    const zb = rows[r + 1]!;
    const ca = near.clone().lerp(haze, Math.min(0.85, -za / 55));
    const cb = near.clone().lerp(haze, Math.min(0.85, -zb / 55));
    for (let x = x0; x < x1; x += 20) {
      const xe = Math.min(x1, x + 20);
      // the far edge hazier than the near one
      q.quad([x, -0.01, za], [xe, -0.01, za], [xe, -0.01, zb], [x, -0.01, zb], [ca, ca, cb, cb]);
    }
  }
  return q;
}
