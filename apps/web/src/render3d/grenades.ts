/**
 * 3D grenades (docs/11 §5). The frag model drawn GRENADE_WIDTH_M wide whatever its own size (W8's
 * 9 cm frag 3.5× life size; the Forge's sim-sized 20 cm one ~1.7×), and never under MIN_PX tall,
 * so it reads at gameplay zoom, with:
 * - a two-tone outline: a dark inner hull and a light outer one, so one of them contrasts with
 *   whatever is behind (bright sky, dark walls), at a constant width in screen pixels;
 * - a fuse light that blinks faster toward the blast (grenadeTracker.ts fuseLight);
 * - a tumble in flight, rolling on the ground and settling upright on its `ground` node;
 * - a grey smoke trail (lit-from-above puffs: a light top and a dark underside).
 * Every grenade on screen shares three InstancedMeshes (body, inner hull, outer hull); the fuse
 * lights and smoke go through the VFX particle layers.
 */
import {
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshToonMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { CollisionWorld } from '@military-forge/sim';
import { reduceFlashes } from '../fx';
import { FUSE_MAX_HZ, FUSE_REDUCED_HZ, FUSE_SECONDS, GrenadeTracker, SIM_RADIUS, fuseLight, type GrenadeSample, type GrenadeTrack } from './grenadeTracker';
import { Cell } from './vfx/atlas';
import { bakeGltfMesh, nodePosition } from './weaponModels';
import type { ParticleLayer } from './vfx/particles';
import { particleSpec, type ParticlePool } from './vfx/pool';
import { Ramp } from './vfx/ramps';

/** how wide a frag is drawn (m): the owner wants frags you can clearly see, about today's size */
export const GRENADE_WIDTH_M = 0.33;
/** never drawn shorter than this on screen (CSS px), at any zoom */
export const GRENADE_MIN_PX = 12;
/** outline widths (CSS px): dark inner, light outer */
const INNER_PX = 1.6;
const OUTER_PX = 1.6;
export const MAX_GRENADES_DRAWN = 32;
/** trail puff spacing along the flight path (m, before the readability scale) */
const TRAIL_SPACING = 0.13;

/** A throwable's geometry in the weapon frame (docs/04 §9.4: origin at the grip, +Y muzzle, +Z up). */
export interface ThrowableModel {
  geometry: BufferGeometry;
  /** the `ground` node's depth below the origin: the floor contact when it stands upright */
  groundDepth: number;
  /** the fuse light: the `light` node, or the fuse cap */
  light: Vector3;
  /** body radius (outline widths, rolling) */
  radius: number;
  /** model height (bounding box), for the minimum on-screen size */
  height: number;
}

/** frag.glb's fuse cap (z 0.078…0.086 in the weapon frame) */
const FRAG_LIGHT = new Vector3(0, 0, 0.086);

/** A stand-in frag until the GLB loads (or if it never does): olive body, grey fuse, red cap. */
export function fallbackFrag(): ThrowableModel {
  const tint = (g: BufferGeometry, hex: number) => {
    const c = new Color(hex);
    const n = g.getAttribute('position').count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
    g.setAttribute('color', new BufferAttribute(colors, 3));
    return g;
  };
  const geometry = mergeGeometries([
    tint(new SphereGeometry(0.045, 14, 10).rotateX(Math.PI / 2), 0x3a4423),
    tint(new CylinderGeometry(0.018, 0.022, 0.04, 10).rotateX(Math.PI / 2).translate(0, 0, 0.058), 0x7a828e),
    tint(new CylinderGeometry(0.012, 0.012, 0.01, 10).rotateX(Math.PI / 2).translate(0, 0, 0.082), 0xf4701c),
  ])!;
  return { geometry, groundDepth: 0.045, light: FRAG_LIGHT.clone(), radius: 0.045, height: 0.135 };
}

/**
 * Reads a throwable GLB (W8: one mesh, vertex colours, a `ground` node, maybe a `light` node), baked
 * into the weapon frame.
 */
export function throwableFromGltf(gltf: GLTF, defaultLight: Vector3 = FRAG_LIGHT): ThrowableModel | null {
  const geometry = bakeGltfMesh(gltf);
  if (!geometry) return null;
  const box = geometry.boundingBox!;
  const ground = nodePosition(gltf.scene, 'ground');
  return {
    geometry,
    groundDepth: ground ? -ground.z : -box.min.z,
    light: nodePosition(gltf.scene, 'light') ?? defaultLight.clone(),
    radius: Math.max(box.max.x - box.min.x, box.max.y - box.min.y) / 2,
    height: box.max.z - box.min.z,
  };
}

/** Drawn size over model size for `model`: GRENADE_WIDTH_M across its body. */
export function grenadeScale(model: Pick<ThrowableModel, 'radius'>): number {
  return GRENADE_WIDTH_M / (2 * model.radius);
}

/** upright: the weapon frame's +Z is world up; then a 3/4 turn toward the camera */
const Q_REST = new Quaternion()
  .setFromAxisAngle(new Vector3(0, 1, 0), 0.6)
  .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), -Math.PI / 2));
const Z = new Vector3(0, 0, 1);
const Y = new Vector3(0, 1, 0);
const _q = new Quaternion();
const _qRest = new Quaternion();
const _n = new Vector3();
const _p = new Vector3();
const _s = new Vector3();
const _m = new Matrix4();
const _light = new Vector3();
const AMBER = new Color(1, 0.55, 0.08);
const RED = new Color(1, 0.08, 0.03);
const _c = new Color();
const puff = particleSpec();
const frac = (v: number) => v - Math.floor(v);

export interface GrenadeFx {
  /** alpha particles: trail puffs */
  smoke: ParticlePool;
  /** additive layer, written this frame: fuse lights */
  glow: ParticleLayer;
}

export class GrenadeRenderer {
  readonly tracker: GrenadeTracker;
  readonly body: InstancedMesh;
  readonly inner: InstancedMesh;
  readonly outer: InstancedMesh;
  readonly meshes: readonly InstancedMesh[];
  private model: ThrowableModel = fallbackFrag();
  /** drawn size over model size (grenadeScale), before MIN_PX */
  private baseScale = grenadeScale(this.model);
  /** reduced motion: the fuse light blinks at most 3 times a second */
  reduced = false;

  constructor(world: CollisionWorld, ramp: Texture) {
    this.tracker = new GrenadeTracker(world);
    this.tracker.rollRadius = this.model.radius;
    const g = this.model.geometry;
    // fog off: projectiles are the highest-contrast thing on screen at every zoom (docs/11 §4)
    this.body = new InstancedMesh(g, new MeshToonMaterial({ vertexColors: true, gradientMap: ramp, fog: false }), MAX_GRENADES_DRAWN);
    this.inner = new InstancedMesh(g, new MeshBasicMaterial({ color: 0x0b0d10, side: BackSide, fog: false }), MAX_GRENADES_DRAWN);
    this.outer = new InstancedMesh(g, new MeshBasicMaterial({ color: 0xfff1cf, side: BackSide, fog: false }), MAX_GRENADES_DRAWN);
    this.meshes = [this.body, this.inner, this.outer];
    for (const m of this.meshes) {
      m.name = 'grenades';
      m.count = 0;
      m.frustumCulled = false;
      m.visible = false;
    }
  }

  /** A new map (Vfx.setMap). */
  setWorld(world: CollisionWorld): void {
    this.tracker.setWorld(world);
  }

  setModel(model: ThrowableModel): void {
    const old = this.model.geometry;
    this.model = model;
    this.baseScale = grenadeScale(model);
    this.tracker.rollRadius = model.radius; // the roll keeps pace with this model's body
    for (const m of this.meshes) m.geometry = model.geometry;
    old.dispose();
  }

  /** Drawn size over model size at `ppm` CSS px per metre: GRENADE_WIDTH_M wide, or more to stay MIN_PX tall. */
  scaleFor(ppm: number): number {
    return Math.max(this.baseScale, GRENADE_MIN_PX / (Math.max(ppm, 1e-3) * this.model.height));
  }

  update(tick: number, samples: readonly GrenadeSample[], dt: number, ppm: number, fx: GrenadeFx): void {
    const S = this.scaleFor(ppm);
    const r = S / this.baseScale; // readability factor for the trail and the light
    this.tracker.update(tick, samples, dt, S);
    const model = this.model;
    const bodyPx = model.radius * S * ppm;
    const kIn = 1 + INNER_PX / bodyPx;
    const kOut = kIn + OUTER_PX / bodyPx;
    // Reduce motion or Reduce flashes: the fuse light blinks no faster than 3 Hz (the Forge's spec)
    const maxHz = this.reduced || reduceFlashes() ? FUSE_REDUCED_HZ : FUSE_MAX_HZ;
    let n = 0;
    for (const t of this.tracker.tracks) {
      if (n >= MAX_GRENADES_DRAWN) break;
      // orientation: tumbling about the view axis, settling upright on the surface it rests on
      _q.setFromAxisAngle(Z, t.angle).multiply(Q_REST);
      if (t.rest > 0.001) {
        _qRest.setFromUnitVectors(Y, _n.set(t.nx, t.ny, 0)).multiply(Q_REST);
        _q.slerp(_qRest, t.rest);
      }
      // the drawn grenade is bigger than the sim's circle: lift it out of the surface it touches
      const lift = Math.max(0, (model.radius + (model.groundDepth - model.radius) * t.rest) * S - SIM_RADIUS) * t.contact;
      _p.set(t.x + t.nx * lift, t.y + t.ny * lift, 0);
      this.body.setMatrixAt(n, _m.compose(_p, _q, _s.setScalar(S)));
      this.inner.setMatrixAt(n, _m.compose(_p, _q, _s.setScalar(S * kIn)));
      this.outer.setMatrixAt(n, _m.compose(_p, _q, _s.setScalar(S * kOut)));
      n++;

      _light.copy(model.light).multiplyScalar(S).applyQuaternion(_q).add(_p);
      this.trail(t, fx.smoke, r, dt);
      this.light(t, fx.glow, r, maxHz);
    }
    for (const m of this.meshes) {
      m.count = n;
      m.visible = n > 0;
      m.instanceMatrix.clearUpdateRanges();
      if (n > 0) {
        m.instanceMatrix.addUpdateRange(0, n * 16);
        m.instanceMatrix.needsUpdate = true;
      }
    }
  }

  /** Smoke puffs every TRAIL_SPACING along the flight; a thin wisp from the fuse at rest. */
  private trail(t: GrenadeTrack, smoke: ParticlePool, r: number, dt: number): void {
    const flying = t.contact < 0.5 && t.speed > 2.5;
    if (flying) {
      const dx = t.x - t.trailX;
      const dy = t.y - t.trailY;
      const d = Math.sqrt(dx * dx + dy * dy);
      const spacing = TRAIL_SPACING * r;
      if (d > 4) {
        // a jump (respawned id, a snapshot gap): restart the trail here
        t.trailCarry = 0;
      } else if (d > 0) {
        let s = spacing - t.trailCarry;
        for (let k = 0; s <= d && k < 16; s += spacing, k++) this.puff(smoke, t.trailX + (dx * s) / d, t.trailY + (dy * s) / d, t, r, false);
        t.trailCarry = Math.min(spacing, d - (s - spacing));
      }
    } else if (t.rest > 0.5 && (t.wisp -= dt) <= 0) {
      t.wisp = 0.11;
      this.puff(smoke, _light.x, _light.y, t, r, true);
    }
    t.trailX = t.x;
    t.trailY = t.y;
  }

  private puff(smoke: ParticlePool, x: number, y: number, t: GrenadeTrack, r: number, wisp: boolean): void {
    const p = puff;
    const j = frac(t.seed * 7.31 + x * 13.7 + y * 5.3) - 0.5; // stable jitter
    p.x = x + j * 0.04 * r;
    p.y = y - j * 0.03 * r;
    p.z = -0.08;
    p.vx = wisp ? j * 0.2 : t.vx * 0.06;
    p.vy = wisp ? 0.6 : 0.35 + t.vy * 0.06;
    p.vz = 0;
    p.age = 0;
    p.life = wisp ? 0.8 : 0.6;
    p.size0 = (wisp ? 0.08 : 0.2) * r;
    p.size1 = (wisp ? 0.3 : 0.62) * r;
    p.ease = 0.6;
    p.drag = 2.2;
    p.grav = 0;
    p.ramp = Ramp.Trail;
    p.alpha = wisp ? 0.6 : 1;
    p.cell = Cell.Puff;
    p.rot = p.spin = p.stretch = p.orient = p.fadeIn = p.front = 0;
    p.tr = p.tg = p.tb = 1;
    p.aspect = 1;
    smoke.emit(p);
  }

  /** The fuse light: an ember that pulses faster toward the blast, amber turning red. */
  private light(t: GrenadeTrack, glow: ParticleLayer, r: number, maxHz: number): void {
    const ft = t.fuseT;
    const level = fuseLight(ft, FUSE_SECONDS, maxHz);
    const u = Math.min(1, ft / FUSE_SECONDS);
    _c.copy(AMBER).lerp(RED, u);
    const urgency = 1 + 0.6 * Math.max(0, (u - 0.7) / 0.3);
    glow.sprite(_light.x, _light.y, 0.3, 0.5 * r * urgency * (0.7 + 0.5 * level), 0, _c.r, _c.g, _c.b, 0.3 + 0.7 * level, Cell.Glow);
    if (level > 0.5) glow.sprite(_light.x, _light.y, 0.31, 0.12 * r, 0, 1, 0.9, 0.7, level, Cell.Dot);
  }

  dispose(): void {
    for (const m of this.meshes) {
      m.removeFromParent();
      (m.material as MeshBasicMaterial).dispose();
      m.dispose();
    }
    this.model.geometry.dispose();
  }
}
