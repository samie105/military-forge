/**
 * Phase 0 Rookie specifics (art/character/rookie.glb): the parts baked into its single mesh and
 * procedural placeholder parts for the starter cosmetics. All of this goes away when W8's split
 * body (no built-in parts) and real part GLBs land; the assembler API stays the same.
 *
 * Coordinates are the rig's bind pose in metres: glTF +Y up, +Z forward, feet at y = 0
 * (bone positions from the rig: head 0.99, eyes y 1.106 z 0.205, hands ±0.374/0.578,
 * feet ±0.186/0.12, socket_jetpack z −0.172).
 */
import { BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, Euler, Matrix4, Quaternion, SphereGeometry, Vector3 } from 'three';
import type { PartSlot } from '@military-forge/content';

/** Triangle regions of the base mesh that belong to a built-in part. */
export const Region = { None: 0, Helmet: 1, Boots: 2, Jetpack: 3 } as const;
export type Region = (typeof Region)[keyof typeof Region];

/** Built-in default per part slot: equipping anything else in the slot hides the region (if any). */
export const BUILT_IN: Readonly<Partial<Record<PartSlot, { item: string; region: Region }>>> = {
  headgear: { item: 'headgear_brim_helmet', region: Region.Helmet },
  boots: { item: 'boots_combat', region: Region.Boots },
  jetpack: { item: 'jetpack_twin_tank', region: Region.Jetpack },
  top: { item: 'top_fatigues', region: Region.None },
  legs: { item: 'legs_fatigues', region: Region.None },
};

/**
 * Region of a base-mesh triangle from its dominant bone, bind-pose centroid and skin weight: the
 * helmet is everything on the head bone above the brow or out at the brim, except skin (ears).
 */
export function classifyRegion(bone: string, x: number, y: number, z: number, skin: number): Region {
  if (bone === 'head') return skin < 0.5 && (y > 1.19 || Math.hypot(x, z + 0.011) > 0.25) ? Region.Helmet : Region.None;
  if (bone.startsWith('foot_') || bone.startsWith('toe_') || (bone.startsWith('calf_') && y < 0.17)) return Region.Boots;
  if (['spine1', 'spine2', 'neck', 'clavicle_L', 'clavicle_R'].includes(bone) && z < -0.185 && y > 0.45 && y < 1.05) return Region.Jetpack;
  return Region.None;
}

/** One rigid piece of a placeholder part: weighted 100% to `bone`, coloured and masked per vertex. */
export interface PlaceholderPiece {
  geometry: BufferGeometry;
  bone: string;
  /** sRGB hex albedo */
  colour: string;
  /** dye weights: primary, secondary, accent, emissive */
  mask: readonly [number, number, number, number];
}

const P = [1, 0, 0, 0] as const;
const S = [0, 1, 0, 0] as const;
const A = [0, 0, 1, 0] as const;
const NONE = [0, 0, 0, 0] as const;
/** Albedo of dyed pieces: about as bright as the body's neutralised dye regions. */
const DYED = '#c8c8c8';

function place(g: BufferGeometry, x: number, y: number, z: number, scale: readonly number[] = [1, 1, 1], rot: readonly number[] = [0, 0, 0]): BufferGeometry {
  const m = new Matrix4().compose(new Vector3(x, y, z), new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2])), new Vector3(...scale));
  return g.applyMatrix4(m);
}

const sphere = (x: number, y: number, z: number, r: readonly number[], upper = false) =>
  place(new SphereGeometry(1, 16, upper ? 6 : 10, 0, Math.PI * 2, 0, upper ? Math.PI / 2 : Math.PI), x, y, z, r);
const cylinder = (x: number, y: number, z: number, r: number, h: number, rot?: readonly number[], rBottom = r) =>
  place(new CylinderGeometry(r, rBottom, h, 14), x, y, z, [1, 1, 1], rot);
const box = (x: number, y: number, z: number, w: number, h: number, d: number) => place(new BoxGeometry(w, h, d), x, y, z);
const cone = (x: number, y: number, z: number, r: number, h: number, rot?: readonly number[]) => place(new ConeGeometry(r, h, 12), x, y, z, [1, 1, 1], rot);

const piece = (geometry: BufferGeometry, bone: string, colour: string, mask: PlaceholderPiece['mask']): PlaceholderPiece => ({ geometry, bone, colour, mask });
const sides = (make: (s: 1 | -1, side: 'L' | 'R') => PlaceholderPiece[]) => [...make(1, 'L'), ...make(-1, 'R')];

/** Every headgear replaces the helmet, so each one closes the skull with its own crown. */
const crown = (colour: string, mask: PlaceholderPiece['mask'], r: readonly number[] = [0.29, 0.25, 0.3]) => piece(sphere(0, 1.17, -0.02, r, true), 'head', colour, mask);

/** Every jetpack replaces the built-in one, so each covers the back with a mounting plate. Tanks sit
 *  close enough to the back that the Stocky body's push-back keeps them in the envelope. */
const backPlate = () => piece(box(0, 0.74, -0.2, 0.34, 0.4, 0.07), 'spine2', '#3a3f45', NONE);

/** Procedural stand-ins by item id. Items without one fall back to the slot's built-in default. */
export const PLACEHOLDERS: Readonly<Record<string, () => PlaceholderPiece[]>> = {
  headgear_field_cap: () => [
    crown(DYED, P),
    piece(cylinder(0, 1.175, -0.02, 0.298, 0.06), 'head', DYED, S),
    piece(place(new CylinderGeometry(0.17, 0.17, 0.018, 16, 1, false, -Math.PI / 2, Math.PI), 0, 1.17, 0.19, [1, 1, 1], [0.25, 0, 0]), 'head', DYED, S),
  ],
  headgear_bandana: () => [
    crown(DYED, A, [0.285, 0.24, 0.295]),
    piece(sphere(0, 1.24, -0.31, [0.06, 0.05, 0.05]), 'head', DYED, A),
    piece(box(0.04, 1.16, -0.33, 0.05, 0.14, 0.02), 'head', DYED, A),
  ],
  headgear_beret: () => [
    crown('#2a2a2a', NONE, [0.285, 0.21, 0.295]),
    piece(place(new SphereGeometry(1, 18, 8), 0.04, 1.37, -0.02, [0.33, 0.085, 0.33], [0, 0, 0.18]), 'head', DYED, P),
    piece(sphere(0.05, 1.46, -0.02, [0.025, 0.025, 0.025]), 'head', DYED, A),
  ],
  headgear_combat_helmet: () => [
    crown(DYED, P, [0.31, 0.29, 0.32]),
    piece(cylinder(0, 1.17, -0.02, 0.325, 0.05, [0, 0, 0], 0.335), 'head', DYED, S),
    piece(box(0, 1.36, 0.27, 0.12, 0.05, 0.04), 'head', DYED, A),
  ],
  eyewear_aviators: () => [
    ...sides((s) => [piece(sphere(0.075 * s, 1.12, 0.245, [0.055, 0.045, 0.02]), 'head', DYED, A)]),
    piece(box(0, 1.14, 0.255, 0.11, 0.012, 0.012), 'head', '#c9a64a', NONE),
  ],
  eyewear_gas_mask: () => [
    piece(sphere(0, 1.07, 0.22, [0.16, 0.12, 0.08]), 'head', DYED, S),
    piece(cylinder(0, 1.02, 0.31, 0.05, 0.08, [Math.PI / 2, 0, 0]), 'head', DYED, P),
    ...sides((s) => [piece(sphere(0.07 * s, 1.12, 0.26, [0.045, 0.04, 0.015]), 'head', DYED, A)]),
  ],
  gloves_tactical: () =>
    sides((s, side) => [
      piece(sphere(0.405 * s, 0.53, -0.018, [0.075, 0.08, 0.07]), `hand_${side}`, DYED, S),
      piece(sphere(0.37 * s, 0.585, -0.024, [0.06, 0.035, 0.06]), `hand_${side}`, DYED, A),
    ]),
  boots_jungle: () =>
    sides((s, side) => [
      piece(cylinder(0.17 * s, 0.12, -0.05, 0.11, 0.2), `foot_${side}`, DYED, S),
      piece(sphere(0.19 * s, 0.07, 0.07, [0.12, 0.08, 0.15]), `foot_${side}`, DYED, S),
      piece(box(0.185 * s, 0.017, 0.02, 0.25, 0.035, 0.4), `foot_${side}`, '#2b2b2b', NONE),
      piece(cylinder(0.17 * s, 0.19, -0.05, 0.115, 0.03), `foot_${side}`, DYED, A),
    ]),
  boots_sneakers: () =>
    sides((s, side) => [
      piece(cylinder(0.17 * s, 0.1, -0.05, 0.105, 0.15), `foot_${side}`, DYED, P),
      piece(sphere(0.19 * s, 0.07, 0.07, [0.12, 0.075, 0.155]), `foot_${side}`, DYED, P),
      piece(box(0.185 * s, 0.02, 0.02, 0.255, 0.04, 0.41), `foot_${side}`, '#f2f2f2', NONE),
      piece(box(0.19 * s, 0.1, 0.12, 0.1, 0.02, 0.12), `foot_${side}`, DYED, A),
    ]),
  jetpack_drum: () => [
    backPlate(),
    ...sides((s) => [
      piece(cylinder(0.105 * s, 0.76, -0.3, 0.1, 0.24), 'spine2', DYED, S),
      piece(cylinder(0.105 * s, 0.76, -0.3, 0.104, 0.04), 'spine2', DYED, A),
      piece(cone(0.105 * s, 0.6, -0.3, 0.06, 0.08, [Math.PI, 0, 0]), 'spine2', '#3a3f45', NONE),
    ]),
  ],
  jetpack_rocket: () => [
    backPlate(),
    piece(cylinder(0, 0.76, -0.29, 0.11, 0.36), 'spine2', DYED, P),
    piece(cone(0, 1.0, -0.29, 0.11, 0.12), 'spine2', DYED, A),
    piece(cone(0, 0.54, -0.29, 0.08, 0.08, [Math.PI, 0, 0]), 'spine2', '#3a3f45', NONE),
    ...sides((s) => [piece(box(0.12 * s, 0.62, -0.29, 0.1, 0.12, 0.02), 'spine2', DYED, S)]),
  ],
};
