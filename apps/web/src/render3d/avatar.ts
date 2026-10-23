/**
 * One player's 3D body: the assembled character, its AnimationMixer and locomotion (locomotion.ts: the clip blend
 * and planted feet; motion.ts: lean, squash, flail, dash pose), the facing turn, procedural aim (spine/head pitch + IK arms that point the gun along the sim's
 * aim), weapons on the hand sockets, the jet flame and a blob shadow (docs/04 §4, docs/11 §2/§4). Any discrete change
 * in the pose eases out instead of popping (inertia.ts).
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
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
  type Texture,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PlayerView } from '../view';
import type { CharacterInstance, CharacterLod } from './character';
import { GunParts, cycleByClass, ease, partPose, type GunCycle, type PartPose } from './gunParts';
import { AimClips, HOLDS, holdFamily, type AimPose, type HoldProfile } from './holds';
import { KICK_MAX, recoilOf } from './recoil';
import { DEFAULT_OFFHAND, bakeGltfMesh, loadWeaponModels, type GltfSource, type GunMaterials, type WeaponModel } from './weaponModels';
import { orientSocket, rotateWorld, solveTwoBone } from './ik';
import { Inertializer, WorldEase } from './inertia';
import { FootPlanter, LocoLayer, UPPER_BODY, aimElevation, facingOf, facingYaw, stepYaw } from './locomotion';
import { MotionLayer } from './motion';
import { ShieldKit, ShieldRig } from './shield';
import { Handoff, SlingRig, slingPointFor, switchPhase, switchSeconds, type SlingPoint, type SwitchPose } from './sling';
import { SwingClock, swingPose, type SwingPose } from './swing';

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
    // the riot shield's Forge model in place of the placeholder plate (shield.ts); a failure keeps the plate
    const shield = loader
      .loadAsync(`${baseUrl}assets/weapons/riot_shield.glb`)
      .then((gltf) => {
        const geometry = bakeGltfMesh(gltf);
        if (geometry) this.shield.setModel(geometry);
      })
      .catch((err: unknown) => console.warn('render3d: riot_shield.glb failed to load, drawing the placeholder shield', err));
    return Promise.all([loadWeaponModels(baseUrl, loader, this.gunMaterials, (def, model) => this.models.set(def, model)), shield]).then(() => undefined);
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

  // --- render3d-b: gun mechanisms (gunParts.ts) ---
  /** guns' moving parts move (Medium, High); on Low they stay merged into the gun, still */
  animateParts = true;
  private readonly classCycles = new Map<number, GunCycle | null>();

  /** The pump or bolt the hands work on weapon `def` (its GLB's, else by class), or null. */
  cycleOf(def: number): GunCycle | null {
    const own = this.weapon(def).cycle;
    if (own) return own;
    let c = this.classCycles.get(def);
    if (c === undefined) this.classCycles.set(def, (c = cycleByClass(weapons[def])));
    return c;
  }
  // --- end render3d-b: gun mechanisms ---

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
  /** the gun's moving parts (gunParts.ts) */
  parts: GunParts;
  /** seconds since this hand's gun last fired (the hands work its pump or bolt) */
  shotAge: number;
  /** animation: the hand's place in the inertia bones, and its world turn as the aim layer left it (ease()) */
  inertiaIndex: number;
  aimed: Quaternion;
  handEase: WorldEase;
}

/** The bones inertialization eases (inertia.ts): every bone the clips and the procedural layers turn. */
const INERTIA_BONES = ['root', 'pelvis', 'spine1', 'spine2', 'neck', 'head', 'clavicle_L', 'clavicle_R', 'upperarm_L', 'upperarm_R', 'forearm_L', 'forearm_R', 'hand_L', 'hand_R', 'thigh_L', 'thigh_R', 'calf_L', 'calf_R', 'foot_L', 'foot_R'];

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
/** a gun without an `eject` socket throws its casings from beside the receiver, out to its right and up */
const EJECT_POS = new Vector3(0.03, 0.06, 0.06);
const _pose: PartPose = { back: 0, turn: 0 };
const _sw: SwitchPose = { holdingOld: false, holdingNew: false, away: 0, across: 0 };
const _c = new Vector3();
const _qa = new Quaternion();
const _qb = new Quaternion();
const _held = new Matrix4();
const _inv = new Matrix4();
const _h = new Vector3();
const _swing: SwingPose = { weight: 0, angle: 0, reach: 0, striking: false };
const _sd = new Vector3();
const _su = new Vector3();
const EJECT_DIR = new Vector3(0.8, -0.25, 0.55).normalize();

/**
 * Mid-switch, the gun arm's pitch at the dip (rad, from the horizontal on the aim's side): lowered from the aim
 * `elevation` by 40° for the quickest switch (a 0.25 s pistol draw) up to 65° for a slower one, never below low ready
 * (−55°), never raised.
 */
export function switchDip(seconds: number, elevation: number): number {
  const k = Math.min(1, Math.max(0, (seconds - 0.25) / 0.1));
  const drop = ((40 + 25 * k * k * (3 - 2 * k)) * Math.PI) / 180;
  return Math.min(elevation, Math.max(elevation - drop, -SWITCH_LOW));
}
/** low ready: how far below the horizontal (rad) a switch takes the arm at most */
const SWITCH_LOW = (55 * Math.PI) / 180;
const _ox = new Vector3();
const _oy = new Vector3();
const _oz = new Vector3();
const _om = new Matrix4();
/** The world turn of a socket pointing +Y along `forward` with +Z toward `up` (as orientSocket turns it). */
function orientFrom(out: Quaternion, forward: Vector3, up: Vector3): Quaternion {
  _oy.copy(forward).normalize();
  _oz.copy(up).addScaledVector(_oy, -up.dot(_oy)).normalize();
  _ox.crossVectors(_oy, _oz);
  return out.setFromRotationMatrix(_om.makeBasis(_ox, _oy, _oz));
}

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
  // --- animation (locomotion.ts / motion.ts): the clip blend and the procedural body motion ---
  readonly loco: LocoLayer;
  readonly motion: MotionLayer;
  readonly feet: FootPlanter;
  /** inertialization (inertia.ts): every discrete pose change eases out over ~0.25 s instead of popping */
  readonly inertia: Inertializer;
  /** the inertia bones the upper-body changes (weapon, hold, aim poses, shield, switch, swing) ease */
  private readonly upperBody: number[];
  /** what the upper body was doing last frame (poseKey); −1: nothing drawn yet */
  private lastKey = -1;
  private deaths = -1;
  // --- end animation ---
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
  /** render3d-b: the guns on the body and the switch (sling.ts) */
  private readonly sling: SlingRig;

  constructor(
    readonly inst: CharacterInstance,
    readonly lod: CharacterLod,
    private readonly kit: AvatarKit,
    seed: number,
  ) {
    this.pivot.add(inst.root);
    this.mixer = new AnimationMixer(inst.root);
    // --- animation ---
    this.loco = new LocoLayer(this.mixer, inst, seed);
    this.motion = new MotionLayer(inst, seed);
    this.feet = new FootPlanter(inst);
    // --- end animation ---
    this.spine = ['spine1', 'spine2', 'head'].map((n) => inst.bone(n)).filter((b): b is NonNullable<typeof b> => !!b);
    this.aimClips = new AimClips(this.mixer, inst.clips);
    this.right = this.arm('R');
    this.left = this.arm('L');
    const armBones = [this.right, this.left].flatMap((a) => (a ? [a.upper, a.lower, a.hand, a.socket] : []));
    // --- animation: the bones inertialization eases (all of them are put back to the animation pose every frame) ---
    const inertiaBones: Object3D[] = INERTIA_BONES.map((n) => inst.bone(n)).filter((b): b is NonNullable<typeof b> => !!b);
    this.inertia = new Inertializer(inertiaBones);
    this.upperBody = inertiaBones.flatMap((b, i) => (UPPER_BODY.includes(b.name) ? [i] : []));
    for (const arm of [this.right, this.left]) if (arm) arm.inertiaIndex = inertiaBones.indexOf(arm.hand);
    // --- end animation ---
    this.posed = [...new Set([...this.spine, ...armBones, ...this.motion.bones, ...this.feet.bones, ...inertiaBones])].map((bone) => ({ bone, anim: bone.quaternion.clone() }));

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
    this.sling = new SlingRig((name) => inst.bone(name), kit.gunMaterial, kit.weapon(0).geometry); // in the rest pose, before any animation
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
    return { upper, lower, hand, socket, gun, def: NO_WEAPON, length, kick: 0, kickNext: 0, parts: new GunParts(gun), shotAge: Infinity, inertiaIndex: -1, aimed: new Quaternion(), handEase: new WorldEase() };
  }

  update(p: PlayerView, dt: number, world: CollisionWorld, blobShadows: boolean): void {
    this.pivot.visible = p.alive;
    this.blob.visible = p.alive && blobShadows;
    if (!p.alive) return;
    this.time += dt;
    for (const b of this.posed) b.bone.quaternion.copy(b.anim); // undo last frame's aim, lean and planted legs
    this.blendAimPose(p);
    // --- animation: clip weights and gait phase for this frame; W8's aim poses own the upper body while shown ---
    this.loco.facing = facingOf(p.aim);
    this.loco.setUpperBody(this.aimClips.pose === null);
    this.loco.update(p, dt);
    // --- end animation ---
    this.mixer.update(dt);
    for (const b of this.posed) b.anim.copy(b.bone.quaternion);

    const facing = facingOf(p.aim);
    const target = facingYaw(facing);
    this.yaw = this.yaw === null ? target : stepYaw(this.yaw, target, dt);
    this.pivot.position.set(p.x, p.y, 0);
    this.pivot.rotation.set(0, this.yaw, 0);
    this.pivot.updateMatrixWorld(true);

    // --- animation: lean, landing squash, launch flail, dash pose, then planted feet (before the aim layer) ---
    const active = p.weapons[p.active]?.def ?? NO_WEAPON;
    // the arms the aim layer holds (aim()): the gun arm, and the left one for a second gun, a two-handed grip or the shield
    const leftHeld = p.dual || (active !== NO_WEAPON && weapons[active]?.hands === 2) || p.shield === 'front' || p.shield === 'raising';
    const held: ('L' | 'R')[] = [...(active !== NO_WEAPON || p.dual ? (['R'] as const) : []), ...(leftHeld ? (['L'] as const) : [])];
    this.motion.update(p, dt, this.yaw, this.loco, this.holdOf(active, p.dual).lean, held);
    this.feet.update(p, this.yaw, this.loco, dt, world, this.motion.drop);
    // --- end animation ---
    this.watchSwitch(p, dt);
    this.swing.update(p.meleeTicks, dt);
    this.aim(p, facing);
    // --- animation: a discrete change in what the upper body does eases out (inertia.ts); an aimed gun stays exact ---
    this.ease(p, dt);
    // --- end animation ---
    this.hangGuns(p, dt);
    this.shield.update(p.shield, this.pivot);
    this.settleRecoil(dt);
    this.updateFlame(p, dt);
    if (blobShadows) this.updateBlob(p, world);
  }

  // --- animation: inertialization (inertia.ts) ---
  /** what the aim layer did with each hand this frame (aim()): the gun hand's weapon, the left hand's job */
  private inHand = NO_WEAPON;
  private leftJob = 0;
  /** the hands whose gun points along the aim this frame: their world turn is kept through the easing */
  private readonly exact: Arm[] = [];

  /**
   * Everything the upper body's pose switches on, as one number: a change starts an ease (a weapon switch, a
   * pick-up or drop, the dual toggle, the aim poses' set, the shield, a melee swing, a switch's phases).
   */
  private poseKey(p: PlayerView): number {
    const pose = this.aimClips.pose;
    const posed = pose === null ? 0 : pose === 'pistol' ? 1 : pose === 'dual' ? 2 : 3;
    const shield = p.shield === 'front' ? 1 : p.shield === 'raising' ? 2 : p.shield === 'back' ? 3 : 0;
    const swinging = this.swing.t >= 0 ? 1 : 0;
    return ((((this.inHand * 8 + this.leftJob) * 4 + posed) * 4 + shield) * 2 + swinging) * 2 + (this.switching ? 1 : 0);
  }

  /** After the aim layer: start an ease on a change of what the upper body does, decay the offsets, keep aimed guns exact. */
  private ease(p: PlayerView, dt: number): void {
    const arms = [this.right, this.left];
    if (p.deaths !== this.deaths) {
      // a respawn is a teleport: shown as it is
      if (this.deaths >= 0) {
        this.inertia.reset();
        for (const arm of arms) arm?.handEase.reset();
      }
      this.deaths = p.deaths;
    }
    const key = this.poseKey(p);
    if (this.lastKey >= 0 && key !== this.lastKey) {
      this.inertia.trigger(this.upperBody);
      for (const arm of arms) arm?.handEase.trigger();
    }
    this.lastKey = key;
    // an aimed gun's hand turns in the world from where it was straight onto the aim, whatever its arm eases through
    for (const arm of this.exact) arm.hand.getWorldQuaternion(arm.aimed);
    const easing = this.inertia.active > 0 || this.inertia.pending;
    if (easing) {
      this.inertia.apply(dt);
      this.inst.root.updateMatrixWorld(true);
    }
    for (const arm of arms) {
      if (!arm) continue;
      if (!this.exact.includes(arm)) {
        arm.handEase.record(arm.hand.getWorldQuaternion(_qb));
        continue;
      }
      this.inertia.pin(arm.inertiaIndex);
      const turning = arm.handEase.active || arm.handEase.pending;
      arm.handEase.apply(arm.aimed, dt);
      if (!easing && !turning) continue;
      arm.hand.parent!.getWorldQuaternion(_qa).invert();
      arm.hand.quaternion.copy(_qa.multiply(arm.aimed));
      arm.hand.updateMatrixWorld(true);
    }
    this.inertia.record();
  }
  // --- end animation: inertialization ---

  // --- render3d-b: melee swings (swing.ts) ---
  private readonly swing = new SwingClock();

  /** One of its melee hits landed: a remote swing (no `meleeTicks` online) plays from the strike. */
  struck(): void {
    if (this.pivot.visible) this.swing.struck();
  }

  /** Mid-strike: the hand and the weapon's tip (its `muzzle`, a blade's point) in world space, for the trail (vfx/melee.ts). */
  swingSegment(out: { hx: number; hy: number; tx: number; ty: number }): boolean {
    const arm = this.right;
    if (!this.pivot.visible || !arm) return false;
    if (!swingPose(this.swing.t, weapons[arm.def]?.fireMode === 'melee', _swing).striking) return false;
    arm.hand.getWorldPosition(_h);
    out.hx = _h.x;
    out.hy = _h.y;
    if (arm.def === NO_WEAPON) _h.set(0, 0.12, 0);
    else _h.copy(this.kit.weapon(arm.def).muzzle);
    arm.socket.localToWorld(_h);
    out.tx = _h.x;
    out.ty = _h.y;
    return true;
  }

  /**
   * The gun arm through a swing, over where its hold put it: drawn back, then a blade sweeping
   * down through the arc (a gun or a fist jabbing out), then easing back. The weapon turns with it.
   */
  private swingArm(arm: Arm, p: PlayerView, facing: 1 | -1, def: number): void {
    const slash = weapons[def]?.fireMode === 'melee';
    const pose = swingPose(this.swing.t, slash, _swing);
    if (pose.weight <= 0) return;
    const a = p.aim + facing * pose.angle;
    _sd.set(Math.cos(a), Math.sin(a), 0);
    _su.set(-Math.sin(a) * facing, Math.cos(a) * facing, 0);
    arm.upper.getWorldPosition(_s);
    arm.hand.getWorldPosition(_c);
    _t.copy(_s).addScaledVector(_sd, arm.length * pose.reach).addScaledVector(_lat, -0.12).lerp(_c, 1 - pose.weight);
    // the elbow: behind the swing and down
    _p.copy(_s).addScaledVector(_sd, -0.3).addScaledVector(UP, -0.35).addScaledVector(_lat, -0.2);
    solveTwoBone(arm.upper, arm.lower, arm.hand, _t, _p);
    if (arm.def === NO_WEAPON) return;
    // the weapon: from along the aim to along the swing (a blade out from the hand like an arm's length more)
    _sd.lerp(_gunDir, 1 - pose.weight).normalize();
    _su.lerp(_gunUp, 1 - pose.weight).normalize(); // _gunUp stays as aim() set it: the left arm reads it next
    orientSocket(arm.hand, arm.socket, _sd, _su);
  }

  /** animation: a hit landed (motion.ts hit reactions); `scale` is 1, or less under Reduce motion */
  hit(dirX: number, dirY: number, size: number, zone: number, scale = 1): void {
    if (this.pivot.visible) this.motion.hit(dirX, dirY, size * scale, zone);
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
    // mid-switch the gun hand holds the old gun, then nothing, then the new one (sling.ts)
    const switching = this.switching ? switchPhase(this.swT / this.swDur, _sw) : null;
    const inHand = switching ? (switching.holdingOld ? this.swFrom : switching.holdingNew ? this.swTo : NO_WEAPON) : active;
    // animation (ease()): what each hand does, and which guns point along the aim
    this.inHand = inHand;
    this.leftJob = 0;
    this.exact.length = 0;
    if (this.right && inHand !== NO_WEAPON && !switching && this.swing.t < 0) this.exact.push(this.right);
    if (this.right) {
      this.aimArm(this.right, inHand, 1, switching ? this.holdOf(inHand, false) : hold, posed);
      if (switching) this.carry(this.right, switching, facing, elevation);
      else this.swingArm(this.right, p, facing, inHand);
    }
    if (this.left) {
      this.left.gun.visible = false;
      this.left.def = NO_WEAPON;
      if (leftDef !== NO_WEAPON) {
        this.aimArm(this.left, leftDef, -1, HOLDS.pistol, posed);
        this.leftJob = 1;
        this.exact.push(this.left);
      } else if (p.shield === 'front' || p.shield === 'raising') {
        this.holdShield(this.left);
        this.leftJob = 2;
      } else if (!switching && active !== NO_WEAPON && weapons[active]?.hands === 2 && this.right) {
        this.leftJob = 3;
        // two-handed: the support hand on the weapon's offhand socket (sockets.json), else where its
        // family holds it; a shotgun's slides forward to the pump
        const model = this.kit.weapon(active);
        const at = model.sockets?.offhand ?? (hold.offhand ? _t.fromArray(hold.offhand) : model.offhand);
        _t.copy(at).setY(at.y + hold.offhandForward);
        // a pump gun: the support hand rides the pump back and forward after each shot (gunParts.ts)
        const cycle = this.kit.cycleOf(active);
        if (cycle?.kind === 'pump') _t.addScaledVector(cycle.axis, cycle.travel * partPose('pump', this.right.shotAge, weapons[active]?.interval ?? 1, _pose).back);
        const grip = this.right.gun.localToWorld(_t);
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
    arm.gun.position.set(0, 0, 0); // held in the hand (workBolt moves it off the hand while that works the bolt)
    arm.gun.quaternion.identity();
    const moving = this.kit.animateParts && model.parts !== undefined;
    arm.gun.geometry = moving || !model.solid ? model.geometry : model.solid;
    arm.gun.material = model.material;
    arm.parts.set(moving ? model.parts : undefined, model.material, weapons[def]?.interval ?? 1);
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
    // a bolt gun: after each shot the trigger hand leaves the grip and works the bolt (gunParts.ts)
    if (side === 1) {
      const cycle = this.kit.cycleOf(def);
      if (cycle?.kind === 'bolt') this.workBolt(arm, cycle, weapons[def]?.interval ?? 1);
    }
  }

  /**
   * The trigger hand on the bolt's handle: up, back, forward, down with the bolt (partPose), then
   * back to the grip, inside the gun's interval. The gun stays where the hand held it: it comes off
   * the hand's socket for the stroke (its local transform undoes the hand's move).
   */
  private workBolt(arm: Arm, cycle: GunCycle, interval: number): void {
    const t = arm.shotAge;
    const k = Math.min(1, interval / 0.7);
    const reach = ease(t, 0.04 * k, 0.14 * k) * (1 - ease(t, 0.56 * k, 0.68 * k));
    if (reach <= 0) return;
    partPose('bolt', t, interval, _pose);
    arm.gun.updateWorldMatrix(true, false);
    _held.copy(arm.gun.matrixWorld);
    // the handle: the bolt's root, back by the stroke, turned up and out to the gun's right
    _h.copy(cycle.axis).multiplyScalar(cycle.travel * _pose.back).add(cycle.position);
    _h.x += 0.03 * _pose.turn;
    _h.z += 0.03 * _pose.turn;
    _h.applyMatrix4(_held);
    // the wrist goes where it puts the grip (the socket, in the palm) on the handle
    arm.hand.getWorldPosition(_s);
    arm.socket.getWorldPosition(_t);
    _h.sub(_t).add(_s);
    _t.copy(_s).lerp(_h, reach);
    arm.upper.getWorldPosition(_s);
    _p.copy(_s).addScaledVector(UP, -0.5).addScaledVector(_dir, -0.25);
    solveTwoBone(arm.upper, arm.lower, arm.hand, _t, _p);
    arm.hand.updateMatrixWorld(true);
    // the gun where it was held, whatever the hand does
    _inv.copy(arm.socket.matrixWorld).invert();
    _held.premultiply(_inv);
    _held.decompose(arm.gun.position, arm.gun.quaternion, _s);
    arm.gun.updateMatrixWorld(true);
  }
  // --- end render3d-b: holds ---

  // --- render3d-b: guns on the body and the switch (sling.ts) ---
  /** the slot in hand and both slots' weapons last frame (a switch starts when the slot changes) */
  private swSlot = -1;
  private readonly swDefs: [number, number] = [NO_WEAPON, NO_WEAPON];
  private swFrom = NO_WEAPON;
  private swTo = NO_WEAPON;
  private swT = 0;
  /** the switch's length (s; 0: none under way) */
  private swDur = 0;
  /** animation: each slot's gun was in a hand last frame; the guns flying between the hand and the body (Handoff) */
  private readonly slungInHand = [true, true];
  private readonly stowed = [new Handoff(), new Handoff()] as const;
  private readonly drawn = new Handoff();

  private get switching(): boolean {
    return this.swDur > 0;
  }

  /**
   * A switch starts on the frame the slot in hand changes with both weapons as they were (a pickup
   * or a dual toggle isn't one), and lasts the sim's equip time for the gun coming up.
   */
  private watchSwitch(p: PlayerView, dt: number): void {
    const d0 = p.weapons[0]?.def ?? NO_WEAPON;
    const d1 = p.weapons[1]?.def ?? NO_WEAPON;
    if (this.swSlot >= 0 && p.active !== this.swSlot && !p.dual && d0 === this.swDefs[0] && d1 === this.swDefs[1]) {
      this.swFrom = this.swDefs[this.swSlot]!;
      this.swTo = p.weapons[p.active]?.def ?? NO_WEAPON;
      this.swT = 0;
      this.swDur = this.swFrom === NO_WEAPON && this.swTo === NO_WEAPON ? 0 : switchSeconds(this.swTo);
    } else if (this.switching) {
      this.swT += dt;
      if (this.swT >= this.swDur || p.dual) this.swDur = 0;
    }
    this.swSlot = p.active;
    this.swDefs[0] = d0;
    this.swDefs[1] = d1;
  }

  /** Where weapon `def` hangs on this body now. */
  private pointOf(def: number, shieldOnBack: boolean): SlingPoint | null {
    return def === NO_WEAPON ? null : slingPointFor(weapons[def], this.kit.weapon(def).sockets?.family, shieldOnBack);
  }

  /**
   * Every gun not in a hand hangs on the body; dual guns are both in hand. Low draws remote
   * soldiers at LOD1 and keeps its draw calls down: they carry no slung gun (+1 draw each).
   */
  private hangGuns(p: PlayerView, dt: number): void {
    if (this.lod === 1) {
      this.sling.hide(0);
      this.sling.hide(1);
      return;
    }
    const pose = this.switching ? switchPhase(this.swT / this.swDur, _sw) : null;
    for (const slot of [0, 1] as const) {
      const def = p.weapons[slot]?.def ?? NO_WEAPON;
      let inHand = p.dual || slot === p.active;
      if (pose && def === this.swFrom && slot !== p.active) inHand = pose.holdingOld; // on its way to the body
      if (pose && slot === p.active) inHand = pose.holdingNew; // still on the body until the hand takes it
      // animation: at a switch's handover the gun flies the last bit between the hand and the body (sling.ts Handoff)
      const handover = pose && def !== NO_WEAPON && inHand !== this.slungInHand[slot];
      this.slungInHand[slot] = inHand;
      if (def === NO_WEAPON || inHand) {
        if (handover && this.right) {
          // into the hand: from where it hung (its point, as the body is now)
          const at = this.sling.points[this.pointOf(def, p.shield === 'back') ?? 'back'];
          if (at) {
            at.updateWorldMatrix(true, false);
            this.drawn.start(at.matrixWorld);
          }
        }
        this.sling.hide(slot);
        continue;
      }
      const model = this.kit.weapon(def);
      this.sling.hang(slot, this.pointOf(def, p.shield === 'back'), model.solid ?? model.geometry, model.material);
      // onto the body: from the hand (the gun mesh still where the hand holds it)
      if (handover && this.right) {
        this.right.gun.updateWorldMatrix(true, false);
        this.stowed[slot].start(this.right.gun.matrixWorld);
      }
      this.stowed[slot].apply(this.sling.meshes[slot], dt);
    }
    if (this.right?.gun.visible && this.drawn.active) this.drawn.apply(this.right.gun, dt);
  }

  /**
   * Mid-switch: a low-ready dip. The whole gun arm, as the aim layer holds it, turns down about the shoulder in the
   * aim's plane (switchDip: further for a slower switch, never past low ready) and holds there while the guns change
   * over (the old one onto the body, the new one into the hand; chibi arms don't reach the back or the thigh, so the
   * guns fly that last bit themselves, see hangGuns), then the new gun comes up onto the aim. The arm turns as one
   * piece, so no bone turns faster than the dip itself (a 0.25 s pistol draw: ≤ ~15° a frame).
   */
  private carry(arm: Arm, pose: SwitchPose, facing: 1 | -1, elevation: number): void {
    const hold = this.holdOf(pose.holdingNew ? this.swTo : this.swFrom, false);
    _q.setFromAxisAngle(_h.set(0, 0, 1), -facing * pose.away * (elevation - switchDip(this.swDur, elevation)));
    // the shoulder; the grip and the elbow as the aim layer has them now, turned down about it
    arm.upper.getWorldPosition(_s);
    arm.socket.getWorldPosition(_c).sub(_s).applyQuaternion(_q).add(_s);
    arm.lower.getWorldPosition(_p).sub(_s).applyQuaternion(_q).add(_s);
    // the gun as the hold has it (along the aim, a blade raised), turned down with the arm
    _sd.copy(_dir).multiplyScalar(Math.cos(hold.pitch)).addScaledVector(_gunUp, Math.sin(hold.pitch)).applyQuaternion(_q); // (_gunUp: the aim's up)
    _su.copy(_gunUp).multiplyScalar(Math.cos(hold.pitch)).addScaledVector(_dir, -Math.sin(hold.pitch)).applyQuaternion(_q);
    orientFrom(_qa, _sd, _su);
    // the wrist for that grip (the socket sits at socket.position in the hand, turned by socket.quaternion); the elbow
    // bends toward where it was, turned down
    _qb.copy(arm.socket.quaternion).invert().premultiply(_qa);
    _c.sub(_t.copy(arm.socket.position).applyQuaternion(_qb));
    solveTwoBone(arm.upper, arm.lower, arm.hand, _c, _p);
    orientSocket(arm.hand, arm.socket, _sd, _su);
  }
  // --- end render3d-b: guns on the body and the switch ---

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
    arm.parts.fire(); // the slide, pump, bolt or cylinder cycles (gunParts.ts)
    arm.shotAge = 0; // and the hands work the pump or bolt
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
    this.right?.parts.update(dt);
    this.left?.parts.update(dt);
    if (this.right) this.right.shotAge += dt;
    if (this.left) this.left.shotAge += dt;
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
    const arm = this.drawnGun(weapon, peek);
    if (!arm) return false;
    out.copy(this.kit.weapon(weapon).muzzle).applyMatrix4(arm.gun.matrixWorld);
    dir.set(0, 1, 0).transformDirection(arm.gun.matrixWorld);
    return true;
  }

  /**
   * Where the gun that last fired `weapon` throws its casings (sockets.json `eject`, else beside its
   * receiver), in world space, which way, and its bore (`bore`, toward the muzzle) (vfx/casings.ts).
   * False when no such gun is drawn.
   */
  eject(weapon: number, out: Vector3, dir: Vector3, bore?: Vector3): boolean {
    const arm = this.drawnGun(weapon, true);
    if (!arm) return false;
    const e = this.kit.weapon(weapon).sockets?.eject;
    out.copy(e?.pos ?? EJECT_POS).applyMatrix4(arm.gun.matrixWorld);
    dir.copy(e?.dir ?? EJECT_DIR).transformDirection(arm.gun.matrixWorld);
    bore?.set(0, 1, 0).transformDirection(arm.gun.matrixWorld);
    return true;
  }

  /**
   * Socket `name` (sockets.json: `pilot`, `charge`…) of the drawn gun that holds `weapon`, in world
   * space (vfx/projectiles.ts); its muzzle when the gun has no such socket. False when no such gun
   * is drawn.
   */
  gunPoint(weapon: number, name: string, out: Vector3): boolean {
    const arm = this.drawnGun(weapon, true);
    if (!arm) return false;
    const model = this.kit.weapon(weapon);
    out.copy(model.sockets?.points[name] ?? model.muzzle).applyMatrix4(arm.gun.matrixWorld);
    return true;
  }

  /** The arm drawing `weapon` (dual guns of one kind take turns; `peek`: the one that fired last), its matrices current. */
  private drawnGun(weapon: number, peek: boolean): Arm | null {
    if (!this.pivot.visible) return null;
    const r = this.right?.gun.visible && this.right.def === weapon ? this.right : null;
    const l = this.left?.gun.visible && this.left.def === weapon ? this.left : null;
    const arm = r && l ? (peek ? (this.lastHand ?? r) : (this.lastHand = this.lastHand === r ? l : r)) : (r ?? l);
    arm?.gun.updateWorldMatrix(true, false);
    return arm;
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
