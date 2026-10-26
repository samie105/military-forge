/**
 * The kit as static, merged geometry: every placement of every piece in a layer becomes one
 * BufferGeometry, so the whole Street Market (81 placements, ~36K triangles) costs one draw call
 * per depth layer instead of one per (piece, flip) pair. Triangles are cheap at this count (docs/11
 * §3: ≤ 150K visible on Low); draw calls are what an iGPU runs out of first.
 *
 * Per vertex, at load: placement transform (mirrored pieces get their winding reversed, so the
 * single-sided kit material stays single-sided), the layer's colour grade (grade.ts) and a
 * box-projected world UV for the tiling weathering map.
 */
import { BufferAttribute, BufferGeometry, Color, Matrix3, Matrix4, Vector3, type Mesh, type Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gradeVertex, type MapGrade } from './grade';
import { placementMatrix, type KitLayer, type LayoutItem } from './layout';

export interface KitPiece {
  name: string;
  layer: KitLayer;
  /** piece space: pivot at the origin, x right, y up, z toward the camera */
  geometry: BufferGeometry;
  extras: Record<string, unknown>;
}

const LAYERS: readonly KitLayer[] = ['gameplay', 'mid', 'far', 'glow'];

/**
 * The pieces of a loaded kit GLB, by node name. Each top-level node is one piece (W8's kit
 * convention); its meshes are baked into one piece-space geometry. glTF node extras arrive as
 * `userData` (layer, collision, adSlot, …).
 */
export function kitPieces(root: Object3D): Map<string, KitPiece> {
  root.updateMatrixWorld(true);
  const toRoot = new Matrix4().copy(root.matrixWorld).invert();
  const pieces = new Map<string, KitPiece>();
  for (const node of root.children) {
    const parts: BufferGeometry[] = [];
    node.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry.clone();
      g.applyMatrix4(new Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld));
      parts.push(g);
    });
    if (!parts.length) continue;
    const geometry = parts.length === 1 ? parts[0]! : mergeGeometries(parts);
    if (!geometry) continue;
    const extras = node.userData as Record<string, unknown>;
    const layer = LAYERS.includes(extras.layer as KitLayer) ? (extras.layer as KitLayer) : 'gameplay';
    pieces.set(node.name, { name: node.name, layer, geometry, extras });
  }
  return pieces;
}

export interface MergeOptions {
  grade?: MapGrade;
  /** world metres per tile of the weathering map (0: no UVs) */
  uvTile?: number;
}

/**
 * One geometry with every placement of `items` whose piece is in `layer`. Unknown pieces are
 * skipped (and reported through `missing`).
 */
export function mergeLayer(pieces: ReadonlyMap<string, KitPiece>, items: readonly LayoutItem[], layer: KitLayer, opts: MergeOptions = {}, missing?: Set<string>): BufferGeometry | null {
  const placed: { piece: KitPiece; item: LayoutItem }[] = [];
  let vertices = 0;
  let indices = 0;
  for (const item of items) {
    const piece = pieces.get(item.piece);
    if (!piece) {
      missing?.add(item.piece);
      continue;
    }
    if (piece.layer !== layer) continue;
    placed.push({ piece, item });
    const n = piece.geometry.attributes.position!.count;
    vertices += n;
    indices += piece.geometry.index?.count ?? n;
  }
  if (!placed.length) return null;

  const pos = new Float32Array(vertices * 3);
  const nor = new Float32Array(vertices * 3);
  const col = new Float32Array(vertices * 3);
  const uv = opts.uvTile ? new Float32Array(vertices * 2) : null;
  const idx = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices);
  const m = new Matrix4();
  const nm = new Matrix3();
  const p = new Vector3();
  const n = new Vector3();
  const c = new Color();
  const inv = opts.uvTile ? 1 / opts.uvTile : 0;
  let v0 = 0;
  let i0 = 0;
  for (const { piece, item } of placed) {
    placementMatrix(item, m);
    nm.getNormalMatrix(m);
    const g = piece.geometry;
    const gp = g.attributes.position!;
    const gn = g.attributes.normal;
    const gc = g.attributes.color;
    for (let i = 0; i < gp.count; i++) {
      p.fromBufferAttribute(gp, i).applyMatrix4(m);
      if (gn) n.fromBufferAttribute(gn, i).applyMatrix3(nm).normalize();
      else n.set(0, 0, 1);
      if (gc) c.setRGB(gc.getX(i), gc.getY(i), gc.getZ(i));
      else c.setRGB(1, 1, 1);
      if (opts.grade && layer !== 'glow') gradeVertex(c, opts.grade, layer, p.y, p.z, n.y);
      const o = (v0 + i) * 3;
      pos[o] = p.x;
      pos[o + 1] = p.y;
      pos[o + 2] = p.z;
      nor[o] = n.x;
      nor[o + 1] = n.y;
      nor[o + 2] = n.z;
      col[o] = c.r;
      col[o + 1] = c.g;
      col[o + 2] = c.b;
      if (uv) {
        const ax = Math.abs(n.x);
        const ay = Math.abs(n.y);
        const az = Math.abs(n.z);
        const t = (v0 + i) * 2;
        // walls facing the camera map (x, y); floors and roofs (x, z); side walls (z, y)
        if (az >= ax && az >= ay) {
          uv[t] = p.x * inv;
          uv[t + 1] = p.y * inv;
        } else if (ay >= ax) {
          uv[t] = p.x * inv;
          uv[t + 1] = p.z * inv;
        } else {
          uv[t] = p.z * inv;
          uv[t + 1] = p.y * inv;
        }
      }
    }
    const gi = g.index;
    const count = gi?.count ?? gp.count;
    for (let k = 0; k < count; k += 3) {
      const a = gi ? gi.getX(k) : k;
      const b = gi ? gi.getX(k + 1) : k + 1;
      const d = gi ? gi.getX(k + 2) : k + 2;
      idx[i0 + k] = v0 + a;
      // a mirror flips the winding: swap two corners so the front stays the front
      idx[i0 + k + 1] = v0 + (item.flip ? d : b);
      idx[i0 + k + 2] = v0 + (item.flip ? b : d);
    }
    v0 += gp.count;
    i0 += count;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(pos, 3));
  out.setAttribute('normal', new BufferAttribute(nor, 3));
  out.setAttribute('color', new BufferAttribute(col, 3));
  if (uv) out.setAttribute('uv', new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(idx, 1));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

export interface ContactShadow {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/**
 * Footprints where a placed piece meets the ground (y = 0): its vertices within `height` of the
 * floor, split into runs along x wherever there is a gap wider than `gap` (a stall's legs, a
 * minibus's wheels, a house's wall). Pieces that don't rise above the floor (ground slabs) and
 * pieces placed off the floor have none.
 */
export function contactFootprints(piece: KitPiece, item: LayoutItem, height = 0.45, gap = 0.9): ContactShadow[] {
  if ((item.y ?? 0) !== 0) return [];
  const g = piece.geometry;
  const gp = g.attributes.position!;
  g.computeBoundingBox();
  if (g.boundingBox!.max.y < 0.3) return [];
  const pts: { x: number; z: number }[] = [];
  for (let i = 0; i < gp.count; i++) {
    const y = gp.getY(i);
    if (y < -0.01 || y > height) continue;
    pts.push({ x: item.flip ? -gp.getX(i) : gp.getX(i), z: gp.getZ(i) });
  }
  if (!pts.length) return [];
  pts.sort((a, b) => a.x - b.x);
  const runs: ContactShadow[] = [];
  let run: ContactShadow | null = null;
  for (const q of pts) {
    if (run && q.x - run.x1 <= gap) {
      run.x1 = q.x;
      run.z0 = Math.min(run.z0, q.z);
      run.z1 = Math.max(run.z1, q.z);
    } else {
      run = { x0: q.x, x1: q.x, z0: q.z, z1: q.z };
      runs.push(run);
    }
  }
  const z = item.z ?? 0;
  return runs.map((r) => ({ x0: item.x + r.x0, x1: item.x + r.x1, z0: z + r.z0, z1: z + r.z1 }));
}
