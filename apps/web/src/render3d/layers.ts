/**
 * Depth layers around the gameplay plane (docs/11 §2):
 *   z −46        sky gradient card
 *   z −38…−22    far skyline cards (unlit, one InstancedMesh), parallax for free via perspective
 *   z −9…−3      mid-depth blocks (one InstancedMesh) on a ground plane behind the band
 *   z +3.2       foreground railings that dither-fade while a player is behind them on screen
 * The dressing is generated from a hash of the map, so it is identical on every load. Real maps
 * replace it with W8's kit pieces; the movement-test map has no kit.
 */
import type { MapDef } from '@military-forge/content';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  PlaneGeometry,
  type Material,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlayerView } from '../view';
import type { LightingPreset } from './lighting';
import { PLANE_BACK_Z } from './mapGeometry';

/** Deterministic 0…1 hash (dressing layout must not depend on Math.random). */
export function hash01(i: number, salt: number): number {
  let h = (Math.imul(i, 374761393) + Math.imul(salt, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Where a rectangle at depth z appears on the z = 0 plane, seen from a camera at (cx, cy, cz). */
export function projectToPlane(r: Rect, z: number, cx: number, cy: number, cz: number, out: Rect): Rect {
  const k = cz / (cz - z);
  out.x0 = cx + (r.x0 - cx) * k;
  out.x1 = cx + (r.x1 - cx) * k;
  out.y0 = cy + (r.y0 - cy) * k;
  out.y1 = cy + (r.y1 - cy) * k;
  return out;
}

/** True when the on-plane rectangle covers any living player's body (with `pad` metres of slack). */
export function coversPlayer(r: Rect, players: readonly PlayerView[], pad = 0.25): boolean {
  for (const p of players) {
    if (!p.alive) continue;
    if (p.x + 0.45 > r.x0 - pad && p.x - 0.45 < r.x1 + pad && p.y + 1.6 > r.y0 - pad && p.y < r.y1 + pad) return true;
  }
  return false;
}

export interface ForegroundProp {
  mesh: Mesh;
  material: MeshLambertMaterial;
  bounds: Rect;
  z: number;
  opacity: number;
}

export interface DepthLayers {
  /** sky, far, mid and ground: static */
  background: Group;
  foreground: ForegroundProp[];
  foregroundGroup: Group;
  materials: Material[];
}

const FORE_Z = 3.2;
const FORE_SPACING = 14;
/** faded foreground opacity: still visible as a hint, never hides a player (docs/01 §5) */
export const FORE_FADED = 0.3;

function skyCard(light: LightingPreset, cx: number, width: number): Mesh {
  // three rows: top, horizon, below the horizon
  const ys = [160, 8, -120];
  const top = new Color(light.sky[0]);
  const horizon = new Color(light.sky[1]);
  const pos: number[] = [];
  const col: number[] = [];
  ys.forEach((y, row) => {
    for (const x of [cx - width / 2, cx + width / 2]) {
      pos.push(x, y, -46);
      const c = row === 0 ? top : horizon;
      col.push(c.r, c.g, c.b);
    }
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex([0, 2, 3, 0, 3, 1, 2, 4, 5, 2, 5, 3]);
  return new Mesh(g, new MeshBasicMaterial({ vertexColors: true, fog: false, depthWrite: false }));
}

export function buildDepthLayers(map: MapDef, light: LightingPreset): DepthLayers {
  const b = map.bounds;
  const cx = (b.minX + b.maxX) / 2;
  const width = b.maxX - b.minX;
  const background = new Group();
  background.name = 'depth-layers';
  const pal = light.palette;
  const m = new Matrix4();

  const sky = skyCard(light, cx, width + 500);
  sky.renderOrder = -10;

  const groundMat = new MeshLambertMaterial({ color: pal.ground });
  const ground = new Mesh(new PlaneGeometry(width + 400, 70), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(cx, -0.02, PLANE_BACK_Z - 35);
  ground.receiveShadow = true;

  // mid depth: blocky buildings/cliffs behind the band
  // lifted shadow side: the background stays low-contrast (docs/11 §4)
  const midMat = new MeshLambertMaterial({ emissive: pal.far, emissiveIntensity: 0.35 });
  const midCount = Math.ceil((width + 80) / 7);
  const mid = new InstancedMesh(new BoxGeometry(1, 1, 1).translate(0, 0.5, 0), midMat, midCount);
  for (let i = 0; i < midCount; i++) {
    const w = 3 + 4 * hash01(i, 1);
    const h = 2.5 + 8 * hash01(i, 2) ** 2;
    const d = 2.5 + 3 * hash01(i, 3);
    const z = -3 - d / 2 - 4 * hash01(i, 4);
    mid.setMatrixAt(i, m.makeScale(w, h, d).setPosition(b.minX - 40 + i * 7 + 2 * hash01(i, 5), 0, z));
    mid.setColorAt(i, new Color(pal.mid[i % pal.mid.length]!));
  }

  // far skyline: unlit cards, fogged toward the horizon
  const farMat = new MeshBasicMaterial({ color: pal.far });
  const farCount = Math.ceil((width + 200) / 9);
  const far = new InstancedMesh(new PlaneGeometry(1, 1).translate(0, 0.5, 0), farMat, farCount);
  for (let i = 0; i < farCount; i++) {
    const w = 5 + 6 * hash01(i, 6);
    const h = 7 + 20 * hash01(i, 7);
    far.setMatrixAt(i, m.makeScale(w, h, 1).setPosition(b.minX - 100 + i * 9, -2, -24 - 14 * hash01(i, 8)));
  }
  // named: map environments pick these by name (environment/index.ts)
  sky.name = 'sky';
  far.name = 'far-skyline';
  ground.name = 'ground';
  mid.name = 'mid-blocks';
  background.add(sky, far, ground, mid);

  // foreground railings: two posts reaching below the view and two rails, merged per railing
  const parts = [
    new BoxGeometry(0.1, 9, 0.1).translate(-1.1, -3.6, 0),
    new BoxGeometry(0.1, 9, 0.1).translate(1.1, -3.6, 0),
    new BoxGeometry(2.6, 0.08, 0.08).translate(0, 0.85, 0),
    new BoxGeometry(2.6, 0.08, 0.08).translate(0, 0.4, 0),
  ];
  const railing = mergeGeometries(parts)!;
  const foregroundGroup = new Group();
  foregroundGroup.name = 'foreground';
  const foreground: ForegroundProp[] = [];
  for (let i = 0, x = b.minX + 9; x < b.maxX - 4; i++, x += FORE_SPACING * (0.8 + 0.4 * hash01(i, 9))) {
    const material = new MeshLambertMaterial({ color: pal.fore, alphaHash: true });
    const mesh = new Mesh(railing, material);
    mesh.position.set(x, 0, FORE_Z);
    foregroundGroup.add(mesh);
    foreground.push({ mesh, material, bounds: { x0: x - 1.2, y0: -8, x1: x + 1.2, y1: 0.95 }, z: FORE_Z, opacity: 1 });
  }
  return {
    background,
    foreground,
    foregroundGroup,
    materials: [sky.material as Material, groundMat, midMat, farMat, ...foreground.map((f) => f.material)],
  };
}

const scratch: Rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

/** Eases each foreground prop toward FORE_FADED while it covers a player on screen, else opaque. */
export function updateForeground(props: readonly ForegroundProp[], players: readonly PlayerView[], cam: { x: number; y: number; z: number }, dt: number): void {
  const k = 1 - Math.exp(-dt * 12);
  for (const f of props) {
    const target = coversPlayer(projectToPlane(f.bounds, f.z, cam.x, cam.y, cam.z, scratch), players) ? FORE_FADED : 1;
    f.opacity += (target - f.opacity) * k;
    f.material.opacity = f.opacity;
  }
}
