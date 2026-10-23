/**
 * render3d's effects (docs/11 §5): grenades with their trails and fuse lights, explosions, the
 * blast's light and trauma camera shake, gunfire (tracers, muzzle flashes, impacts) and spent
 * casings. Fed by sim events (Renderer3D.onEvents) and each Frame.
 *
 * Budgets (docs/11 §3): every particle lives in a fixed pool sized for High and capped per preset
 * (1.5K live on Low, 5K on High); the steady-state frame allocates nothing; each layer is one draw
 * call and is hidden while empty, so a quiet scene costs no extra draws.
 */
import { FRAG, PROJECTILE_TYPE_BASE, ROCKET, SHELL, grenades as grenadeDefs } from '@military-forge/content';
import type { CollisionWorld, SimEvent } from '@military-forge/sim';
import { SRGBColorSpace, TextureLoader, Vector3, type BufferGeometry, type DirectionalLight, type HemisphereLight, type Mesh, type Scene, type Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { Camera } from '../../camera';
import { reduceFlashes } from '../../fx';
import type { Frame } from '../../view';
import { GrenadeRenderer, throwableFromGltf, type GrenadeFx } from '../grenades';
import type { GraphicsPreset } from '../presets';
import { bakeMesh } from '../weaponModels';
import { ATLAS_GRID, vfxAtlas } from './atlas';
import { CASING_KINDS, Casings, DEFAULT_NODES, type CasingArt, type CasingKind, type EjectLookup } from './casings';
import { DashFx, type BodyLookup } from './dash';
import { DashGhosts, type GhostSource } from './dashGhosts';
import { DashTrail } from './dashTrail';
import { spawnExplosion, type ExplosionTargets } from './explosion';
import { SceneFlash } from './flash';
import { Gunfire, type MuzzleLookup } from './gunfire';
import { loadExplosionArt, loadWeaponVfx, type ExplosionArt, type FlipbookArt } from './manifest';
import { ParticleLayer } from './particles';
import { ParticlePool } from './pool';
import { ProjectileFx, type GunPointLookup } from './projectiles';
import { MeleeFx, type SwingLookup } from './melee';
import { ShieldBlasts, shieldBreak } from './shieldBlast';
import { CameraShake, blastTrauma } from './shake';
import { ThrowArc } from './throwArc';

/** arsenal-b grenade types whose `explosion` event is not a blast (arsenal-b-interfaces.md) */
const NOT_A_BLAST = { flashbang: 3, emp: 5 } as const;

/** the Forge's explosion styles (explosions.vfx.json), and the one each blast's `grenade` takes */
const BLAST_STYLES = ['frag', 'grenade_launcher', 'rocket'] as const;
type BlastStyle = (typeof BLAST_STYLES)[number];
/** the Thumper's rocket (8) and the Popper's shell (9) in their own styles; any other blast, the frag's */
export function blastStyle(grenade: number | undefined): BlastStyle {
  return grenade === PROJECTILE_TYPE_BASE + ROCKET.index ? 'rocket' : grenade === PROJECTILE_TYPE_BASE + SHELL.index ? 'grenade_launcher' : 'frag';
}

const _warm = new Vector3();

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
  /** every grenade type's models in flight and pairs on the map (#91), by type */
  readonly throwables: readonly GrenadeRenderer[];
  /** the frag's */
  readonly grenades: GrenadeRenderer;
  readonly flash: SceneFlash;
  readonly shake = new CameraShake();
  readonly gunfire: Gunfire;
  /** spent casings out of the guns' eject ports */
  readonly casings: Casings;
  /** the launchers' and the flamethrower's projectiles, burns and wind-up tells (projectiles.ts) */
  readonly projectiles: ProjectileFx;
  /** the throw arc (Frame.throwArc) */
  readonly arc: ThrowArc;
  /** dashes: the jet kick, speed lines and afterimages, and the green trail with its sparkles */
  readonly dash: DashFx;
  readonly ghosts: DashGhosts;
  readonly trail: DashTrail;
  /** the Forge's explosion flipbook, when published */
  private readonly books: Book[] = [];
  private readonly targets: ExplosionTargets;
  /** each style's targets (the frag's until the art loads): its flipbook and its numbers */
  private readonly styles: Partial<Record<BlastStyle, ExplosionTargets>> = {};
  private readonly grenadeFx: GrenadeFx;
  /** a launcher's blast at a riot shield's face: the plate's flare and sparks */
  private readonly shieldBlasts = new ShieldBlasts();
  /** melee: the swing's trail and the hit (melee.ts) */
  private readonly melee: MeleeFx;
  private breakSeed = 0x0b1e;
  private readonly breakRand = (): number => {
    this.breakSeed = (Math.imul(this.breakSeed, 1664525) + 1013904223) >>> 0;
    return this.breakSeed / 4294967296;
  };
  private readonly modules: VfxModule[] = [];
  /** the Low preset (fewer casings) */
  private low = false;
  /** handed to modules (read-only there); detail and reduced motion change with the settings */
  private readonly ctx: { -readonly [K in keyof VfxContext]: VfxContext[K] };

  constructor(
    private readonly scene: Scene,
    private world: CollisionWorld,
    private readonly camera: Camera,
    lights: { hemi: HemisphereLight; sun: DirectionalLight },
    ramp: Texture,
    preset: GraphicsPreset,
    /** where a shooter's drawn gun has its muzzle (Renderer3D: from the avatars) */
    private readonly muzzles: MuzzleLookup = () => false,
    /** a player's drawn character, for dash afterimages (Renderer3D: from the avatars) */
    bodies: BodyLookup = () => null,
    /** where a shooter's drawn gun ejects its casings (Renderer3D: from the avatars) */
    ejects: EjectLookup = () => false,
    /** a drawn gun's named socket (`pilot`, `charge`) for the projectiles' tells (Renderer3D: from the avatars) */
    gunPoints: GunPointLookup = () => false,
    /** a soldier's weapon mid-strike, for the swing's trail (Renderer3D: from the avatars) */
    swings: SwingLookup = () => false,
  ) {
    this.melee = new MeleeFx(swings);
    const atlas = vfxAtlas();
    const grid = [ATLAS_GRID, ATLAS_GRID] as const;
    this.decals = new ParticleLayer(DECALS_MAX, { texture: atlas, grid, blend: 'alpha', depthTest: true, renderOrder: 10, polygonOffset: true });
    this.smoke = new ParticleLayer(SMOKE_MAX, { texture: atlas, grid, blend: 'alpha', depthTest: true, renderOrder: 11 });
    this.glow = new ParticleLayer(GLOW_MAX + SPRITES_MAX, { texture: atlas, grid, blend: 'additive', depthTest: false, renderOrder: 12 });
    this.throwables = grenadeDefs.map((g) => new GrenadeRenderer(world, ramp, g.index));
    this.grenades = this.throwables[FRAG.index]!;
    this.flash = new SceneFlash(lights.hemi, lights.sun);
    this.gunfire = new Gunfire(world);
    this.casings = new Casings(scene, ramp, world, ejects);
    this.projectiles = new ProjectileFx(scene, ramp, atlas, gunPoints);
    this.arc = new ThrowArc(atlas, grid);
    this.ghosts = new DashGhosts(scene);
    this.trail = new DashTrail(scene);
    this.dash = new DashFx(this.ghosts, bodies);
    for (const l of [this.decals, this.smoke, this.glow]) l.mesh.name = 'vfx';
    scene.add(this.decals.mesh, this.smoke.mesh, this.glow.mesh, this.arc.layer.mesh, ...this.throwables.flatMap((g) => g.meshes));
    this.targets = { glow: this.glowPool, smoke: this.smokePool, decals: this.decalPool, book: null, art: null };
    this.grenadeFx = { smoke: this.smokePool, glow: this.glow };
    this.ctx = { smoke: this.smokePool, glow: this.glowPool, decals: this.decalPool, glowLayer: this.glow, world, scene, camera, detail: 1, reducedMotion: false };
    this.setPreset(preset);
  }

  get context(): VfxContext {
    return this.ctx;
  }

  /**
   * A new map (Renderer3D's buildMap, when the map changes): its collision for grenades, blasts and
   * impacts, and a clean slate: no particles, marks, grenades or shake carried over. Then the
   * relit scene's light values become the flash's base. Safe to call any time after construction.
   */
  setMap(world: CollisionWorld): void {
    this.world = world;
    this.ctx.world = world;
    for (const g of this.throwables) g.setWorld(world);
    this.gunfire.world = world;
    this.gunfire.clear();
    this.casings.world = world;
    this.casings.clear();
    this.projectiles.clear();
    for (const p of [this.glowPool, this.smokePool, this.decalPool, ...this.books.map((b) => b.pool)]) p.clear();
    this.shake.trauma = 0;
    this.ghosts.clear();
    this.trail.clear();
    this.flash.rebase();
  }

  /** Plugs in an effect module (one line in Renderer3D's constructor). */
  register(module: VfxModule): void {
    this.modules.push(module);
  }

  /** The grenade models and any Forge flipbooks. Failures keep the stand-ins (procedural effects, modelled grenades). */
  async load(baseUrl: string): Promise<void> {
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    // one model per grenade type (#91): frag, smoke, gas, flash, mine and emp.glb, by content id
    const models = Promise.all(
      this.throwables.map((g) => {
        const id = grenadeDefs[g.type]!.id;
        return loader
          .loadAsync(`${baseUrl}assets/weapons/${id}.glb`)
          .then((gltf) => {
            const model = throwableFromGltf(gltf);
            if (model) g.setModel(model);
          })
          .catch((err: unknown) => console.warn(`render3d: ${id}.glb failed to load, drawing the stand-in`, err));
      }),
    );
    const books = loadExplosionArt(baseUrl, BLAST_STYLES).then((loaded) => {
      if (!loaded) return;
      const { arts, texture } = loaded;
      // one flipbook layer per distinct flipbook (the frag's serves the grenade launcher too); the
      // bright first frames draw over the additive shockwave (Forge notes)
      const books = new Map<string, Book>();
      for (const style of BLAST_STYLES) {
        const art: ExplosionArt | undefined = arts[style];
        if (!art) continue;
        let book: ExplosionTargets['book'] = null;
        if (art.book && texture) {
          const key = art.book.frames.join(',');
          const shared = books.get(key) ?? this.book(art.book, texture, 13);
          books.set(key, shared);
          // a style's own size and anchor, on the layer its flipbook shares
          book = shared.art === art.book ? shared : { pool: shared.pool, art: art.book };
        }
        this.styles[style] = { ...this.targets, art, book };
      }
      const frag = this.styles.frag;
      if (frag) {
        this.targets.art = frag.art;
        this.targets.book = frag.book;
      }
      if (frag?.art?.light) this.flash.style(frag.art.light.color, frag.art.light.seconds);
    });
    const guns = loadWeaponVfx(baseUrl).then(async (art) => {
      if (art) this.gunfire.setArt(art.art, art.texture, this.scene);
      this.casings.setArt(art?.art.casings ?? null);
      await this.loadCasings(baseUrl, art?.art.casings ?? null);
    });
    await Promise.all([models, books, guns, this.loadProjectiles(baseUrl)]);
  }

  /** projectiles.glb's models and the flame and specials atlases; anything missing keeps the stand-ins. */
  private async loadProjectiles(baseUrl: string): Promise<void> {
    const texture = (file: string) =>
      new TextureLoader()
        .loadAsync(`${baseUrl}assets/vfx/${file}`)
        .then((t) => ((t.colorSpace = SRGBColorSpace), t))
        .catch((err: unknown) => (console.warn(`render3d: ${file} failed to load, keeping the stand-in`, err), null));
    const models = new GLTFLoader()
      .setMeshoptDecoder(MeshoptDecoder)
      .loadAsync(`${baseUrl}assets/vfx/projectiles.glb`)
      .then((gltf) => {
        gltf.scene.updateMatrixWorld(true);
        const out: Partial<Record<'rocket' | 'shell' | 'blade', BufferGeometry>> = {};
        for (const [key, node] of [['rocket', 'proj_rocket'], ['shell', 'proj_grenade'], ['blade', 'proj_blade']] as const) {
          let mesh: Mesh | null = null;
          gltf.scene.getObjectByName(node)?.traverse((o) => {
            if (!mesh && (o as Mesh).isMesh) mesh = o as Mesh;
          });
          if (mesh) out[key] = bakeMesh(mesh, (mesh as Mesh).matrix);
        }
        return out;
      })
      .catch((err: unknown) => (console.warn('render3d: projectiles.glb failed to load, keeping the stand-in projectiles', err), {}));
    const [flame, specials, geos] = await Promise.all([texture('flame_atlas.webp'), texture('specials_atlas.webp'), models]);
    this.projectiles.setArt({ models: geos, flame, specials });
  }

  /** casings.glb's shapes (weapons.vfx.json names the file and nodes); a failure keeps the stand-ins. */
  private async loadCasings(baseUrl: string, art: CasingArt | null): Promise<void> {
    try {
      const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`${baseUrl}assets/vfx/${art?.file ?? 'casings.glb'}`);
      gltf.scene.updateMatrixWorld(true);
      const models: Partial<Record<CasingKind, BufferGeometry>> = {};
      for (const kind of CASING_KINDS) {
        const named = art?.types[kind]?.node;
        for (const name of named ? [named] : DEFAULT_NODES[kind]) {
          let mesh: Mesh | null = null;
          gltf.scene.getObjectByName(name)?.traverse((o) => {
            if (!mesh && (o as Mesh).isMesh) mesh = o as Mesh;
          });
          if (!mesh) continue;
          // in the node's own frame: the casing's long axis along Y, centred
          const g = bakeMesh(mesh, (mesh as Mesh).matrix);
          g.center();
          models[kind] = g;
          break;
        }
      }
      this.casings.setModels(models);
    } catch (err) {
      console.warn('render3d: casings.glb failed to load, keeping the stand-in casings', err);
    }
  }

  private book(art: FlipbookArt, texture: Texture, renderOrder: number): Book {
    // depth-tested: a fireball on the floor goes behind the ground's front face (it sits at z 0.6,
    // in front of the players and the band, behind the face at z +1) instead of painting over it
    const layer = new ParticleLayer(16, {
      texture,
      grid: art.grid,
      blend: art.blend,
      depthTest: true,
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
    this.gunfire.detail = preset.vfxDetail;
    this.gunfire.low = preset.name === 'low';
    // dash afterimages cost a draw call per character mesh each: a few on High, two on Medium, none on Low
    this.ghosts.max = preset.name === 'high' ? 4 : preset.name === 'medium' ? 2 : 0;
    this.low = preset.name === 'low';
    this.casings.setLimits(this.low, this.ctx.reducedMotion);
    if (this.ghosts.max === 0) this.ghosts.clear();
    this.setLights(preset.vfxLights);
  }

  /**
   * The effects' real point lights (High) in the scene or out of it. Renderer3D also flips them for a
   * moment at load, to compile the scene's shaders for the light set of a tier Auto may step to.
   */
  setLights(on: boolean): void {
    this.projectiles.lights = on;
    if (on) this.scene.add(this.flash.point, this.gunfire.light, this.projectiles.light);
    else {
      this.flash.point.removeFromParent();
      this.gunfire.light.removeFromParent();
      this.projectiles.light.removeFromParent();
    }
  }

  /** Blood on player hits (blood.ts), instead of the non-gory thud. */
  setBlood(on: boolean): void {
    this.melee.blood = on;
    this.gunfire.blood = on;
  }

  setReducedMotion(on: boolean): void {
    this.ctx.reducedMotion = on;
    this.casings.setLimits(this.low, on);
    this.shake.enabled = !on;
    this.flash.reduced = on;
    for (const g of this.throwables) g.reduced = on;
  }

  /** Sim events → effects: blasts now, shots once the avatars are posed (update). */
  onEvents(events: readonly SimEvent[]): void {
    for (const m of this.modules) m.onEvents?.(events, this.ctx);
    this.gunfire.onEvents(events);
    this.casings.onEvents(events);
    this.projectiles.onEvents(events);
    this.dash.onEvents(events, this.ctx);
    this.melee.onEvents(events, this.ctx, this.world, this.ctx.detail);
    // a riot shield broken at 0 HP: a flash, its shards and sparks (docs/03 §5)
    for (const e of events) if (e.type === 'shieldBreak') shieldBreak(e.x, e.y, this.glowPool, this.smokePool, this.ctx.detail, this.breakRand);
    for (const e of events) {
      // arsenal-b: a flashbang (3) or EMP (5) going off isn't a fireball; its own effects draw it
      const kind = (e as { grenade?: number }).grenade ?? 0;
      if (e.type !== 'explosion' || kind === NOT_A_BLAST.flashbang || kind === NOT_A_BLAST.emp) continue;
      // the Thumper's and Popper's blasts in their own styles (explosions.vfx.json), else the frag's
      const t = this.styles[blastStyle(kind)] ?? this.targets;
      spawnExplosion(t, this.world, e.x, e.y, e.radius, this.ctx.detail);
      // a rocket, shell or blade stopped by a riot shield (#111) went off at its face: the plate flares and sparks
      this.shieldBlasts.blast(e.x, e.y, kind, this.glowPool, this.ctx.detail, this.ctx.reducedMotion, reduceFlashes());
      // light and shake by distance from the view centre (the Forge's shake falloff when published)
      const cx = e.x - this.camera.x;
      const cy = e.y - this.camera.y;
      const d = Math.sqrt(cx * cx + cy * cy);
      this.flash.trigger(e.x, e.y, Math.max(0.15, Math.min(1, 1 - Math.max(0, d - e.radius) / 25)));
      const shake = t.art?.shake;
      const k = e.radius / (t.art?.radiusM ?? e.radius);
      this.shake.add(shake ? blastTrauma(d, shake.fullWithinM * k, shake.zeroAtM * k) : blastTrauma(d, e.radius));
    }
  }

  /**
   * Steps every effect and uploads this frame's particles; call it after the avatars are posed
   * (tracers leave the drawn muzzles). Returns the camera shake offset (m).
   */
  update(frame: Frame, dt: number): { x: number; y: number } {
    this.flash.update(dt);
    this.glowPool.update(dt);
    this.smokePool.update(dt);
    this.decalPool.update(dt);
    this.gunfire.update(dt, this.ctx, this.muzzles);
    this.casings.update(frame, dt);
    this.dash.localId = frame.localId;
    this.dash.update(frame, dt, this.ctx);
    this.trail.steady = reduceFlashes();
    this.trail.update(frame, dt, this.ctx);
    this.projectiles.steady = this.trail.steady;
    this.projectiles.update(frame, dt, this.ctx);
    // the throw arc while one is aimed (amber when a map event starts or ends mid-flight)
    this.arc.update(frame.throwArc, dt, this.camera.ppm, this.ctx.reducedMotion);
    for (const b of this.books) {
      b.pool.update(dt);
      b.layer.begin();
      b.layer.addPool(b.pool);
      b.layer.end();
    }

    this.glow.begin();
    this.glow.addPool(this.glowPool);
    // grenades: their trail puffs join the smoke pool, their fuse lights this glow frame
    for (const g of this.throwables) g.update(frame.tick, frame.grenades, dt, this.camera.ppm, this.grenadeFx, frame.pickups);
    for (const m of this.modules) m.update?.(frame, dt, this.ctx);
    this.glow.end();
    this.smoke.begin();
    this.smoke.addPool(this.smokePool);
    this.smoke.end();
    this.decals.begin();
    this.decals.addPool(this.decalPool);
    this.decals.end();
    // the shields as this frame drew them, for the blasts of the next batch of events
    this.shieldBlasts.players = frame.players;
    this.melee.update(frame, this.ctx, this.ctx.detail, this.ctx.reducedMotion);
    return this.shake.update(dt);
  }

  /**
   * Every effect on show at (x, y), so the warm-up compiles it and draws it once (docs/11 §3; QA 23 Oct:
   * a driver that builds a pipeline on its first draw built it on the first dash, jet or grenade):
   * the meshes of their own, a sprite in every particle layer (each blend and depth state), a grenade
   * of each type, and an afterimage of `ghost` (a warm-up soldier). `endWarmUp()` after the draw.
   */
  showForWarmUp(x: number, y: number, ghost?: GhostSource): void {
    this.trail.showForWarmUp(x, y);
    this.casings.showForWarmUp(_warm.set(x, y, 0));
    this.projectiles.showForWarmUp(x, y);
    for (const l of this.warmLayers()) {
      l.begin();
      l.sprite(x, y, 0, 0.5, 0, 1, 1, 1, 1, 0);
      l.end();
    }
    for (const g of this.throwables) g.showForWarmUp(x, y);
    if (ghost) this.ghosts.showForWarmUp(ghost);
  }

  endWarmUp(): void {
    this.trail.clear();
    this.casings.clear(); // they cast no shadows: nothing more to compile
    this.projectiles.clear();
    for (const l of this.warmLayers()) {
      l.begin();
      l.end();
    }
    for (const g of this.throwables) g.endWarmUp();
    this.ghosts.clear();
  }

  /** every particle layer in the scene: decals, smoke, glow, the throw arc, the blast flipbooks and the muzzle flashes */
  private warmLayers(): ParticleLayer[] {
    const layers = [this.decals, this.smoke, this.glow, this.arc.layer, ...this.books.map((b) => b.layer)];
    if (this.gunfire.flashLayer) layers.push(this.gunfire.flashLayer);
    return layers;
  }

  /** live particles (the docs/11 §3 budget counts these) */
  get particles(): number {
    let n = this.glowPool.count + this.smokePool.count + this.decalPool.count;
    for (const b of this.books) n += b.pool.count;
    return n;
  }

  dispose(): void {
    for (const l of [this.decals, this.smoke, this.glow, this.arc.layer, ...this.books.map((b) => b.layer)]) l.dispose();
    for (const g of this.throwables) g.dispose();
    this.gunfire.dispose();
    this.casings.dispose();
    this.projectiles.dispose();
    this.ghosts.dispose();
    this.trail.dispose();
    for (const m of this.modules) m.dispose?.();
    this.flash.point.removeFromParent();
  }
}
