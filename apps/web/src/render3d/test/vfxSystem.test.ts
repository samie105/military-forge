import { EMP, FLASHBANG, FRAG, GAS, MINE, PROJECTILE_TYPE_BASE, RIOT_SHIELD, ROCKET, SMOKE, fluxLabMap, movementTestMap } from '@military-forge/content';
import { CollisionWorld, createRayHit, type SimEvent } from '@military-forge/sim';
import { DataTexture, DirectionalLight, HemisphereLight, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../camera';
import type { Frame, PlayerView } from '../../view';
import { PRESETS } from '../presets';
import { Vfx, type VfxContext, type VfxModule } from '../vfx';
import { F, STRIDE, particleSpec } from '../vfx/pool';
import { Ramp } from '../vfx/ramps';
import { playerView } from './helpers';

function system(preset = PRESETS.low) {
  const scene = new Scene();
  const camera = new Camera();
  camera.resize(1280, 720);
  camera.x = 150;
  camera.y = 3;
  const lights = { hemi: new HemisphereLight(), sun: new DirectionalLight() };
  const vfx = new Vfx(scene, new CollisionWorld(movementTestMap), camera, lights, new DataTexture(new Uint8Array([128]), 1, 1), preset);
  return { vfx, scene, lights };
}

const frame = (over: Partial<Frame> = {}): Frame => ({ tick: 1, localId: 0, players: [], grenades: [], ...over });
const blast: SimEvent = { type: 'explosion', x: 151, y: 0.1, radius: 4, owner: 0 };

describe('Vfx', () => {
  it('a blast fills the layers, shakes the camera and flashes; then it all dies away and the layers hide', () => {
    const { vfx } = system();
    vfx.onEvents([blast]);
    const shake = vfx.update(frame(), 1 / 60);
    expect(vfx.glow.count).toBeGreaterThan(10);
    expect(vfx.smoke.count).toBeGreaterThan(5);
    expect(vfx.decals.count).toBe(2);
    expect(Math.hypot(shake.x, shake.y)).toBeGreaterThan(0);
    expect(vfx.flash.level).toBeGreaterThan(0.5);
    for (let i = 0; i < 60 * 4; i++) vfx.update(frame(), 1 / 60);
    expect(vfx.glow.mesh.visible).toBe(false);
    expect(vfx.smoke.mesh.visible).toBe(false);
    expect(vfx.decals.mesh.visible).toBe(true); // scorch marks last 10 s
    expect(vfx.particles).toBe(2);
  });

  it('keeps live particles inside the preset budget however many blasts land at once', () => {
    const { vfx } = system(PRESETS.low);
    for (let i = 0; i < 40; i++) vfx.onEvents([{ ...blast, x: 140 + i * 0.5 }]);
    vfx.update(frame(), 1 / 60);
    expect(vfx.particles).toBeLessThanOrEqual(PRESETS.low.particles);
    expect(vfx.glowPool.dropped + vfx.smokePool.dropped).toBeGreaterThan(0);
  });

  it('runs registered modules with the shared pools (arsenal-b clouds plug in here)', () => {
    const { vfx } = system();
    const seen: string[] = [];
    let ctx: VfxContext | null = null;
    const puff = particleSpec();
    const clouds: VfxModule = {
      onEvents: (events) => seen.push(...events.map((e) => e.type)),
      update: (_f, _dt, fx) => {
        ctx = fx;
        Object.assign(puff, { x: 150, y: 2, life: 3, size0: 2, size1: 3, ramp: Ramp.Smoke });
        fx.smoke.emit(puff);
      },
    };
    vfx.register(clouds);
    vfx.onEvents([blast]);
    vfx.update(frame(), 1 / 60);
    expect(seen).toEqual(['explosion']);
    expect(ctx!.detail).toBe(PRESETS.low.vfxDetail);
    vfx.setReducedMotion(true);
    expect(ctx!.reducedMotion).toBe(true);
    expect(vfx.smokePool.count).toBeGreaterThan(0);
  });

  it('a quiet scene adds no draw calls: every effect mesh is hidden', () => {
    const { vfx, scene } = system();
    vfx.update(frame(), 1 / 60);
    const shown: string[] = [];
    scene.traverse((o) => {
      if (o.name.startsWith('vfx') || o.name === 'grenades') if (o.visible) shown.push(o.name);
    });
    expect(shown).toEqual([]);
  });

  it('a new map (setMap): the old map’s effects go, blasts hit its world, the blast light flashes from its levels', () => {
    const { vfx, lights } = system();
    vfx.onEvents([blast]);
    vfx.update(frame({ grenades: [{ x: 150, y: 4, fuse: 120 }] }), 1 / 60);
    expect(vfx.decals.count).toBe(2);
    expect(vfx.grenades.tracker.tracks.length).toBe(1);
    // Renderer3D.setMap sets the new map's lighting, then hands over its world
    lights.hemi.intensity = 0.4;
    lights.sun.intensity = 0.7;
    const world = new CollisionWorld(fluxLabMap);
    expect(world.raycast(blast.x, blast.y + 0.05, 0, -1, 2, 0, createRayHit())).toBe(false); // nothing under the blast there
    vfx.setMap(world);
    expect(vfx.context.world).toBe(world);
    expect(vfx.particles).toBe(0);
    expect(vfx.grenades.tracker.tracks.length).toBe(0);
    expect(vfx.shake.trauma).toBe(0);
    // half a second: past the flash rate limit, which a map swap doesn't reset
    for (let i = 0; i < 30; i++) vfx.update(frame(), 1 / 60);
    expect(lights.hemi.intensity).toBeCloseTo(0.4);
    expect(lights.sun.intensity).toBeCloseTo(0.7);
    vfx.onEvents([blast]);
    vfx.update(frame(), 1 / 60);
    expect(vfx.decals.count).toBe(0); // a blast in the air: no scorch
    expect(lights.hemi.intensity).toBeGreaterThan(0.4 * 1.5);
  });

  it('High gets the pooled blast light; Low and Medium never add a light to the scene', () => {
    const { vfx, scene } = system(PRESETS.low);
    expect(vfx.flash.point.parent).toBeNull();
    vfx.setPreset(PRESETS.high);
    expect(vfx.flash.point.parent).toBe(scene);
    vfx.setPreset(PRESETS.medium);
    expect(vfx.flash.point.parent).toBeNull();
  });
});

describe('Vfx and arsenal-b grenade types', () => {
  it("draws each thrown grenade with its own type's model (#91), once: the smoke's renderer, not the frag's", () => {
    const { vfx } = system();
    vfx.update(frame({ grenades: [{ x: 150, y: 4, fuse: 60, type: SMOKE.index }, { x: 152, y: 4, fuse: 60, type: EMP.index }] }), 1 / 60);
    expect(vfx.throwables.map((g) => g.body.count)).toEqual([0, 1, 0, 0, 0, 1]); // frag, smoke, gas, flash, mine, emp
    expect(vfx.throwables.map((g) => g.type)).toEqual([FRAG.index, SMOKE.index, GAS.index, FLASHBANG.index, MINE.index, EMP.index]);
  });

  it('a flashbang or EMP going off is not a fireball (their own effects draw it); a mine blast is', () => {
    for (const [grenade, fireball] of [
      [3, false],
      [5, false],
      [4, true],
      [0, true],
    ] as const) {
      const { vfx } = system();
      vfx.onEvents([{ ...blast, grenade } as SimEvent]);
      vfx.update(frame(), 1 / 60);
      expect(vfx.decals.count > 0).toBe(fireball);
    }
  });
});
describe('Vfx.setMap (a map change)', () => {
  it('takes the new collision world, clears every effect, and rebases the blast light on the relit scene', () => {
    const { vfx } = system();
    vfx.onEvents([blast]);
    vfx.update(frame(), 1 / 60);
    expect(vfx.particles).toBeGreaterThan(0);
    const world = new CollisionWorld(movementTestMap);
    vfx.setMap(world);
    expect(vfx.particles).toBe(0);
    expect(vfx.context.world).toBe(world);
    expect(vfx.gunfire.world).toBe(world);
    expect(vfx.shake.trauma).toBe(0);
  });

  it('drops shots queued before the change: none fires on the new map’s first frame (review L5)', () => {
    const { vfx } = system();
    const shot: SimEvent = { type: 'shot', shooter: 0, weapon: 0, ox: 150, oy: 1.2, ex: 159.8, ey: 1.4, hit: 1, target: -1, zone: 0 };
    for (let i = 0; i < 20; i++) vfx.onEvents([shot]); // queued while 3D wasn't drawing
    vfx.setMap(new CollisionWorld(movementTestMap));
    vfx.update(frame(), 1 / 60);
    expect(vfx.particles).toBe(0);
  });

  it('leaves the map’s lights alone between blasts, so a relight sticks', () => {
    const hemi = new HemisphereLight(0xffffff, 0x000000, 1.6);
    const sun = new DirectionalLight(0xffffff, 2);
    const scene = new Scene();
    const camera = new Camera();
    camera.resize(1280, 720);
    const vfx = new Vfx(scene, new CollisionWorld(movementTestMap), camera, { hemi, sun }, new DataTexture(new Uint8Array([128]), 1, 1), PRESETS.low);
    vfx.update(frame(), 1 / 60);
    hemi.intensity = 0.7; // a darker map was built
    sun.intensity = 1.1;
    vfx.update(frame(), 1 / 60);
    expect([hemi.intensity, sun.intensity]).toEqual([0.7, 1.1]);
    vfx.setMap(new CollisionWorld(movementTestMap)); // buildMap → rebase
    vfx.onEvents([blast]);
    for (let i = 0; i < 120; i++) vfx.update(frame(), 1 / 60);
    expect(hemi.intensity).toBeCloseTo(0.7, 5); // back to the new map's value after the flash
    expect(sun.intensity).toBeCloseTo(1.1, 5);
  });
});

describe('Vfx: a launcher blast at a riot shield (#111)', () => {
  it("a rocket gone off at a raised shield's face flares the plate (the shields of the last drawn frame); in the open it doesn't", () => {
    const flares = (shield: PlayerView['shield']) => {
      const { vfx } = system();
      vfx.update(frame({ players: [playerView({ x: 150, y: 0, aim: Math.PI, shield })] }), 1 / 60);
      // facing left: the face at 150 − 0.42, the rocket stopped just short of it
      vfx.onEvents([{ type: 'explosion', x: 150 - RIOT_SHIELD.forward - ROCKET.radius, y: 0.8, radius: 3.5, owner: 1, grenade: PROJECTILE_TYPE_BASE + ROCKET.index }]);
      const pool = vfx.glowPool;
      let n = 0;
      for (let i = 0; i < pool.count; i++) if (pool.data[i * STRIDE + F.ramp] === Ramp.Flash && pool.data[i * STRIDE + F.rot] === Math.fround(Math.PI / 2)) n++;
      return n;
    };
    expect(flares('front')).toBe(1);
    expect(flares(undefined)).toBe(0);
  });
});
