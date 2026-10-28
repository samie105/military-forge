/**
 * Weapon skins in the 3D view (docs/17 §3.6–3.7): the tracer hue (V5, V7), the kill effect's trigger and limits
 * (V13), and the gun a soldier holds. The content-side rules are packages/content's test/weaponSkins.test.ts.
 */
import { readFileSync } from 'node:fs';
import {
  DEFAULT_COSMETIC_LOADOUT,
  K47,
  KILL_EFFECT_LIMITS,
  RESERVED_COLOURS,
  RESERVED_DELTA_E,
  getCosmetic,
  movementTestMap,
  nearestReserved,
  tracerTintOf,
  weapons,
  type CosmeticLoadout,
} from '@military-forge/content';
import { CollisionWorld, DamageSource, type SimEvent } from '@military-forge/sim';
import { BufferAttribute, BufferGeometry, Color, DataTexture, Group, Mesh, MeshStandardMaterial, Scene, Texture, type MeshToonMaterial } from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { AvatarKit } from '../avatar';
import type { GltfSource } from '../weaponModels';
import { describe, expect, it } from 'vitest';
import { MARK_COLOURS } from '../../teams/marking';
import { Gunfire, tracerClass, tracerLook } from '../vfx/gunfire';
import { KillEffects, killEffectFor, type KillEffectHost } from '../vfx/killEffects';
import { parseWeaponVfx } from '../vfx/manifest';
import { F, ParticlePool, STRIDE } from '../vfx/pool';
import { Ramp } from '../vfx/ramps';
import type { VfxContext } from '../vfx';

const world = new CollisionWorld(movementTestMap);
const wearing = (id: string): CosmeticLoadout => ({ ...DEFAULT_COSMETIC_LOADOUT, items: { ...DEFAULT_COSMETIC_LOADOUT.items, skin_k47: id } });
const linear = (hex: string): [number, number, number] => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};
const lum = ([r, g, b]: readonly number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
const shipped = parseWeaponVfx(JSON.parse(readFileSync(new URL('../../../public/assets/vfx/weapons.vfx.json', import.meta.url), 'utf8')))!;

describe('a skin\'s tracer (docs/17 V5, V7)', () => {
  const styleName = shipped.weapons.k47!.tracer!;
  const style = shipped.tracers[styleName]!;
  const def = getCosmetic('skin_k47_galaxy_relic')!;
  const skin = { bolt: linear(def.tracerTint!), trail: linear(def.tracerTrail ?? def.tracerTint!) };

  it('the content keeps its copy of the base tracer tint in step with the shipped art', () => {
    // packages/content's test holds the hue to ±10% of this tint by luminance
    expect(style.tint.map((c) => +c.toFixed(4))).toEqual(linear('#ffe9a0').map((c) => +c.toFixed(4)));
  });

  it('width, length and speed are the base\'s exactly; brightness within ±10%; only the hue moves', () => {
    for (const dist of [0.5, 4, 25, 80]) {
      const base = tracerLook(style, tracerClass(K47.class)!, dist);
      const skinned = tracerLook(style, tracerClass(K47.class)!, dist, skin);
      expect(skinned.width).toBe(base.width);
      expect(skinned.len).toBe(base.len);
      expect(skinned.speed).toBe(base.speed);
      for (const hue of [skinned.tint, skinned.trail]) expect(Math.abs(lum(hue) / lum(base.tint) - 1)).toBeLessThanOrEqual(0.1);
      expect(skinned.tint).not.toEqual(base.tint);
      expect(base.trail).toEqual(base.tint); // the base tracer is one colour
    }
  });

  it('both hues stay ΔE ≥ 15 from every reserved colour', () => {
    for (const hue of [skin.bolt, skin.trail]) {
      const near = nearestReserved(hue);
      expect(near.deltaE, `${near.name}`).toBeGreaterThanOrEqual(RESERVED_DELTA_E);
    }
  });

  it('Gunfire draws a skinned shooter\'s K-47 shots in the hue, everything else as the base', () => {
    const run = (tintOf: Gunfire['tracerTintOf']) => {
      const g = new Gunfire(world);
      g.setArt(shipped, new Texture(), new Scene());
      g.tracerTintOf = tintOf;
      const glow = new ParticlePool(500);
      g.onEvents([{ type: 'shot', shooter: 3, weapon: K47.index, ox: 150, oy: 1.2, ex: 170, ey: 1.2, hit: 0, target: -1, zone: 0 } as SimEvent]);
      g.update(1 / 60, { glow, smoke: new ParticlePool(500) }, () => false);
      const find = (ramp: number) => Array.from({ length: glow.count }, (_, i) => i).find((i) => glow.data[i * STRIDE + F.ramp] === ramp)!;
      const bolt = find(Ramp.Book);
      const path = find(Ramp.Tracer);
      const at = (i: number, f: number) => glow.data[i * STRIDE + f]!;
      return {
        size: at(bolt, F.size0), aspect: at(bolt, F.aspect), vx: at(bolt, F.vx), life: at(bolt, F.life), pathAspect: at(path, F.aspect),
        tint: [at(bolt, F.tr), at(bolt, F.tg), at(bolt, F.tb)], trail: [at(path, F.tr), at(path, F.tg), at(path, F.tb)],
      };
    };
    const lookOf = (id: number) => (id === 3 ? wearing('skin_k47_galaxy_relic') : DEFAULT_COSMETIC_LOADOUT);
    const base = run(null);
    const skinned = run((shooter, weapon) => {
      const hues = tracerTintOf(lookOf(shooter), weapons[weapon]!.id);
      return hues ? { bolt: linear(hues.bolt), trail: linear(hues.trail) } : null;
    });
    expect(skinned.size).toBe(base.size);
    expect(skinned.aspect).toBe(base.aspect);
    expect(skinned.vx).toBe(base.vx);
    expect(skinned.life).toBe(base.life);
    expect(skinned.pathAspect).toBe(base.pathAspect);
    expect(skinned.tint.map((c) => +c.toFixed(4))).toEqual(skin.bolt.map((c) => +c.toFixed(4)));
    expect(skinned.trail.map((c) => +c.toFixed(4))).toEqual(skin.trail.map((c) => +c.toFixed(4)));
  });
});

describe('the reserved colours (V7) match what the client draws', () => {
  it('every relation mark in every colour-blind mode is on the list', () => {
    const listed = new Set(RESERVED_COLOURS.map((r) => r.hex));
    for (const mode of Object.values(MARK_COLOURS)) for (const rel of ['self', 'ally', 'enemy'] as const) expect(listed.has(mode[rel]), `${rel} ${mode[rel]}`).toBe(true);
  });
});

describe('kill effects (docs/17 §3.7)', () => {
  const KILLER = 1;
  const VICTIM = 2;
  type Body = { x: number; y: number; tinted: { colour: Color; seconds: number } | null; killEffect(c: Color, s: number): void };
  const setup = (opts: { killerLook?: CosmeticLoadout; teams?: Record<number, number>; viewer?: number } = {}) => {
    const bodies = new Map<number, Body>();
    const body = (id: number): Body => {
      let b = bodies.get(id);
      if (!b) {
        const made: Body = { x: 10, y: 2, tinted: null, killEffect: (colour, seconds) => (made.tinted = { colour, seconds }) };
        bodies.set(id, (b = made));
      }
      return b;
    };
    const host: KillEffectHost = {
      lookOf: (id) => (id === KILLER ? (opts.killerLook ?? wearing('skin_k47_galaxy_relic_fx')) : DEFAULT_COSMETIC_LOADOUT),
      teamOf: (id) => opts.teams?.[id] ?? -1,
      viewer: () => opts.viewer ?? KILLER,
      body,
    };
    const scene = new Scene();
    const fx = { scene, detail: 1, reducedMotion: false } as unknown as VfxContext;
    return { fx: new KillEffects(host), ctx: fx, scene, body };
  };
  const death = (over: Partial<{ victim: number; killer: number; source: number }> = {}): SimEvent =>
    ({ type: 'death', victim: VICTIM, killer: KILLER, source: K47.index, ...over }) as SimEvent;

  it('triggers on a kill with the skinned gun by its owner, and nothing else', () => {
    const host = { lookOf: (id: number) => (id === KILLER ? wearing('skin_k47_galaxy_relic_fx') : null), teamOf: () => -1 };
    expect(killEffectFor({ victim: VICTIM, killer: KILLER, source: K47.index }, host)?.id).toBe('stardust');
    const other = weapons.find((w) => w.id === 'widow')!;
    expect(killEffectFor({ victim: VICTIM, killer: KILLER, source: other.index }, host)).toBeNull(); // another gun
    for (const source of [DamageSource.Grenade, DamageSource.Mine, DamageSource.Gas, DamageSource.Melee, DamageSource.World]) {
      expect(killEffectFor({ victim: VICTIM, killer: KILLER, source }, host), `source ${source}`).toBeNull();
    }
    expect(killEffectFor({ victim: KILLER, killer: KILLER, source: K47.index }, host)).toBeNull(); // a suicide
    expect(killEffectFor({ victim: VICTIM, killer: -1, source: K47.index }, host)).toBeNull(); // the world
    expect(killEffectFor({ victim: VICTIM, killer: KILLER, source: K47.index }, { ...host, teamOf: () => 0 })).toBeNull(); // a team kill
    expect(killEffectFor({ victim: VICTIM, killer: KILLER, source: K47.index }, { ...host, lookOf: () => wearing('skin_k47_galaxy_relic') })).toBeNull(); // plain Forged: no effect
  });

  it('≤ 80 particles, inside the victim\'s body envelope, behind the gameplay plane, gone within 1 s', () => {
    const { fx, ctx, scene } = setup();
    fx.onEvents([death()], ctx);
    expect(fx.particles).toBeGreaterThan(0);
    expect(fx.particles).toBeLessThanOrEqual(KILL_EFFECT_LIMITS.maxParticles);
    const layer = scene.getObjectByName('vfx-kill-effects')!;
    expect(layer).toBeDefined();
    // under the glow layer's tracers (12) and depth-tested: the dropped gun, pickups and players draw over it
    expect(layer.renderOrder).toBeLessThan(12);
    const env = KILL_EFFECT_LIMITS.envelopeMul;
    const pool = (fx as unknown as { pool: ParticlePool }).pool;
    for (let t = 0; t < 1.05; t += 1 / 60) {
      for (let i = 0; i < pool.count; i++) {
        const o = i * STRIDE;
        const half = pool.data[o + F.size0]! / 2;
        expect(Math.abs(pool.data[o + F.x]! - 10) + half).toBeLessThanOrEqual(0.3 * env + 0.02);
        expect(pool.data[o + F.y]! + half).toBeLessThanOrEqual(2 + 1.5 * env + 0.01);
        expect(pool.data[o + F.y]!).toBeGreaterThanOrEqual(2);
        expect(pool.data[o + F.z]!).toBeLessThan(0);
      }
      fx.update({} as never, 1 / 60);
    }
    expect(fx.particles).toBe(0);
    expect(fx.playing).toBe(0);
  });

  it('the body takes the effect\'s tint over the effect\'s time; the still variant under Reduce motion, on Low, and for a fifth at once', () => {
    const a = setup();
    a.fx.onEvents([death()], a.ctx);
    expect(a.body(VICTIM).tinted!.seconds).toBeLessThanOrEqual(KILL_EFFECT_LIMITS.maxDurationS);
    const reduced = setup();
    reduced.fx.onEvents([death()], { ...reduced.ctx, reducedMotion: true });
    expect(reduced.fx.particles).toBe(0);
    expect(reduced.body(VICTIM).tinted).not.toBeNull();
    const low = setup();
    low.fx.low = true;
    low.fx.onEvents([death()], low.ctx);
    expect(low.fx.particles).toBe(0);
    const many = setup();
    many.fx.onEvents([1, 2, 3, 4, 5].map((v) => death({ victim: 10 + v })), many.ctx);
    expect(many.fx.playing).toBe(5);
    expect(many.fx.particles).toBeLessThanOrEqual(4 * KILL_EFFECT_LIMITS.maxParticles);
    expect(many.fx.particles).toBe(4 * getKillParticles());
  });

  it('"Show other players\' kill effects" off: only your own kills play one', () => {
    const others = setup({ viewer: 7 });
    others.fx.showOthers = false;
    others.fx.onEvents([death()], others.ctx);
    expect(others.body(VICTIM).tinted).toBeNull();
    expect(others.fx.particles).toBe(0);
    const mine = setup({ viewer: KILLER });
    mine.fx.showOthers = false;
    mine.fx.onEvents([death()], mine.ctx);
    expect(mine.fx.particles).toBeGreaterThan(0);
  });
});

function getKillParticles(): number {
  return Math.min(KILL_EFFECT_LIMITS.maxParticles, 64);
}

describe('the skinned gun in the hand (docs/17 §3.6)', () => {
  /** a one-triangle scan with an albedo and, for a Forged skin, an emissive map */
  const glb = (emissive: boolean): GLTF => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 0.05, 0.4, 0, 0, 0.3, 0.05]), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
    const map = new DataTexture(new Uint8Array(4), 1, 1);
    const root = new Group();
    root.add(new Mesh(g, new MeshStandardMaterial({ map, ...(emissive ? { emissiveMap: new DataTexture(new Uint8Array(4), 1, 1) } : {}) })));
    return { scene: root } as unknown as GLTF;
  };

  it('the base gun until the skin loads, then the skin with its glow; a failed skin keeps the base', async () => {
    const kit = new AvatarKit(new DataTexture(new Uint8Array(4), 1, 1));
    const loads: string[] = [];
    let release!: () => void;
    const ready = new Promise<void>((r) => (release = r));
    const loader: GltfSource = {
      loadAsync: async (url) => {
        loads.push(url);
        if (url.endsWith('k47_galaxy_relic.glb')) {
          await ready;
          return glb(true);
        }
        if (url.endsWith('missing.glb')) throw new Error('404');
        return glb(false);
      },
    };
    await kit.loadWeapons('/', loader).catch(() => undefined);
    const base = kit.weapon(K47.index);
    const model = getCosmetic('skin_k47_galaxy_relic')!.assets.model!;
    expect(kit.skinned(K47.index, model)).toBe(base);
    expect(loads.filter((u) => u.endsWith(model))).toHaveLength(1);
    expect(kit.skinned(K47.index, model)).toBe(base); // one load, however many soldiers ask
    expect(loads.filter((u) => u.endsWith(model))).toHaveLength(1);
    const arrived = new Promise<string>((r) => (kit.onSkin = r));
    release();
    expect(await arrived).toBe(model);
    const skinned = kit.skinned(K47.index, model);
    expect(skinned).not.toBe(base);
    const material = skinned.material as MeshToonMaterial;
    expect(material.emissiveMap).not.toBeNull();
    expect(material.emissiveIntensity).toBeLessThan(1); // V9: below the albedo, no bloom
    expect(kit.materials()).toContain(kit.gunMaterialGlow); // its shader variant warms up with the rest
    // the same sockets as the base gun (a blueprint keeps them): tracers and casings leave the same points
    expect(skinned.muzzle.toArray()).toEqual(base.muzzle.toArray());
    kit.skinned(K47.index, 'weapons/skins/missing.glb');
    await new Promise((r) => setTimeout(r, 0));
    expect(kit.skinned(K47.index, 'weapons/skins/missing.glb')).toBe(base);
  });

  it('a dropped gun always draws its base look (WeaponItems never asks for a skin)', () => {
    const src = readFileSync(new URL('../weaponItems.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/skinned\(/);
  });
});
