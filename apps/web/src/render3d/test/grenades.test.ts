import { movementTestMap } from '@military-forge/content';
import { CollisionWorld, DT } from '@military-forge/sim';
import { BufferAttribute, BufferGeometry, DataTexture, Group, Matrix4, Mesh, Vector3 } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { describe, expect, it } from 'vitest';
import {
  FUSE_MAX_HZ,
  FUSE_MIN_HZ,
  FUSE_REDUCED_HZ,
  FUSE_SECONDS,
  FUSE_SOLID,
  FUSE_TICKS,
  GrenadeTracker,
  ROLL_RADIUS,
  SIM_RADIUS,
  fuseBlinkHz,
  fuseBlinkPhase,
  fuseLight,
} from '../grenadeTracker';
import { GRENADE_MIN_PX, GRENADE_WIDTH_M, GrenadeRenderer, fallbackFrag, grenadeScale, throwableFromGltf } from '../grenades';
import { ParticleLayer } from '../vfx/particles';
import { ParticlePool } from '../vfx/pool';

const world = new CollisionWorld(movementTestMap);

describe('fuse light', () => {
  it('blinks faster toward the blast: from FUSE_MIN_HZ at the throw to the cap at the end', () => {
    expect(fuseBlinkHz(0, FUSE_SECONDS, FUSE_MAX_HZ)).toBe(FUSE_MIN_HZ);
    expect(fuseBlinkHz(FUSE_SECONDS, FUSE_SECONDS, FUSE_MAX_HZ)).toBe(FUSE_MAX_HZ);
    let prev = 0;
    for (let t = 0; t <= FUSE_SECONDS; t += 0.05) {
      const hz = fuseBlinkHz(t, FUSE_SECONDS, FUSE_MAX_HZ);
      expect(hz).toBeGreaterThanOrEqual(prev);
      prev = hz;
    }
  });

  it('keeps a continuous phase: its rate of change is the blink rate (no jumps as it speeds up)', () => {
    for (const t of [0.1, 0.6, 1.2, 1.5]) {
      const h = 1e-4;
      const rate = (fuseBlinkPhase(t + h, FUSE_SECONDS, FUSE_MAX_HZ) - fuseBlinkPhase(t - h, FUSE_SECONDS, FUSE_MAX_HZ)) / (2 * h);
      expect(rate).toBeCloseTo(fuseBlinkHz(t, FUSE_SECONDS, FUSE_MAX_HZ), 3);
    }
  });

  /** pulses (rising through 0.6) in [t0, t1), sampled at 1 kHz */
  const pulses = (maxHz: number, t0: number, t1: number) => {
    let n = 0;
    let was = fuseLight(t0, FUSE_SECONDS, maxHz);
    for (let t = t0 + 0.001; t < t1; t += 0.001) {
      const v = fuseLight(t, FUSE_SECONDS, maxHz);
      if (was < 0.6 && v >= 0.6) n++;
      was = v;
    }
    return n;
  };

  it('pulses about twice in the first second and much faster in the last half second', () => {
    expect(pulses(FUSE_MAX_HZ, 0, 1)).toBeLessThanOrEqual(3);
    expect(pulses(FUSE_MAX_HZ, FUSE_SECONDS - 0.62, FUSE_SECONDS - FUSE_SOLID)).toBeGreaterThanOrEqual(3);
  });

  it('reduced motion: never more than 3 pulses in any second (docs/11 §5 photosensitivity)', () => {
    for (let t0 = 0; t0 + 1 <= FUSE_SECONDS; t0 += 0.1) expect(pulses(FUSE_REDUCED_HZ, t0, t0 + 1)).toBeLessThanOrEqual(3);
    expect(pulses(FUSE_REDUCED_HZ, FUSE_SECONDS - 1, FUSE_SECONDS)).toBeLessThanOrEqual(3);
  });

  it('is solid just before the blast, and always 0…1', () => {
    expect(fuseLight(FUSE_SECONDS - FUSE_SOLID / 2, FUSE_SECONDS, FUSE_MAX_HZ)).toBe(1);
    for (let t = 0; t < FUSE_SECONDS; t += 0.013) {
      const v = fuseLight(t, FUSE_SECONDS, FUSE_MAX_HZ);
      expect(v).toBeGreaterThanOrEqual(0.2);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

/** a grenade's samples, tick by tick, from a simple ballistic arc (no bounces) */
function arc(x0: number, y0: number, vx: number, vy: number, ticks: number, firstTick = 100) {
  const out: { tick: number; x: number; y: number; fuse: number }[] = [];
  for (let k = 0; k < ticks; k++) {
    const t = k * DT;
    out.push({ tick: firstTick + k, x: x0 + vx * t, y: y0 + vy * t - 10 * t * t, fuse: FUSE_TICKS - 1 - k });
  }
  return out;
}

describe('GrenadeTracker', () => {
  it('follows two grenades thrown on the same tick as two tracks (no ids: blast tick + nearest)', () => {
    const tr = new GrenadeTracker(world);
    const a = arc(20, 5, 8, 3, 30);
    const b = arc(30, 5, -8, 3, 30);
    for (let k = 0; k < 30; k++) tr.update(a[k]!.tick, [a[k]!, b[k]!], DT);
    expect(tr.tracks.length).toBe(2);
    const left = tr.tracks.find((t) => t.x < 25)!;
    expect(left.vx).toBeCloseTo(8, 4);
    expect(left.vy).toBeCloseTo(3 - 20 * 29 * DT + 10 * DT, 1); // average over the last tick
  });

  it('tumbles in the direction of travel while airborne', () => {
    const tr = new GrenadeTracker(world);
    for (const s of arc(20, 6, 9, 4, 20)) tr.update(s.tick, [s], DT);
    expect(tr.tracks[0]!.grounded).toBe(false);
    expect(tr.tracks[0]!.omega).toBeLessThan(0); // rightward: clockwise, as seen from the camera
    const back = new GrenadeTracker(world);
    for (const s of arc(20, 6, -9, 4, 20)) back.update(s.tick, [s], DT);
    expect(back.tracks[0]!.omega).toBeGreaterThan(0);
  });

  it('rolls on the ground at the drawn body’s rim speed, then settles upright at rest', () => {
    const tr = new GrenadeTracker(world);
    const scale = 3.5;
    let x = 20;
    let fuse = 90;
    for (let k = 0; k < 30; k++, fuse--) {
      x += 2 * DT;
      tr.update(k, [{ x, y: SIM_RADIUS, fuse }], DT, scale);
    }
    const t = tr.tracks[0]!;
    expect(t.grounded).toBe(true);
    expect(t.omega).toBeCloseTo(-2 / (ROLL_RADIUS * scale), 0);
    expect(t.rest).toBeLessThan(0.1);
    for (let k = 30; k < 70; k++, fuse--) tr.update(k, [{ x, y: SIM_RADIUS, fuse }], DT, scale);
    expect(t.rest).toBeGreaterThan(0.95);
    expect(t.contact).toBeGreaterThan(0.95);
  });

  it('drops a track when its grenade is gone, and an id that comes back with a fresh fuse is a new grenade', () => {
    const tr = new GrenadeTracker(world);
    tr.update(1, [{ id: 5, x: 20, y: 5, fuse: 50 }], DT);
    const first = tr.tracks[0]!;
    tr.update(2, [{ id: 5, x: 20.1, y: 5, fuse: 49 }], DT);
    expect(tr.tracks[0]).toBe(first);
    tr.update(3, [{ id: 5, x: 40, y: 2, fuse: FUSE_TICKS }], DT); // the slot was reused by a new throw
    expect(tr.tracks.length).toBe(1);
    expect(tr.tracks[0]!.fuse).toBe(FUSE_TICKS);
    expect(tr.tracks[0]!.x).toBe(40);
    tr.update(4, [], DT);
    expect(tr.tracks.length).toBe(0);
  });

  it('runs the fuse clock smoothly between ticks, never past the full fuse', () => {
    const tr = new GrenadeTracker(world);
    tr.update(10, [{ x: 20, y: 5, fuse: FUSE_TICKS - 30 }], DT);
    const t = tr.tracks[0]!;
    expect(t.fuseT).toBeCloseTo(30 * DT + DT, 6); // one frame of DT since the sample
    tr.update(10, [{ x: 20, y: 5, fuse: FUSE_TICKS - 30 }], 0.004);
    expect(t.fuseT).toBeCloseTo(31 * DT, 6); // capped at one tick between samples
  });
});

describe('GrenadeRenderer', () => {
  const ramp = new DataTexture(new Uint8Array([128]), 1, 1);
  const fx = () => ({ smoke: new ParticlePool(256), glow: new ParticleLayer(64, { texture: ramp, grid: [4, 4], blend: 'additive', depthTest: false, renderOrder: 0 }) });

  it('draws one body and two outline hulls per grenade, outlines a fixed number of pixels wider', () => {
    const r = new GrenadeRenderer(world, ramp);
    const f = fx();
    f.glow.begin();
    r.update(1, [{ x: 20, y: 5, fuse: 60 }, { x: 25, y: 6, fuse: 30 }], DT, 35, f);
    expect(r.body.count).toBe(2);
    expect(r.inner.count).toBe(2);
    expect(r.outer.count).toBe(2);
    const m = new Matrix4();
    const scale = (mesh: typeof r.body) => new Vector3().setFromMatrixScale((mesh.getMatrixAt(0, m), m)).x;
    const body = scale(r.body);
    expect(body).toBeCloseTo(grenadeScale(fallbackFrag()), 5);
    expect(scale(r.inner)).toBeGreaterThan(body);
    expect(scale(r.outer)).toBeGreaterThan(scale(r.inner));
    // two fuse-light sprites at most per grenade went into the glow layer
    expect(f.glow.count).toBeGreaterThanOrEqual(2);
    r.update(2, [], DT, 35, f);
    expect(r.body.visible).toBe(false);
  });

  it('draws a frag GRENADE_WIDTH_M wide whatever its model’s size, and rolls it at that body’s rim (art review H3)', () => {
    for (const [w, h] of [
      [0.093, 0.143], // W8's frag
      [0.197, 0.254], // the Forge's sim-sized frag (#46)
    ] as const) {
      const r = new GrenadeRenderer(world, ramp);
      const model = { ...fallbackFrag(), radius: w / 2, height: h };
      r.setModel(model);
      expect(r.scaleFor(35) * w).toBeCloseTo(GRENADE_WIDTH_M, 6);
      expect(r.tracker.rollRadius).toBe(w / 2);
    }
    expect(grenadeScale({ radius: 0.093 / 2 })).toBeCloseTo(3.55, 2); // today's look kept
  });

  it('never draws a grenade under GRENADE_MIN_PX tall, however far the camera pulls back', () => {
    const r = new GrenadeRenderer(world, ramp);
    for (const ppm of [80, 35, 15, 8]) {
      const s = r.scaleFor(ppm);
      expect(s).toBeGreaterThanOrEqual(grenadeScale(fallbackFrag()));
      expect(s * 0.135 * ppm).toBeGreaterThanOrEqual(GRENADE_MIN_PX - 1e-9); // the stand-in frag is 13.5 cm
    }
  });

  it('leaves a smoke trail in flight, spaced along the path', () => {
    const r = new GrenadeRenderer(world, ramp);
    const f = fx();
    for (const s of arc(20, 6, 12, 2, 20)) {
      f.glow.begin();
      r.update(s.tick, [s], DT, 35, f);
    }
    // 19 ticks of ~0.2 m each, a puff every ~0.13 m × scale/3.5
    expect(f.smoke.count).toBeGreaterThan(10);
    expect(f.smoke.count).toBeLessThan(60);
  });

  it('reads a throwable GLB: mesh in the weapon frame, the `ground` depth and a `light` node', () => {
    // a mine-like GLB: a mesh under a scaled node, plus ground and light nodes
    const root = new Group();
    const node = new Group();
    node.scale.setScalar(2);
    root.add(node);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.05, -0.05, -0.01, 0.05, -0.05, -0.01, 0, 0.05, 0.02]), 3));
    g.setAttribute('color', new BufferAttribute(new Uint16Array([65535, 0, 0, 65535, 0, 65535, 0, 65535, 0, 0, 65535, 65535]), 4, true));
    node.add(new Mesh(g));
    const ground = new Group();
    ground.name = 'ground';
    ground.position.set(0, 0, -0.02);
    const light = new Group();
    light.name = 'light';
    light.position.set(0, 0, 0.04);
    root.add(ground, light);
    const model = throwableFromGltf({ scene: root } as unknown as GLTF)!;
    expect(model.groundDepth).toBeCloseTo(0.02);
    expect(model.light.z).toBeCloseTo(0.04);
    expect(model.height).toBeCloseTo(0.06); // baked through the node's ×2
    expect(model.geometry.getAttribute('color').itemSize).toBe(3);
    expect(model.geometry.getAttribute('color').getX(0)).toBeCloseTo(1);
    // without a light node (the frag), the fuse cap
    root.remove(light);
    expect(throwableFromGltf({ scene: root } as unknown as GLTF)!.light.z).toBeCloseTo(0.086);
  });
});

describe('grenade types (arsenal-b)', () => {
  it('tracks frags only: smoke, gas, flashbang, mine and EMP grenades are drawn by clouds.ts', () => {
    const tr = new GrenadeTracker(world);
    tr.update(1, [{ x: 20, y: 5, fuse: 60 }, { x: 22, y: 5, fuse: 60, type: 0 }, ...[1, 2, 3, 4, 5].map((type) => ({ x: 24 + type, y: 5, fuse: 60, type }))], DT);
    expect(tr.tracks.length).toBe(2);
  });
});

describe('reversed gravity (review L6)', () => {
  it('a frag stuck under a ceiling settles against it, hanging from its normal', () => {
    const tr = new GrenadeTracker(world);
    // under the crouch corridor's ceiling (its underside at y 1.25, x 88…96)
    for (let k = 0; k < 40; k++) tr.update(k, [{ x: 92, y: 1.25 - SIM_RADIUS, fuse: 90 - k }], DT);
    const t = tr.tracks[0]!;
    expect(t.grounded).toBe(true);
    expect(t.ny).toBeLessThan(-0.9);
    expect(t.rest).toBeGreaterThan(0.9);
  });
});
