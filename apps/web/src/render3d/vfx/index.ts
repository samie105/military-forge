/**
 * render3d's effects (docs/11 §5): grenades with their trails and fuse lights, explosions, the
 * blast's light and trauma camera shake. Fed by sim events (Renderer3D.onEvents) and each Frame.
 *
 * Budgets (docs/11 §3): every particle lives in a fixed pool sized for High and capped per preset
 * (1.5K live on Low, 5K on High); the steady-state frame allocates nothing; each layer is one draw
 * call and is hidden while empty, so a quiet scene costs no extra draws.
 */
import type { CollisionWorld, SimEvent } from '@military-forge/sim';
import type { DirectionalLight, HemisphereLight, Scene, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Camera } from '../../camera';
import type { Frame } from '../../view';
import { GrenadeRenderer, throwableFromGltf, type GrenadeFx } from '../grenades';
import type { GraphicsPreset } from '../presets';
import { ATLAS_GRID, vfxAtlas } from './atlas';
import { spawnExplosion, type ExplosionTargets } from './explosion';
import { SceneFlash } from './flash';
import { loadExplosionArt, type FlipbookArt } from './manifest';
import { ParticleLayer } from './particles';
import { ParticlePool } from './pool';
import { CameraShake, blastTrauma } from './shake';

/** arsenal-b grenade types whose `explosion` event is not a blast (arsenal-b-interfaces.md) */
const NOT_A_BLAST = { flashbang: 3, emp: 5 } as const;

/** pool sizes for the High budget (5K live); lower presets cap them (`limit`) */
const GLOW_MAX = 2300;
const SMOKE_MAX = 2500;
const DECALS_MAX = 32;
/** one-frame sprites written straight into the glow layer (two per grenade's fuse light) */
const SPRITES_MAX = 96;

interface Book {
  pool: ParticlePool;
  layer: ParticleLayer;
  art: FlipbookArt;
}

/**
 * What a plugged-in effect gets (arsenal-b's grenade clouds, later effects): the shared pools, so
 * every particle counts against one budget and draws in the same three calls.
 */
export interface VfxContext {
  /** alpha-blended (smoke, dust, gas): depth-tested, drawn after the decals */
  readonly smoke: ParticlePool;
  /** additive light (fire, sparks, flashes): drawn over everything */
  readonly glow: ParticlePool;
  /** long-lived surface marks: use emitRecycling (the oldest goes when full) */
  readonly decals: ParticlePool;
  /** one-frame additive sprites (`sprite`/`quad`): only inside `update` */
  readonly glowLayer: ParticleLayer;
  readonly world: CollisionWorld;
  readonly scene: Scene;
  readonly camera: Camera;
  /** the preset's effect density: 0.6 Low, 0.8 Medium, 1 High */
  readonly detail: number;
  readonly reducedMotion: boolean;
}

/** An effect module: `vfx.register(module)` in Renderer3D's constructor. */
export interface VfxModule {
  /** each batch of sim events */
  onEvents?(events: readonly SimEvent[], fx: VfxContext): void;
  /** once per drawn frame, after the pools have stepped and before they upload */
  update?(frame: Frame, dt: number, fx: VfxContext): void;
  dispose?(): void;
}

export class Vfx {
  readonly glowPool = new ParticlePool(GLOW_MAX);
  readonly smokePool = new ParticlePool(SMOKE_MAX);
  readonly decalPool = new ParticlePool(DECALS_MAX);
  readonly glow: ParticleLayer;
  readonly smoke: ParticleLayer;
  readonly decals: ParticleLayer;
  readonly grenades: GrenadeRenderer;
  readonly flash: SceneFlash;
  readonly shake = new CameraShake();
  /** the Forge's explosion flipbook, when published */
  private readonly books: Book[] = [];
  private readonly targets: ExplosionTargets;
  private readonly grenadeFx: GrenadeFx;
  private readonly modules: VfxModule[] = [];
  /** handed to modules (read-only there); detail and reduced motion change with the settings */
  private readonly ctx: { -readonly [K in keyof VfxContext]: VfxContext[K] };

  constructor(
    private readonly scene: Scene,
    private readonly world: CollisionWorld,
    private readonly camera: Camera,
    lights: { hemi: HemisphereLight; sun: DirectionalLight },
    ramp: Texture,
    preset: GraphicsPreset,
  ) {
    const atlas = vfxAtlas();
    const grid = [ATLAS_GRID, ATLAS_GRID] as const;
    this.decals = new ParticleLayer(DECALS_MAX, { texture: atlas, grid, blend: 'alpha', depthTest: true, renderOrder: 10, polygonOffset: true });
    this.smoke = new ParticleLayer(SMOKE_MAX, { texture: atlas, grid, blend: 'alpha', depthTest: true, renderOrder: 11 });
    this.glow = new ParticleLayer(GLOW_MAX + SPRITES_MAX, { texture: atlas, grid, blend: 'additive', depthTest: false, renderOrder: 12 });
    this.grenades = new GrenadeRenderer(world, ramp);
    this.flash = new SceneFlash(lights.hemi, lights.sun);
    for (const l of [this.decals, this.smoke, this.glow]) l.mesh.name = 'vfx';
    scene.add(this.decals.mesh, this.smoke.mesh, this.glow.mesh, ...this.grenades.meshes);
    this.targets = { glow: this.glowPool, smoke: this.smokePool, decals: this.decalPool, book: null, art: null };
    this.grenadeFx = { smoke: this.smokePool, glow: this.glow };
    this.ctx = { smoke: this.smokePool, glow: this.glowPool, decals: this.decalPool, glowLayer: this.glow, world, scene, camera, detail: 1, reducedMotion: false };
    this.setPreset(preset);
  }

  get context(): VfxContext {
    return this.ctx;
  }

  /** Plugs in an effect module (one line in Renderer3D's constructor). */
  register(module: VfxModule): void {
    this.modules.push(module);
  }

  /** The frag model and any Forge flipbooks. Failures keep the stand-ins (procedural effects, a modelled frag). */
  async load(baseUrl: string): Promise<void> {
    const frag = new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .loadAsync(`${baseUrl}assets/weapons/frag.glb`)
      .then((gltf) => {
        const model = throwableFromGltf(gltf);
        if (model) this.grenades.setModel(model);
      })
      .catch((err: unknown) => console.warn('render3d: frag.glb failed to load, drawing the stand-in frag', err));
    const books = loadExplosionArt(baseUrl).then((loaded) => {
      if (!loaded) return;
      const { art, texture } = loaded;
      this.targets.art = art;
      // the flipbook's bright first frames draw over the additive shockwave (Forge notes)
      if (art.book && texture) this.targets.book = this.book(art.book, texture, 13);
      if (art.light) this.flash.style(art.light.color, art.light.seconds);
    });
    await Promise.all([frag, books]);
  }

  private book(art: FlipbookArt, texture: Texture, renderOrder: number): Book {
    const layer = new ParticleLayer(16, {
      texture,
      grid: art.grid,
      blend: art.blend,
      depthTest: false,
      renderOrder,
      flipbook: { fps: art.fps, frames: art.frames },
    });
    layer.mesh.name = 'vfx-flipbook';
    this.scene.add(layer.mesh);
    const book = { pool: new ParticlePool(16), layer, art };
    this.books.push(book);
    return book;
  }

  setPreset(preset: GraphicsPreset): void {
    this.ctx.detail = preset.vfxDetail;
    this.glowPool.limit = Math.round(preset.particles * 0.45);
    this.smokePool.limit = Math.round(preset.particles * 0.5);
    if (preset.vfxLights) this.scene.add(this.flash.point);
    else this.flash.point.removeFromParent();
  }

  setReducedMotion(on: boolean): void {
    this.ctx.reducedMotion = on;
    this.shake.enabled = !on;
    this.flash.reduced = on;
    this.grenades.reduced = on;
  }

  /** Sim events → effects (explosions; gunfire comes with the tracers). */
  onEvents(events: readonly SimEvent[]): void {
    for (const m of this.modules) m.onEvents?.(events, this.ctx);
    for (const e of events) {
      // arsenal-b: a flashbang (3) or EMP (5) going off isn't a fireball; its own effects draw it
      const kind = (e as { grenade?: number }).grenade ?? 0;
      if (e.type !== 'explosion' || kind === NOT_A_BLAST.flashbang || kind === NOT_A_BLAST.emp) continue;
      spawnExplosion(this.targets, this.world, e.x, e.y, e.radius, this.ctx.detail);
      // light and shake by distance from the view centre (the Forge's shake falloff when published)
      const d = Math.hypot(e.x - this.camera.x, e.y - this.camera.y);
      this.flash.trigger(e.x, e.y, Math.max(0.15, Math.min(1, 1 - Math.max(0, d - e.radius) / 25)));
      const shake = this.targets.art?.shake;
      const k = e.radius / (this.targets.art?.radiusM ?? e.radius);
      this.shake.add(shake ? blastTrauma(d, shake.fullWithinM * k, shake.zeroAtM * k) : blastTrauma(d, e.radius));
    }
  }

  /** Steps every effect and uploads this frame's particles. Returns the camera shake offset (m). */
  update(frame: Frame, dt: number): { x: number; y: number } {
    this.flash.update(dt);
    this.glowPool.update(dt);
    this.smokePool.update(dt);
    this.decalPool.update(dt);
    for (const b of this.books) {
      b.pool.update(dt);
      b.layer.begin();
      b.layer.addPool(b.pool);
      b.layer.end();
    }

    this.glow.begin();
    this.glow.addPool(this.glowPool);
    // grenades: their trail puffs join the smoke pool, their fuse lights this glow frame
    this.grenades.update(frame.tick, frame.grenades, dt, this.camera.ppm, this.grenadeFx);
    for (const m of this.modules) m.update?.(frame, dt, this.ctx);
    this.glow.end();
    this.smoke.begin();
    this.smoke.addPool(this.smokePool);
    this.smoke.end();
    this.decals.begin();
    this.decals.addPool(this.decalPool);
    this.decals.end();
    return this.shake.update(dt);
  }

  /** live particles (the docs/11 §3 budget counts these) */
  get particles(): number {
    let n = this.glowPool.count + this.smokePool.count + this.decalPool.count;
    for (const b of this.books) n += b.pool.count;
    return n;
  }

  dispose(): void {
    for (const l of [this.decals, this.smoke, this.glow, ...this.books.map((b) => b.layer)]) l.dispose();
    this.grenades.dispose();
    for (const m of this.modules) m.dispose?.();
    this.flash.point.removeFromParent();
  }
}
