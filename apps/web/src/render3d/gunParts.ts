/**
 * A gun's moving parts (the owner, 18 Oct: "a pump, bolt, slide or cylinder moving" when it fires).
 * The weapon GLB has them as nodes `part_slide`, `part_pump`, `part_bolt` and `part_cylinder`, each
 * over its own mesh with its pivot at the node (forge-sling-sockets.md), and the motion in the
 * node's extras:
 *   axis    [x, y, z], unit, weapon frame (+Y muzzle, +Z up): a slide, pump or bolt travels back
 *           along it; the cylinder turns about it, through the node's origin
 *   travel  metres back (slide, pump, bolt)
 *   angle   degrees a shot (cylinder; default 60, six chambers)
 *   lift    degrees the bolt's handle turns up about `axis` before it comes back (default 60)
 *   cutClean  true once the Forge has capped the part's cut and closed its shell. Only such a part
 *           moves (review-art-stacks.md N1: an open cut tears when it moves); any other stays put,
 *           baked into the gun as on main
 * After each shot, inside the gun's interval:
 *   slide     blowback: back and home in about 0.1 s
 *   pump      back (the shell flies out at the back of the stroke, ~0.25 s), then forward
 *   bolt      up, back (the case flies out, ~0.35 s), forward, down
 *   cylinder  on one chamber, just after the shot
 * Any other part (`part_mag`…) is baked into the gun and stays still, as does a part without a
 * usable axis or without `cutClean`. A gun without parts skips all this. On Low the parts stay still, merged into the gun
 * (`withPartsAtRest`): no draws beyond the gun's own.
 */
import type { WeaponDef } from '@military-forge/content';
import { BufferGeometry, Matrix4, Mesh, Quaternion, Vector3, type Material, type Object3D } from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

export type PartKind = 'slide' | 'pump' | 'bolt' | 'cylinder';
export const PART_KINDS: readonly PartKind[] = ['slide', 'pump', 'bolt', 'cylinder'];

export interface GunPart {
  kind: PartKind;
  /** the part's meshes, baked in its node's frame */
  geometry: BufferGeometry;
  /** the node at rest, in the weapon frame */
  position: Vector3;
  quaternion: Quaternion;
  /** unit, weapon frame */
  axis: Vector3;
  /** m back (slide, pump, bolt), or rad a shot (cylinder) */
  travel: number;
  /** rad the bolt's handle turns up first (bolt only, else 0) */
  lift: number;
}

const DEG = Math.PI / 180;
const DEFAULT_TRAVEL = 0.03;
const DEFAULT_ANGLE = 60;
const DEFAULT_LIFT = 60;

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const vec3 = (v: unknown): Vector3 | null => (Array.isArray(v) && v.length === 3 && v.every(finite) ? new Vector3(v[0], v[1], v[2]) : null);

/** The moving kind a node's name gives (`part_pump` → 'pump'), or null. */
export function partKind(o: Object3D): PartKind | null {
  if (!o.name.startsWith('part_')) return null;
  const kind = o.name.slice(5) as PartKind;
  return PART_KINDS.includes(kind) ? kind : null;
}

/**
 * Baked pieces as one geometry: those whose attributes match the first one's (others are left out),
 * all indexed or none. Null when there are none.
 */
export function mergeBaked(pieces: readonly BufferGeometry[]): BufferGeometry | null {
  if (pieces.length <= 1) return pieces[0] ?? null;
  const names = (g: BufferGeometry) => Object.keys(g.attributes).sort().join(',');
  const key = names(pieces[0]!);
  let same = pieces.filter((g) => names(g) === key);
  if (same.some((g) => !g.index)) same = same.map((g) => (g.index ? g.toNonIndexed() : g));
  return mergeGeometries(same) ?? pieces[0]!;
}

/**
 * The GLB's moving parts (`bake`: a mesh's attributes as plain floats, moved by `frame`), and their
 * nodes (the gun's body leaves everything under them out). A part with no mesh, a zero axis or no
 * `cutClean` isn't one: it stays in the body.
 */
export function gunPartsFromGltf(gltf: GLTF, bake: (mesh: Mesh, frame: Matrix4) => BufferGeometry): { parts: GunPart[]; nodes: Set<Object3D> } {
  gltf.scene.updateMatrixWorld(true);
  const parts: GunPart[] = [];
  const nodes = new Set<Object3D>();
  const inv = new Matrix4();
  gltf.scene.traverse((node) => {
    const kind = partKind(node);
    if (!kind) return;
    for (let p = node.parent; p; p = p.parent) if (nodes.has(p)) return; // a part inside a part moves with it
    const extras = node.userData as Record<string, unknown>;
    if (extras.cutClean !== true) return; // its cut isn't clean yet: it stays in the gun, still
    const axis = vec3(extras.axis) ?? (kind === 'cylinder' ? new Vector3(0, 1, 0) : new Vector3(0, -1, 0));
    if (axis.lengthSq() < 1e-8) return;
    axis.normalize();
    inv.copy(node.matrixWorld).invert();
    const pieces: BufferGeometry[] = [];
    node.traverse((o) => {
      const m = o as Mesh;
      if (m.isMesh) pieces.push(bake(m, new Matrix4().multiplyMatrices(inv, m.matrixWorld)));
    });
    const geometry = mergeBaked(pieces);
    if (!geometry) return;
    const position = new Vector3();
    const quaternion = new Quaternion();
    node.matrixWorld.decompose(position, quaternion, new Vector3());
    parts.push({
      kind,
      geometry,
      position,
      quaternion,
      axis,
      travel: kind === 'cylinder' ? (finite(extras.angle) ? extras.angle : DEFAULT_ANGLE) * DEG : finite(extras.travel) ? extras.travel : DEFAULT_TRAVEL,
      lift: kind === 'bolt' ? (finite(extras.lift) ? extras.lift : DEFAULT_LIFT) * DEG : 0,
    });
    nodes.add(node);
  });
  return { parts, nodes };
}

/**
 * What the hands work on a gun that cycles by hand, cut clean or not (the hands move whether or not
 * the part does): a pump the support hand rides, or a bolt the trigger hand works.
 */
export interface GunCycle {
  kind: 'pump' | 'bolt';
  /** the part's pivot (the handle's root), weapon frame */
  position: Vector3;
  /** unit, weapon frame: back along it */
  axis: Vector3;
  /** m */
  travel: number;
}

/** The GLB's `part_pump` or `part_bolt`, whatever its cut, as a GunCycle (null: neither). */
export function gunCycleFromGltf(gltf: GLTF): GunCycle | null {
  gltf.scene.updateMatrixWorld(true);
  let cycle: GunCycle | null = null;
  gltf.scene.traverse((node) => {
    const kind = partKind(node);
    if (cycle || (kind !== 'pump' && kind !== 'bolt')) return;
    const extras = node.userData as Record<string, unknown>;
    const axis = vec3(extras.axis) ?? new Vector3(0, -1, 0);
    if (axis.lengthSq() < 1e-8) return;
    cycle = { kind, position: new Vector3().setFromMatrixPosition(node.matrixWorld), axis: axis.normalize(), travel: finite(extras.travel) ? extras.travel : DEFAULT_TRAVEL };
  });
  return cycle;
}

/** A gun with no such node (a placeholder, a GLB without parts): a pump shotgun's pump, a sniper's bolt, by class. */
export function cycleByClass(def: WeaponDef | undefined): GunCycle | null {
  if (def?.class === 'shotgun' && def.fireMode === 'semi') return { kind: 'pump', position: new Vector3(0, 0.36, -0.04), axis: new Vector3(0, -1, 0), travel: 0.06 };
  if (def?.class === 'sniper') return { kind: 'bolt', position: new Vector3(0.035, 0.1, -0.06), axis: new Vector3(0, -1, 0), travel: 0.05 };
  return null;
}

/** The gun with its parts at rest merged in: what Low draws (one mesh, no extra draws). */
export function withPartsAtRest(body: BufferGeometry, parts: readonly GunPart[]): BufferGeometry {
  if (!parts.length) return body;
  const m = new Matrix4();
  const one = new Vector3(1, 1, 1);
  const merged = mergeBaked([body, ...parts.map((p) => p.geometry.clone().applyMatrix4(m.compose(p.position, p.quaternion, one)))]) ?? body;
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

/** smooth 0 → 1 over [a, b] */
export function ease(t: number, a: number, b: number): number {
  const k = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return k * k * (3 - 2 * k);
}

/** Where a part is in its cycle: `back` 0…1 of its travel, `turn` 0…1 (the bolt's lift, the cylinder's step). */
export interface PartPose {
  back: number;
  turn: number;
}

/**
 * A part's pose `t` s after a shot, its cycle fitted into the gun's `interval` (s): never still
 * moving when the next shot can come.
 */
export function partPose(kind: PartKind, t: number, interval: number, out: PartPose): PartPose {
  out.back = 0;
  out.turn = 0;
  switch (kind) {
    case 'slide': {
      // blowback: back in 25 ms, home by 90 ms
      const k = Math.min(1, interval / 0.12);
      out.back = t < 0.025 * k ? t / (0.025 * k) : 1 - ease(t, 0.025 * k, 0.09 * k);
      break;
    }
    case 'pump': {
      // the Breacher (0.75 s): back by 0.25 s, when its shell flies out (weapons.vfx.json ejectDelayMs)
      const k = Math.min(1, interval / 0.6);
      out.back = ease(t, 0.1 * k, 0.25 * k) * (1 - ease(t, 0.3 * k, 0.45 * k));
      break;
    }
    case 'bolt': {
      // the Widow (0.8 s): up, back by 0.35 s (the case flies out), forward, down
      const k = Math.min(1, interval / 0.7);
      out.turn = ease(t, 0.12 * k, 0.2 * k) * (1 - ease(t, 0.5 * k, 0.58 * k));
      out.back = ease(t, 0.2 * k, 0.35 * k) * (1 - ease(t, 0.38 * k, 0.5 * k));
      break;
    }
    case 'cylinder': {
      const k = Math.min(1, interval / 0.3);
      out.turn = ease(t, 0.04 * k, 0.16 * k);
      break;
    }
  }
  return out;
}

const _pose: PartPose = { back: 0, turn: 0 };
const _q = new Quaternion();
const NONE: readonly GunPart[] = [];

/**
 * The moving parts on one drawn gun: child meshes of the gun, posed every frame from the time since
 * its last shot. `set` follows the weapon in the hand; `fire` starts a cycle.
 */
export class GunParts {
  private readonly meshes: Mesh[] = [];
  private parts: readonly GunPart[] = NONE;
  private since = Infinity;
  /** chambers the cylinder has turned on (the turn carries on from shot to shot) */
  private chambers = 0;
  private interval = 1;

  constructor(private readonly gun: Object3D) {}

  /** The weapon in the hand: its parts (none: nothing extra drawn), material and fire interval (s). */
  set(parts: readonly GunPart[] = NONE, material: Material, interval: number): void {
    this.interval = interval;
    if (parts !== this.parts) {
      this.parts = parts;
      this.since = Infinity;
      this.chambers = 0;
    }
    const n = Math.max(parts.length, this.meshes.length);
    for (let i = 0; i < n; i++) {
      let m = this.meshes[i];
      if (i >= parts.length) {
        if (m) m.visible = false;
        continue;
      }
      if (!m) {
        m = new Mesh(parts[i]!.geometry, material);
        m.name = 'gun-part';
        this.meshes.push(m);
        this.gun.add(m);
      }
      m.geometry = parts[i]!.geometry;
      m.material = material;
      m.visible = true;
    }
  }

  /** A shot: the cycle starts over (a cylinder moves on a chamber). */
  fire(): void {
    if (!this.parts.length) return;
    if (this.since !== Infinity) this.chambers++;
    this.since = 0;
  }

  update(dt: number): void {
    if (!this.parts.length) return;
    this.since += dt;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]!;
      const m = this.meshes[i]!;
      partPose(p.kind, this.since, this.interval, _pose);
      m.position.copy(p.position);
      m.quaternion.copy(p.quaternion);
      if (p.kind === 'cylinder') {
        const step = this.since === Infinity ? 0 : _pose.turn;
        m.quaternion.premultiply(_q.setFromAxisAngle(p.axis, (this.chambers + step) * p.travel));
        continue;
      }
      m.position.addScaledVector(p.axis, _pose.back * p.travel);
      if (p.kind === 'bolt' && _pose.turn > 0) m.quaternion.premultiply(_q.setFromAxisAngle(p.axis, _pose.turn * p.lift));
    }
  }

  /** the part meshes on show (tests) */
  get shown(): readonly Mesh[] {
    return this.meshes.filter((m) => m.visible);
  }
}
