import { movementTestMap } from '@military-forge/content';
import { CollisionWorld, type SimEvent } from '@military-forge/sim';
import {
  AnimationClip,
  Bone,
  DataTexture,
  DirectionalLight,
  Group,
  HemisphereLight,
  NumberKeyframeTrack,
  Quaternion,
  Scene,
  Vector3,
  type Object3D,
} from 'three';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../camera';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp, type CharacterInstance } from '../character';
import { PRESETS } from '../presets';
import { PickupMeshes, RicochetSparks, SHIELD_SOCKETS, ShieldKit, ShieldRig } from '../shield';
import { Vfx } from '../vfx';
import { playerView } from './helpers';

/** The bones the shield touches, in the Rookie's bind layout (no shield sockets, like the Phase 0 rig). */
function rig(): CharacterInstance {
  const bones = new Map<string, Bone>();
  const bone = (name: string, parent: Object3D, x: number, y: number, z = 0) => {
    const b = new Bone();
    b.name = name;
    b.position.set(x, y, z);
    parent.add(b);
    bones.set(name, b);
    return b;
  };
  const root = new Group();
  const spine2 = bone('spine2', bone('spine1', bone('pelvis', root, 0, 0.47), 0, 0.1), 0, 0.145);
  bone('head', bone('neck', spine2, 0, 0.145), 0, 0.13);
  for (const [side, s] of [
    ['L', 1],
    ['R', -1],
  ] as const) {
    const upper = bone(`upperarm_${side}`, spine2, 0.22 * s, 0.085);
    const lower = bone(`forearm_${side}`, upper, 0, -0.162);
    const hand = bone(`hand_${side}`, lower, 0, -0.108);
    bone(`socket_weapon_${side}`, hand, 0, -0.052);
  }
  const idle = new AnimationClip('idle', 1, [new NumberKeyframeTrack('pelvis.position[y]', [0, 1], [0.47, 0.46])]);
  return { root, meshes: [], clips: [idle], bone: (n) => bones.get(n) ?? null, dispose: () => root.removeFromParent() };
}

const world = new CollisionWorld(movementTestMap);
const kit = () => new AvatarKit(toonRamp());

describe('riot shield in 3D', () => {
  it('adds socket_shield (forearm_L) and socket_shield_back (spine2) at the documented offsets when the rig lacks them', () => {
    const inst = rig();
    const r = new ShieldRig((n) => inst.bone(n), new ShieldKit(toonRamp()));
    expect(r.front?.name).toBe('socket_shield');
    expect(r.front?.parent?.name).toBe('forearm_L');
    expect(r.front?.position.toArray()).toEqual([...SHIELD_SOCKETS.front.position]);
    expect(r.back?.name).toBe('socket_shield_back');
    expect(r.back?.parent?.name).toBe('spine2');
    expect(r.back?.position.toArray()).toEqual([...SHIELD_SOCKETS.back.position]);
    expect(r.back?.rotation.y).toBeCloseTo(Math.PI, 9);
    // a rig that has them keeps its own
    const own = new Bone();
    own.name = 'socket_shield';
    const withSocket = new ShieldRig((n) => (n === 'socket_shield' ? own : inst.bone(n)), new ShieldKit(toonRamp()));
    expect(withSocket.front).toBe(own);
  });

  it('up: on the left forearm, upright, facing the way the body faces; slung: on the back; none: hidden', () => {
    const inst = rig();
    const a = new Avatar(inst, 0, kit(), 1);
    const mesh = () => inst.root.getObjectByName('riot-shield')!;
    for (const aim of [0.2, Math.PI - 0.2]) {
      for (let i = 0; i < 30; i++) a.update(playerView({ x: 20, aim, shield: 'front' }), 1 / 60, world, true);
      const m = mesh();
      expect(m.visible).toBe(true);
      expect(m.parent?.name).toBe('socket_shield');
      const q = m.getWorldQuaternion(new Quaternion());
      const up = new Vector3(0, 1, 0).applyQuaternion(q);
      const face = new Vector3(0, 0, 1).applyQuaternion(q);
      expect(up.y).toBeCloseTo(1, 6);
      const body = new Vector3(0, 0, 1).applyQuaternion(a.pivot.getWorldQuaternion(new Quaternion()));
      expect(face.dot(body)).toBeCloseTo(1, 6);
      expect(Math.sign(face.x)).toBe(Math.cos(aim) >= 0 ? 1 : -1); // toward the aim side
      // the left arm is held forward: the hand ahead of the shoulder along the body's forward
      const shoulder = inst.bone('upperarm_L')!.getWorldPosition(new Vector3());
      const hand = inst.bone('hand_L')!.getWorldPosition(new Vector3());
      expect(hand.clone().sub(shoulder).dot(body)).toBeGreaterThan(0.15);
    }
    // on its way up: on the arm, but held low and tipped (it guards neither side yet)
    a.update(playerView({ x: 20, aim: 0.2, shield: 'raising' }), 1 / 60, world, true);
    expect(mesh().parent?.name).toBe('socket_shield');
    expect(mesh().position.y).toBeLessThan(-0.2);
    expect(mesh().rotation.x).toBeGreaterThan(0.3);
    a.update(playerView({ x: 20, shield: 'back' }), 1 / 60, world, true);
    expect(mesh().parent?.name).toBe('socket_shield_back');
    expect(mesh().visible).toBe(true);
    expect(mesh().position.toArray()).toEqual([0, 0, 0]);
    a.update(playerView({ x: 20 }), 1 / 60, world, true);
    expect(mesh().visible).toBe(false);
  });

  it('up, the plate sits in front of the left hand (review L6: the hand poked through)', () => {
    const inst = rig();
    const a = new Avatar(inst, 0, kit(), 1);
    for (let i = 0; i < 30; i++) a.update(playerView({ x: 20, aim: 0, shield: 'front' }), 1 / 60, world, true);
    const m = inst.root.getObjectByName('riot-shield')!;
    const body = new Vector3(0, 0, 1).applyQuaternion(a.pivot.getWorldQuaternion(new Quaternion()));
    // the inner face, along the body's forward, vs. the fist: 8 cm past the wrist along the hand bone
    const innerFace = m.getWorldPosition(new Vector3()).addScaledVector(body, 0.05).dot(body);
    const hand = inst.bone('hand_L')!;
    const along = new Vector3(0, 1, 0).applyQuaternion(hand.getWorldQuaternion(new Quaternion()));
    const fist = hand.getWorldPosition(new Vector3()).addScaledVector(along, 0.08).dot(body);
    expect(innerFace).toBeGreaterThan(fist);
  });

  it('items on the map get a mesh each, removed once taken', () => {
    const p = new PickupMeshes(new ShieldKit(toonRamp()));
    p.sync([{ id: 3, def: 0, x: 150.5, y: 0 }, { id: 7, def: 0, x: 154.5, y: 1.2 }], 1 / 60);
    expect(p.count).toBe(2);
    expect(p.group.children[1]!.position.x).toBe(154.5);
    expect(p.group.children[1]!.position.y).toBeGreaterThan(1.2 + 0.4); // standing on its edge
    p.sync([{ id: 7, def: 0, x: 154.5, y: 1.2 }], 1 / 60);
    expect(p.count).toBe(1);
    p.sync(undefined, 1 / 60);
    expect(p.count).toBe(0);
  });

  it('a ricochet spark pops along the shield normal and is gone in a fraction of a second', () => {
    // a Vfx module: events through onEvents, aged by update once per drawn frame
    const s = new RicochetSparks(new ShieldKit(toonRamp()), 4);
    const e: SimEvent = { type: 'ricochet', shooter: 0, owner: 1, weapon: 0, x: 10, y: 1, nx: -1, ny: 0, ex: 4, ey: 1, hit: 1, target: -1, zone: 0 };
    s.onEvents([e, { type: 'spawn', player: 2 }]);
    s.update(null, 1 / 60);
    expect(s.live).toBe(1);
    const spark = s.group.children.find((c) => c.visible)!;
    expect(spark.position.x).toBe(10);
    expect(spark.scale.x).toBe(0.6); // drawn once at its birth size
    expect(new Vector3(1, 0, 0).applyQuaternion(spark.quaternion).x).toBeCloseTo(-1, 6);
    for (let i = 0; i < 15; i++) s.update(null, 1 / 60);
    expect(s.live).toBe(0);
    // more at once than the pool holds: the oldest are reused
    s.onEvents([e, e, e, e, e, e]);
    s.update(null, 1 / 60);
    expect(s.live).toBe(4);
  });

  it('registered with the effects, the spark hears the sim events the renderer forwards', () => {
    const camera = new Camera();
    camera.resize(1280, 720);
    const lights = { hemi: new HemisphereLight(), sun: new DirectionalLight() };
    const vfx = new Vfx(new Scene(), new CollisionWorld(movementTestMap), camera, lights, new DataTexture(new Uint8Array([128]), 1, 1), PRESETS.low);
    const s = new RicochetSparks(new ShieldKit(toonRamp()), 2);
    vfx.register(s);
    vfx.onEvents([{ type: 'ricochet', shooter: 0, owner: 1, weapon: 0, x: 3, y: 1, nx: 1, ny: 0, ex: 9, ey: 1, hit: 0, target: -1, zone: 0 }]);
    vfx.update({ tick: 1, localId: 0, players: [], grenades: [] }, 1 / 60);
    expect(s.live).toBe(1);
    for (let i = 0; i < 15; i++) vfx.update({ tick: 1, localId: 0, players: [], grenades: [] }, 1 / 60);
    expect(s.live).toBe(0);
    vfx.dispose();
  });
});
