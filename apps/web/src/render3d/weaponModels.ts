/**
 * W8's weapon models in the hands (assets/weapons/<id>.glb, docs/04 §9.4: origin at the grip,
 * +Y toward the muzzle, +Z up, attached to socket_weapon_R/L with an identity transform). Their
 * sockets come from the Forge's `weapons/sockets.json` (`muzzle`: flashes and tracers leave it;
 * `offhand`: the support hand's IK target; `eject`, family and aim pose for later), else from the
 * GLB's own nodes. Until a weapon's GLB loads, or if it fails, the avatar keeps its placeholder box.
 *
 * Two kinds of gun come in: the scripted ones carry their colours as vertex colours (COLOR_0); the
 * scans (the Forge's build_gun_scan) carry a 256² albedo texture on TEXCOORD_0 and no colours. A
 * scan keeps its texture on a toon material of its own; both keep the `_CAMO` panel attribute.
 */
import { weapons } from '@military-forge/content';
import { BufferAttribute, BufferGeometry, Mesh, Vector3, type Material, type MeshStandardMaterial, type Object3D, type Texture } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

/** The materials a weapon GLB is drawn with: by vertex colour, by its own texture, or plain (neither). */
export interface GunMaterials {
  vertexColors: Material;
  /** a toon material with `map` (one per scanned gun's albedo) */
  textured(map: Texture): Material;
  plain: Material;
}

export interface WeaponModel {
  geometry: BufferGeometry;
  /** socket space (+Y muzzle, +Z top): where the barrel ends */
  muzzle: Vector3;
  /** where a two-handed weapon's support hand goes */
  offhand: Vector3;
  material: Material;
  /** the rest of sockets.json's entry, when there is one (hold poses, casings, attachments) */
  sockets?: WeaponSockets;
}

/** One weapon's entry in sockets.json (weapon frame, metres). */
export interface WeaponSockets {
  family: string | null;
  aimPose: string | null;
  hands: number | null;
  muzzle: { pos: Vector3; dir: Vector3; boreRadius: number } | null;
  offhand: Vector3 | null;
  eject: { pos: Vector3; dir: Vector3 } | null;
}

const vec = (v: unknown): Vector3 | null => (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? new Vector3(v[0], v[1], v[2]) : null);
const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The Forge's sockets.json, by weapon id (bad entries are skipped: the GLB's nodes stand in). */
export function parseSockets(json: unknown): Map<string, WeaponSockets> {
  const out = new Map<string, WeaponSockets>();
  for (const [id, raw] of Object.entries(rec(rec(json)?.weapons) ?? {})) {
    const w = rec(raw);
    const s = rec(w?.sockets);
    if (!w || !s) continue;
    const muzzle = rec(s.muzzle);
    const eject = rec(s.eject);
    const mPos = vec(muzzle?.pos);
    const ePos = vec(eject?.pos);
    out.set(id, {
      family: typeof w.family === 'string' ? w.family : null,
      aimPose: typeof w.aimPose === 'string' ? w.aimPose : null,
      hands: typeof w.hands === 'number' ? w.hands : null,
      muzzle: mPos ? { pos: mPos, dir: vec(muzzle?.dir) ?? new Vector3(0, 1, 0), boreRadius: typeof muzzle?.boreRadius === 'number' ? muzzle.boreRadius : 0.015 } : null,
      offhand: vec(rec(s.offhand)?.pos),
      eject: ePos ? { pos: ePos, dir: vec(eject?.dir) ?? new Vector3(1, 0, 0) } : null,
    });
  }
  return out;
}

/** Fetches sockets.json; an empty map when it's missing or unusable. */
export async function loadSockets(baseUrl: string): Promise<Map<string, WeaponSockets>> {
  try {
    const res = await fetch(`${baseUrl}assets/weapons/sockets.json`);
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return new Map();
    return parseSockets(await res.json());
  } catch {
    return new Map();
  }
}

/** the default support-hand target: docs/04 §4.1 socket_offhand_IK, 0.07 m along +Y and 0.02 m up */
export const DEFAULT_OFFHAND = new Vector3(0, 0.07, 0.02);

/**
 * The GLB's first mesh baked into the file's root frame, with plain float position, normal and
 * colour attributes (meshopt and quantisation store normalised integers). Null without a mesh.
 */
/** The GLB's first mesh, with world matrices up to date. */
function firstMesh(gltf: GLTF): Mesh | null {
  gltf.scene.updateMatrixWorld(true);
  let mesh: Mesh | null = null;
  gltf.scene.traverse((o) => {
    if (!mesh && (o as Mesh).isMesh) mesh = o as Mesh;
  });
  return mesh;
}

/** Attributes kept from a GLB mesh: colours (scripted guns), UVs (scans' albedo), `_camo` (camo panels). */
const KEPT = ['position', 'normal', 'color', 'uv', '_camo'] as const;

export function bakeGltfMesh(gltf: GLTF): BufferGeometry | null {
  const mesh = firstMesh(gltf);
  if (!mesh) return null;
  const src = mesh.geometry;
  const geometry = new BufferGeometry();
  for (const name of KEPT) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const size = name === 'color' ? 3 : a.itemSize;
    const out = new Float32Array(a.count * size);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < size; c++) out[i * size + c] = a.getComponent(i, c);
    geometry.setAttribute(name, new BufferAttribute(out, size));
  }
  if (src.index) geometry.setIndex(Array.from(src.index.array as ArrayLike<number>));
  geometry.applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** A node's position in the GLB root frame, or null. */
export function nodePosition(root: Object3D, name: string): Vector3 | null {
  const node = root.getObjectByName(name);
  return node ? node.getWorldPosition(new Vector3()) : null;
}

/**
 * A hand weapon from its GLB, its sockets from sockets.json when given, else from the GLB's nodes
 * (the muzzle falls back to the barrel's tip, the off hand to socket_offhand_IK's spot).
 */
/**
 * The material for a baked gun: its GLB texture when it has one and UVs (a scan), else vertex
 * colours (a scripted gun), else plain (never black: no colour attribute reads as 0 in WebGL).
 */
function gunMaterial(gltf: GLTF, geometry: BufferGeometry, materials: GunMaterials): Material {
  const map = (firstMesh(gltf)?.material as MeshStandardMaterial | undefined)?.map ?? null;
  if (map && geometry.getAttribute('uv')) return materials.textured(map);
  return geometry.getAttribute('color') ? materials.vertexColors : materials.plain;
}

export function weaponFromGltf(gltf: GLTF, materials: GunMaterials | Material, sockets?: WeaponSockets): WeaponModel | null {
  const geometry = bakeGltfMesh(gltf);
  if (!geometry) return null;
  const box = geometry.boundingBox!;
  return {
    geometry,
    muzzle: sockets?.muzzle?.pos.clone() ?? nodePosition(gltf.scene, 'muzzle') ?? new Vector3(0, box.max.y, (box.min.z + box.max.z) / 2),
    offhand: sockets?.offhand?.clone() ?? nodePosition(gltf.scene, 'offhand') ?? DEFAULT_OFFHAND.clone(),
    material: 'isMaterial' in materials ? materials : gunMaterial(gltf, geometry, materials),
    ...(sockets ? { sockets } : {}),
  };
}

/** the part of GLTFLoader the kit uses (tests pass a stub) */
export interface GltfSource {
  loadAsync(url: string): Promise<GLTF>;
}

/**
 * Loads every content weapon's GLB (by `WeaponDef.id`) and sockets.json. Each model is handed to
 * `onModel` as it arrives; a failed one is skipped (its placeholder stays). Resolves when all have
 * settled.
 */
export async function loadWeaponModels(baseUrl: string, loader: GltfSource, materials: GunMaterials, onModel: (def: number, model: WeaponModel) => void): Promise<void> {
  const sockets = loadSockets(baseUrl);
  await Promise.all(
    weapons.map((def) =>
      loader.loadAsync(`${baseUrl}assets/weapons/${def.id}.glb`).then(
        async (gltf) => {
          const model = weaponFromGltf(gltf, materials, (await sockets).get(def.id));
          if (model) onModel(def.index, model);
        },
        (err: unknown) => console.warn(`render3d: ${def.id}.glb failed to load, keeping its placeholder`, err),
      ),
    ),
  );
}
