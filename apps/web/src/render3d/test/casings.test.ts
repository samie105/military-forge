import { BREACHER, BUZZ, HAMMER, K47, MACHETE, WIDOW, movementTestMap } from '@military-forge/content';
import { CollisionWorld, type SimEvent } from '@military-forge/sim';
import { DataTexture, Matrix4, Scene, Vector3, type InstancedMesh } from 'three';
import { describe, expect, it } from 'vitest';
import type { Frame } from '../../view';
import { CASINGS_CALM, CASINGS_LOW, CASINGS_MAX, CASING_DRAW_SCALE, Casings, SNIPER_SCALE, gunEject } from '../vfx/casings';
import { parseWeaponVfx } from '../vfx/manifest';
import { playerView } from './helpers';

const ramp = new DataTexture(new Uint8Array(4), 1, 1);
const world = new CollisionWorld(movementTestMap);

/** weapons.vfx.json as the Forge published it (17 Oct), trimmed to what the parsers read */
const forge = {
  flash: { atlas: 'flash_atlas.webp', atlasSize: [512, 512], cell: [128, 128], styles: {} },
  casings: {
    file: 'casings.glb',
    maxLive: 32,
    types: {
      pistol: { node: 'casing_pistol', lengthM: 0.048, speedMps: 2.2, coneDeg: 18, spinRps: 18, lifeMs: 1400 },
      rifle: { node: 'casing_rifle', lengthM: 0.093, speedMps: 2.8, coneDeg: 15, spinRps: 22, lifeMs: 1500 },
      shotgun: { node: 'casing_shotgun', lengthM: 0.102, speedMps: 1.8, coneDeg: 20, spinRps: 10, lifeMs: 1800 },
    },
  },
  weapons: {
    hammer44: { flash: 'pistol', casing: 'pistol', eject: 'reload', ejectCount: 6 },
    buzz: { casing: 'pistol', eject: 'shot' },
    k47: { casing: 'rifle', eject: 'shot' },
    breacher: { casing: 'shotgun', eject: 'pump', ejectDelayMs: 250 },
    widow: { casing: 'rifle', eject: 'bolt', ejectDelayMs: 350 },
    machete: { flash: null, casing: null, eject: null },
  },
};
const art = () => parseWeaponVfx(forge)!.casings;

/** Every shooter's gun, aiming right, ejects from (x + id, 1.2, 0) (open floor at y 0 by default). */
function setup(x = 118) {
  const c = new Casings(new Scene(), ramp, world, (shooter, _weapon, out, dir, bore) => {
    out.set(x + shooter, 1.2, 0);
    dir.set(0.3, 0.2, 0.9).normalize(); // the port faces the camera
    bore.set(1, 0, 0); // aiming right
    return true;
  });
  c.setArt(art());
  const frame: Frame = { tick: 1, localId: 0, players: [playerView({ x: 18 })], grenades: [] };
  return { c, frame };
}

const shot = (weapon: number, shooter = 0): SimEvent => ({ type: 'shot', shooter, weapon, ox: 18, oy: 1.2, ex: 25, ey: 1.2, hit: 0, target: -1, zone: 0 });
const m = new Matrix4();
const positionOf = (mesh: InstancedMesh, i = 0) => (mesh.getMatrixAt(i, m), new Vector3().setFromMatrixPosition(m));
const scaleOf = (mesh: InstancedMesh, i = 0) => (mesh.getMatrixAt(i, m), new Vector3().setFromMatrixScale(m).x);

describe('gunEject: what each gun drops, and when', () => {
  it("weapons.vfx.json: a case a shot, the pump's and bolt's back stroke, the revolver's reload; a sniper drops the big case", () => {
    const a = art();
    expect(a.types.rifle).toMatchObject({ node: 'casing_rifle', speed: 2.8, life: 1.5 });
    expect(gunEject(BUZZ, a)).toEqual({ kind: 'pistol', mode: 'shot', delay: 0, count: 1 });
    expect(gunEject(K47, a)).toEqual({ kind: 'rifle', mode: 'shot', delay: 0, count: 1 });
    expect(gunEject(BREACHER, a)).toEqual({ kind: 'shotgun', mode: 'pump', delay: 0.25, count: 1 });
    expect(gunEject(WIDOW, a)).toEqual({ kind: 'sniper', mode: 'bolt', delay: 0.35, count: 1 });
    expect(gunEject(HAMMER, a)).toEqual({ kind: 'pistol', mode: 'reload', delay: 0, count: 6 });
    expect(gunEject(MACHETE, a)).toBeNull();
  });

  it('without the file: by class (melee none)', () => {
    expect(gunEject(K47, null)?.kind).toBe('rifle');
    expect(gunEject(BREACHER, null)).toMatchObject({ kind: 'shotgun', mode: 'pump' });
    expect(gunEject(WIDOW, null)).toMatchObject({ kind: 'sniper', mode: 'bolt' });
    expect(gunEject(MACHETE, null)).toBeNull();
  });
});

describe('Casings', () => {
  it('one a shot (a shotgun blast is one), flung out of the port, then falling', () => {
    const { c, frame } = setup();
    c.onEvents([shot(BUZZ.index), shot(BUZZ.index), shot(K47.index, 1)]); // the Buzz shot twice in a batch: pellets, one casing
    c.update(frame, 1 / 60);
    expect(c.count).toBe(2);
    expect([c.meshes.pistol.count, c.meshes.rifle.count, c.meshes.shotgun.count]).toEqual([1, 1, 0]);
    expect([c.meshes.pistol.visible, c.meshes.shotgun.visible]).toEqual([true, false]);
    const p0 = positionOf(c.meshes.pistol);
    expect(p0.distanceTo(new Vector3(118, 1.2, 0))).toBeLessThan(0.1);
    for (let i = 0; i < 12; i++) c.update(frame, 1 / 60);
    const p1 = positionOf(c.meshes.pistol);
    expect(p1.y).toBeGreaterThan(p0.y + 0.05); // up out of the port…
    expect(p1.x).toBeLessThan(p0.x + 0.1); // …never thrown ahead along the shot
    for (let i = 0; i < 20; i++) c.update(frame, 1 / 60);
    expect(positionOf(c.meshes.pistol).y).toBeLessThan(p1.y); // and falling
  });

  it('lands on the floor, lies there, then shrinks away at the end of its life', () => {
    const { c, frame } = setup();
    c.onEvents([shot(K47.index)]);
    let lowest = Infinity;
    for (let i = 0; i < 70; i++) {
      c.update(frame, 1 / 60);
      lowest = Math.min(lowest, positionOf(c.meshes.rifle).y);
    }
    expect(lowest).toBeGreaterThan(-0.005); // never through the floor (y 0)
    expect(lowest).toBeLessThan(0.05);
    // off a wall (x 22 has one just to the right) it comes back, and lands
    const wall = setup(22);
    wall.c.onEvents([shot(K47.index)]);
    for (let i = 0; i < 60; i++) wall.c.update(wall.frame, 1 / 60);
    expect(positionOf(wall.c.meshes.rifle).x).toBeLessThan(22);
    expect(positionOf(wall.c.meshes.rifle).y).toBeLessThan(0.05);
    // and on a step (x 18: the floor at y 1) it lies on the step
    const step = setup(18);
    step.c.onEvents([shot(K47.index)]);
    for (let i = 0; i < 60; i++) step.c.update(step.frame, 1 / 60);
    expect(positionOf(step.c.meshes.rifle).y).toBeCloseTo(1, 1);
    const resting = positionOf(c.meshes.rifle);
    c.update(frame, 0.2);
    expect(positionOf(c.meshes.rifle).distanceTo(resting)).toBeLessThan(1e-6);
    c.update(frame, 1.5 - 70 / 60 - 0.2 - 0.05);
    expect(scaleOf(c.meshes.rifle)).toBeLessThan(CASING_DRAW_SCALE); // shrinking away
    c.update(frame, 0.5);
    expect(c.count).toBe(0);
    expect(c.meshes.rifle.visible).toBe(false);
  });

  it("the pump's shell and the bolt's big case come out on the back stroke, not with the shot", () => {
    const { c, frame } = setup();
    c.onEvents([shot(BREACHER.index), shot(WIDOW.index, 1)]);
    c.update(frame, 0.2);
    expect(c.count).toBe(0);
    c.update(frame, 0.06); // 0.26 s: the pump's
    expect([c.meshes.shotgun.count, c.meshes.sniper.count]).toEqual([1, 0]);
    c.update(frame, 0.1); // 0.36 s: the bolt's
    expect(c.meshes.sniper.count).toBe(1);
    c.meshes.rifle.geometry.computeBoundingBox();
    c.meshes.sniper.geometry.computeBoundingBox();
    const length = (mesh: InstancedMesh) => mesh.geometry.boundingBox!.max.y - mesh.geometry.boundingBox!.min.y;
    expect(length(c.meshes.sniper) / length(c.meshes.rifle)).toBeCloseTo(SNIPER_SCALE, 3);
  });

  it('the revolver drops nothing when it fires, and its spent rounds when a reload starts', () => {
    const { c, frame } = setup();
    const me = frame.players[0]!;
    me.weapons = [{ def: HAMMER.index, mag: 2, reserve: 30, reloadTicks: 0 }];
    me.active = 0;
    c.onEvents([shot(HAMMER.index)]);
    c.update(frame, 1 / 60);
    expect(c.count).toBe(0);
    me.weapons[0]!.reloadTicks = 120; // a reload with 2 left: 4 spent
    c.update(frame, 1 / 60);
    expect(c.count).toBe(4);
    c.update(frame, 1 / 60); // still reloading: no more
    expect(c.count).toBe(4);
    // online, a remote revolver's mag is unknown (0): all six
    me.weapons[0] = { def: HAMMER.index, mag: 0, reserve: 0, reloadTicks: 0 };
    c.update(frame, 1 / 60);
    me.weapons[0]!.reloadTicks = 1;
    c.update(frame, 1 / 60);
    expect(c.count).toBe(10);
  });

  it('a cap that recycles the oldest: 32, 16 on Low, 8 under Reduce motion; none from melee or an undrawn gun', () => {
    const { c, frame } = setup();
    const burst = (n: number) => {
      for (let i = 0; i < n; i++) {
        c.onEvents([shot(BUZZ.index)]);
        c.update(frame, 1 / 240);
      }
    };
    burst(40);
    expect(c.count).toBe(CASINGS_MAX);
    c.setLimits(true, false);
    expect(c.count).toBe(CASINGS_LOW);
    burst(10);
    expect(c.count).toBe(CASINGS_LOW);
    c.setLimits(false, true);
    expect(c.count).toBe(CASINGS_CALM);
    c.clear();
    c.onEvents([shot(MACHETE.index)]);
    c.update(frame, 1 / 60);
    expect(c.count).toBe(0);
    const hidden = new Casings(new Scene(), ramp, world, () => false);
    hidden.onEvents([shot(BUZZ.index)]);
    hidden.update(frame, 1 / 60);
    expect(hidden.count).toBe(0);
  });

  it('one InstancedMesh a kind in the scene, drawn only while it has casings', () => {
    const scene = new Scene();
    const c = new Casings(scene, ramp, world);
    expect(scene.children.length).toBe(4);
    expect(scene.children.every((o) => !o.visible)).toBe(true);
    c.showForWarmUp(new Vector3(1, 2, 0));
    expect(scene.children.every((o) => o.visible)).toBe(true);
    c.clear();
    expect(scene.children.every((o) => !o.visible)).toBe(true);
  });
});
