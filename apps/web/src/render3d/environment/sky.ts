/**
 * The far background (docs/11 §2, z −40 and beyond): a sky gradient card and a soft sun glow, unlit
 * and out of the fog. It sits deep enough that perspective gives it a slow parallax. Backdrop art
 * (skyline cards) goes in front of it.
 */
import { AdditiveBlending, BufferAttribute, BufferGeometry, Color, Mesh, MeshBasicMaterial, PlaneGeometry, type Texture } from 'three';
import type { EnvironmentLook } from './looks';

export const SKY_Z = -72;

/** A vertical gradient through the look's stops, wide and tall enough for every zoom. */
export function skyGradient(look: EnvironmentLook, cx: number, halfWidth = 170, bottom = -60, top = 120): Mesh<BufferGeometry, MeshBasicMaterial> {
  const heights = [bottom, ...look.skyHeights, top];
  const stops = look.skyStops.map((h) => new Color(h));
  const colours = [stops[0]!, ...stops, stops[2]!];
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  heights.forEach((y, row) => {
    for (const x of [cx - halfWidth, cx + halfWidth]) {
      pos.push(x, y, SKY_Z);
      const c = colours[row]!;
      col.push(c.r, c.g, c.b);
    }
    if (row > 0) {
      const a = (row - 1) * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(idx);
  const mesh = new Mesh(g, new MeshBasicMaterial({ vertexColors: true, fog: false, depthWrite: false }));
  mesh.name = 'sky';
  mesh.renderOrder = -20;
  mesh.frustumCulled = false;
  return mesh;
}

/** The sun's glow on the sky (additive). */
export function sunGlow(look: EnvironmentLook, glow: Texture): Mesh<BufferGeometry, MeshBasicMaterial> {
  const g = look.sunGlow;
  const mesh = new Mesh(
    new PlaneGeometry(g.size, g.size),
    new MeshBasicMaterial({ color: new Color(g.color).multiplyScalar(g.strength), alphaMap: glow, transparent: true, blending: AdditiveBlending, depthWrite: false, fog: false }),
  );
  mesh.position.set(g.x, g.y, SKY_Z + 0.5);
  mesh.name = 'sun-glow';
  mesh.renderOrder = -19;
  return mesh;
}
