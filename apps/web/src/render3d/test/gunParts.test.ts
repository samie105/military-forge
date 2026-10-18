import { BREACHER, BUZZ, HAMMER, WIDOW, movementTestMap } from '@military-forge/content';
import { CollisionWorld } from '@military-forge/sim';
import { BoxGeometry, BufferAttribute, BufferGeometry, Group, Mesh, MeshBasicMaterial, Vector3, type Object3D } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import { Avatar, AvatarKit } from '../avatar';
import { toonRamp } from '../character';
import { GunParts, partPose, type PartKind } from '../gunParts';
import { weaponFromGltf } from '../weaponModels';
import { aimRig as rig, playerView } from './helpers';

/** A plain box mesh (positions and normals, non-indexed) `size` m across. */
const box = (size: number) => new Mesh(new BoxGeometry(size, size, size).toNonIndexed());
const verts = (g: BufferGeometry) => g.getAttribute('position').count;

/** A gun GLB: a body, a pump and a cylinder that move, a mag that doesn't, and a part with no usable axis. */
function gunGltf(): { gltf: GLTF; root: Group } {
  const root = new Group();
  root.add(box(0.1)); // the body
  const node = (name: string, at: [number, number, number], extras: Record<string, unknown>, child: Object3D = box(0.03)) => {
    const n = new Group();
    n.name = name;
    n.position.set(...at);
    n.userData = extras;
    n.add(child);
    root.add(n);
    return n;
  };
  node('part_pump', [0, 0.3, -0.02], { axis: [0, -1, 0], travel: 0.06, cutClean: true });
  node('part_cylinder', [0, 0.05, 0.04], { axis: [0, 1, 0], angle: 60, cutClean: true });
  node('part_mag', [0, 0.1, -0.08], { axis: [0, 0, -1], travel: 0.1, cutClean: true }); // not a moving kind: stays in the body
  node('part_bolt', [0, 0.2, 0.06], { axis: [0, 0, 0], cutClean: true }); // no axis: stays in the body
  node('part_slide', [0, 0.15, 0.07], { axis: [0, -1, 0], travel: 0.03 }); // its cut isn't clean yet (no flag): stays in the body
  return { gltf: { scene: root } as unknown as GLTF, root };
}

describe('moving parts from the weapon GLB', () => {
  it('the parts come apart from the body, in their own frames; anything else stays in the body', () => {
    const model = weaponFromGltf(gunGltf().gltf, new MeshBasicMaterial())!;
    const box36 = 36; // a non-indexed box
    expect(verts(model.geometry)).toBe(box36 * 4); // body, mag, the axis-less bolt and the slide not yet cut clean
    expect(model.parts!.map((p) => p.kind)).toEqual(['pump', 'cylinder']);
    const pump = model.parts![0]!;
    expect(pump.position.toArray()).toEqual([0, 0.3, -0.02]);
    expect(pump.axis.toArray()).toEqual([0, -1, 0]);
    expect(pump.travel).toBeCloseTo(0.06);
    pump.geometry.computeBoundingBox();
    expect(pump.geometry.boundingBox!.getCenter(new Vector3()).length()).toBeLessThan(1e-6); // centred on its node
    expect(model.parts![1]!.travel).toBeCloseTo(Math.PI / 3); // 60° a shot
    // Low draws one mesh: the body with the parts still, in place
    expect(verts(model.solid!)).toBe(box36 * 6);
    model.solid!.computeBoundingBox();
    expect(model.solid!.boundingBox!.max.y).toBeCloseTo(0.3 + 0.015);
  });

  it('a gun without parts has none (and no second geometry)', () => {
    const root = new Group();
    root.add(box(0.1));
    const model = weaponFromGltf({ scene: root } as unknown as GLTF, new MeshBasicMaterial())!;
    expect(model.parts).toBeUndefined();
    expect(model.solid).toBeUndefined();
  });

  it('meshes that cannot merge with the body are left out, not fatal', () => {
    const root = new Group();
    root.add(box(0.1));
    const odd = new BufferGeometry();
    odd.setAttribute('position', new BufferAttribute(new Float32Array(9), 3)); // no normals
    root.add(new Mesh(odd));
    expect(verts(weaponFromGltf({ scene: root } as unknown as GLTF, new MeshBasicMaterial())!.geometry)).toBe(36);
  });
});

describe('partPose: each cycle inside its gun interval', () => {
  const pose = { back: 0, turn: 0 };
  const at = (kind: PartKind, t: number, interval: number) => ({ ...partPose(kind, t, interval, pose) });

  it('the pump is back when its shell flies (0.25 s on the Breacher) and home before the next shot', () => {
    expect(at('pump', 0.05, BREACHER.interval).back).toBe(0);
    expect(at('pump', 0.27, BREACHER.interval).back).toBeCloseTo(1, 2);
    expect(at('pump', BREACHER.interval - 0.01, BREACHER.interval).back).toBe(0);
  });

  it('the bolt goes up, then back when its case flies (0.35 s on the Widow), forward and down before the next shot', () => {
    expect(at('bolt', 0.18, WIDOW.interval).turn).toBeGreaterThan(0.5);
    expect(at('bolt', 0.18, WIDOW.interval).back).toBe(0);
    expect(at('bolt', 0.36, WIDOW.interval)).toMatchObject({ back: expect.closeTo(1, 1), turn: 1 });
    expect(at('bolt', WIDOW.interval - 0.01, WIDOW.interval)).toEqual({ back: 0, turn: 0 });
  });

  it('a slide blows back and is home within a fast gun interval; the cylinder steps after the shot', () => {
    expect(at('slide', 0.012, BUZZ.interval).back).toBeGreaterThan(0.4);
    expect(at('slide', BUZZ.interval, BUZZ.interval).back).toBe(0);
    expect(at('cylinder', 0.01, HAMMER.interval).turn).toBe(0);
    expect(at('cylinder', 0.2, HAMMER.interval).turn).toBe(1);
  });
});

describe('GunParts on a drawn gun', () => {
  it('moves the pump back along its axis after a shot and home again; the cylinder turns a chamber a shot', () => {
    const gun = new Mesh();
    const parts = new GunParts(gun);
    const model = weaponFromGltf(gunGltf().gltf, new MeshBasicMaterial())!;
    parts.set(model.parts, model.material, BREACHER.interval);
    expect(parts.shown.length).toBe(2);
    const [pump, cyl] = parts.shown as Mesh[];
    parts.update(1 / 60);
    expect(pump!.position.toArray()).toEqual([0, 0.3, -0.02]); // at rest before any shot
    parts.fire();
    parts.update(0.27);
    expect(pump!.position.y).toBeCloseTo(0.3 - 0.06, 2);
    parts.update(0.5);
    expect(pump!.position.y).toBeCloseTo(0.3, 6);
    const turned = (m: Mesh) => 2 * Math.acos(Math.min(1, Math.abs(m.quaternion.w)));
    expect(turned(cyl!)).toBeCloseTo(Math.PI / 3, 4);
    parts.fire();
    parts.update(0.3);
    expect(turned(cyl!)).toBeCloseTo((2 * Math.PI) / 3, 4);
    // another gun without parts: nothing extra drawn
    parts.set(undefined, model.material, 0.1);
    expect(parts.shown.length).toBe(0);
  });

  it('an avatar fires its gun parts on a kick, poses them each frame, and keeps them still (merged) on Low', () => {
    const kit = new AvatarKit(toonRamp());
    const model = weaponFromGltf(gunGltf().gltf, new MeshBasicMaterial())!;
    (kit as unknown as { models: Map<number, typeof model> }).models.set(BREACHER.index, model);
    const inst = rig();
    const a = new Avatar(inst, 0, kit, 1);
    const world = new CollisionWorld(movementTestMap);
    const view = playerView({ x: 20, weapons: [{ def: BREACHER.index, mag: 6, reserve: 30, reloadTicks: 0 }, { def: BUZZ.index, mag: 40, reserve: 250, reloadTicks: 0 }] });
    a.update(view, 1 / 60, world, true);
    const gun = inst.bone('socket_weapon_R')!.children.find((c) => (c as Mesh).isMesh) as Mesh;
    const pump = () => gun.children.find((c) => c.name === 'gun-part' && c.visible) as Mesh | undefined;
    expect(gun.geometry).toBe(model.geometry);
    expect(pump()!.position.y).toBeCloseTo(0.3);
    a.kick(BREACHER.index);
    for (let t = 0; t < 0.27; t += 1 / 60) a.update(view, 1 / 60, world, true);
    expect(pump()!.position.y).toBeLessThan(0.26);
    kit.animateParts = false;
    a.update(view, 1 / 60, world, true);
    expect(gun.geometry).toBe(model.solid);
    expect(pump()).toBeUndefined();
  });
});

describe('the hands work the pump and the bolt (whatever the part’s cut)', () => {
  const world = new CollisionWorld(movementTestMap);
  /** two avatars posed alike, one of them fired at t 0; recoil off, so only the hands differ */
  function pair(def: number) {
    const kit = new AvatarKit(toonRamp());
    kit.recoilScale = 0;
    const view = playerView({ x: 20, aim: 0.1, weapons: [{ def, mag: 5, reserve: 20, reloadTicks: 0 }, { def: BUZZ.index, mag: 40, reserve: 250, reloadTicks: 0 }] });
    const a = new Avatar(rig(), 0, kit, 1);
    const b = new Avatar(rig(), 0, kit, 1);
    a.update(view, 1 / 60, world, true);
    b.update(view, 1 / 60, world, true);
    a.kick(def);
    const step = (seconds: number) => {
      for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
        a.update(view, 1 / 60, world, true);
        b.update(view, 1 / 60, world, true);
      }
    };
    const pos = (av: Avatar, bone: string) => av.inst.bone(bone)!.getWorldPosition(new Vector3());
    const gunOf = (av: Avatar) => av.inst.bone('socket_weapon_R')!.children.find((c) => (c as Mesh).isMesh) as Mesh;
    return { a, b, step, pos, gunOf, kit };
  }

  it('the Breacher: the support hand rides the pump back at 0.25 s and forward again', () => {
    const { a, b, step, pos, gunOf } = pair(BREACHER.index);
    step(0.27);
    const back = pos(b, 'hand_L').sub(pos(a, 'hand_L'));
    const muzzleward = new Vector3(0, 1, 0).transformDirection(gunOf(b).matrixWorld);
    expect(back.dot(muzzleward)).toBeGreaterThan(0.01); // pulled back toward the shooter (as far as the test rig's arm reaches)
    step(0.4);
    expect(pos(a, 'hand_L').distanceTo(pos(b, 'hand_L'))).toBeLessThan(0.005);
  });

  it('the Widow: the trigger hand leaves the grip for the bolt, and the gun stays where it was held', () => {
    const { a, b, step, pos, gunOf, kit } = pair(WIDOW.index);
    step(0.36);
    const cycle = kit.cycleOf(WIDOW.index)!;
    expect(cycle.kind).toBe('bolt');
    const handle = cycle.position.clone().applyMatrix4(gunOf(b).matrixWorld);
    expect(pos(a, 'socket_weapon_R').distanceTo(handle)).toBeLessThan(pos(b, 'socket_weapon_R').distanceTo(handle) - 0.03);
    const held = gunOf(b).matrixWorld.elements;
    gunOf(a).matrixWorld.elements.forEach((e, i) => expect(e).toBeCloseTo(held[i]!, 4));
    step(0.5);
    expect(pos(a, 'hand_R').distanceTo(pos(b, 'hand_R'))).toBeLessThan(0.005); // back on the grip
    expect(gunOf(a).position.length()).toBe(0);
  });
});
