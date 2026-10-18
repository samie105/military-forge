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
  SRGBColorSpace,
  Vector3,
  type AnimationAction,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlayerView } from '../view';
import type { CharacterInstance, CharacterLod } from './character';
import { AimClips, HOLDS, holdFamily, type AimPose, type HoldProfile } from './holds';
import { KICK_MAX, recoilOf } from './recoil';
import { DEFAULT_OFFHAND, loadWeaponModels, type GltfSource, type GunMaterials, type WeaponModel } from './weaponModels';
import { orientSocket, rotateWorld, solveTwoBone } from './ik';
import { Locomotion, aimElevation, clipCandidates, facingOf, facingYaw, fadeTime, runTimeScale, stepYaw, type LocoState } from './locomotion';
import { ShieldKit, ShieldRig } from './shield';

/** GPU resources shared by every avatar. */
export class AvatarKit {
  readonly gunMaterial: MeshToonMaterial;
  /** W8's scripted weapon GLBs: vertex colours on one toon material */
  readonly gunMaterialVC: MeshToonMaterial;
  /** the scanned guns: a toon material per albedo texture (gunMaterials.textured) */
  private readonly gunMaterialsMapped = new Map<Texture, MeshToonMaterial>();
  /** a mapped toon material for the warm-up: the scans' shader variant, before any scan loads */
  readonly gunMaterialMapped: MeshToonMaterial;
  /** how weapon GLBs are drawn: scans by their own texture, scripted guns by vertex colour */
  readonly gunMaterials: GunMaterials;
  private readonly ramp: Texture;
  readonly flameOuter = new MeshBasicMaterial({ color: 0xff8a1f, transparent: true, opacity: 0.9, depthWrite: false });
  readonly flameInner = new MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0.95, depthWrite: false });
  readonly flameOuterGeo: BufferGeometry;
  readonly flameInnerGeo: BufferGeometry;
  readonly blobGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  readonly blobTexture: Texture;
  /** riot shield placeholder, items and sparks (shield.ts) */
  readonly shield: ShieldKit;
  private readonly models = new Map<number, WeaponModel>();

  constructor(ramp: Texture) {
    this.gunMaterial = new MeshToonMaterial({ color: 0x2d3136, gradientMap: ramp });
    this.shield = new ShieldKit(ramp);
    this.gunMaterialVC = new MeshToonMaterial({ vertexColors: true, gradientMap: ramp });
    this.ramp = ramp;
    this.gunMaterials = { vertexColors: this.gunMaterialVC, plain: this.gunMaterial, textured: (map) => this.texturedGun(map) };
    const white = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.colorSpace = SRGBColorSpace;
    white.needsUpdate = true;
    this.gunMaterialMapped = new MeshToonMaterial({ map: white, gradientMap: ramp });
    // twin nozzles ~0.26 m below and 0.1 m behind socket_jetpack (+Y up the back, +Z forward)
    const cones = (r: number, len: number) =>
      mergeGeometries([-0.065, 0.065].map((x) => new ConeGeometry(r, len, 10).rotateX(Math.PI).translate(x, -len / 2, -0.1)))!;
    this.flameOuterGeo = cones(0.075, 0.62);
    this.flameInnerGeo = cones(0.038, 0.34);
    this.blobTexture = blobTexture();
  }

  // --- render3d-b: weapon models (W8 GLBs, placeholders until they load) ---
  /** W8's weapon GLBs; each replaces its placeholder as it arrives (weaponModels.ts). */
  loadWeapons(baseUrl: string, loader: GltfSource): Promise<void> {
    return loadWeaponModels(baseUrl, loader, this.gunMaterials, (def, model) => this.models.set(def, model));
  }

  /** A scanned gun's toon material, one per albedo texture. */
  private texturedGun(map: Texture): MeshToonMaterial {
    let m = this.gunMaterialsMapped.get(map);
    if (!m) {
      m = new MeshToonMaterial({ map, gradientMap: this.ramp });
      this.gunMaterialsMapped.set(map, m);
    }
    return m;
  }

  /** The model in the hand for weapon `def`: its GLB once loaded, else a placeholder box gun (origin = grip, socket space). */
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
      m = { geometry: mergeGeometries(parts)!, muzzle: new Vector3(0, len + 0.1, 0.06), offhand: DEFAULT_OFFHAND.clone(), material: this.gunMaterial };
      this.models.set(def, m);
    }
    return m;
  }
  // --- end render3d-b: weapon models ---

  // --- render3d-b: recoil (recoil.ts) ---
  /** every avatar's kick size: reduced motion halves it (and the camera kick is off) */
  recoilScale = 1;
  // --- end render3d-b: recoil ---

  materials(): Material[] {
    return [this.gunMaterial, this.gunMaterialVC, this.gunMaterialMapped, ...this.gunMaterialsMapped.values(), this.flameOuter, this.flameInner];
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
  /** the weapon in this hand (NO_WEAPON: empty) */
  def: number;
  /** shoulder → wrist, bind pose */
  length: number;
  /** recoil (recoil.ts): shots' worth of kick on show, and kicks landing next frame */
  kick: number;
  kickNext: number;
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
const _gunDir = new Vector3();
/** how much of the aim's pitch each spine bone takes (spine1, spine2, head), and of a recoil jolt */
const AIM_SHARE = [0.1, 0.15, 0.15] as const;
const JOLT_SHARE = [0.4, 0.6, 0] as const;

/** recoil.ts: an arm's kick settles at its weapon's rate, then takes the shots that just landed. */
function settleArm(arm: Arm, dt: number): void {
  arm.kick = Math.min(KICK_MAX, arm.kick * Math.exp(-recoilOf(arm.def).recover * dt) + arm.kickNext);
  arm.kickNext = 0;
}

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
  private readonly shield: ShieldRig;

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
    this.aimClips = new AimClips(this.mixer, inst.clips);
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
    this.shield = new ShieldRig((name) => inst.bone(name), kit.shield);
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
    return { upper, lower, hand, socket, gun, def: NO_WEAPON, length, kick: 0, kickNext: 0 };
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
    this.blendAimPose(p);
    this.mixer.update(dt);
    for (const b of this.posed) b.anim.copy(b.bone.quaternion);

    const facing = facingOf(p.aim);
    const target = facingYaw(facing);
    this.yaw = this.yaw === null ? target : stepYaw(this.yaw, target, dt);
    this.pivot.position.set(p.x, p.y, 0);
    this.pivot.rotation.set(0, this.yaw, 0);
    this.pivot.updateMatrixWorld(true);

    this.aim(p, facing);
    this.shield.update(p.shield, this.pivot);
    this.settleRecoil(dt);
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
  showAllForWarmUp(variant = 0): void {
    this.flame.visible = true;
    for (const arm of [this.right, this.left]) if (arm) arm.gun.visible = true;
    this.shield.showForWarmUp();
    // every gun material between the warm-up avatars: the placeholders' (right), and on the left
    // the scripted GLBs' vertex colours (variant 0) or the scans' textures (variant 1)
    if (this.left) this.left.gun.material = variant === 1 ? this.kit.gunMaterialMapped : this.kit.gunMaterialVC;
  }

  // --- render3d-b: holds (holds.ts): how each kind of weapon is carried ---
  private readonly aimClips: AimClips;

  /** The hold for weapon `def` (a dual pair: both hands out, the pistol hold). */
  private holdOf(def: number, dual: boolean): HoldProfile {
    if (dual || def === NO_WEAPON) return HOLDS.pistol;
    return HOLDS[holdFamily(weapons[def], this.kit.weapon(def).sockets?.family)];
  }

  /** W8's aim poses, when the rig has them: the held weapon's set, blended around the aim angle. */
  private blendAimPose(p: PlayerView): void {
    if (!this.aimClips.available) return;
    const def = p.weapons[p.active]?.def ?? NO_WEAPON;
    const pose: AimPose | null = def === NO_WEAPON ? null : p.dual ? 'dual' : this.holdOf(def, false).aimPose;
    this.aimClips.update(pose, aimElevation(p.aim));
  }

  /**
   * Spine and head pitch toward the aim and lean into the hold, then the gun arm(s) carry the gun
   * the way its family is held, pointing along the aim (docs/11 §4: procedural aim). With W8's aim
   * poses playing, they pose the spine and arms, and the gun is only turned onto the exact aim.
   */
  private aim(p: PlayerView, facing: 1 | -1): void {
    const elevation = aimElevation(p.aim);
    const slots = p.weapons;
    const active = slots[p.active]?.def ?? NO_WEAPON;
    const other = slots[p.active === 0 ? 1 : 0]?.def ?? NO_WEAPON;
    const leftDef = p.dual ? other : NO_WEAPON;
    const hold = this.holdOf(active, p.dual);
    const posed = this.aimClips.pose !== null;
    _lat.set(1, 0, 0).applyAxisAngle(UP, this.yaw!); // the body's left, in world space
    // +X flexes a vertical bone forward (art/README.md), so looking up is a negative turn; the
    // hold leans in, the head tips to the sights, and a recoil jolt throws the torso back
    const jolt = this.jolt * this.joltRad;
    for (let i = 0; i < this.spine.length; i++) {
      const lean = (i < 2 ? hold.lean * 0.5 : hold.head) - jolt * JOLT_SHARE[i]!;
      rotateWorld(this.spine[i]!, _q.setFromAxisAngle(_lat, (posed ? 0 : -elevation * AIM_SHARE[i]!) + lean));
    }

    _dir.set(Math.cos(p.aim), Math.sin(p.aim), 0);
    _gunUp.set(-Math.sin(p.aim) * facing, Math.cos(p.aim) * facing, 0);
    if (this.right) this.aimArm(this.right, active, 1, hold, posed);
    if (this.left) {
      this.left.gun.visible = false;
      this.left.def = NO_WEAPON;
      if (leftDef !== NO_WEAPON) this.aimArm(this.left, leftDef, -1, HOLDS.pistol, posed);
      else if (p.shield === 'front' || p.shield === 'raising') this.holdShield(this.left);
      else if (active !== NO_WEAPON && weapons[active]?.hands === 2 && this.right) {
        // two-handed: the support hand on the weapon's offhand socket (sockets.json), else where its
        // family holds it; a shotgun's slides forward to the pump
        const model = this.kit.weapon(active);
        const at = model.sockets?.offhand ?? (hold.offhand ? _t.fromArray(hold.offhand) : model.offhand);
        const grip = this.right.gun.localToWorld(_t.copy(at).setY(at.y + hold.offhandForward));
        this.left.upper.getWorldPosition(_s);
        _p.copy(_s).addScaledVector(UP, -0.5).addScaledVector(_lat, 0.3);
        solveTwoBone(this.left.upper, this.left.lower, this.left.hand, grip, _p);
      }
    }
  }

  /**
   * Riot shield up: the left arm held forward at chest height along the body's forward, elbow down
   * and out; the shield sits on its forearm (ShieldRig). `_lat` holds the body's left (aim()).
   */
  private holdShield(arm: Arm): void {
    arm.upper.getWorldPosition(_s);
    _p.set(0, 0, 1).applyAxisAngle(UP, this.yaw!); // the body's forward
    _t.copy(_s).addScaledVector(_p, arm.length * 0.85).addScaledVector(UP, -0.04);
    _p.multiplyScalar(-0.2).add(_s).addScaledVector(UP, -0.5).addScaledVector(_lat, 0.3);
    solveTwoBone(arm.upper, arm.lower, arm.hand, _t, _p);
  }

  /** side: +1 right arm, −1 left arm. `posed`: W8's aim pose placed the arm; only aim the gun. */
  private aimArm(arm: Arm, def: number, side: 1 | -1, hold: HoldProfile, posed: boolean): void {
    arm.gun.visible = def !== NO_WEAPON;
    arm.def = def;
    if (def === NO_WEAPON) return;
    const model = this.kit.weapon(def);
    arm.gun.geometry = model.geometry;
    arm.gun.material = model.material;
    const recoil = recoilOf(def);
    const kick = recoil.kick * arm.kick;
    if (!posed) {
      arm.upper.getWorldPosition(_s);
      // the hand: out along the aim, dropped toward the hip or raised to the shoulder, pulled in
      // front of the body; a shot's kick pushes it back and up, and the elbow gives
      _t.copy(_s)
        .addScaledVector(_dir, arm.length * hold.reach - kick)
        .addScaledVector(UP, -hold.drop)
        .addScaledVector(_lat, hold.inward * side)
        .addScaledVector(_gunUp, kick * 0.35);
      // the elbow: down, out to its own side, back along the aim
      _p.copy(_s).addScaledVector(UP, -hold.elbowDown).addScaledVector(_lat, -hold.elbowOut * side).addScaledVector(_dir, -hold.elbowBack);
      solveTwoBone(arm.upper, arm.lower, arm.hand, _t, _p);
    }
    // the gun along the aim (a raised blade pitches up from it; a kick makes the muzzle climb)
    const pitch = hold.pitch + recoil.rise * arm.kick;
    _gunDir.copy(_dir).multiplyScalar(Math.cos(pitch)).addScaledVector(_gunUp, Math.sin(pitch));
    orientSocket(arm.hand, arm.socket, _gunDir, _gunUp);
  }
  // --- end render3d-b: holds ---

  // --- render3d-b: recoil (recoil.ts): the gun kicks, the arm gives, big guns jolt the torso ---
  /** shots' worth of torso jolt on show, landing next frame, and its size and settle rate */
  private jolt = 0;
  private joltNext = 0;
  private joltRad = 0;
  private joltRecover = 10;
  private lastKicked: Arm | null = null;

  /**
   * A shot from `weapon` (once per shot: a shotgun's pellets are one). It shows from the next
   * frame, so the muzzle flash and tracer leave the gun where it aimed. Dual guns of the same
   * kind take turns, like their muzzles.
   */
  kick(weapon: number): void {
    if (!this.pivot.visible) return;
    const r = this.right?.gun.visible && this.right.def === weapon ? this.right : null;
    const l = this.left?.gun.visible && this.left.def === weapon ? this.left : null;
    const arm = r && l ? (this.lastKicked = this.lastKicked === r ? l : r) : (r ?? l);
    if (!arm) return;
    const scale = this.kit.recoilScale;
    const recoil = recoilOf(weapon);
    arm.kickNext += scale;
    if (recoil.torso > 0) {
      this.joltNext += scale;
      this.joltRad = recoil.torso;
      this.joltRecover = recoil.recover;
    }
  }

  /** After the aim: the kicks on show settle, and this frame's shots land for the next. */
  private settleRecoil(dt: number): void {
    if (this.right) settleArm(this.right, dt);
    if (this.left) settleArm(this.left, dt);
    this.jolt = Math.min(KICK_MAX, this.jolt * Math.exp(-this.joltRecover * dt) + this.joltNext);
    this.joltNext = 0;
  }
  // --- end render3d-b: recoil ---

  // --- render3d-b: gun muzzles for the gunfire VFX (vfx/gunfire.ts) ---
  private lastHand: Arm | null = null;

  /**
   * The muzzle of the gun that fired `weapon`, in world space, and the barrel's direction. Dual
   * guns of the same kind take turns (`peek`: the one that fired last, no turn taken). False when
   * no such gun is drawn (dead, not loaded, swapped).
   */
  muzzle(weapon: number, out: Vector3, dir: Vector3, peek = false): boolean {
    if (!this.pivot.visible) return false;
    const r = this.right?.gun.visible && this.right.def === weapon ? this.right : null;
    const l = this.left?.gun.visible && this.left.def === weapon ? this.left : null;
    const arm = r && l ? (peek ? (this.lastHand ?? r) : (this.lastHand = this.lastHand === r ? l : r)) : (r ?? l);
    if (!arm) return false;
    arm.gun.updateWorldMatrix(true, false);
    out.copy(this.kit.weapon(weapon).muzzle).applyMatrix4(arm.gun.matrixWorld);
    dir.set(0, 1, 0).transformDirection(arm.gun.matrixWorld);
    return true;
  }
  // --- end render3d-b: gun muzzles ---

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
