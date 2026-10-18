/**
 * Guns on the body and the switch between them (the owner, 18 Oct: "guns hanging at their back
 * and have a switch mechanism"). The weapon not in hand hangs on the soldier for everyone to see:
 * - rifles, shotguns, snipers, heavies and launchers diagonally across the back (`sling_back`);
 * - pistols and SMGs (the `pistol` family: Hammer, Buzz, Hawk, Rattler) in a thigh holster
 *   (`holster_thigh`);
 * - melee at the left hip (`hip_L`);
 * - with the riot shield slung on the back, a long gun hangs at the right side instead
 *   (`sling_side`), so nothing clips.
 * Dual pistols are both in the hands: nothing hangs.
 *
 * The back and thigh points are the Forge's rig sockets (#95: `sling_back` on spine2,
 * `holster_thigh` on thigh_R); a rig without them hangs nothing there. The hip and side points are
 * fixed points on the pelvis, placed from the Forge's rest-pose numbers (forge-sling-sockets.md).
 * Every point mounts a gun as `socket_weapon_R` does: the grip at the point, +Y toward the muzzle,
 * +Z the gun's top, +X its right side.
 *
 * The switch (`switchPhase`) runs for the sim's own equip time from the frame `PlayerView.active`
 * changes, local or remote, and the hand carries the guns between hand and body.
 */
import { weapons, type WeaponDef } from '@military-forge/content';
import { Matrix4, Mesh, Object3D, Vector3, type BufferGeometry, type Material } from 'three';

export type SlingPoint = 'back' | 'thigh' | 'hip' | 'side';

type PointDef =
  /** the rig's own socket: the gun mounts on it as it is */
  | { socket: string }
  | {
      /** the bone it hangs from */
      bone: string;
      /** rest pose, rig model space (+Y up, the character faces +Z, its right is −X) */
      pos: readonly [number, number, number];
      /** the gun's +X (its right side) and +Y (toward the muzzle) there */
      x: readonly [number, number, number];
      y: readonly [number, number, number];
    };

export const SLING_POINTS: Readonly<Record<SlingPoint, PointDef>> = {
  // on its side across the back, muzzle up over the left shoulder
  back: { socket: 'sling_back' },
  // on the outer right thigh, muzzle down, slide forward
  thigh: { socket: 'holster_thigh' },
  // a blade at the left hip, down and back
  hip: { bone: 'pelvis', pos: [0.21, 0.62, -0.06], x: [1, 0, 0], y: [0, -0.87, -0.5] },
  // a long gun at the right side, muzzle down and a little back (the shield has the back)
  side: { bone: 'pelvis', pos: [-0.27, 0.95, -0.1], x: [-1, 0, 0], y: [0, -0.94, -0.34] },
};

/** Where weapon `def` hangs (`family`: sockets.json's, when known), with the shield `onBack` or not. */
export function slingPointFor(def: WeaponDef | undefined, family: string | null | undefined, shieldOnBack: boolean): SlingPoint | null {
  if (!def) return null;
  const fam = family ?? (def.class === 'sidearm' || def.class === 'smg' ? 'pistol' : def.class === 'melee' ? 'melee' : 'rifle');
  if (fam === 'pistol') return 'thigh';
  if (fam === 'melee') return 'hip';
  if (fam === 'shield') return null;
  return shieldOnBack ? 'side' : 'back';
}

/** smooth 0 → 1 */
function smooth(k: number): number {
  const c = Math.min(1, Math.max(0, k));
  return c * c * (3 - 2 * c);
}

/** Where a switch is at `phase` (0…1 of its time). */
export interface SwitchPose {
  /** the old gun is still in the hand (on the way to its point); else the new one is, or neither */
  holdingOld: boolean;
  holdingNew: boolean;
  /** how far the hand is from the aim pose toward a body point (0 aim, 1 at the point) */
  away: number;
  /** while neither is held: from the old gun's point (0) to the new one's (1) */
  across: number;
}

/** stow the old gun until here, move across until here, then draw the new one */
export const STOW_END = 0.4;
export const DRAW_START = 0.6;

/**
 * The switch at `phase`: the hand carries the old gun to its point (to STOW_END), crosses to the
 * new gun's point empty (to DRAW_START), then brings the new gun up to the aim.
 */
export function switchPhase(phase: number, out: SwitchPose): SwitchPose {
  out.holdingOld = phase < STOW_END;
  out.holdingNew = phase >= DRAW_START;
  out.across = 0;
  if (out.holdingOld) out.away = smooth(phase / STOW_END);
  else if (out.holdingNew) out.away = 1 - smooth((phase - DRAW_START) / (1 - DRAW_START));
  else {
    out.away = 1;
    out.across = smooth((phase - STOW_END) / (DRAW_START - STOW_END));
  }
  return out;
}

/** The switch's length for drawing weapon `to` (s): the sim's equip time (combat.ts swapTicks). */
export function switchSeconds(to: number): number {
  return weapons[to]?.equip ?? 0.25;
}

const _m = new Matrix4();
const _rest = new Matrix4();
const _x = new Vector3();
const _y = new Vector3();
const _z = new Vector3();
const _p = new Vector3();

/**
 * The guns on one soldier's body: a point object per SlingPoint on its bone, and a mesh per weapon
 * slot that hangs from the point its weapon belongs on (+1 draw call per gun on show).
 */
export class SlingRig {
  readonly points: Partial<Record<SlingPoint, Object3D>> = {};
  readonly meshes: readonly [Mesh, Mesh];

  /** `bone`: the character's bone by name; built in the rig's rest pose (before any animation). */
  constructor(bone: (name: string) => Object3D | undefined | null, material: Material, geometry: BufferGeometry) {
    for (const [name, def] of Object.entries(SLING_POINTS) as [SlingPoint, PointDef][]) {
      if ('socket' in def) {
        const own = bone(def.socket);
        if (own) this.points[name] = own;
        continue;
      }
      const parent = bone(def.bone);
      if (!parent) continue;
      parent.updateWorldMatrix(true, false);
      _x.fromArray(def.x).normalize();
      _y.fromArray(def.y).normalize();
      _z.crossVectors(_x, _y).normalize();
      _rest.makeBasis(_x, _y, _z).setPosition(_p.fromArray(def.pos));
      const point = new Object3D();
      point.name = `${name}-sling`;
      _m.copy(parent.matrixWorld).invert().multiply(_rest);
      _m.decompose(point.position, point.quaternion, point.scale);
      parent.add(point);
      this.points[name] = point;
    }
    const make = () => {
      const m = new Mesh(geometry, material);
      m.name = 'slung-gun';
      m.visible = false;
      return m;
    };
    this.meshes = [make(), make()];
  }

  /** Slot `slot`'s gun hanging at `point` (null, or no such point: not shown). */
  hang(slot: 0 | 1, point: SlingPoint | null, geometry: BufferGeometry, material: Material): void {
    const mesh = this.meshes[slot];
    const at = point ? this.points[point] : undefined;
    if (!at) {
      mesh.visible = false;
      return;
    }
    if (mesh.parent !== at) at.add(mesh);
    mesh.geometry = geometry;
    mesh.material = material;
    mesh.visible = true;
  }

  hide(slot: 0 | 1): void {
    this.meshes[slot].visible = false;
  }
}
