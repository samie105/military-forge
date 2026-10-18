/**
 * Procedural props that dress a kit map beyond its pieces: street lamps in the foreground (they
 * dither-fade while a player is behind them, docs/01 §5), and the contact shadows that ground the
 * kit on Low and Medium, where there is no shadow map (docs/11 §2).
 */
import { BufferGeometry, InstancedMesh, Matrix4, MeshBasicMaterial, PlaneGeometry, type Texture } from 'three';
import type { ContactShadow } from './merge';
import { box, merge, post } from './shapes';

/** A street lamp standing at the origin, its arm reaching over the road toward the market (−z). */
export function streetLampGeometry(paint = 0x3d4440, lamp = 0xd9d2bf): BufferGeometry {
  return merge([
    box(-0.2, 0, -0.2, 0.2, 0.55, 0.2, paint, 0.75),
    post(0, 0.5, 0, 6.1, 0.075, paint, 8),
    box(-0.05, 6.45, -1.7, 0.05, 6.55, 0.05, paint),
    box(-0.04, 6.25, -0.35, 0.04, 6.47, 0.05, paint),
    box(-0.16, 6.3, -1.95, 0.16, 6.5, -1.45, paint),
    box(-0.13, 6.26, -1.9, 0.13, 6.31, -1.5, lamp),
  ]);
}

/**
 * Every contact shadow as one instanced quad (one draw call): a soft rectangle a little larger
 * than the footprint, just above the floor.
 */
export function contactShadows(footprints: readonly ContactShadow[], alpha: Texture, color: number, opacity: number, pad = 0.35): InstancedMesh {
  const geo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mat = new MeshBasicMaterial({ color, alphaMap: alpha, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new InstancedMesh(geo, mat, Math.max(1, footprints.length));
  mesh.count = footprints.length;
  const m = new Matrix4();
  footprints.forEach((f, i) => {
    const w = f.x1 - f.x0 + 2 * pad;
    const d = Math.max(0.6, f.z1 - f.z0 + 2 * pad);
    m.makeScale(w, 1, d).setPosition((f.x0 + f.x1) / 2, 0.012, (f.z0 + f.z1) / 2);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.name = 'contact-shadows';
  mesh.renderOrder = -1;
  return mesh;
}
