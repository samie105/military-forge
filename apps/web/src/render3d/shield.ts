/**
 * Riot shield in 3D, a placeholder until the Weapons Forge model lands: on the left forearm when it
 * is up (the left arm held forward), on the back when slung, items lying on the map, and the
 * ricochet spark. avatar.ts and index.ts hold a few lines of glue each.
 *
 * Sockets: the Rookie rig has none for the shield yet, so they are added here at runtime when the
 * rig lacks them (exact numbers in the shared notes, shield-sockets.md):
 *   socket_shield       parent forearm_L, at (0, 0.07, 0) in the bone's frame: on the forearm by the
 *                       wrist. While the shield is up its rotation is set every frame: +Y world up,
 *                       +Z the body's forward (yaw only), so the shield stands upright and faces
 *                       the way the body does whatever the arm's twist.
 *   socket_shield_back  parent spine2, at (0, 0.10, −0.40), turned 180° about Y: +Y up, +Z out of the
 *                       back. The shield hangs behind the jetpack (whose back is at z −0.40).
 * Model convention (shield space): origin at the arm strap; +Y up the long edge; +Z out of the strike
 * face; the inner face 5 cm in front of the origin, the strike face 9 cm; 0.55 m wide, 0.90 m tall,
 * centred on the origin.
 */
import { pickups as pickupDefs } from '@military-forge/content';
import type { SimEvent } from '@military-forge/sim';
import type { Frame, PickupView } from '../view';
import {
  AdditiveBlending,
  BoxGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Object3D,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { VfxModule } from './vfx';

/** Where the shield sockets go when the rig doesn't have them (shield-sockets.md). */
export const SHIELD_SOCKETS = {
  front: { name: 'socket_shield', parent: 'forearm_L', position: [0, 0.07, 0] as const, yaw: 0 },
  back: { name: 'socket_shield_back', parent: 'spine2', position: [0, 0.1, -0.4] as const, yaw: Math.PI },
} as const;

/** Placeholder size (m): what the Forge's model should match. */
export const SHIELD_SIZE = { width: 0.55, height: 0.9, thickness: 0.04, innerFace: 0.05 } as const;

/**
 * Up, the placeholder sits this much further out from the forearm socket than the model convention
 * says, so the Rookie's left hand (held forward by IK) stays behind the plate. The Forge's model can
 * replace it with a `grip` node (shield-sockets.md).
 */
export const HAND_CLEARANCE = 0.1;
/** On its way up (0.25 s; it guards neither side yet): held low and tipped, so it reads as not up yet. */
const RAISING_DROP = 0.25;
const RAISING_TILT = 0.45;

type SocketDef = (typeof SHIELD_SOCKETS)[keyof typeof SHIELD_SOCKETS];

function painted(geometry: BufferGeometry, hex: number): BufferGeometry {
  const c = new Color(hex);
  const n = geometry.getAttribute('position').count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) colors.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** GPU resources shared by every shield, item and spark. */
export class ShieldKit {
  /** the placeholder plate until the Forge's riot_shield.glb loads (setModel) */
  geometry: BufferGeometry;
  /** every mesh drawing the shield, so a loaded model replaces the placeholder in all of them */
  private readonly users = new Set<Mesh>();
  readonly material: MeshToonMaterial;
  readonly sparkGeometry: BufferGeometry;
  /** warm and drawn on top: the plate (or a pale sky) must not hide or wash it out */
  readonly sparkMaterial = new MeshBasicMaterial({ color: 0xffb340, transparent: true, opacity: 1, depthTest: false, depthWrite: false, blending: AdditiveBlending });

  constructor(ramp: Texture) {
    const { width: w, height: h, thickness: t, innerFace: z0 } = SHIELD_SIZE;
    const face = z0 + t;
    const parts = [
      painted(new BoxGeometry(w, h, t).translate(0, 0, z0 + t / 2), 0x5d7a99), // the plate: light steel, reads on dark and light layers
      painted(new BoxGeometry(w * 0.72, 0.13, 0.012).translate(0, h * 0.28, face), 0xc4e6ff), // viewport
      painted(new BoxGeometry(w, 0.035, 0.016).translate(0, h / 2 - 0.0175, face), 0xf2f5f8), // rim: top
      painted(new BoxGeometry(w, 0.035, 0.016).translate(0, -h / 2 + 0.0175, face), 0xf2f5f8), // bottom
      painted(new BoxGeometry(0.035, h, 0.016).translate(w / 2 - 0.0175, 0, face), 0xf2f5f8), // sides
      painted(new BoxGeometry(0.035, h, 0.016).translate(-w / 2 + 0.0175, 0, face), 0xf2f5f8),
      painted(new BoxGeometry(0.05, 0.12, 0.05).translate(0, 0, z0 / 2), 0x1f252c), // handle, behind
    ];
    this.geometry = mergeGeometries(parts)!;
    this.material = new MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
    // a four-point star: the long arms along the shield's normal (local +X)
    this.sparkGeometry = mergeGeometries([new BoxGeometry(0.75, 0.08, 0.08), new BoxGeometry(0.09, 0.42, 0.09)])!;
  }

  /** A mesh drawing the shield (it takes the model when it loads); `false` lets it go. */
  use(mesh: Mesh, on = true): void {
    if (on) this.users.add(mesh);
    else this.users.delete(mesh);
  }

  /**
   * The Forge's model (riot_shield.glb, baked into shield space: origin at the arm strap, +Y up,
   * +Z out of the strike face 9 cm in front, 0.56 × 0.90 m: the placeholder's own frame) in place
   * of the placeholder plate, on every shield already drawn.
   */
  setModel(geometry: BufferGeometry): void {
    const old = this.geometry;
    this.geometry = geometry;
    for (const m of this.users) m.geometry = geometry;
    old.dispose();
  }
}

/** The socket `def` names, or one added where it should be. Null when the rig lacks its parent bone. */
function shieldSocket(bone: (name: string) => Object3D | null, def: SocketDef): Object3D | null {
  const existing = bone(def.name);
  if (existing) return existing;
  const parent = bone(def.parent);
  if (!parent) return null;
  const socket = new Object3D();
  socket.name = def.name;
  socket.position.set(def.position[0], def.position[1], def.position[2]);
  socket.rotation.y = def.yaw;
  parent.add(socket);
  return socket;
}

const _q = new Quaternion();
const _pq = new Quaternion();

/** One avatar's shield: which socket holds it, and the up socket's upright rotation. */
export class ShieldRig {
  readonly mesh: Mesh;
  readonly front: Object3D | null;
  readonly back: Object3D | null;

  constructor(bone: (name: string) => Object3D | null, kit: ShieldKit) {
    this.mesh = new Mesh(kit.geometry, kit.material);
    kit.use(this.mesh);
    this.mesh.name = 'riot-shield';
    this.mesh.visible = false;
    this.front = shieldSocket(bone, SHIELD_SOCKETS.front);
    this.back = shieldSocket(bone, SHIELD_SOCKETS.back);
  }

  /**
   * After the arm is posed: `mode` from PlayerView.shield; `body` is the avatar's pivot (its world
   * rotation is the facing turn). Up, the shield stands upright facing the body's forward; on its
   * way up it is held low and tipped (it guards neither side yet); slung, it hangs on the back.
   */
  update(mode: 'front' | 'back' | 'raising' | undefined, body: Object3D): void {
    const onArm = mode === 'front' || mode === 'raising';
    const socket = onArm ? this.front : mode === 'back' ? this.back : null;
    this.mesh.visible = socket !== null;
    if (!socket) return;
    if (this.mesh.parent !== socket) socket.add(this.mesh);
    const raising = mode === 'raising';
    this.mesh.position.set(0, raising ? -RAISING_DROP : 0, onArm ? HAND_CLEARANCE : 0);
    this.mesh.rotation.set(raising ? RAISING_TILT : 0, 0, 0);
    if (!onArm || !socket.parent) return;
    // world rotation = the body's yaw → local = parent⁻¹ · yaw
    socket.parent.getWorldQuaternion(_pq);
    socket.quaternion.copy(_pq.invert().multiply(body.getWorldQuaternion(_q)));
    socket.updateMatrixWorld(true);
  }

  /** Shown on the back so the shader warm-up compiles its material. */
  showForWarmUp(): void {
    if (!this.back) return;
    this.back.add(this.mesh);
    this.mesh.visible = true;
  }
}

/** Items lying on the map: a shield standing on its edge, swinging ±50° about facing the camera. */
export class PickupMeshes {
  readonly group = new Group();
  private readonly meshes = new Map<number, Mesh>();
  private readonly seen = new Set<number>();
  private time = 0;

  constructor(private readonly kit: ShieldKit) {
    this.group.name = 'pickups';
  }

  sync(items: readonly PickupView[] | undefined, dt: number): void {
    this.time += dt;
    this.seen.clear();
    for (const k of items ?? []) {
      if (pickupDefs[k.def]?.kind !== 'shield') continue; // grenade pairs are clouds.ts's
      this.seen.add(k.id);
      let m = this.meshes.get(k.id);
      if (!m) {
        m = new Mesh(this.kit.geometry, this.kit.material);
        this.kit.use(m);
        m.castShadow = true;
        this.meshes.set(k.id, m);
        this.group.add(m);
      }
      // resting on its bottom edge, bobbing a little so it reads as something to grab; it never
      // turns edge-on to the camera (a full spin would hide it half the time)
      m.position.set(k.x, k.y + SHIELD_SIZE.height / 2 + 0.04 + 0.04 * Math.sin(this.time * 3 + k.id), 0);
      m.rotation.y = 0.87 * Math.sin(this.time * 1.6 + k.id);
    }
    for (const [id, m] of this.meshes) {
      if (this.seen.has(id)) continue;
      m.removeFromParent();
      this.kit.use(m, false);
      this.meshes.delete(id);
    }
  }

  get count(): number {
    return this.meshes.size;
  }
}

/**
 * A ricochet's spark: a four-point star along the shield's normal that pops and is gone. A Vfx
 * module (`vfx.register` in Renderer3D): the sim events arrive through Renderer3D.onEvents, which
 * the 2D renderer forwards in both modes, and `update` ages the sparks once per drawn frame.
 */
export class RicochetSparks implements VfxModule {
  static readonly LIFE = 0.22;
  readonly group = new Group();
  private readonly pool: { mesh: Mesh; age: number; fresh: boolean }[] = [];
  private next = 0;
  private readonly axis = new Vector3(1, 0, 0);
  private readonly normal = new Vector3();

  constructor(kit: ShieldKit, size = 12) {
    this.group.name = 'ricochet-sparks';
    for (let i = 0; i < size; i++) {
      const mesh = new Mesh(kit.sparkGeometry, kit.sparkMaterial);
      mesh.visible = false;
      mesh.renderOrder = 10;
      this.group.add(mesh);
      this.pool.push({ mesh, age: RicochetSparks.LIFE, fresh: false });
    }
  }

  /** Starts one spark per ricochet (the oldest is reused when they all burn). */
  onEvents(events: readonly SimEvent[]): void {
    for (const e of events) {
      if (e.type !== 'ricochet') continue;
      const s = this.pool[this.next]!;
      this.next = (this.next + 1) % this.pool.length;
      s.age = 0;
      s.fresh = true;
      s.mesh.visible = true;
      s.mesh.scale.setScalar(0.6);
      s.mesh.position.set(e.x, e.y, 0.5); // in front of the plate (whose turned face reaches z ≈ 0.25)
      s.mesh.quaternion.setFromUnitVectors(this.axis, this.normal.set(e.nx, e.ny, 0).normalize());
    }
  }

  /** Ages the live sparks; one started since the last frame is drawn once at its birth size first. */
  update(_frame: Frame | null, dt: number): void {
    for (const s of this.pool) {
      if (s.fresh) {
        s.fresh = false;
        continue;
      }
      if (s.age >= RicochetSparks.LIFE) continue;
      s.age += dt;
      const k = s.age / RicochetSparks.LIFE;
      s.mesh.visible = k < 1;
      s.mesh.scale.setScalar(0.6 + 2.4 * k * (1 - k)); // pops to 1.2× halfway, then shrinks
    }
  }

  /** The meshes share the kit's geometry and material (the kit owns them). */
  dispose(): void {
    this.group.removeFromParent();
  }

  get live(): number {
    return this.pool.filter((s) => s.mesh.visible).length;
  }
}
