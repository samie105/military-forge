import { fluxLabMap, movementTestMap } from '@military-forge/content';
import { CollisionWorld, createRayHit, type SimEvent } from '@military-forge/sim';
import { DataTexture, DirectionalLight, HemisphereLight, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { Camera } from '../../camera';
import type { Frame } from '../../view';
import { PRESETS } from '../presets';
import { Vfx, type VfxContext, type VfxModule } from '../vfx';
import { particleSpec } from '../vfx/pool';
import { Ramp } from '../vfx/ramps';

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