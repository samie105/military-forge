import { AnimationClip, Bone, Group, NumberKeyframeTrack, type Object3D } from 'three';
import type { PlayerView } from '../../view';
import type { CharacterInstance } from '../character';

/** A living, grounded, armed player view; override what the test needs. */
export function playerView(over: Partial<PlayerView> = {}): PlayerView {
  return {
    id: 0,
    name: 'P',
    isBot: false,
    isLocal: true,
    alive: true,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    grounded: true,
    crouched: false,
    jetting: false,
    aim: 0,
    hp: 100,
    fuel: 100,
    fuelRegenDelay: 0,
    frags: 3,
    active: 0,
    dual: false,
    weapons: [
      { def: 0, mag: 6, reserve: 30, reloadTicks: 0 },
      { def: 1, mag: 40, reserve: 250, reloadTicks: 0 },
    ],
    respawnTicks: 0,
    kills: 0,
    deaths: 0,
    ...over,
  };
}

/** The bones the aim drives, in the Rookie's bind layout (as in avatar.test.ts), with an idle clip. */
export function aimRig(): CharacterInstance {
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
    bone(`socket_weapon_${side}`, bone(`hand_${side}`, bone(`forearm_${side}`, upper, 0, -0.162), 0, -0.108), 0, -0.052);
  }
  const idle = new AnimationClip('idle', 1, [new NumberKeyframeTrack('pelvis.position[y]', [0, 1], [0.47, 0.46])]);
  return { root, meshes: [], clips: [idle], bone: (n) => bones.get(n) ?? null, dispose: () => root.removeFromParent() };
}
