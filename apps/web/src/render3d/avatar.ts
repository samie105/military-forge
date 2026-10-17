/**
 * One player's 3D body: the assembled character, its AnimationMixer and locomotion state machine,
 * the facing turn, procedural aim (spine/head pitch + IK arms that point the gun along the sim's
 * aim), weapons on the hand sockets, the jet flame and a blob shadow (docs/04 §4, docs/11 §2/§4).
 */
import { NO_WEAPON, weapons, type WeaponDef } from '@military-forge/content';
import { createRayHit, type CollisionWorld } from '@military-forge/sim';
import {
  AnimationMixer,
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
  type AnimationAction,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlayerView } from '../view';
import type { CharacterInstance, CharacterLod } from './character';
import { orientSocket, rotateWorld, solveTwoBone } from './ik';
import { Locomotion, aimElevation, clipCandidates, facingOf, facingYaw, fadeTime, runTimeScale, stepYaw, type LocoState } from './locomotion';

interface WeaponModel {
  geometry: BufferGeometry;
  /** socket space (+Y muzzle, +Z top): where the barrel ends, for tracers (Milestone B) */
  muzzle: Vector3;
  /** where a two-handed weapon's support hand goes (≤ 0.08 m ahead of the grip: review-art-prs §6) */
  offhand: Vector3;
}

/** GPU resources shared by every avatar. */
export class AvatarKit {
  readonly gunMaterial: MeshToonMaterial;
  readonly flameOuter = new MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.9, depthWrite: false });
  readonly flameInner = new MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0.95, depthWrite: false });
  readonly flameOuterGeo: BufferGeometry;
  readonly flameInnerGeo: BufferGeometry;
  readonly blobGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  readonly blobTexture: Texture;
  private readonly models = new Map<number, WeaponModel>();

  constructor(ramp: Texture) {
    this.gunMaterial = new MeshToonMaterial({ color: 0x2d3136, gradientMap: ramp });
    // twin nozzles ~0.26 m below and 0.1 m behind socket_jetpack (+Y up the back, +Z forward)
    const cones = (r: number, len: number) =>
      mergeGeometries([-0.065, 0.065].map((x) => new ConeGeometry(r, len, 10).rotateX(Math.PI).translate(x, -len / 2, -0.1)))!;
    this.flameOuterGeo = cones(0.075, 0.62);
    this.flameInnerGeo = cones(0.038, 0.34);
    this.blobTexture = blobTexture();
  }

  /** Placeholder guns by weapon until W8's models land (origin = grip, socket space). */
  weapon(def: number): WeaponModel {
    let m = this.models.get(def);
    if (!m) {
      const w: WeaponDef | undefined = weapons[def];
      const smg = w?.fireMode === 'auto';
      const len = smg ? 0.3 : 0.24;
      const parts = [
        new BoxGeometry(0.05, 0.11, 0.07).translate(0, 0, -0.02), // grip
        new BoxGeometry(0.06, len, 0.08).translate(0, len / 2 - 0.02, 0.05), // body
        new CylinderGeometry(0.016, 0.016, 0.12, 8).translate(0, len + 0.04, 0.06), // barrel
      ];
      if (smg) parts.push(new BoxGeometry(0.04, 0.05, 0.14).translate(0, 0.12, -0.04)); // magazine
      if (w?.hands === 2) parts.push(new BoxGeometry(0.05, 0.16, 0.07).translate(0, -0.12, 0.04)); // stock
      m = { geometry: mergeGeometries(parts)!, muzzle: new Vector3(0, len + 0.1, 0.06), offhand: new Vector3(0, 0.07, 0.02) };
      this.models.set(def, m);
    }
    return m;
  }

  materials(): Material[] {
    return [this.gunMaterial, this.flameOuter, this.flameInner];
  }
}

function blobTexture(): DataTexture {
  const n = 32;
  const data = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
      // alphaMap reads the green channel
      data.fill(Math.round(255 * Math.max(0, 1 - d) ** 1.5), (y * n + x) * 4, (y * n + x) * 4 + 4);
    }
  }
  const t = new DataTexture(data, n, n);
  t.needsUpdate = true;
  return t;
}

interface Arm {
  upper: Object3D;
  lower: Object3D;
  hand: Object3D;
  socket: Object3D;
  gun: Mesh;
  /** shoulder → wrist, bind pose */
  length: number;
}

const UP = new Vector3(0, 1, 0);
const _q = new Quaternion();
const _lat = new Vector3();
const _dir = new Vector3();
const _gunUp = new Vector3();
const _s = new Vector3();
const _t = new Vector3();
const _p = new Vector3();
const _hit = createRayHit();

export class Avatar {
  /** world placement: feet at (x, y, 0), yawed for facing */
  readonly pivot = new Group();
  readonly blob: Mesh;
  private readonly mixer: AnimationMixer;
  private readonly actions = new Map<string, AnimationAction>();
  private current: AnimationAction | null = null;
  private readonly loco = new Locomotion();
  private yaw: number | null = null;
  private readonly right: Arm | null;
  private readonly left: Arm | null;
  private readonly spine: Object3D[];
  /**
   * Bones the procedural aim rotates, with the pose the animation gave them this frame. The mixer
   * skips writing a property whose mixed value didn't change, so a clip that holds a bone still
   * (the run clip's spine) would otherwise leave last frame's aim in place and the aim would pile
   * up every frame: the head and spine spun while running.
   */
  private readonly posed: { bone: Object3D; anim: Quaternion }[];
  private readonly flame = new Group();
  private flameScale = 0;
  private time = 0;

  constructor(
    readonly inst: CharacterInstance,
    readonly lod: CharacterLod,
    private readonly kit: AvatarKit,
    private readonly seed: number,
  ) {
    this.pivot.add(inst.root);
    this.mixer = new AnimationMixer(inst.root);
    for (const clip of inst.clips) this.actions.set(clip.name, this.mixer.clipAction(clip));
    this.spine = ['spine1', 'spine2', 'head'].map((n) => inst.bone(n)).filter((b): b is NonNullable<typeof b> => !!b);
    this.right = this.arm('R');
    this.left = this.arm('L');
    const armBones = [this.right, this.left].flatMap((a) => (a ? [a.upper, a.lower, a.hand, a.socket] : []));
    this.posed = [...this.spine, ...armBones].map((bone) => ({ bone, anim: bone.quaternion.clone() }));

    const outer = new Mesh(kit.flameOuterGeo, kit.flameOuter);
    const inner = new Mesh(kit.flameInnerGeo, kit.flameInner);
    inner.renderOrder = 1;
    this.flame.add(outer, inner);
    this.flame.position.y = -0.26; // scale from the nozzles
    this.flame.visible = false;
    inst.bone('socket_jetpack')?.add(this.flame);

    this.blob = new Mesh(kit.blobGeo, new MeshBasicMaterial({ color: 0x000000, alphaMap: kit.blobTexture, transparent: true, depthWrite: false }));
    this.blob.renderOrder = -1;
  }

  private arm(side: 'L' | 'R'): Arm | null {
    const b = (n: string) => this.inst.bone(`${n}_${side}`);
    const upper = b('upperarm');
    const lower = b('forearm');
    const hand = b('hand');
    const socket = b('socket_weapon');
    if (!upper || !lower || !hand || !socket) return null;
    const gun = new Mesh(this.kit.weapon(0).geometry, this.kit.gunMaterial);
    gun.visible = false;
    socket.add(gun);
    const length = lower.position.length() + hand.position.length();
    return { upper, lower, hand, socket, gun, length };
  }

  update(p: PlayerView, dt: number, world: CollisionWorld, blobShadows: boolean): void {
    this.pivot.visible = p.alive;
    this.blob.visible = p.alive && blobShadows;
    if (!p.alive) return;
    this.time += dt;
    const speed = Math.abs(p.vx);
    const prev = this.loco.state;
    const state = this.loco.update(p, dt);
    this.play(prev, state, speed);
    if (state === 'run' && this.current) this.current.timeScale = runTimeScale(speed);
    for (const b of this.posed) b.bone.quaternion.copy(b.anim); // undo last frame's aim
    this.mixer.update(dt);
    for (const b of this.posed) b.anim.copy(b.bone.quaternion);

    const facing = facingOf(p.aim);
    const target = facingYaw(facing);
    this.yaw = this.yaw === null ? target : stepYaw(this.yaw, target, dt);
    this.pivot.position.set(p.x, p.y, 0);
    this.pivot.rotation.set(0, this.yaw, 0);
    this.pivot.updateMatrixWorld(true);

    this.aim(p, facing);
    this.updateFlame(p, dt);
    if (blobShadows) this.updateBlob(p, world);
  }

  private play(prev: LocoState, state: LocoState, speed: number): void {
    let next: AnimationAction | undefined;
    for (const name of clipCandidates(state, speed)) if ((next = this.actions.get(name))) break;
    if (!next || next === this.current) return;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    if (this.current) next.crossFadeFrom(this.current, fadeTime(prev, state), false);
    // dummies standing side by side shouldn't breathe in sync
    else next.time = (this.seed * 0.37) % next.getClip().duration;
    this.current = next;
  }

  /** Everything visible once, so compileAsync sees every material variant (docs/11 §3). */
  showAllForWarmUp(): void {
    this.flame.visible = true;
    for (const arm of [this.right, this.left]) if (arm) arm.gun.visible = true;
  }

  /** Spine and head pitch toward the aim, then the gun arm(s) point along it (docs/11 §4: procedural aim). */
  private aim(p: PlayerView, facing: 1 | -1): void {
    const elevation = aimElevation(p.aim);
    _lat.set(1, 0, 0).applyAxisAngle(UP, this.yaw!); // the body's left, in world space
    // +X flexes a vertical bone forward (art/README.md), so looking up is a negative turn
    const share = [0.1, 0.15, 0.15];
    this.spine.forEach((bone, i) => rotateWorld(bone, _q.setFromAxisAngle(_lat, -elevation * share[i]!)));

    const slots = p.weapons;
    const active = slots[p.active]?.def ?? NO_WEAPON;
    const other = slots[p.active === 0 ? 1 : 0]?.def ?? NO_WEAPON;
    const leftDef = p.dual ? other : NO_WEAPON;
    _dir.set(Math.cos(p.aim), Math.sin(p.aim), 0);
    _gunUp.set(-Math.sin(p.aim) * facing, Math.cos(p.aim) * facing, 0);
    if (this.right) this.aimArm(this.right, active, 1);
    if (this.left) {
      this.left.gun.visible = false;
      if (leftDef !== NO_WEAPON) this.aimArm(this.left, leftDef, -1);
      else if (active !== NO_WEAPON && weapons[active]?.hands === 2 && this.right) {
        // two-handed weapon: the off hand holds the foregrip (docs/04 §4.2)
        const grip = this.right.gun.localToWorld(_t.copy(this.kit.weapon(active).offhand));
        this.left.upper.getWorldPosition(_s);
        _p.copy(_s).addScaledVector(UP, -0.5).addScaledVector(_lat, 0.3);
        solveTwoBone(this.left.upper, this.left.lower, this.left.hand, grip, _p);
      }
    }
  }

  /** side: +1 right arm, −1 left arm */
  private aimArm(arm: Arm, def: number, side: 1 | -1): void {
    arm.gun.visible = def !== NO_WEAPON;
    if (def === NO_WEAPON) return;
    arm.gun.geometry = this.kit.weapon(def).geometry;
    arm.upper.getWorldPosition(_s);
    _t.copy(_s).addScaledVector(_dir, arm.length * 0.9);
    // elbow down and out to its own side, a little behind the hand
    _p.copy(_s).addScaledVector(UP, -0.5).addScaledVector(_lat, -0.3 * side).addScaledVector(_dir, -0.2);
    solveTwoBone(arm.upper, arm.lower, arm.hand, _t, _p);
    orientSocket(arm.hand, arm.socket, _dir, _gunUp);
  }

  /** ignite fast, flicker while sustained, shrink out (docs/11 §5 jetpack flame) */
  private updateFlame(p: PlayerView, dt: number): void {
    const target = p.jetting ? 1 : 0;
    this.flameScale += (target - this.flameScale) * (1 - Math.exp(-dt * (p.jetting ? 30 : 18)));
    this.flame.visible = this.flameScale > 0.03;
    if (!this.flame.visible) return;
    const flicker = 0.85 + 0.2 * Math.sin(this.time * 43 + p.id) * Math.sin(this.time * 17);
    this.flame.scale.set(this.flameScale, this.flameScale * flicker, this.flameScale);
  }

  private updateBlob(p: PlayerView, world: CollisionWorld): void {
    const blob = this.blob;
    if (!world.raycast(p.x, p.y + 0.05, 0, -1, 30, 0, _hit)) {
      blob.visible = false;
      return;
    }
    const height = p.y - _hit.y;
    const k = Math.max(0, 1 - height / 8);
    blob.visible = k > 0;
    blob.position.set(p.x, _hit.y + 0.015, 0);
    blob.quaternion.setFromUnitVectors(UP, _t.set(world.nx[_hit.seg]!, world.ny[_hit.seg]!, 0));
    blob.scale.setScalar(0.9 * (0.6 + 0.4 * k));
    (blob.material as MeshBasicMaterial).opacity = 0.45 * k;
  }

  /** `keepBlobMaterial`: the shader warm-up keeps its blob materials so the program stays compiled */
  dispose({ keepBlobMaterial = false } = {}): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.inst.root);
    if (!keepBlobMaterial) (this.blob.material as Material).dispose();
    this.blob.removeFromParent();
    this.pivot.removeFromParent();
    this.inst.dispose();
  }
}
